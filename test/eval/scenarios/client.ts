// 场景标准解的客户端：只能读公开附件、发 HTTP 请求、保存实际响应。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, writeJson } from '../../sim/client.ts';
import type { SolveContext } from '../../sim/task.ts';

export interface EvidenceStep {
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; body: unknown };
}

export class Investigator {
  readonly ctx: SolveContext;
  readonly steps: EvidenceStep[] = [];

  constructor(ctx: SolveContext) {
    this.ctx = ctx;
  }

  handover<T>(): T {
    return JSON.parse(this.ctx.materials['handover.json'] ?? '{}') as T;
  }

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T }> {
    const response = await http(`${this.ctx.url}${path}`, { method, body, headers });
    this.steps.push({
      request: { method, path, headers, ...(body === undefined ? {} : { body }) },
      response: { status: response.status, body: response.body ?? null },
    });
    return { status: response.status, body: response.body as T };
  }

  async get<T = Record<string, unknown>>(path: string, headers: Record<string, string> = {}): Promise<T> {
    return this.ok(await this.call<T>('GET', path, undefined, headers));
  }

  async post<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    return this.ok(await this.call<T>('POST', path, body, headers));
  }

  /** 调度由查询推进，标准解不依赖现实时间。 */
  async poll<T>(path: string): Promise<T> {
    for (let i = 0; i < 12; i++) {
      const response = await this.call<T>('GET', path);
      if (response.status !== 202) return this.ok(response);
    }
    throw new Error('作业在测试调度周期内没有完成');
  }

  private ok<T>(res: { status: number; body: T }): T {
    if (res.status < 200 || res.status >= 300) throw new Error(`请求失败 ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  finish(answer: Record<string, unknown>, explanation: string): void {
    writeJson(this.ctx.dir, 'answer.json', answer);
    writeJson(this.ctx.dir, 'evidence.json', { steps: this.steps });
    const positive = this.steps.findLastIndex((s) => s.response.status >= 200 && s.response.status < 300);
    const negative = this.steps.findIndex((s) => s.response.status >= 400);
    writeFileSync(
      join(this.ctx.dir, 'report.md'),
      `${explanation}\n\n[成功观测](evidence.json#step-${positive})与[失败对照](evidence.json#step-${negative})` +
        '保留了原请求及完整 JSON 响应，按同一顺序在新实例重放可以复核。\n',
    );
  }
}

/** 照交接材料只走普通入口，没有调查中间状态与跨步骤绑定。 */
export async function naiveScenario(ctx: SolveContext): Promise<void> {
  const c = new Investigator(ctx);
  const h = c.handover<{ baseline: EvidenceStep['request'] }>();
  await c.get('/api');
  const r = await c.call(h.baseline.method, h.baseline.path, h.baseline.body, h.baseline.headers);
  c.finish({ observed: r.body }, '只按交接材料调用普通入口，把普通响应当作调查结果；没有建立跨步骤的对照或复现链。');
}
