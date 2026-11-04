// HTTP 与 SDK 测试：真实存储、配置和接口，替换任务执行器。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { accessPolicy } from '../../../src/api/access.ts';
import { type InfraDeps, Melina, type MelinaInternals, type Runtime } from '../../../src/api/sdk.ts';
import type { InputRequest, MelinaOptions } from '../../../src/core/api.ts';
import { resolveRunConfig } from '../../../src/core/config.ts';
import { conflict, notFound } from '../../../src/core/errors.ts';
import { type Id, newId } from '../../../src/core/ids.ts';
import type { CreateRunInput, RunManager } from '../../../src/core/interfaces/runtime.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import type { HumanInput, Material, Run } from '../../../src/core/types.ts';
import { runResult } from '../../../src/projections/views.ts';

export const PORT = 7474;
export const HOST = `127.0.0.1:${PORT}`;
export const ORIGIN = `http://${HOST}`;
export const MODEL: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' };

export function tempDir(prefix = 'melina-api-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── 假的运行时 ────────────────────────────────────────────────────────────

export type RunCall =
  | { method: 'create'; input: CreateRunInput; contents: string[] }
  | { method: 'pause' | 'resume' | 'cancel' | 'delete' | 'result'; runId: Id }
  | { method: 'input'; runId: Id; req: InputRequest }
  | { method: 'start' | 'stop' };

/**
 * RunManager 的假实现：用真的 RunStoreWriter 写记录，所以事件、SSE、视图都是真的。
 * create 只建 Run（给了 completion 就同时写进去）；scripted 时再自己往下走：
 * 起草完成标准 → 求解分支开跑 → 提交候选 → done（SDK 的 README 例子用）。
 */
export class FakeRuns implements RunManager {
  readonly calls: RunCall[] = [];
  readonly deps: InfraDeps;
  readonly scripted: boolean;

  constructor(deps: InfraDeps, options: { scripted?: boolean } = {}) {
    this.deps = deps;
    this.scripted = options.scripted ?? false;
  }

  async create(input: CreateRunInput): Promise<Run> {
    const { readFile } = await import('node:fs/promises');
    const contents = await Promise.all(input.materials.map((m) => readFile(m.path, 'utf8')));
    this.calls.push({ method: 'create', input, contents });
    const id = newId();
    const materials: Material[] = [];
    for (const m of input.materials)
      materials.push({ name: m.name, handle: await this.deps.artifacts.putFile(id, m.path) });
    let continued: Run | undefined;
    if (input.continueFrom) {
      continued = this.deps.queries.getRun(input.continueFrom);
      if (!continued) throw notFound(`没有这个任务：${input.continueFrom}`);
      if (continued.status === 'running' || continued.status === 'paused') throw conflict('上个任务还没结束');
    }
    const config = resolveRunConfig(input.config ?? {});
    const run = this.deps.writer.createRun({
      id,
      goal: { statement: input.statement, constraints: [], materials },
      workspace: {
        root: input.workspace ?? continued?.workspace.root ?? join(this.deps.paths.dataDir, id),
        kind: 'dir-copy',
      },
      ...(continued ? { continuedFrom: continued.id } : {}),
      config: { ...config, bet0: { models: [MODEL] } },
      createdAt: new Date().toISOString(),
    });
    if (input.completion) {
      this.deps.writer.draftCompletion(id, {
        completion: input.completion,
        constraints: [],
        domain: input.domain ?? 'general',
      });
    }
    if (this.scripted) setImmediate(() => void this.#play(id).catch((e) => console.error('剧本跑错了', e)));
    return this.deps.queries.getRun(id) ?? run;
  }

  async pause(runId: Id): Promise<Run> {
    this.calls.push({ method: 'pause', runId });
    const run = this.#live(runId);
    if (run.mode === 'settling') throw conflict('任务正在收尾，不能暂停');
    return this.deps.writer.updateRun(runId, { status: 'paused' });
  }

  async resume(runId: Id): Promise<Run> {
    this.calls.push({ method: 'resume', runId });
    const run = this.#live(runId);
    if (run.status !== 'paused') throw conflict('任务没有暂停');
    return this.deps.writer.updateRun(runId, { status: 'running' });
  }

  async cancel(runId: Id): Promise<Run> {
    this.calls.push({ method: 'cancel', runId });
    this.#live(runId);
    const report = await this.deps.artifacts.put(runId, '# 知识报告\n\n你取消了任务。\n');
    return this.deps.writer.endRun(runId, {
      status: 'cancelled',
      endReason: '你取消了任务',
      result: { knowledgeReport: report },
      branchNote: '你取消了任务',
    });
  }

  async input(runId: Id, req: InputRequest): Promise<HumanInput> {
    this.calls.push({ method: 'input', runId, req });
    this.#live(runId);
    return this.deps.writer.recordHumanInput({
      runId,
      text: req.text,
      ...(req.key ? { key: req.key } : {}),
      ...(req.acceptance ? { acceptance: req.acceptance } : {}),
    }).input;
  }

  async delete(runId: Id): Promise<void> {
    this.calls.push({ method: 'delete', runId });
    const run = this.deps.queries.getRun(runId);
    if (!run) throw notFound(`没有这个任务：${runId}`);
    if (run.status === 'running' || run.status === 'paused') throw conflict('还没结束的任务不能删');
    this.deps.writer.deleteRun(runId);
    await this.deps.artifacts.deleteRun(runId);
  }

  async result(runId: Id) {
    this.calls.push({ method: 'result', runId });
    const r = runResult(this.deps.queries, runId);
    if (!r) throw conflict('任务还没结束');
    return r;
  }

  async start(): Promise<void> {
    this.calls.push({ method: 'start' });
  }

  async stop(): Promise<void> {
    this.calls.push({ method: 'stop' });
  }

  #live(runId: Id): Run {
    const run = this.deps.queries.getRun(runId);
    if (!run) throw notFound(`没有这个任务：${runId}`);
    if (run.status !== 'running' && run.status !== 'paused') throw conflict('任务已经结束了');
    return run;
  }

  /** 最短的求解流程：启动分支、记录观测并提交候选。 */
  async #play(runId: Id): Promise<void> {
    const w = this.deps.writer;
    const q = this.deps.queries;
    if (!q.getRun(runId)?.goal.completion) {
      w.draftCompletion(runId, {
        completion: { interpretation: '照字面做', criteria: ['做完了'] },
        constraints: [],
        domain: 'general',
      });
    }
    const bet = w.createBet({
      runId,
      kind: 'direct',
      label: '主干直解路线',
      startFrom: { snapshot: 'root' },
      model: MODEL,
      source: { kind: 'template' },
    });
    let branch = w.createBranch({ runId, betId: bet.id, lastSnapshot: 'root' });
    branch = w.updateBranch(branch.id, { state: 'running', queued: false, workspace: { path: '/tmp/ws' } });
    const output = await this.deps.artifacts.put(runId, '做完了\n');
    const current = q.getBranch(branch.id) ?? branch;
    w.appendObservation(
      {
        runId,
        branchId: branch.id,
        episode: current.episode,
        role: 'explorer',
        tool: 'sh',
        args: { cmd: 'make' },
        expect: '做完',
        summary: '做完了（退出码 0）',
        output,
        snapshot: current.lastSnapshot,
        exitCode: 0,
      },
      { countsAsToolCall: true },
    );
    const snapshot = `snap-${newId().toLowerCase()}`;
    const closed = w.closeEpisode({
      branchId: branch.id,
      episode: current.episode,
      outcome: 'submitted',
      snapshot: { id: snapshot },
      seenSeq: q.lastSeq(),
      candidate: {
        runId,
        branchId: branch.id,
        snapshot,
        claim: '做完了',
      },
    });
    const report = await this.deps.artifacts.put(runId, '# 知识报告\n\n做完了。\n');
    const patch = await this.deps.artifacts.put(runId, 'diff --git a/README.md b/README.md\n');
    w.endRun(runId, {
      status: 'done',
      result: { candidateId: closed.candidate?.id, knowledgeReport: report, patch },
      branchNote: '另一条路线先交了',
    });
  }
}

