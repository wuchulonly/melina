// 分支的主循环：agents/explorer.ts 只跑一个 episode，循环在这里。
//
//   while 分支在跑:
//     排队拿名额（任务暂停时不放行）→ 第一次跑就从 Bet.startFrom 建 workspace（starting → running）→ 起容器
//     → 拼上下文、开 ToolSession、跑一个 episode（kill、取消时中止，整个丢掉；收尾工具已经被接受的照常收尾）

//     → 清理用不着的 snapshot 内容 → 还名额
//

// 更新 lastSnapshot、记一次失败，往收件箱放提示。系统出错（建 workspace、起容器、打 snapshot 失败）按 5 秒、30 秒、2 分钟重试，
// 还不行分支转 failed，原因写进 stateNote。

import { conflict, isMelinaError, MelinaError, notFound } from '../core/errors.ts';
import { type Id, ROOT, type SnapshotId } from '../core/ids.ts';
import type { EpisodeOutcome, ExplorerAgent } from '../core/interfaces/agents.ts';
import type { ContextAssembler } from '../core/interfaces/context.ts';
import type { CallerContext, ToolGateway, ToolSession, ToolSessionOptions } from '../core/interfaces/gateway.ts';
import type { Slot } from '../core/interfaces/scheduler.ts';
import type { DeliverVersionResult, EventBus, RunStoreQueries, RunStoreWriter } from '../core/interfaces/store.ts';
import type { WorkspaceProvider, WorkspaceProviders } from '../core/interfaces/workspace.ts';
import { type Bet, type Branch, ENDED_RUN_STATUSES, type Run, type WorkspaceRef } from '../core/types.ts';
import { anySignal, type Clock, errorText, sleep, untilAborted } from './async.ts';
import type { BranchEnv } from './branch-env.ts';
import { isTerminal, type RuntimeBranchManager, VERSION_LABEL, type VersionDraft } from './branch-manager.ts';
import type { MelinaScheduler } from './scheduler.ts';
import { scopedNotice, setupFailedNotice } from './templates.ts';

/** 每个 Run 一个取消信号：取消、放弃、收尾、出错时一起中止这个 Run 的在途作业 */
export class RunScopes {
  private readonly scopes = new Map<Id, AbortController>();

  signal(runId: Id): AbortSignal {
    let c = this.scopes.get(runId);
    if (!c) {
      c = new AbortController();
      this.scopes.set(runId, c);
    }
    return c.signal;
  }

  abort(runId: Id, reason: string): void {
    let c = this.scopes.get(runId);
    if (!c) {
      c = new AbortController();
      this.scopes.set(runId, c);
    }
    if (!c.signal.aborted) c.abort(new MelinaError('conflict', reason));
  }

  /** Run 删掉了：不再留着它的信号 */
  forget(runId: Id): void {
    this.scopes.delete(runId);
  }

  /** 进程退出：所有 Run 的在途作业（准备中的 Scoper、预备发散）一起中止，下次启动由恢复流程重来 */
  abortAll(reason: string): void {
    for (const c of this.scopes.values()) if (!c.signal.aborted) c.abort(new MelinaError('unavailable', reason));
  }
}

export interface BranchRunnerDeps {
  bus: EventBus;
  queries: RunStoreQueries;
  writer: Pick<RunStoreWriter, 'appendInbox'>;
  branches: RuntimeBranchManager;
  scheduler: MelinaScheduler;
  workspaces: WorkspaceProviders;
  env: BranchEnv;
  /** watchMap 不给就没有巡检器的地图（没接巡检器的测试） */
  assembler: Pick<ContextAssembler, 'forExplorer'> & Partial<Pick<ContextAssembler, 'watchMap'>>;
  gateway: ToolGateway;
  explorer: ExplorerAgent;
  scopes: RunScopes;
  clock: Clock;
  /** 开 ToolSession 时的选项（收尾工具的语义检查）；Explorer 要的话由进程入口接上 */
  sessionOptions?: (run: Run, branch: Branch, bet: Bet) => ToolSessionOptions | undefined;
  /** 系统出错后的重试间隔；用完还不行分支转 failed */
  retryDelaysMs?: readonly number[];
  log?: (text: string) => void;
}

const DEFAULT_RETRY_DELAYS = [5_000, 30_000, 120_000];

