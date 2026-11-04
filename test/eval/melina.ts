// 跑分脚本和 Melina 之间的接口，照  TypeScript SDK 的样子：melina.createRun(...) 拿到 run，
// run.events() 订阅事件，run.result() 取结果，run.cancel() 取消。评估时直接传 completion 和 domain，照给的用；
// Melina 仍调用 Scoper，补充开题画像、约束、共用系统及准备命令。
//
// 现在的实现是 HttpMelina：走 HTTP 接口（src/core/api.ts 的契约），对着 `melina serve` 跑，和 Melina 不在一个进程里，
// Melina 崩了重启时 SSE 按 since 续上（门槛 1 的崩溃恢复可以直接拿它跑）。 的 SDK 好了以后，
// 它的 Melina 只要长得像 MelinaClient 就能直接传给跑分脚本。

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  API_ROUTES,
  apiPath,
  type CreateRunRequest,
  type CreateRunResponse,
  type InputRequest,
  type RunResultResponse,
  type RunSummary,
} from '../../src/core/api.ts';
import type { RunConfigOverride } from '../../src/core/config.ts';
import type { MelinaEvent } from '../../src/core/events.ts';
import { type Handle, sha256OfHandle } from '../../src/core/ids.ts';
import type { CompletionSpec } from '../../src/core/types.ts';
import { eventIssues } from '../../src/core/validate.ts';
import { SseParser } from './sse.ts';

export interface EvalRunRequest {
  goal: {
    statement: string;
    materials: string[]; // 本地文件路径，附件名取文件名
    completion?: CompletionSpec; // 评估时可给固定标准；Scoper 保留给定标准并补充其余任务信息。
    domain?: string;
  };
  workspace?: { root: string };
  config?: RunConfigOverride;
}

export interface EventsOptions {
  since?: number;
  signal?: AbortSignal;
  onDropped?: (raw: string, problems: string) => void;
}

export interface MelinaRun {
  readonly id: string;
  /** 这个 Run 的事件，从 since 之后开始；断了自己续上，直到 signal 停。不合契约的事件跳过，交给 onDropped 记一笔 */
  events(options?: EventsOptions): AsyncIterable<MelinaEvent>;
  cancel(): Promise<unknown>; // 返回什么不管（SDK 返回改完的 Run）
  result(): Promise<RunResultResponse>;
  /** GET /runs/:id：分支卡片和按分支、按角色分的用量；SDK 的是同步的 */
  summary?(): RunSummary | Promise<RunSummary>;
  /** POST /runs/:id/input：跑分时代人追加指令（变体的 hint，门槛 2 的 fork 场景） */
  input?(req: InputRequest): Promise<unknown>;
  /** 按句柄读产物（没提交候选时拿 patch 用）；SDK 没有就不给 */
  artifact?(handle: Handle): Promise<Uint8Array>;
}

export interface MelinaClient {
  createRun(req: EvalRunRequest): Promise<MelinaRun>;
}

export interface HttpMelinaOptions {
  baseUrl: string; // 比如 http://127.0.0.1:7878，不带 /api
  headers?: Record<string, string>; // Melina 要访问令牌之类的时候用
  /** SSE 断了以后最多连续重连多久，默认 15 分钟（Melina 崩溃重启的时间） */
  maxDownMs?: number;
}

/** Melina 回了不是 2xx 的状态：4xx 多半是跑分这边的请求不对，5xx 算 Melina 这边的问题（contenders.ts 按它分） */
export class MelinaHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'MelinaHttpError';
    this.status = status;
  }
}

export class HttpMelina implements MelinaClient {
  readonly options: HttpMelinaOptions;

  constructor(options: HttpMelinaOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') };
  }

  url(template: string, params: Record<string, string> = {}, query = ''): string {
    return `${this.options.baseUrl}${apiPath(template, params)}${query}`;
  }

  async request(
    method: string,
    url: string,
    body?: string | FormData,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const res = await fetch(url, { method, body, headers: { ...this.options.headers, ...headers } });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 500);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {}
      throw new MelinaHttpError(`Melina ${method} ${url} 返回 ${res.status}：${message}`, res.status);
    }
    return res;
  }

  async createRun(req: EvalRunRequest): Promise<MelinaRun> {
    const body: CreateRunRequest = { statement: req.goal.statement };
    if (req.workspace) body.workspace = req.workspace.root;
    if (req.config) body.config = req.config;
    if (req.goal.completion) body.completion = req.goal.completion;
    if (req.goal.domain) body.domain = req.goal.domain;
    let res: Response;
    if (req.goal.materials.length === 0) {
      res = await this.request('POST', this.url(API_ROUTES.createRun.path), JSON.stringify(body), {
        'content-type': 'application/json',
      });
    } else {
      // 附件用 multipart：run 字段放请求的 JSON，materials 放文件，保留原文件名（api.ts CreateRunRequest）
      const form = new FormData();
      form.append('run', JSON.stringify(body));
      for (const path of req.goal.materials) form.append('materials', new Blob([readFileSync(path)]), basename(path));
      res = await this.request('POST', this.url(API_ROUTES.createRun.path), form);
    }
    const { runId } = (await res.json()) as CreateRunResponse;
    return new HttpRun(this, runId);
  }
}

