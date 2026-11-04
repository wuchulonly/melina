// 假后端的 HTTP 层： 接口表里的全部接口（路径照 src/core/api.ts，带 /api 前缀）、两条 SSE 流，
// 加上测试用的 /__fake/* 控制口。独立进程（server.ts）和 Vite 开发服务器（vite-plugin.ts）共用这一个处理函数。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  API_BASE,
  API_ROUTES,
  type ApiRouteName,
  CreateRunRequest,
  HTTP_STATUS,
  InputRequest,
} from '../../src/core/api.ts';
import { ModelsConfig, Settings } from '../../src/core/config.ts';
import { type ErrorCode, invalid, isMelinaError, notFound } from '../../src/core/errors.ts';
import type { MelinaEvent } from '../../src/core/events.ts';
import type { Id } from '../../src/core/ids.ts';
import { check } from '../../src/core/validate.ts';
import type { FakeMelina, FakeOptions } from './melina.ts';

export type FakeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

interface Matcher {
  name: ApiRouteName;
  method: string;
  re: RegExp;
}

const MATCHERS: Matcher[] = Object.entries(API_ROUTES).map(([name, r]) => ({
  name: name as ApiRouteName,
  method: r.method,
  re: new RegExp(`^${API_BASE}${r.path.replace(/:([A-Za-z]+)/g, '(?<$1>[^/]+)')}$`),
}));

export interface FakeHandlerOptions {
  /** SSE 心跳间隔，默认和 Melina 一样 15 秒（api.ts SSE_HEARTBEAT_MS） */
  heartbeatMs?: number;
}

/** 返回 false 表示不是 /api 或 /__fake 的请求，交给下一个处理（静态文件、Vite） */
export function createFakeHandler(melina: FakeMelina, options: FakeHandlerOptions = {}): FakeHandler {
  // 开着的 SSE 连接 → 收尾函数（退订、停心跳）。reset 和 drop 时先收尾再关，免得往关掉的连接里写
  const streams = new Map<ServerResponse, () => void>();
  melina.onReset(() => {
    for (const [res, done] of [...streams]) {
      done();
      res.end();
    }
  });
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://melina.local');
    if (url.pathname.startsWith('/__fake/')) {
      await control(melina, req, res, url);
      return true;
    }
    if (url.pathname !== API_BASE && !url.pathname.startsWith(`${API_BASE}/`)) return false;
    try {
      const method = req.method ?? 'GET';
      const candidates = MATCHERS.map((m) => ({ m, hit: m.re.exec(url.pathname) })).filter((x) => x.hit);
      const found = candidates.find((x) => x.m.method === method);
      if (!found?.hit) {
        if (candidates.length > 0) throw invalid(`这个接口不接受 ${method}`);
        throw notFound(`没有这个接口：${method} ${url.pathname}`);
      }
      const params = Object.fromEntries(
        Object.entries(found.hit.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]),
      ) as Record<string, string>;
      await dispatch(found.m.name, params, req, res, url);
    } catch (error) {
      sendError(res, error);
    }
    return true;
  };

  async function dispatch(
    name: ApiRouteName,
    p: Record<string, string>,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const id = p.id as Id;
    switch (name) {
      case 'listRuns':
        return json(res, melina.listRuns());
      case 'createRun': {
        const { body, uploads } = await readCreateRun(req, url);
        return json(res, melina.createRun(check(CreateRunRequest, body, '新建任务的请求'), uploads), 201);
      }
      case 'dirs':
        return json(res, melina.dirs(url.searchParams.get('prefix') ?? ''));
      case 'getRun':
        return json(res, melina.getRun(id));
      case 'runProgress':
        return json(res, melina.progress(id));
      case 'runEvents':
        melina.getRun(id);
        return stream(req, res, url, id);
      case 'branch': {
        const limit = url.searchParams.get('limit');
        return json(
          res,
          melina.branch(
            id,
            p.branchId as Id,
            url.searchParams.get('cursor') ?? undefined,
            limit ? Number(limit) : undefined,
          ),
        );
      }
      case 'branchDiff':
        return json(res, melina.branchDiff(id, p.branchId as Id));
      case 'input':
        return json(res, melina.input(id, check(InputRequest, await readJson(req), '输入')));
      case 'interrupt':
        return json(res, melina.pause(id));
      case 'pause':
        return json(res, melina.pause(id));
      case 'resume':
        return json(res, melina.resume(id));
      case 'cancel':
        return json(res, melina.cancel(id));
      case 'deleteRun':
        melina.deleteRun(id);
        res.writeHead(204).end();
        return;
      case 'result':
        return json(res, melina.result(id));
      case 'artifact': {
        const found = melina.artifact(id, p.hash ?? '');
        const text = typeof found.content === 'string';
        res.writeHead(200, {
          'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
          ...(text ? {} : { 'Content-Disposition': 'attachment' }),
          'Cache-Control': 'private, max-age=31536000, immutable',
        });
        res.end(found.content);
        return;
      }
      case 'events':
        return stream(req, res, url);
      case 'usage':
        return json(res, melina.usage());
      case 'status':
        return json(res, melina.systemStatus());
      case 'getModels':
        return json(res, melina.getModels());
      case 'modelCatalog':
        return json(res, melina.modelCatalog());
      case 'putModels':
        return json(res, melina.putModels(check(ModelsConfig, await readJson(req), '模型配置')));
      case 'getSettings':
        return json(res, melina.getSettings());
      case 'putSettings':
        return json(res, melina.putSettings(check(Settings, await readJson(req), '设置')));
    }
  }

  /** SSE：先补发 seq > since 的历史（since 和浏览器自动带的 Last-Event-ID 取大的；都没有就不补），再推新的 */
  function stream(req: IncomingMessage, res: ServerResponse, url: URL, runId?: Id): void {
    const since = Math.max(numberOr(url.searchParams.get('since')), numberOr(header(req, 'last-event-id')));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const write = (e: MelinaEvent) => {
      if (runId !== undefined && e.runId !== runId) return;
      if (res.writableEnded || res.destroyed) return;
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    if (since >= 0) for (const e of melina.eventsSince(since, runId)) write(e);
    const off = melina.subscribe(write);
    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write('event: ping\ndata: {}\n\n');
    }, heartbeatMs);
    const done = () => {
      off();
      clearInterval(ping);
      streams.delete(res);
    };
    streams.set(res, done);
    req.on('close', done);
    res.on('close', done);
    res.on('error', done);
  }
}