export interface FakeRuntimeHandle {
  runs?: FakeRuns;
}

export function fakeRuntime(handle: FakeRuntimeHandle, options: { scripted?: boolean } = {}) {
  return (deps: InfraDeps): Runtime => {
    const runs = new FakeRuns(deps, options);
    handle.runs = runs;
    return { runs, start: () => runs.start(), close: () => runs.stop() };
  };
}

// ── 一个测试用的 Melina ─────────────────────────────────────────────────────

export interface TestMelina {
  dir: string;
  melina: Melina;
  app: Hono;
  runs: FakeRuns;
  /** 带上 Melina 认的 Host（和可选的 Origin）发一个请求 */
  request(path: string, init?: RequestInit & { origin?: string | null; host?: string }): Promise<Response>;
  close(): Promise<void>;
}

export async function testMelina(
  options: {
    scripted?: boolean;
    melinaOptions?: Partial<MelinaOptions>;
    internals?: MelinaInternals;
    web?: string;
    home?: string;
    heartbeatMs?: number;
    dir?: string;
  } = {},
): Promise<TestMelina> {
  const dir = options.dir ?? tempDir();
  const handle: FakeRuntimeHandle = {};
  const melina = new Melina(
    { db: join(dir, 'melina.db'), artifacts: join(dir, 'artifacts'), ...options.melinaOptions },
    {
      runtime: fakeRuntime(handle, { scripted: options.scripted ?? false }),
      containers: null,
      env: {},
      log: { warn: () => {}, error: () => {} },
      ...options.internals,
    },
  );
  await melina.ready();
  const app = melina.app({
    port: PORT,
    access: accessPolicy(PORT),
    ...(options.web !== undefined ? { web: options.web } : {}),
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
  });
  const runs = handle.runs;
  if (!runs) throw new Error('假的运行时没建起来');
  return {
    dir,
    melina,
    app,
    runs,
    request: (path, init = {}) => {
      const { origin, host, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set('host', host ?? HOST);
      if (origin !== null && origin !== undefined) headers.set('origin', origin);
      return Promise.resolve(app.request(`http://${HOST}${path}`, { ...rest, headers }));
    },
    close: async () => {
      await melina.close();
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
