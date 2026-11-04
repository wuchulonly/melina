import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig } from '../../../src/core/config.ts';
import type { EpisodeFailure, MelinaEvent } from '../../../src/core/events.ts';
import { ZERO_USAGE } from '../../../src/core/events.ts';
import { type Handle, handleOf, type Id, newId, type SnapshotId } from '../../../src/core/ids.ts';
import type {
  EpisodeHandle,
  EpisodeInput,
  EpisodeOutcome,
  ExplorerAgent,
  PickResult,
  ScoperAgent,
  ScoperOutcome,
  SelectVersion,
  WatcherAgent,
  WatchResult,
} from '../../../src/core/interfaces/agents.ts';
import type { ContainerRef, ContainerRuntime } from '../../../src/core/interfaces/container.ts';
import type { ContextAssembler, Layout, PickRequest, WatchRequest } from '../../../src/core/interfaces/context.ts';
import type { CallerContext, ToolGateway, ToolSession } from '../../../src/core/interfaces/gateway.ts';
import type {
  WorkspaceCreateOpts,
  WorkspaceProvider,
  WorkspaceProviders,
} from '../../../src/core/interfaces/workspace.ts';
import type { ModelChoice, ModelRef } from '../../../src/core/model-ref.ts';
import type { CloseOutcome, SubmitCandidateArgs, SubmitWatchArgs } from '../../../src/core/tools.ts';
import type {
  Bet,
  Branch,
  CompletionSpec,
  Observation,
  Run,
  ScoperOutput,
  WorkspaceKind,
  WorkspaceRef,
} from '../../../src/core/types.ts';
import { latestWatch } from '../../../src/projections/watch.ts';
import type { Clock } from '../../../src/runtime/async.ts';
import type { BranchEnv } from '../../../src/runtime/branch-env.ts';
import type { RunSecretsHook } from '../../../src/runtime/run-manager.ts';
import {
  createKernel,
  type KernelContinuations,
  type KernelDeps,
  type RuntimeKernel,
} from '../../../src/runtime/runtime.ts';
import { createScheduler, type MelinaScheduler } from '../../../src/runtime/scheduler.ts';
import { openRunStore, type RunStore } from '../../../src/storage/state.ts';

export const STRONG: ModelRef = { provider: 'deepseek', model: 'deepseek-pro', tier: 'strong' };
export const FAST: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' };

export const COMPLETION: CompletionSpec = {
  interpretation: '按 vitest 的行覆盖率算',
  criteria: ['覆盖率不低于 80%', '测试全过'],
  metric: { name: '覆盖率', unit: '%', better: 'higher', target: 80 },
};

/**
 * 假 Scoper 默认交的。没写约束：给了完成标准的 Run（h.run）里 Scoper 起草完就没有要补给求解分支的，
 * 收件箱里只有各个测试自己关心的提示；要看补给的测试自己设 scoper.output
 */
export const SCOPED: ScoperOutput = { completion: COMPLETION, constraints: [], domain: 'code' };

// ── 等 ────────────────────────────────────────────────────────────────────