/** 网关的 deliver 交过来的 */
export interface DeliverRequest {
  runId: Id;
  branchId: Id;
  version: VersionDraft;
}

interface Loop {
  done: Promise<void>;
  /** 正在排队等名额、或者正在建 workspace（跑 setup）：分支暂停、结束时取消这次等待 */
  wait: AbortController | undefined;
  /** 循环还没退出时又有人要它跑（比如收尾后清理 snapshot 的时候分支被恢复了）：退出后再看一遍要不要接着跑 */
  again: boolean;
}

/** 一次 episode 走到哪了：继续下一个、退出循环 */
type Step = 'next' | 'exit';

export class BranchRunners {
  private readonly deps: BranchRunnerDeps;
  private readonly loops = new Map<Id, Loop>();
  private readonly sessions = new Map<Id, ToolSession>();
  private readonly continuationSnapshots = new Set<SnapshotId>();
  private readonly root = new AbortController();
  private started = false;
  private unsubscribe: (() => void) | undefined;

  constructor(deps: BranchRunnerDeps) {
    this.deps = deps;
  }

  /** 先订阅状态变化再扫描已有分支，恢复前提交的分支也不会漏掉。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.deps.bus.subscribe(
      (event) => {
        if (event.type !== 'branch.created' && event.type !== 'branch.updated') return;
        const branch = event.data;
        if (branch.state === 'starting' || branch.state === 'running') this.ensure(branch.id);
        else this.inactive(branch);
      },
      { types: ['branch.created', 'branch.updated'] },
    );
    for (const run of this.deps.queries.listRuns({ status: ['running', 'paused'] })) {
      for (const b of this.deps.queries.listBranches(run.id, { states: ['starting', 'running'] })) this.ensure(b.id);
    }
  }

  /** 退出：在途的 episode 都中止、丢掉，下次启动由恢复流程从 lastSnapshot 重来 */
  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (!this.root.signal.aborted) this.root.abort(new MelinaError('unavailable', 'Melina 正在退出'));
    await Promise.allSettled([...this.loops.values()].map((l) => l.done));
  }

  private inactive(branch: Branch): void {
    const loop = this.loops.get(branch.id);
    if (loop?.wait && !loop.wait.signal.aborted) loop.wait.abort(new MelinaError('conflict', '分支不再跑了'));
  }

  /**
   * 存个阶段版（deliver）：给正在跑 episode 的分支打 snapshot，交给 BranchManager 写成一版；episode 接着跑、Run 不结束。
   * 网关的 deliver 接这里。分支不在跑、episode 号对不上、Run 在收尾或已结束时说清楚、不打 snapshot；
   * 打 snapshot 出错不重试（模型可以再交一次），RunStore 拒收时那个 snapshot 没人引用，下次清理时清掉
   */
  async deliver(req: DeliverRequest): Promise<DeliverVersionResult> {
    const { queries: q, branches } = this.deps;
    const b = q.getBranch(req.branchId);
    if (!b || b.runId !== req.runId) throw notFound(`分支 ${req.branchId} 不在任务 ${req.runId} 里`);
    const run = q.getRun(b.runId);
    if (!run) throw notFound(`任务 ${b.runId} 不存在`);
    if ((ENDED_RUN_STATUSES as readonly string[]).includes(run.status)) throw conflict('任务已经结束，这一版不收');
    if (run.mode === 'settling') throw conflict('任务正在收尾，已经有路线交了候选，这一版不收');
    if (b.state !== 'running' || b.episode !== req.version.episode) {
      throw conflict('这条路线的这个 episode 已经停下了，这一版不收');
    }
    if (!b.workspace) throw conflict('这条路线还没有 workspace，没法交');
    const snapshot = await this.deps.workspaces.forRun(run).snapshot(b.workspace, VERSION_LABEL);
    return branches.deliverVersion(b.id, req.version, snapshot);
  }

  /** 工具执行间隙存档；新命令等待存档完成，原会话继续运行。 */
  async checkpoint(branchId: Id, handoff: string, signal: AbortSignal): Promise<Branch> {
    const { queries: q, branches } = this.deps;
    const session = this.sessions.get(branchId);
    if (!session?.checkpoint) throw conflict('分支当前没有可存档的会话');
    let saved: Branch | undefined;
    const accepted = await untilAborted(
      session.checkpoint(async () => {
        signal.throwIfAborted();
        const branch = q.getBranch(branchId);
        const run = branch && q.getRun(branch.runId);
        if (
          !branch?.workspace ||
          !run ||
          run.status !== 'running' ||
          run.mode === 'settling' ||
          branch.state !== 'running' ||
          branch.episode !== session.caller.episode
        )
          throw conflict('分支已停止或换代，这次存档作废');
        const snapshot = await this.deps.workspaces.forRun(run).snapshot(branch.workspace, 'handoff');
        signal.throwIfAborted();
        saved = await branches.checkpoint(branchId, { id: snapshot }, { episode: branch.episode, handoff });
        signal.throwIfAborted();
        this.preserveCheckpoint(saved.lastSnapshot);
      }),
      signal,
    );
    if (!accepted || !saved) throw conflict('分支已收尾，这次存档作废');
    return saved;
  }

  preserveCheckpoint(snapshot: SnapshotId): void {
    this.continuationSnapshots.add(snapshot);
  }

  releaseCheckpoint(snapshot: SnapshotId): void {
    this.continuationSnapshots.delete(snapshot);
  }

  handoffMaterial(branchId: Id): string | undefined {
    return this.deps.branches.episode(branchId)?.handle.handoffMaterial?.();
  }

  /** 这条分支的主循环在不在跑；不在就起一个 */
  ensure(branchId: Id): void {
    if (!this.started) return;
    const existing = this.loops.get(branchId);
    if (existing) {
      existing.again = true;
      return;
    }
    const loop: Loop = { done: Promise.resolve(), wait: undefined, again: false };
    this.loops.set(branchId, loop);
    loop.done = this.runLoop(branchId, loop)
      .catch((error) => this.deps.log?.(`分支 ${branchId} 的主循环出错退出：${errorText(error)}`))
      .finally(() => {
        if (this.loops.get(branchId) === loop) this.loops.delete(branchId);
        if (loop.again) this.ensure(branchId);
      });
  }

  /** 正在跑主循环的分支数（测试和状态显示用） */
  get size(): number {
    return this.loops.size;
  }

  /** 等某条分支的主循环退出（测试用） */
  async idle(branchId: Id): Promise<void> {
    await this.loops.get(branchId)?.done;
  }

  // ── 主循环 ──────────────────────────────────────────────────────────────

  private async runLoop(branchId: Id, loop: Loop): Promise<void> {
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    let errors = 0;
    for (;;) {
      loop.again = false;
      if (!this.runnable(branchId)) return;
      let step: Step;
      try {
        step = await this.turn(branchId, loop);
        errors = 0;
      } catch (error) {
        if (this.root.signal.aborted) return;
        errors++;
        const b = this.deps.queries.getBranch(branchId);
        if (!b || isTerminal(b.state)) return;
        this.deps.log?.(`分支 ${branchId} 出错（第 ${errors} 次）：${errorText(error)}`);
        const delay = delays[errors - 1];
        if (delay === undefined) {
          await this.deps.branches
            .apply({ kind: 'fail', branchId, reason: `系统出错，重试 ${errors - 1} 次仍不行：${errorText(error)}` })
            .catch((e) => this.deps.log?.(`分支 ${branchId} 转 failed 失败：${errorText(e)}`));
          return;
        }
        try {
          await sleep(this.deps.clock, delay, anySignal([this.root.signal, this.deps.scopes.signal(b.runId)]));
        } catch {
          return;
        }
        continue;
      }
      if (step === 'exit') return;
    }
  }

  /** 分支还在跑、任务没结束也没在收尾（也没在被取消）、进程没在退出 */
  private runnable(branchId: Id): boolean {
    if (this.root.signal.aborted) return false;
    const b = this.deps.queries.getBranch(branchId);
    if (!b || (b.state !== 'running' && b.state !== 'starting')) return false;
    if (this.deps.scopes.signal(b.runId).aborted) return false;
    const run = this.deps.queries.getRun(b.runId);
    if (!run || isEnded(run) || run.mode === 'settling') return false;
    return true;
  }

  private async turn(branchId: Id, loop: Loop): Promise<Step> {
    const { queries: q, scheduler, branches } = this.deps;
    const first = q.getBranch(branchId) as Branch;
    const bet = q.getBet(first.betId);
    if (!bet) throw new MelinaError('not_found', `Bet ${first.betId} 不存在`);
    const scope = this.deps.scopes.signal(first.runId);

    // 1. 排队拿名额：没马上拿到就标成排队；分支暂停、结束、任务取消、进程退出时不再等
    const wait = new AbortController();
    loop.wait = wait;
    let queued = false;
    let slot: Slot;
    try {
      slot = await scheduler.episodeSlot(
        first,
        bet.model.provider,
        anySignal([wait.signal, scope, this.root.signal]),
        () => {
          queued = true;
          void branches
            .apply({ kind: 'queued', branchId, queued: true })
            .catch((e) => this.deps.log?.(`标记排队失败：${errorText(e)}`));
        },
      );
    } catch (error) {
      if (wait.signal.aborted || scope.aborted || this.root.signal.aborted) return 'next'; // 回到循环开头重新看状态
      throw error;
    } finally {
      loop.wait = undefined;
    }

    try {
      return await this.episode(branchId, bet, queued, scope, loop);
    } finally {
      slot.release();
    }
  }

  private async episode(branchId: Id, bet: Bet, queued: boolean, scope: AbortSignal, loop: Loop): Promise<Step> {
    const { queries: q, branches, env } = this.deps;
    if (!this.runnable(branchId)) return 'next';
    let b = q.getBranch(branchId) as Branch;
    let run = q.getRun(b.runId) as Run;
    const provider = this.deps.workspaces.forRun(run);

    // 2. 第一次跑：从 Bet.startFrom 的 snapshot 建 workspace（排队时不建）
    if (!b.workspace) {
      const started = await this.startWorkspace(provider, b, scope, loop);
      if (!started) return 'next';
      b = started;
    } else if (queued || b.queued) {
      b = await branches.apply({ kind: 'queued', branchId, queued: false });
    }
    // 求解分支独立开跑，Scoper 可能在建 workspace 时完成起草：起容器按这一刻的领域。
    run = q.getRun(b.runId) as Run;
    const container = await env.ensure(run, b, bet);

    // 3. 跑一个 episode。从这里到 attach 都是同步的：中间插不进别的命令（暂停、kill 看得到它）
    if (!this.runnable(branchId)) return 'next';
    b = q.getBranch(branchId) as Branch;
    run = q.getRun(b.runId) as Run;
    if (b.state !== 'running' || !b.workspace) return 'next';
    // 拿到名额以后任务刚好暂停了：不开新 episode，还掉名额回去排队（暂停时只给在跑的 episode 追加了收尾提示）
    if (run.status === 'paused') {
      await env.stop(b);
      return 'next';
    }

    // 提示也给了已经结束的它。现在没有在跑的 episode，暂停这就生效，不再开新的。
    // 以前会照开一个 episode，它收不到提示，要整整多跑一个 episode 才停
    if (b.pendingPause !== undefined) {
      await branches.apply({ kind: 'pause', branchId, reason: b.pendingPause });
      return 'next';
    }
    const kill = new AbortController();
    const signal = AbortSignal.any([kill.signal, scope, this.root.signal]);
    const layout = this.deps.assembler.forExplorer(b);
    const caller: CallerContext = {
      runId: run.id,
      role: 'explorer',
      branchId: b.id,
      episode: b.episode,
      snapshot: b.lastSnapshot,
      ...(container ? { container } : {}),
      workspace: b.workspace,
      readOnly: false,
    };
    const session = this.deps.gateway.open(caller, this.deps.sessionOptions?.(run, b, bet));
    this.sessions.set(branchId, session);
    const startSeq = q.lastSeq();
    const { assembler } = this.deps;
    // 任务内容变化时才重组提示，避免每次请求重复读取收件箱。
    let systemRun = JSON.stringify(run);
    let currentSystem = layout.system;
    const systemPrompt = () => {
      const latest = q.getRun(run.id);
      const version = JSON.stringify(latest);
      if (latest && version !== systemRun) {
        currentSystem = assembler.forExplorer(q.getBranch(branchId) ?? b).system;
        systemRun = version;
      }
      return currentSystem;
    };
    // 巡检器地图每次请求现读最新的一版，作为独立参考材料提供。
    const referenceContext = assembler.watchMap ? () => assembler.watchMap?.(branchId) : undefined;
    const handle = this.deps.explorer.startEpisode({
      run,
      branch: b,
      bet,
      layout,
      session,
      signal,
      systemPrompt,
      ...(referenceContext ? { referenceContext } : {}),
    });
    branches.attachEpisode(branchId, handle, kill, {
      runId: run.id,
      startSeq,
      seenSeq: layout.seenSeq ?? b.seenSeq,
    });
    let outcome: EpisodeOutcome;
    try {
      outcome = await handle.done;
    } catch (error) {
      this.sessions.delete(branchId);
      branches.forget(branchId);
      if (signal.aborted) return 'next';
      throw error;
    }
    if (signal.aborted && (!outcome.close || this.root.signal.aborted)) {
      this.sessions.delete(branchId);
      // kill、任务取消、收尾、进程退出：在途的 episode 整个丢掉，不收尾。
      // 收尾工具已经被接受的（交回了 close，比如提交了候选）是中止后到的：照常落库，kill、取消等它落完再执行（BranchManager）；
      // Melina 正在退出时一律丢掉，下次启动从 lastSnapshot 重来
      branches.forget(branchId);
      return 'next';
    }

    //    随收尾一起生效，不会让分支先转 paused、把这次收尾挤成迟到写入
    let closed: Branch | undefined;
    try {
      closed = await this.close(b, outcome, provider, b.workspace, signal);
    } finally {
      this.sessions.delete(branchId);
      branches.detach(branchId);
    }
    if (!closed) return 'next';

    // 5. 运行中每个分支只留 lastSnapshot 的内容
    await this.prune(run.id, closed, provider);
    return isTerminal(closed.state) || closed.state === 'paused' ? 'exit' : 'next';
  }

  /**
   * 打 snapshot 并收尾。打 snapshot 出错按重试间隔再试（kill、取消、退出时不再试，这个 episode 丢掉）；
   * 都不行分支直接转 failed：没有恢复点就收不了尾，再开 episode 只会白花 token、让没记下的改动越堆越多。
   */
  private async close(
    b: Branch,
    outcome: EpisodeOutcome,
    provider: WorkspaceProvider,
    ws: WorkspaceRef,
    signal: AbortSignal,
  ): Promise<Branch | undefined> {
    const { branches } = this.deps;
    let snapshot: SnapshotId | undefined;
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    for (let attempt = 0; ; attempt++) {
      try {
        snapshot = await provider.snapshot(ws);
        break;
      } catch (error) {
        const delay = delays[attempt];
        if (signal.aborted) {
          branches.forget(b.id);
          return undefined;
        }
        if (delay === undefined) {
          branches.forget(b.id);
          this.deps.log?.(`分支 ${b.id} 打 snapshot 一直失败：${errorText(error)}`);
          await branches
            .apply({
              kind: 'fail',
              branchId: b.id,
              reason: `episode 收尾时打 snapshot 一直失败：${errorText(error)}`,
            })
            .catch((e) => this.deps.log?.(`分支 ${b.id} 转 failed 失败：${errorText(e)}`));
          return undefined;
        }
        this.deps.log?.(`分支 ${b.id} 打 snapshot 出错，${delay} 毫秒后再试：${errorText(error)}`);
        try {
          await sleep(this.deps.clock, delay, signal);
        } catch {
          branches.forget(b.id);
          return undefined;
        }
      }
    }
    try {
      return await branches.closeEpisode(b, outcome, snapshot);
    } catch (error) {
      if (isMelinaError(error) && error.code === 'invalid') {
        // 收尾内容过不了 RunStore 的校验：不丢 workspace 里的改动，按没有合法收尾记一次失败
        this.deps.log?.(`分支 ${b.id} 的收尾被拒：${error.message}`);
        try {
          return await branches.closeAsFailed(b, outcome, snapshot, `收尾内容不合规：${error.message}`);
        } catch (again) {
          branches.forget(b.id);
          if (isMelinaError(again) && again.code === 'conflict') return undefined;
          throw again;
        }
      }
      branches.forget(b.id);
      // conflict：分支已经不在跑（被 kill、任务收尾），或已经有别的分支先提交了候选
      if (isMelinaError(error) && (error.code === 'conflict' || error.code === 'not_found')) return undefined;
      throw error;
    }
  }

  /**
   * 只留要用的 snapshot 内容：所有分支的 lastSnapshot（fork 出来、还没收过尾的分支，
   * lastSnapshot 就是源分支打的那个；开分支、算没做完的 patch、崩溃恢复都要用），加上交付的候选。
   * prune 只清这个 workspace 打的，别的分支的不动；出错只记日志。
   */
  private async prune(runId: Id, branch: Branch, provider: WorkspaceProvider): Promise<void> {
    const ws = branch.workspace;
    if (!ws || branch.lastSnapshot === ROOT) return;
    const q = this.deps.queries;
    const keep = new Set<SnapshotId>([branch.lastSnapshot]);
    for (const snapshot of this.continuationSnapshots) keep.add(snapshot);
    const branches = q.listBranches(runId);
    for (const other of branches) keep.add(other.lastSnapshot);
    for (const c of q.candidates(runId)) keep.add(c.snapshot);

    const opened = new Set(branches.map((other) => other.betId));
    for (const bet of q.listBets(runId)) {
      if (bet.status === 'active' && !opened.has(bet.id)) keep.add(bet.startFrom.snapshot);
    }
    try {
      await provider.prune(ws, [...keep]);
    } catch (error) {
      this.deps.log?.(`分支 ${branch.id} 清理旧 snapshot 出错：${errorText(error)}`);
    }
  }

  /**
   * 第一次跑：从 Bet.startFrom 的 snapshot 建 workspace，建完执行 workspace.setup（可能好几分钟）。建的时候分支被叫停、暂停，
   * 或者任务取消、Melina 退出，setup 跟着停下；建好时分支已经不跑了，这个 workspace 删掉，不留没人用的。返回 running 的分支
   */
  private async startWorkspace(
    provider: WorkspaceProvider,
    b: Branch,
    scope: AbortSignal,
    loop: Loop,
  ): Promise<Branch | undefined> {
    const stop = new AbortController();
    loop.wait = stop;
    let ws: WorkspaceRef;
    try {
      ws = await provider.create(b.lastSnapshot, { signal: anySignal([stop.signal, scope, this.root.signal]) });
    } finally {
      loop.wait = undefined;
    }
    const drop = () =>
      provider.dispose(ws).catch((error) => this.deps.log?.(`删掉没用上的 workspace 出错：${errorText(error)}`));
    if (stop.signal.aborted || !this.runnable(b.id)) {
      await drop();
      return undefined;
    }
    let started: Branch;
    try {
      started = await this.deps.branches.apply({ kind: 'started', branchId: b.id, workspace: ws });
    } catch (error) {
      await drop();
      if (isMelinaError(error) && error.code === 'conflict') return undefined; // 刚好被叫停、暂停了
      throw error;
    }
    this.noticeSetup(started, ws);
    this.noticeLateSetup(started, ws);
    return started;
  }

  /**
   * Scoper 在创建 workspace 期间定下 setup，准备命令尚未执行时，通知 Explorer 补跑。
   * Scoper 起草完时这条分支已经有 workspace 的，RunManager 补给它的那条已经说了，不重复
   */
  private noticeLateSetup(branch: Branch, ws: WorkspaceRef): void {
    if (ws.setup) return;
    const { queries: q, writer } = this.deps;
    const setup = q.getRun(branch.runId)?.workspace.setup?.trim();
    if (!setup) return;
    if (q.inbox(branch.id, 0).some((i) => i.kind === 'notice' && i.text.includes(setup))) return;
    const text = scopedNotice({ constraints: [], setup });
    if (!text) return;
    try {
      writer.appendInbox({ runId: branch.runId, branchId: branch.id, kind: 'notice', text });
    } catch (error) {
      this.deps.log?.(`写 setup 的提示出错：${errorText(error)}`);
    }
  }

  /** setup 失败不让分支失败：输出放进收件箱，Explorer 自己修；被取消、没跑的不提示 */
  private noticeSetup(branch: Branch, ws: WorkspaceRef): void {
    const setup = ws.setup;
    if (setup?.ok !== false || setup.skipped) return;
    try {
      this.deps.writer.appendInbox({
        runId: branch.runId,
        branchId: branch.id,
        kind: 'notice',
        text: setupFailedNotice(setup),
      });
    } catch (error) {
      this.deps.log?.(`写 setup 失败的提示出错：${errorText(error)}`);
    }
  }
}

function isEnded(run: Run): boolean {
  return (ENDED_RUN_STATUSES as readonly string[]).includes(run.status);
}