// ── 测试用的控制口 ────────────────────────────────────────────────────────

async function control(melina: FakeMelina, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const what = url.pathname.slice('/__fake/'.length);
    if (what === 'state' && req.method === 'GET') return json(res, melina.describe());
    if (what === 'secrets' && req.method === 'GET') return json(res, melina.secretsForTest());
    if (req.method !== 'POST') throw notFound(`没有这个控制口：${req.method} ${url.pathname}`);
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    switch (what) {
      case 'reset':
        melina.reset(body as FakeOptions);
        return json(res, melina.describe());
      case 'speed':
        melina.setSpeed(Number(body.speed ?? 0));
        return json(res, melina.describe());
      case 'step':
        return json(res, {
          events: melina.step(Number(body.count ?? 1), typeof body.track === 'string' ? body.track : undefined),
        });
      case 'drop':
        melina.dropStreams();
        return json(res, { ok: true });
      default:
        throw notFound(`没有这个控制口：${url.pathname}`);
    }
  } catch (error) {
    sendError(res, error);
  }
}

// ── 请求和返回 ────────────────────────────────────────────────────────────

function json(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function sendError(res: ServerResponse, error: unknown): void {
  const code: ErrorCode = isMelinaError(error) ? error.code : 'internal';
  const message = error instanceof Error ? error.message : String(error);
  const details = isMelinaError(error) ? error.details : undefined;
  if (res.headersSent) {
    res.end();
    return;
  }
  json(res, { error: { code, message, ...(details !== undefined ? { details } : {}) } }, HTTP_STATUS[code]);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = (await readBody(req)).toString('utf8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('请求体不是合法的 JSON');
  }
}

/** POST /runs：multipart（run 字段放 JSON，附件放 materials）或 JSON（api.ts CreateRunRequest） */
async function readCreateRun(
  req: IncomingMessage,
  url: URL,
): Promise<{ body: unknown; uploads: { name: string; content: Uint8Array }[] }> {
  const type = header(req, 'content-type') ?? '';
  if (!type.startsWith('multipart/form-data')) return { body: await readJson(req), uploads: [] };
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(url, {
    method: 'POST',
    headers,
    body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    duplex: 'half',
  } as RequestInit);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw invalid('附件没传完整，再试一次');
  }
  const raw = form.get('run');
  if (typeof raw !== 'string') throw invalid('缺少 run 字段（新建任务的请求，JSON）');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw invalid('run 字段不是合法的 JSON');
  }
  const uploads: { name: string; content: Uint8Array }[] = [];
  for (const file of form.getAll('materials')) {
    if (typeof file === 'string') continue;
    uploads.push({ name: file.name || '附件', content: new Uint8Array(await file.arrayBuffer()) });
  }
  return { body, uploads };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function numberOr(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return -1;
  const n = Number(value);
  return Number.isFinite(n) ? n : -1;
}