/** 一直等到 cond 成立（默认最多 5 秒） */
export async function waitFor(cond: () => boolean, what = '条件成立', ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`等了 ${ms} 毫秒，${what}还没发生`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 假时钟 ────────────────────────────────────────────────────────────────

export class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /** 往前走 ms 毫秒，到点的计时器按时间先后执行 */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

// ── 假 Explorer：按剧本跑 episode ─────────────────────────────────────────

export interface EpisodeCtx {
  input: EpisodeInput;
  runStore: RunStore;
  signal: AbortSignal;
  /** 这个 episode 收到的追加内容 */
  steered: string[];
  /** 记一次环境工具调用（Observation，算工具调用数） */
  observe(summary?: string, opts?: { counts?: boolean }): Observation;
  /** 收到追加内容（steer）才往下走 */
  untilSteered(match?: (text: string) => boolean): Promise<string>;
  /** 一直等到被中止（kill、取消、退出） */
  untilAborted(): Promise<never>;
  /** 交回：收尾工具；不给就是没有合法收尾（failureDetail：失败的原因，C23） */
  done(close?: CloseOutcome, failure?: EpisodeFailure, failureDetail?: string): EpisodeOutcome;
}

export type EpisodeScript = (ctx: EpisodeCtx) => EpisodeOutcome | Promise<EpisodeOutcome>;

export const closes = {
  end(extra: { handoff?: string } = {}): CloseOutcome {
    return { kind: 'continue', handoff: '接着做', ...extra };
  },
  submit(extra: Partial<SubmitCandidateArgs> = {}): CloseOutcome {
    return { kind: 'candidate', claim: '覆盖率提到了 82%，测试全过', ...extra };
  },
};

/** 默认保持 direct 会话运行，直到任务中止。 */
export const DEFAULT_SCRIPT: EpisodeScript = (ctx) => ctx.untilAborted();

export class FakeExplorer implements ExplorerAgent {
  readonly runStore: RunStore;
  /** 每条路线（按 Bet.label）排着的剧本，用完了用 fallback */
  private readonly queues = new Map<string, EpisodeScript[]>();
  fallback: EpisodeScript = DEFAULT_SCRIPT;
  readonly started: EpisodeInput[] = [];
  /** 每条分支收到过的追加内容 */
  readonly steers = new Map<Id, string[]>();

  constructor(runStore: RunStore) {
    this.runStore = runStore;
  }

  on(label: string, ...scripts: EpisodeScript[]): this {
    this.queues.set(label, [...(this.queues.get(label) ?? []), ...scripts]);
    return this;
  }

  /** 某条分支已经开始了几个 episode */
  count(branchId: Id): number {
    return this.started.filter((s) => s.branch.id === branchId).length;
  }

  startEpisode(input: EpisodeInput): EpisodeHandle {
    this.started.push(input);
    const steered: string[] = [];
    const waiters: ((text: string) => void)[] = [];
    let toolCalls = 0;
    let seenSeq = input.layout.seenSeq ?? input.branch.seenSeq;
    const runStore = this.runStore;
    const branchId = input.branch.id;
    const ctx: EpisodeCtx = {
      input,
      runStore,
      signal: input.signal,
      steered,
      observe: (summary = '跑了一下', opts = {}) => {
        const b = runStore.queries.getBranch(branchId) as Branch;
        const counts = opts.counts ?? true;
        if (counts) toolCalls++;
        return runStore.writer.appendObservation(
          {
            runId: b.runId,
            branchId,
            episode: b.episode,
            role: 'explorer',
            tool: 'sh',
            args: { cmd: 'pnpm test' },
            summary,
            output: putText(runStore, b.runId, summary),
            snapshot: b.lastSnapshot,
            exitCode: 0,
          },
          { countsAsToolCall: counts },
        );
      },
      untilSteered: (match) =>
        new Promise<string>((resolve, reject) => {
          const found = steered.find((t) => !match || match(t));
          if (found !== undefined) {
            resolve(found);
            return;
          }
          const onAbort = () => reject(input.signal.reason);
          input.signal.addEventListener('abort', onAbort, { once: true });
          waiters.push((text) => {
            if (match && !match(text)) return;
            input.signal.removeEventListener('abort', onAbort);
            resolve(text);
          });
        }),
      untilAborted: () =>
        new Promise<never>((_, reject) => {
          if (input.signal.aborted) reject(input.signal.reason);
          else input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        }),
      done: (close, failure, failureDetail) => ({
        ...(close ? { close } : { failure: failure ?? 'no_close', ...(failureDetail ? { failureDetail } : {}) }),
        toolCalls,
        seenSeq,
        usage: { ...ZERO_USAGE },
      }),
    };
    const queue = this.queues.get(input.bet.label);
    const script = queue && queue.length > 0 ? (queue.shift() as EpisodeScript) : this.fallback;
    const done = Promise.resolve().then(() => script(ctx));
    return {
      done,
      steer: (text, seq) => {
        steered.push(text);
        if (seq !== undefined && seq > seenSeq) seenSeq = seq;
        const list = this.steers.get(branchId) ?? [];
        list.push(text);
        this.steers.set(branchId, list);
        for (const w of [...waiters]) w(text);
      },
    };
  }
}

/** 同步地把一段文字放进 Artifact store（按内容寻址的同一个位置），测试里 observe 这类调用就不用 await */
export function putText(runStore: RunStore, runId: Id, text: string): Handle {
  const store = runStore.artifacts;
  if (!store) throw new Error('测试的 RunStore 要有 Artifact store');
  const handle = handleOf(text);
  const path = store.path(runId, handle);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return handle;
}

// ── 假 workspace ──────────────────────────────────────────────────────────

export class FakeWorkspaces implements WorkspaceProviders {
  readonly dir: string;
  readonly runStore: RunStore;
  readonly providers = new Map<Id, FakeProvider>();
  /** 所有 provider 的调用，按先后：init、create、snapshot、restore、prune、deliver、diffSnapshots、dispose */
  readonly calls: { op: string; runId: Id; args: unknown[] }[] = [];
  failCreate = 0;
  failSnapshot = 0;
  /** create 返回的 ref 上带的 setup 结果 */
  setup: unknown;
  /** 打根 snapshot 时先等它（测试工作目录尚在准备、初始求解分支未启动的阶段）。 */
  initGate: Promise<void> | undefined;
  /** 建 workspace 时先等它（测试跑 setup 的那几分钟） */
  createGate: Promise<void> | undefined;
  createWaiting = false;
  /** 每次 create 收到的取消信号（C17：kill、暂停、取消时停掉 setup） */
  readonly createSignals: (AbortSignal | undefined)[] = [];
  /** 打 snapshot 时先等它（测试收尾前的那几秒） */
  snapshotGate: Promise<void> | undefined;
  snapshotWaiting = false;
  /** 清理旧 snapshot 时先等它 */
  pruneGate: Promise<void> | undefined;
  pruneWaiting = false;
  /** restore 这些 workspace 时出错 */
  failRestore = new Set<string>();

  constructor(runStore: RunStore, dir: string) {
    this.runStore = runStore;
    this.dir = dir;
  }

  async detect(root: string): Promise<WorkspaceKind> {
    return root.includes('git') ? 'git-clone' : 'dir-copy';
  }

  forRun(run: Run): WorkspaceProvider {
    let p = this.providers.get(run.id);
    if (!p) {
      p = new FakeProvider(this, run.id);
      this.providers.set(run.id, p);
    }
    return p;
  }

  ops(op: string): unknown[][] {
    return this.calls.filter((c) => c.op === op).map((c) => c.args);
  }
}

export class FakeProvider implements WorkspaceProvider {
  readonly kind = 'dir-copy' as const;
  private readonly ws: FakeWorkspaces;
  private readonly runId: Id;

  constructor(ws: FakeWorkspaces, runId: Id) {
    this.ws = ws;
    this.runId = runId;
  }

  private log(op: string, ...args: unknown[]) {
    this.ws.calls.push({ op, runId: this.runId, args });
  }

  async init(): Promise<void> {
    this.log('init');
    if (this.ws.initGate) await this.ws.initGate;
  }

  async create(from: SnapshotId, opts: WorkspaceCreateOpts = {}): Promise<WorkspaceRef> {
    this.log('create', from);
    this.ws.createSignals.push(opts.signal);
    if (this.ws.createGate) {
      this.ws.createWaiting = true;
      await this.ws.createGate;
    }
    if (this.ws.failCreate > 0) {
      this.ws.failCreate--;
      throw new Error('建 workspace 失败（测试）');
    }
    const id = newId();
    const path = join(this.ws.dir, this.runId, 'ws', id);
    await mkdir(path, { recursive: true });
    const ref: WorkspaceRef = { path };
    return Object.assign(ref, { id }, this.ws.setup ? { setup: this.ws.setup } : {});
  }

  async snapshot(ws: WorkspaceRef): Promise<SnapshotId> {
    if (this.ws.snapshotGate) {
      this.ws.snapshotWaiting = true;
      await this.ws.snapshotGate;
    }
    if (this.ws.failSnapshot > 0) {
      this.ws.failSnapshot--;
      throw new Error('打 snapshot 失败（测试）');
    }
    const id = newId();
    this.log('snapshot', ws.path, id);
    return id;
  }

  async restore(ws: WorkspaceRef, to: SnapshotId): Promise<void> {
    this.log('restore', ws.path, to);
    if (this.ws.failRestore.has(ws.path)) throw new Error('restore 失败（测试）');
  }

  async diff(ws: WorkspaceRef, base: SnapshotId): Promise<Handle> {
    this.log('diff', ws.path, base);
    return putText(this.ws.runStore, this.runId, `diff ${ws.path} ${base}\n+改动\n`);
  }

  async diffSnapshots(base: SnapshotId, target: SnapshotId): Promise<Handle> {
    this.log('diffSnapshots', base, target);
    return putText(this.ws.runStore, this.runId, `diff ${base}..${target}\n+没做完的改动\n`);
  }

  async apply(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async exec(): Promise<never> {
    throw new Error('测试里不跑命令');
  }

  async prune(ws: WorkspaceRef, keep: SnapshotId[]): Promise<void> {
    this.log('prune', ws.path, [...keep]);
    if (this.ws.pruneGate) {
      this.ws.pruneWaiting = true;
      await this.ws.pruneGate;
    }
  }

  async deliver(_ws: WorkspaceRef, snapshot: SnapshotId): Promise<{ branch?: string; patch: Handle }> {
    this.log('deliver', snapshot);
    return {
      branch: `melina/${this.runId}`,
      patch: putText(this.ws.runStore, this.runId, `diff root..${snapshot}\n+交付的改动\n`),
    };
  }

  async dispose(ws: WorkspaceRef): Promise<void> {
    this.log('dispose', ws.path);
  }
}

// ── 假的 ToolGateway、ContextAssembler、Scoper、容器 ─────────────────────

export class FakeGateway implements ToolGateway {
  readonly callers: CallerContext[] = [];

  open(caller: CallerContext): ToolSession {
    this.callers.push(caller);
    return {
      caller,
      tools: [],
      check: () => undefined,
      toolCalls: 0,
      closed: () => undefined,
    };
  }
}

export function fakeAssembler(
  runStore: RunStore,
): Pick<ContextAssembler, 'forExplorer' | 'explorerUpdate' | 'forScoper' | 'watchMap'> {
  const layout = (role: Layout['role']): Layout => ({
    role,
    system: '',
    tools: [],
    messages: [{ role: 'user', text: '开始' }],
    basedOnSeq: runStore.queries.lastSeq(),
    seenSeq: runStore.queries.lastSeq(),
  });
  return {
    forExplorer: () => layout('explorer'),
    forScoper: () => layout('scoper'),
    /** 收件箱里的新条目 */
    explorerUpdate: (branch, sinceSeq) => {
      const q = runStore.queries;
      const inbox = q.inbox(branch.id, sinceSeq);
      if (inbox.length === 0) return undefined;
      const seq = Math.max(...inbox.map((i) => i.seq));
      const text = inbox.map((i) => i.text).join('\n');
      return { text, seenSeq: seq };
    },
    /** 巡检器的地图：这条分支最新的一版，写成「【巡检器】第 N 版：最该注意的那句」；还没有就是 undefined */
    watchMap: (branchId) => {
      const branch = runStore.queries.getBranch(branchId);
      const latest = branch ? latestWatch(runStore.queries, branch.runId, branch.id) : undefined;
      return latest ? `【巡检器】第 ${latest.rev} 版：${latest.advice}` : undefined;
    },
  };
}

export class FakeScoper implements ScoperAgent {
  output: ScoperOutput = SCOPED;
  calls = 0;
  failures = 0;
  hang = false;
  /** 提交前先等它（测试 Scoper 尚在起草、求解分支已运行的阶段）。 */
  gate: Promise<void> | undefined;

  async scope(input: { signal: AbortSignal }): Promise<ScoperOutcome> {
    this.calls++;
    if (this.hang) {
      await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason)));
    }
    if (this.gate) await this.gate;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('Scoper 的容器起不来（测试）');
    }
    return { output: this.output, degraded: false };
  }
}

