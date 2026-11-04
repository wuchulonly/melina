// TypeScript SDK：参数校验、HTTP 适配和任务句柄；基础设施装配与资源生命周期由 assemble.ts 管理。
// HTTP 服务（cli.ts 的 melina serve）也使用同一个 Melina 实例。
//
//   const melina = new Melina({ db: './melina.db', artifacts: './artifacts', models: { strong: [...], fast: [...] } });
//   const run = await melina.createRun({ goal: { statement: '…' }, workspace: { root: './repo' } });
//   for await (const ev of run.events()) { … }      // Run 结束后自己停
//   const result = await run.result();               // 没结束就等到结束
//
// 配置以数据库为准：构造参数里的 models、sandbox 只在数据库从没配过时当初值，之后改用 setModels、setSettings（或 PUT /api/models、/api/settings）。
// 运行时（src/runtime/）默认由 runtime.ts 的 melinaRuntime() 组装；第二个参数的 runtime 可以换掉它（测试），
// 换成 notConnectedRuntime 时只能查看、改配置，建任务和动任务回 unavailable。

import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Hono } from 'hono';
import {
  CreateRunRequest,
  type InputRequest,
  type MelinaOptions,
  type ModelCatalogResponse,
  type RunListItem,
  type RunResultResponse,
  type RunSummary,
  type UsageResponse,
} from '../core/api.ts';
import { ModelsConfig, type RunConfigOverride, type Settings } from '../core/config.ts';
import { conflict, invalid, notFound } from '../core/errors.ts';
import type { MelinaEvent, SystemStatus } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { RecoveryReport, RunManager } from '../core/interfaces/runtime.ts';
import type { EventBus, RunStoreQueries } from '../core/interfaces/store.ts';
import { type CompletionSpec, ENDED_RUN_STATUSES, type HumanInput, type Run, type RunStatus } from '../core/types.ts';
import { check } from '../core/validate.ts';
import type { MelinaModelRegistry } from '../models/registry.ts';
import { runList, runResult, runSummary } from '../projections/views.ts';
import type { AccessPolicy } from './access.ts';
import { MelinaInfrastructure, type MelinaInternals, type MelinaPaths } from './assemble.ts';
import { checkWorkspaceRoot } from './dirs.ts';
import { type ApiDeps, createApp } from './http.ts';
import type { UploadLimits } from './multipart.ts';

export type { InfraDeps, MelinaInternals, MelinaLog, MelinaPaths, Runtime, RuntimeFactory } from './assemble.ts';
export { notConnectedRuntime, resolvePaths } from './assemble.ts';

export interface CreateRunOptions {
  goal: {
    statement: string;
    /** 本地文件路径，存进 Artifact store，容器里只读挂在 /melina/materials/<文件名> */
    materials?: (string | { path: string; name?: string })[];
    /** 评估时可直接给完成标准和领域；Scoper 保留给定内容并补充约束等任务信息。 */
    completion?: CompletionSpec;
    domain?: string;
  };
  /** 工作目录；不传就新建一个空目录；provider 自动选，setup 由 Scoper 给 */
  workspace?: { root: string };
  /** 接着哪个已结束的 Run 做，这时不传 workspace */
  continueFrom?: Id;
  /** 可以按 Run 覆盖的配置 */
  config?: RunConfigOverride;
}

export interface AppOptions {
  /** HTTP 服务监听的端口，Host、Origin 校验按它来 */
  port: number;
  /** 前端打包出来的 dist 目录 */
  web?: string;
  home?: string;
  heartbeatMs?: number;
  uploadLimits?: UploadLimits;
}

interface RunContext {
  queries: RunStoreQueries;
  bus: EventBus;
  runs: () => Promise<RunManager>;
  /** Melina.close() 时触发：还在等的事件流、结果都停下 */
  shutdown: AbortSignal;
}

/** 两个 signal 任一触发就触发 */
function either(a: AbortSignal, b?: AbortSignal): AbortSignal {
  return b ? AbortSignal.any([a, b]) : a;
}