class HttpRun implements MelinaRun {
  readonly id: string;
  readonly #melina: HttpMelina;

  constructor(melina: HttpMelina, id: string) {
    this.#melina = melina;
    this.id = id;
  }

  async *events(options: EventsOptions = {}): AsyncIterable<MelinaEvent> {
    let since = options.since ?? 0;
    let downSince: number | undefined;
    const maxDown = this.#melina.options.maxDownMs ?? 15 * 60_000;
    let controller: AbortController | undefined;
    const abort = () => controller?.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      while (!options.signal?.aborted) {
        const queue: MelinaEvent[] = [];
        let wake: (() => void) | undefined;
        let done = false;
        let failure: unknown;
        const parser = new SseParser((m) => {
          if (m.event !== undefined && m.event !== 'message') return; // 心跳（event: ping）这类具名消息不是 Melina 的事件
          let event: unknown;
          try {
            event = JSON.parse(m.data);
          } catch {
            options.onDropped?.(m.data, '不是 JSON');
            return;
          }
          const problems = eventIssues(event);
          if (problems.length > 0) {
            // 不合契约的事件跳过，不中断评估；记一笔，契约对不上时查得到
            options.onDropped?.(m.data, problems.map((p) => `${p.path} ${p.message}`).join('；'));
            return;
          }
          queue.push(event as MelinaEvent);
          wake?.();
        });
        const current = new AbortController();
        controller = current;
        const reading = (async () => {
          try {
            const url = this.#melina.url(API_ROUTES.runEvents.path, { id: this.id }, `?since=${since}`);
            const res = await fetch(url, {
              headers: { ...this.#melina.options.headers, accept: 'text/event-stream' },
              signal: current.signal,
            });
            if (!res.ok || !res.body) throw new Error(`订阅事件返回 ${res.status}`);
            downSince = undefined;
            const decoder = new TextDecoder();
            for await (const chunk of res.body) parser.push(decoder.decode(chunk as Uint8Array, { stream: true }));
          } catch (e) {
            failure = e;
          } finally {
            done = true;
            wake?.();
          }
        })();
        for (;;) {
          while (queue.length > 0) {
            const event = queue.shift() as MelinaEvent;
            if (event.seq <= since) continue; // 续传时补发的旧事件
            since = event.seq;
            yield event;
          }
          if (done) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        await reading;
        if (options.signal?.aborted) return;
        // 连接断了（Melina 重启、网络抖）：按 since 续上；连续断太久就放弃
        downSince ??= Date.now();
        if (Date.now() - downSince > maxDown) {
          throw new Error(`Melina 的事件流断了超过 ${Math.round(maxDown / 1000)} 秒：${String(failure)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, failure ? 1000 : 200));
      }
    } finally {
      // 读的人不读了（break）、被停了、出错了：把连接关掉
      options.signal?.removeEventListener('abort', abort);
      controller?.abort();
    }
  }

  async cancel(): Promise<void> {
    await this.#melina.request('POST', this.#melina.url(API_ROUTES.cancel.path, { id: this.id }));
  }

  async result(): Promise<RunResultResponse> {
    const res = await this.#melina.request('GET', this.#melina.url(API_ROUTES.result.path, { id: this.id }));
    return (await res.json()) as RunResultResponse;
  }

  async summary(): Promise<RunSummary> {
    const res = await this.#melina.request('GET', this.#melina.url(API_ROUTES.getRun.path, { id: this.id }));
    return (await res.json()) as RunSummary;
  }

  async input(req: InputRequest): Promise<unknown> {
    const res = await this.#melina.request(
      'POST',
      this.#melina.url(API_ROUTES.input.path, { id: this.id }),
      JSON.stringify(req),
      {
        'content-type': 'application/json',
      },
    );
    return res.json();
  }

  async artifact(handle: Handle): Promise<Uint8Array> {
    const res = await this.#melina.request(
      'GET',
      this.#melina.url(API_ROUTES.artifact.path, { id: this.id, hash: sha256OfHandle(handle) }),
    );
    return new Uint8Array(await res.arrayBuffer());
  }
}