/**
 * 挑版：choose 定挑哪一版（默认最后一版），fail 时抛错；gate 给了就等它放行再交（测停下时等在途的挑版），
 * 被中止时抛错（测停下时掐掉没看到新记录的那次）。calls 记下每次比的是哪几版、拿到的内容；
 * basedOn 记下每次「拼上下文」时 RunStore 最新的 seq（harness 接上 RunStore，和真的一样在调用一开始拼）
 */
export class FakeSelector {
  readonly calls: PickRequest['versions'][] = [];
  readonly basedOn: number[] = [];
  choose: (ids: readonly Id[]) => Id = (ids) => ids[ids.length - 1] as Id;
  why = '这一版的证据最扎实';
  fail = false;
  gate: Promise<void> | undefined;
  lastSeq: () => number = () => 0;

  async pick(input: Parameters<SelectVersion>[0]): Promise<PickResult> {
    this.calls.push(input.request.versions);
    const basedOnSeq = this.lastSeq();
    this.basedOn.push(basedOnSeq);
    if (this.gate) {
      const { signal } = input;
      await Promise.race([
        this.gate,
        new Promise<void>((_, reject) => {
          if (signal.aborted) reject(new Error('挑版被取消了'));
          signal.addEventListener('abort', () => reject(new Error('挑版被取消了')), { once: true });
        }),
      ]);
    }
    if (this.fail) throw new Error('挑版的模型出错了');
    return { candidateId: this.choose(input.request.versions.map((v) => v.candidateId)), why: this.why, basedOnSeq };
  }
}