export class Melina {
  readonly paths: MelinaPaths;
  readonly runtimeConnected: boolean;
  readonly #infra: MelinaInfrastructure;
  readonly #ctx: RunContext;

  constructor(options: MelinaOptions, internals: MelinaInternals = {}) {
    const infra = new MelinaInfrastructure(options, internals);
    this.#infra = infra;
    this.paths = infra.paths;
    this.runtimeConnected = infra.runtimeConnected;
    this.#ctx = {
      queries: infra.queries,
      bus: infra.bus,
      runs: async () => {
        await infra.ready;
        return infra.runtime.runs;
      },
      shutdown: infra.signal,
    };
  }

  /** 等待恢复完成、运行时开始调度；SDK 的写操作也会自动等待。 */
  ready(): Promise<RecoveryReport | undefined> {
    return this.#infra.ready;
  }

  // ── 任务 ────────────────────────────────────────────────────────────────

  async createRun(options: CreateRunOptions): Promise<MelinaRun> {
    await this.#infra.ready;
    const goal = options.goal ?? ({} as CreateRunOptions['goal']);
    const req = check(
      CreateRunRequest,
      plain({
        statement: goal.statement,
        ...(options.workspace !== undefined ? { workspace: options.workspace.root } : {}),
        ...(options.continueFrom !== undefined ? { continueFrom: options.continueFrom } : {}),
        ...(options.config !== undefined ? { config: options.config } : {}),
        ...(goal.completion !== undefined ? { completion: goal.completion } : {}),
        ...(goal.domain !== undefined ? { domain: goal.domain } : {}),
      }),
      '新建任务的参数',
    );
    if (req.continueFrom !== undefined && req.workspace !== undefined) {
      throw invalid('接着做时不传 workspace：照上个任务的来');
    }
    if (req.continueFrom !== undefined && !this.#infra.queries.getRun(req.continueFrom)) {
      throw invalid(`接着做的任务不存在：${req.continueFrom}`);
    }
    // SDK 里的相对路径按当前目录算（HTTP 那边按 home 算）
    const workspace =
      req.workspace !== undefined
        ? await checkWorkspaceRoot(resolve(req.workspace), this.paths.protectedDirs)
        : undefined;
    const materials = (goal.materials ?? []).map((m) => {
      const path = resolve(typeof m === 'string' ? m : m.path);
      let st: ReturnType<typeof statSync> | undefined;
      try {
        st = statSync(path);
      } catch {
        st = undefined;
      }
      if (!st?.isFile()) throw invalid(`附件不是文件：${path}`);
      return { name: (typeof m === 'string' ? undefined : m.name) ?? basename(path), path };
    });
    const run = await this.#infra.runtime.runs.create({
      ...req,
      ...(workspace !== undefined ? { workspace } : {}),
      materials,
    });
    return new MelinaRun(this.#ctx, run.id);
  }

  /** 已有的任务；没有就抛 not_found */
  run(id: Id): MelinaRun {
    if (!this.#infra.queries.getRun(id)) throw notFound(`没有这个任务：${id}`);
    return new MelinaRun(this.#ctx, id);
  }

  /** 任务列表，新的在前（GET /runs） */
  runs(): RunListItem[] {
    return runList(this.#infra.queries);
  }

  /** 所有任务的事件（GET /events）：从 since 之后开始，不给就只要新的；不会自己结束，用 signal 或 break 停 */
  async *events(options: { since?: number; signal?: AbortSignal } = {}): AsyncGenerator<MelinaEvent> {
    const since = options.since ?? this.#infra.queries.lastSeq();
    yield* this.#infra.bus.stream(since, { signal: either(this.#infra.signal, options.signal) });
  }

  usage(): UsageResponse {
    return this.#infra.queries.usageReport();
  }

  status(): SystemStatus {
    return this.#infra.status.current();
  }

  // ── 配置（以数据库为准） ────────────────────────────────────────────────

  models(): ModelsConfig {
    return this.#infra.config.getModels();
  }

  /** 模型目录（GET /models/catalog）：DeepSeek 供应商和模型；模型页的选择面板用 */
  modelCatalog(): ModelCatalogResponse {
    return this.#infra.registry.catalog();
  }

  /** 改模型页：供应商和模型要在 DeepSeek 目录里；API key 只写，不带就保留，空串删掉 */
  setModels(config: ModelsConfig): ModelsConfig {
    const value = check(ModelsConfig, plain(config), '模型配置');
    checkCatalog(this.#infra.registry, value);
    return this.#infra.config.putModels(value);
  }

  settings(): Settings {
    return this.#infra.config.getSettings();
  }

  /** 改设置：凭证的值只写，规则同 API key；改了只影响之后启动的容器 */
  setSettings(settings: Settings): Settings {
    return this.#infra.config.putSettings(plain(settings));
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  /** 这个 Melina 的 HTTP 接口（Hono 应用），melina serve 用 @hono/node-server 跑它 */
  app(options: AppOptions & { access: AccessPolicy }): Hono {
    return createApp(this.apiDeps(options));
  }

  apiDeps(options: AppOptions & { access: AccessPolicy }): ApiDeps {
    // 动任务的请求要等恢复跑完；只读的接口不用等
    const runs = this.#ctx.runs;
    const gated: RunManager = {
      create: async (input) => (await runs()).create(input),
      pause: async (id) => (await runs()).pause(id),
      interrupt: async (id) => {
        const manager = await runs();
        if (!manager.interrupt) throw conflict('这个运行时不支持宿主立即暂停，不能确认在途进程已停止');
        return manager.interrupt(id);
      },
      resume: async (id) => (await runs()).resume(id),
      cancel: async (id) => (await runs()).cancel(id),
      input: async (id, req) => (await runs()).input(id, req),
      delete: async (id) => (await runs()).delete(id),
      result: async (id) => (await runs()).result(id),
      start: () => this.#infra.runtime.start(),
      stop: () => this.#infra.runtime.close(),
    };
    return {
      queries: this.#infra.queries,
      bus: this.#infra.bus,
      artifacts: this.#infra.artifacts,
      runs: gated,
      config: this.#infra.config,
      putModels: (config) => this.setModels(config),
      putSettings: (settings) => this.setSettings(settings),
      status: () => this.status(),
      modelCatalog: () => this.modelCatalog(),
      branchDiff: (runId, branchId) => this.#infra.branchDiff(runId, branchId),
      access: options.access,
      protectedDirs: this.paths.protectedDirs,
      uploadDir: this.paths.uploads,
      ...(options.uploadLimits ? { uploadLimits: options.uploadLimits } : {}),
      ...(options.web !== undefined ? { web: options.web } : {}),
      ...(options.home !== undefined ? { home: options.home } : {}),
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
      onError: (e) => this.#infra.log.error('HTTP 请求出错', e),
    };
  }

  /** 关闭运行时并释放基础设施；重复调用等待同一次关闭。 */
  close(): Promise<void> {
    return this.#infra.close();
  }
}

// ── 一个任务 ──────────────────────────────────────────────────────────────

export class MelinaRun {
  readonly id: Id;
  readonly #ctx: RunContext;

  /** 由 Melina.createRun、Melina.run 给出，不要自己 new */
  constructor(ctx: RunContext, id: Id) {
    this.#ctx = ctx;
    this.id = id;
  }

  /** 这个 Run 现在的记录 */
  get(): Run {
    const run = this.#ctx.queries.getRun(this.id);
    if (!run) throw notFound(`没有这个任务：${this.id}`);
    return run;
  }

  /** GET /runs/:id */
  summary(): RunSummary {
    const summary = runSummary(this.#ctx.queries, this.id);
    if (!summary) throw notFound(`没有这个任务：${this.id}`);
    return summary;
  }

  /**
   * 这个 Run 的事件，默认从头开始；Run 结束（run.updated 带结束状态）后自己停。
   * 已经结束的 Run（比如 since 给的是结束之后的 RunSummary.lastSeq）：把 since 之后的历史给完就停，不等新的。
   */
  async *events(options: { since?: number; signal?: AbortSignal } = {}): AsyncGenerator<MelinaEvent> {
    const since = options.since ?? 0;
    const signal = either(this.#ctx.shutdown, options.signal);
    if (signal.aborted) return;
    const run = this.#ctx.queries.getRun(this.id);
    if (!run) return;
    if (isEnded(run.status)) {
      // 结束了就不会再有 run.updated：只给历史（删除 Run 也要先结束，所以不会等一个已经删掉的 Run）
      for (let cursor = since; ; ) {
        const page = this.#ctx.queries.events({ since: cursor, runId: this.id, limit: 500 });
        for (const event of page) {
          if (signal.aborted) return;
          yield event;
          cursor = event.seq;
        }
        if (page.length < 500) return;
      }
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const event of this.#ctx.bus.stream(since, { runId: this.id, signal: abort.signal })) {
        yield event;
        if (event.type === 'run.updated' && isEnded(event.data.status)) return;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      abort.abort();
    }
  }

  /** 向当前任务的求解路线补充要求或宿主验收反馈。 */
  async input(req: InputRequest): Promise<HumanInput> {
    return (await this.#ctx.runs()).input(this.id, req);
  }

  async pause(): Promise<Run> {
    return (await this.#ctx.runs()).pause(this.id);
  }

  async resume(): Promise<Run> {
    return (await this.#ctx.runs()).resume(this.id);
  }

  async cancel(): Promise<Run> {
    return (await this.#ctx.runs()).cancel(this.id);
  }

  /** 删掉已结束的任务，连同 workspace、产物和 RunStore 记录；不动用户仓库里的 melina/<runId> 分支 */
  async delete(): Promise<void> {
    await (await this.#ctx.runs()).delete(this.id);
  }

  /** 结果：没结束就等到结束（signal 可以不等了） */
  async result(options: { signal?: AbortSignal } = {}): Promise<RunResultResponse> {
    await waitForEnd(this.#ctx, this.id, either(this.#ctx.shutdown, options.signal));
    const result = runResult(this.#ctx.queries, this.id);
    if (!result) throw conflict(`任务 ${this.id} 结束了却没有结果`);
    return result;
  }
}

function isEnded(status: RunStatus): boolean {
  return (ENDED_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** 先订阅再看状态：结束的事件落在两步中间也不会漏 */
function waitForEnd(ctx: RunContext, runId: Id, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolveEnd, rejectEnd) => {
    let off = () => {};
    const done = (error?: unknown) => {
      off();
      signal?.removeEventListener('abort', onAbort);
      if (error === undefined) resolveEnd();
      else rejectEnd(error);
    };
    const onAbort = () => done(signal?.reason ?? new Error('不等了'));
    off = ctx.bus.subscribe(
      (event) => {
        if (event.type === 'run.updated' && isEnded(event.data.status)) done();
      },
      { runId, types: ['run.updated'] },
    );
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const run = ctx.queries.getRun(runId);
    if (!run) done(notFound(`没有这个任务：${runId}`));
    else if (isEnded(run.status)) done();
  });
}

// ── 参数校验 ──────────────────────────────────────────────────────────

/** SDK 的参数按 JSON 走一遍：值为 undefined 的字段去掉（比如 apiKey: process.env.X 没设），和 HTTP 进来的一样 */
function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** 供应商和模型要在目录里（registry.unusable），不然这份配置用不了（PUT /models 拒绝，invalid） */
export function checkCatalog(registry: Pick<MelinaModelRegistry, 'unusable'>, config: ModelsConfig): void {
  const problems = registry.unusable(config);
  if (problems.length > 0) throw invalid(`模型配置用不了：${problems.join('；')}`, problems);
}