/** 巡检器用的模型 */
export const WATCHER_MODEL: ModelRef = { provider: 'zhipu', model: 'glm-5.3', tier: 'strong' };

/**
 * 巡检器：每轮记下看的是哪条路线、看到 RunStore 的哪一刻、那时它做了几次工具调用；draft 定交什么（默认按轮次写一句
 * 最该注意的）；fail 是接下来几轮抛错；gate 给了就等它放行再交（被中止时抛错，和真的一样）
 */
export class FakeWatcher implements WatcherAgent {
  readonly calls: { request: WatchRequest; author: ModelRef; toolCalls: number }[] = [];
  draft: (round: number, request: WatchRequest) => SubmitWatchArgs = (round) => ({
    standing: `第 ${round} 轮：还差第 1 条`,
    directions: [],
    tension: [],
    advice: `第 ${round} 轮的提醒`,
  });
  fail = 0;
  gate: Promise<void> | undefined;
  runStore: RunStore | undefined;

  beforePublish?: (
    round: number,
    input: Parameters<WatcherAgent['watch']>[0],
  ) => Partial<{ basedOnSeq: number; toolCalls: number }> | undefined;

  async watch(input: Parameters<WatcherAgent['watch']>[0]): Promise<WatchResult> {
    const branch = this.runStore?.queries.getBranch(input.request.branchId);
    this.calls.push({ request: input.request, author: input.author, toolCalls: branch?.toolCalls ?? -1 });
    const round = this.calls.length;
    if (this.gate) {
      const { signal } = input;
      await Promise.race([
        this.gate,
        new Promise<void>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      ]);
    }
    if (input.signal.aborted) throw input.signal.reason;
    if (this.fail > 0) {
      this.fail--;
      throw new Error('巡检器的模型出错了（测试）');
    }
    if (!this.runStore) throw new Error('FakeWatcher requires a RunStore');
    const coverage = this.beforePublish?.(round, input);
    const published = this.runStore.writer.recordWatch({
      runId: input.run.id,
      branchId: input.request.branchId,
      draft: this.draft(round, input.request),
      model: WATCHER_MODEL,
      basedOnSeq: coverage?.basedOnSeq ?? input.request.untilSeq,
      ...(input.request.state ? { state: { ...input.request.state, seenSeq: input.request.state.untilSeq } } : {}),
      toolCalls: coverage?.toolCalls ?? input.request.toolCalls ?? branch?.toolCalls ?? 0,
    });
    return { published, windowUntilSeq: input.request.untilSeq };
  }
}

export class FakeEnv implements BranchEnv {
  readonly calls: { op: string; id: string }[] = [];
  /** 起分支容器时 Run 的领域（决定镜像） */
  readonly domains: (string | undefined)[] = [];
  failEnsure = 0;

  async ensure(run: Run, branch: Branch): Promise<ContainerRef | undefined> {
    this.calls.push({ op: 'ensure', id: branch.id });
    this.domains.push(run.goal.domain);
    if (this.failEnsure > 0) {
      this.failEnsure--;
      throw new Error('容器起不来（测试）');
    }
    return { id: `c-${branch.id}`, name: `melina-${branch.id}` };
  }

  async stop(branch: Branch): Promise<void> {
    this.calls.push({ op: 'stop', id: branch.id });
  }

  async remove(branch: Branch): Promise<void> {
    this.calls.push({ op: 'remove', id: branch.id });
  }

  async scoper(run: Run): Promise<ContainerRef | undefined> {
    this.calls.push({ op: 'scoper', id: run.id });
    return { id: `c-scoper-${run.id}`, name: `melina-${run.id}-scoper` };
  }

  async removeScoper(runId: Id): Promise<void> {
    this.calls.push({ op: 'removeScoper', id: runId });
  }

  ops(op: string, id?: string): number {
    return this.calls.filter((c) => c.op === op && (id === undefined || c.id === id)).length;
  }
}

export class FakeContinuations implements KernelContinuations {
  async restore(): Promise<void> {}
  async close(): Promise<void> {}
  start(): void {}
}

export const registry = {
  resolve: (c: ModelChoice): ModelRef => ('provider' in c ? c : c.tier === 'strong' ? STRONG : FAST),
  tier: (t: 'fast' | 'strong'): ModelRef[] => (t === 'strong' ? [STRONG] : [FAST]),
};

// ── 一整套 runtime ────────────────────────────────────────────────────────

export interface Harness {
  runStore: RunStore;
  rt: RuntimeKernel;
  explorer: FakeExplorer;
  workspaces: FakeWorkspaces;
  gateway: FakeGateway;
  scoper: FakeScoper;
  env: FakeEnv;
  continuations: FakeContinuations;
  scheduler: MelinaScheduler;
  dir: string;
  logs: string[];
  /** 等后台的事（准备、收尾）都做完 */
  settle(): Promise<void>;
  /** 建一个 Run（默认带完成标准，Scoper 照抄它），等准备做完 */
  run(over?: Partial<Parameters<RuntimeKernel['runs']['create']>[0]>): Promise<Run>;
  /** 某个 Run 的第一条初始求解分支。 */
  bet0(runId: Id): Branch;
  branchOf(runId: Id, label: string): Branch;
  events(type?: MelinaEvent['type']): MelinaEvent[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  assembler?: (runStore: RunStore) => KernelDeps['assembler'];
  beforeCreate?: KernelDeps['beforeCreate'];
  global?: Partial<GlobalConfig>;
  toolExec?: number;
  /** 各家同时跑的 episode（和在途的模型调用）上限；要让分支排队就把它设成 1（toolExec 不限 episode） */
  modelCalls?: Record<string, number>;
  start?: boolean;
  db?: string;
  dir?: string;
  retryDelaysMs?: number[];
  /** 结束、收尾写结果出错后的重试间隔 */
  commitRetryDelaysMs?: number[];
  /** 容器运行时（恢复时清上次留下的容器要用）；不给就没有 */
  containers?: ContainerRuntime;
  /** 工作目录里原有的密钥、交付前查 patch 的钩子；不给就没有 */
  secrets?: RunSecretsHook;
  onRecover?: (runId: Id) => Promise<void>;
  /** 挑版；不给就不挑，停下时交付最先存的那一版 */
  selector?: FakeSelector;
  /** 巡检器；不给就不看 */
  watcher?: WatcherAgent;
  /** 巡检器一轮的用时上限 */
  watchTimeMs?: number;
  /** 模型分档；不给就是一档一个、不看 key */
  registry?: KernelDeps['registry'];
  /** 巡检器第一轮、之后每轮隔多久；不给用 runtime 的默认 */
  watchPace?: { firstMs: number; everyMs: number };
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'melina-runtime-'));
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const runStore = openRunStore({ db: opts.db ?? ':memory:', artifacts: join(dir, 'artifacts') });
  if (opts.selector instanceof FakeSelector) opts.selector.lastSeq = () => runStore.queries.lastSeq();
  if (opts.watcher instanceof FakeWatcher) opts.watcher.runStore = runStore;
  const published: MelinaEvent[] = [];
  runStore.bus.subscribe((e) => published.push(e));
  const logs: string[] = [];
  const background: Promise<void>[] = [];
  const global: GlobalConfig = {
    ...DEFAULT_GLOBAL_CONFIG,
    ...opts.global,
    limits: { modelCalls: opts.modelCalls ?? {}, toolExec: opts.toolExec ?? 4, diskFreeMin: 0 },
  };
  const scheduler = createScheduler({ limits: () => global.limits, cpus: () => 4 });
  const explorer = new FakeExplorer(runStore);
  const workspaces = new FakeWorkspaces(runStore, join(dir, 'data'));
  const gateway = new FakeGateway();
  const scoper = new FakeScoper();
  const env = new FakeEnv();
  const continuations = new FakeContinuations();
  const rt = createKernel({
    writer: runStore.writer,
    queries: runStore.queries,
    bus: runStore.bus,
    artifacts: runStore.artifacts as NonNullable<RunStore['artifacts']>,
    workspaces,
    gateway,
    assembler: opts.assembler?.(runStore) ?? fakeAssembler(runStore),
    explorer,
    scoper,
    registry: opts.registry ?? registry,
    config: { global: () => global, credentials: () => [] },
    scheduler,
    dataDir: join(dir, 'data'),
    env,
    createContinuations: () => continuations,
    ...(opts.beforeCreate ? { beforeCreate: opts.beforeCreate } : {}),
    ...(opts.containers ? { containers: opts.containers } : {}),
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    ...(opts.onRecover ? { onRecover: opts.onRecover } : {}),
    ...(opts.selector ? { selectVersion: opts.selector.pick.bind(opts.selector) } : {}),
    ...(opts.watcher ? { watcher: opts.watcher } : {}),
    ...(opts.watchTimeMs !== undefined ? { watchTimeMs: opts.watchTimeMs } : {}),
    ...(opts.watchPace ? { watchPace: opts.watchPace } : {}),
    retryDelaysMs: opts.retryDelaysMs ?? [5, 5, 5],
    commitRetryDelaysMs: opts.commitRetryDelaysMs ?? [20],
    onBackground: (w) => background.push(w),
    log: (t) => logs.push(t),
  });
  if (opts.start !== false) {
    await rt.recovery.run();
    await rt.start();
  }
  const h: Harness = {
    runStore,
    rt,
    explorer,
    workspaces,
    gateway,
    scoper,
    env,
    continuations,
    scheduler,
    dir,
    logs,
    settle: async () => {
      for (let i = 0; i < 50; i++) {
        const pending = background.splice(0);
        if (pending.length === 0) {
          await tick(5);
          if (background.length === 0) return;
          continue;
        }
        await Promise.all(pending);
      }
    },
    run: async (over = {}) => {
      const run = await rt.runs.create({
        statement: '把 search 模块的测试覆盖率提到 80% 以上',
        materials: [],
        completion: COMPLETION,
        domain: 'code',
        ...over,
      });
      await h.settle();
      return runStore.queries.getRun(run.id) as Run;
    },
    bet0: (runId) => {
      const bet = runStore.queries.listBets(runId).find((b) => !b.continuation);
      const branch = runStore.queries.listBranches(runId).find((b) => b.betId === bet?.id);
      if (!branch) throw new Error('没有主干路线');
      return branch;
    },
    branchOf: (runId, label) => {
      const bet = runStore.queries.listBets(runId).find((b: Bet) => b.label === label);
      const branch = bet && runStore.queries.listBranches(runId).find((b) => b.betId === bet.id);
      if (!branch) throw new Error(`任务 ${runId} 里没有「${label}」这条分支`);
      return runStore.queries.getBranch(branch.id) as Branch;
    },
    events: (type) => (type ? published.filter((e) => e.type === type) : [...published]),
    close: async () => {
      await rt.stop();
      runStore.close();
      if (!opts.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** 记一次工具调用（Observation），原文先放进 Artifact store：RunStore 配了 Artifact store 时会查句柄 */
export function observeStored(
  runStore: RunStore,
  branch: Branch | Id,
  summary = '跑了一下',
  counts = true,
): Observation {
  const id = typeof branch === 'string' ? branch : branch.id;
  const b = runStore.queries.getBranch(id) as Branch;
  return runStore.writer.appendObservation(
    {
      runId: b.runId,
      branchId: b.id,
      episode: b.episode,
      role: 'explorer',
      tool: 'sh',
      args: { cmd: 'pnpm test' },
      summary,
      output: putText(runStore, b.runId, summary),
      snapshot: b.lastSnapshot,
      exitCode: 0,
    },
    { countsAsToolCall: counts },
  );
}

/** 写一个文件到某条分支的 workspace 里（交付物测试用） */
export async function writeInWorkspace(branch: Branch, rel: string, content: string): Promise<string> {
  const ws = branch.workspace?.path;
  if (!ws) throw new Error('分支还没有 workspace');
  const path = join(ws, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}
