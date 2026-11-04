// 巡检器：求解分支运行期间，runtime 按时间周期唤醒巡检器，
// observation_submit 合并并写上 RunStore（watch.noted），这里只接收已发布版本。主干直解路线每次发请求前现读最新的一版、
// 编成短地图作为独立参考材料提供（context/layouts/explorer.ts 的 watchMap）。这里只管什么时候看、看完记下来，看出什么全归巡检器。
// 巡检器在后台运行，主干直解路线不等它。
//
// 非零退出码、验收回执和提交候选留到常规周期处理，只有真正的新提示可提前唤醒。
// 这条路线开跑 WATCH_FIRST_MS（1 分钟）后看第一轮，之后每轮
// 完成以后 WATCH_EVERY_MS（5 分钟）看下一轮；只有尚未展示的积压缩短间隔，仍至少冷却 WATCH_CATCH_UP_MS。

// watch.enabled 控制开关；按时间唤醒，观测、提示到达或路线恢复时也检查。
// 对应分支的主模型请求在途时延迟启动。软截止只提醒优先提交，硬截止才取消。预算耗尽缩窗并短冷却；
// 供应商、上下文、存储等失败按正常间隔指数退避（最多 WATCH_BACKOFF_MAX 个），成功清零。积压按连续窗口限速追赶。
// 任务暂停时不开新的一轮、在跑的那轮停下（暂停不花钱），恢复、重启、路线重新跑起来时重新判；这条路线结束了（交了、失败了），
// 在跑的那轮也停下，没人读了。收尾、结束、取消、立即暂停时 RunScopes 的信号停下在跑的一轮。这几种停下都不算没做成。
// 在跑的一轮只在内存里，重启后从 RunStore 上最新的一版接着看。

// 开了几份的每份各看各的：进度、在跑的一轮都按分支记。

import { isMelinaError, MelinaError } from '../core/errors.ts';
import type { MelinaEvent } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { WatcherAgent } from '../core/interfaces/agents.ts';
import type { WatchRequest } from '../core/interfaces/context.ts';
import type { EventBus, RunStoreQueries } from '../core/interfaces/store.ts';
import { modelKey } from '../core/model-ref.ts';
import {
  type Bet,
  type Branch,
  ENDED_RUN_STATUSES,
  type Run,
  TERMINAL_BRANCH_STATES,
  type WatchNote,
} from '../core/types.ts';
import {
  WATCH_HARD_MS,
  WATCH_SOFT_MS,
  WATCH_WINDOW_BYTES,
  WATCH_WINDOW_STEPS,
  WatchFailure,
  type WatchFailureReason,
} from '../core/watch-budget.ts';
import { WATCH_INPUT } from '../core/watch-input.ts';
import { bet0WatchEnabled } from '../projections/bet0.ts';
import { latestWatch } from '../projections/watch.ts';
import { watchTaskComplete } from '../projections/watch-state.ts';
import { freezeWatchWindow, watchBacklog, watchLag } from '../projections/watch-window.ts';
import { type Clock, errorText } from './async.ts';
import type { RunScopes } from './branch-runner.ts';

/** 一轮最多多久（看记录、查几次、交）：到点停下，按没做成算 */
export const WATCH_TIME_MS = WATCH_HARD_MS;
export const WATCH_RETRY_MS = 30_000;
export const WATCH_YIELD_MS = 1000;

/** 接连没做成时，要等的间隔数最多翻到几个 */
export const WATCH_BACKOFF_MAX = 8;

/** 完成以后正常隔多久看下一轮 */
export const WATCH_EVERY_MS = 5 * 60_000;

/** 开局一分钟介入，尽早提供方向；新提示仍可立即唤醒。 */
export const WATCH_FIRST_MS = 60_000;

/** 有积压也要合并一段新增材料，避免观察在途的一两步触发连续模型调用。 */
export const WATCH_CATCH_UP_MS = 90_000;

export interface WatchDeskDeps {
  queries: RunStoreQueries;
  inputs?: {
    collect(run: Run, branchId: Id, signal: AbortSignal): Promise<void>;
    read(run: Run, request: WatchRequest, signal: AbortSignal): Promise<WatchRequest>;
  };
  bus: EventBus;
  /** 不给就不看（测试、没接巡检器的进程） */
  watcher?: WatcherAgent;
  /** 对应分支的 Explorer 正在请求模型时，让出启动机会。 */
  mainLlmInFlight?: (branchId: Id) => boolean;
  scopes: RunScopes;
  clock: Clock;
  /** 一轮的用时上限，默认 WATCH_TIME_MS；测试里调短 */
  timeMs?: number;
  softMs?: number;
  /** 第一轮、之后每轮隔多久，默认 WATCH_FIRST_MS、WATCH_EVERY_MS；测试里调短 */
  pace?: { firstMs: number; everyMs: number };
  log?: (text: string) => void;
}

interface Round {
  runId: Id;
  stop: AbortController;
}

/**
 * 每条路线记在内存里的：上一版看到第几次工具调用为止（从 RunStore 读一次，之后写一版记一次），第一次看到它跑着的时刻、常规周期的起点，
 * 没做成的那一刻、接连没做成几轮（时刻都是 clock.now 的毫秒）
 */
interface Pace {
  seen?: number;
  /** 已发布版本实际覆盖的截止点：后面的观测、意外和提示仍需处理，重启时从 RunStore 恢复。 */
  seenSeq: number;
  stateSeq: number;
  /** 上次启动观察时收到的最新提示：同一份材料失败后遵守退避。 */
  attemptedHintSeq: number;
  since: number;
  cadenceAt?: number;
  failedAt?: number;
  failures: number;
  failureReason?: WatchFailureReason;
  window?: WatchRequest['window'];
  catchingUp?: boolean;
}

/** 停下了，但不算没做成：恢复、重启以后照常判 */
class Halt extends MelinaError {
  constructor(why: string) {
    super('conflict', why);
  }
}

export class WatchDesk {
  readonly #deps: WatchDeskDeps;
  /** 正在看的：分支 → 这一轮 */
  readonly #rounds = new Map<Id, Round>();
  readonly #pace = new Map<Id, Pace>();
  /** 还没到点的分支：分支 → 到点时再判一次的计时器 */
  readonly #due = new Map<Id, unknown>();
  readonly #pending = new Set<string>();
  readonly #inflight = new Set<Promise<void>>();
  #timer: unknown;
  #unsubscribe: (() => void) | undefined;
  #stopped = false;

  constructor(deps: WatchDeskDeps) {
    this.#deps = deps;
  }

  /** 开始听 RunStore 的事件；进程启动、恢复跑完以后在跑的任务各判一次 */
  start(): void {
    if (this.#unsubscribe || !this.#deps.watcher) return;
    this.#stopped = false;
    this.#unsubscribe = this.#deps.bus.subscribe((e) => this.#onEvent(e));
    for (const run of this.#deps.queries.listRuns({ status: ['running'] })) this.kick(run.id);
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#deps.clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const t of this.#due.values()) this.#deps.clock.clearTimeout(t);
    this.#due.clear();
    this.#pending.clear();
    for (const round of this.#rounds.values()) round.stop.abort(new Halt('Melina 正在退出'));
  }

  /** 判一下这个任务的主干直解路线（开了几份的每份）要不要看一轮（恢复、重启以后） */
  kick(runId: Id): void {
    for (const branch of this.#deps.queries.listBranches(runId)) this.#schedule(runId, branch.id);
  }

  /** 等在跑的几轮都结束（测试用） */
  async settle(): Promise<void> {
    while (this.#inflight.size > 0 || this.#timer !== undefined) {
      if (this.#timer !== undefined) {
        this.#deps.clock.clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#flush();
      }
      await Promise.allSettled([...this.#inflight]);
    }
  }

  /** 正在看的分支（测试和状态显示用） */
  get watching(): Id[] {
    return [...this.#rounds.keys()];
  }

  // ── 什么时候看 ────────────────────────────────────────────────────────────

  #onEvent(e: MelinaEvent): void {
    if (!e.runId) return;
    switch (e.type) {
      case 'observation.created':
        if (
          e.data.branchId &&
          (e.data.role === 'explorer' ||
            (e.data.role === 'watcher' &&
              [WATCH_INPUT.platform, WATCH_INPUT.receipt, WATCH_INPUT.extension].some((tool) => tool === e.data.tool)))
        )
          this.#schedule(e.runId, e.data.branchId);
        return;
      case 'inbox.created':
        if (e.data.ref && this.#deps.queries.getRecord(e.data.ref)?.kind === 'input')
          this.#schedule(e.runId, e.data.branchId);
        return;
      case 'branch.updated':
        // 这条路线结束了：在跑的那轮没人读了。（重新）跑起来了：恢复、重启以后它要是早就做满了一段，不用等它下一次工具调用
        if ((TERMINAL_BRANCH_STATES as readonly string[]).includes(e.data.state)) {
          this.#rounds.get(e.data.id)?.stop.abort(new Halt('这条路线已经结束了'));
        } else if (e.data.state === 'running') {
          this.#schedule(e.runId, e.data.id);
        }
        return;
      case 'run.updated':
        if (isEnded(e.data)) this.#forget(e.runId);
        else if (e.data.status === 'paused') this.#stopRun(e.runId, '任务暂停了');
        else if (e.data.mode === 'settling') this.#stopRun(e.runId, '任务在收尾');
        else this.kick(e.runId);
        return;
      default:
        return;
    }
  }

  /** 事件是在路线的工具调用里同步发出来的：先记下，下一拍再判，不拖它 */
  #schedule(runId: Id, branchId: Id): void {
    if (this.#stopped) return;
    this.#pending.add(`${runId} ${branchId}`);
    if (this.#timer !== undefined) return;
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, 0);
  }

  #flush(): void {
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const key of pending) {
      const [runId, branchId] = key.split(' ') as [Id, Id];
      try {
        this.#maybe(runId, branchId);
      } catch (error) {
        this.#deps.log?.(`任务 ${runId} 判巡检器要不要看一轮时出错：${errorText(error)}`);
      }
    }
  }

  #maybe(runId: Id, branchId: Id): void {
    const { queries: q, watcher } = this.#deps;
    if (this.#stopped || !watcher) return;
    const run = q.getRun(runId);
    if (run?.status !== 'running' || run.mode === 'settling') return;
    const branch = q.getBranch(branchId);
    if (!branch || branch.runId !== runId || branch.state !== 'running') return;
    const bet = q.getBet(branch.betId);
    if (bet?.kind !== 'direct') return;
    if (!bet0WatchEnabled(q, run, bet.id)) return;
    if (this.#deps.scopes.signal(runId).aborted) return;
    if (watchTaskComplete(q, runId, branchId)) {
      this.#rounds.get(branchId)?.stop.abort(new Halt('平台已确认全部目标完成'));
      this.#deps.clock.clearTimeout(this.#due.get(branchId));
      this.#due.delete(branchId);
      return;
    }
    if (this.#rounds.has(branchId)) return;
    const pace = this.#paceOf(run, branch);
    const { unread, hintSeq } = watchBacklog(q, branch, pace.seenSeq, pace.seen ?? 0, pace.stateSeq);
    const hinted = hintSeq > 0;
    const freshHint = hintSeq > pace.attemptedHintSeq;
    if (!hinted && !unread) {
      pace.catchingUp = false;
      pace.window = undefined;
      this.#deps.clock.clearTimeout(this.#due.get(branchId));
      this.#due.delete(branchId);
      return;
    }
    const { firstMs, everyMs } = this.#paceMs();
    const due =
      pace.failedAt !== undefined || freshHint
        ? 0
        : pace.cadenceAt === undefined
          ? pace.since + firstMs
          : pace.cadenceAt + (pace.catchingUp ? Math.min(WATCH_CATCH_UP_MS, everyMs) : everyMs);
    const retry =
      pace.failedAt === undefined || (freshHint && !shrinksWindow(pace.failureReason))
        ? 0
        : pace.failedAt + retryDelay(pace, everyMs);
    const at = Math.max(due, retry);
    const now = this.#deps.clock.now();
    if (now < at) {
      this.#wakeAt(runId, branchId, at - now);
      return;
    }
    if (this.#deps.mainLlmInFlight?.(branchId)) {
      this.#wakeAt(runId, branchId, WATCH_YIELD_MS);
      return;
    }
    this.#deps.clock.clearTimeout(this.#due.get(branchId));
    this.#due.delete(branchId);
    this.#launch(run, branch, bet);
  }

  /** 还没到点：到点时再判一次（同一条路线只留一个计时器） */
  #wakeAt(runId: Id, branchId: Id, ms: number): void {
    const { clock } = this.#deps;
    clock.clearTimeout(this.#due.get(branchId));
    this.#due.set(
      branchId,
      clock.setTimeout(() => {
        this.#due.delete(branchId);
        this.#schedule(runId, branchId);
      }, ms),
    );
  }

  /**
   * 这条路线的进度；第一次用到时（它开跑时 branch.updated 叫过来，第一轮从这一刻起算）从 RunStore 读上一版看到第几次为止
   * （还没有一版就是 0）。重启以后不知道上一轮什么时候开始的：有上一版就当这一刻刚看过，等一个间隔
   */
  #paceOf(run: Run, branch: Branch): Pace {
    let pace = this.#pace.get(branch.id);
    if (!pace) {
      const latest = latestWatch(this.#deps.queries, run.id, branch.id);
      const now = this.#deps.clock.now();
      pace = {
        failures: 0,
        seen: latest?.toolCalls ?? 0,
        seenSeq: latest?.basedOnSeq ?? 0,
        stateSeq: latest?.stateSeq ?? latest?.basedOnSeq ?? 0,
        attemptedHintSeq: Math.max(latest?.stateSeq ?? 0, latest?.basedOnSeq ?? 0),
        since: now,
      };
      if (latest) pace.cadenceAt = now;
      this.#pace.set(branch.id, pace);
    }
    return pace;
  }

  // ── 看一轮 ────────────────────────────────────────────────────────────────

  #launch(run: Run, branch: Branch, bet: Bet): void {
    const { queries: q, clock } = this.#deps;
    const previous = latestWatch(q, run.id, branch.id);
    const pace = this.#paceOf(run, branch);
    const latest = q.lastSeq();
    const request: WatchRequest = {
      branchId: branch.id,
      untilSeq: latest,
      ...(previous ? { previous: noteOf(previous) } : {}),
      window: pace.window ?? { maxSteps: WATCH_WINDOW_STEPS, maxBytes: WATCH_WINDOW_BYTES },
    };
    const stop = new AbortController();
    const closing = new AbortController();
    const round: Round = { runId: run.id, stop };
    this.#rounds.set(branch.id, round);
    const timer = clock.setTimeout(
      () => stop.abort(new WatchFailure('budget', `一轮用时预算耗尽（${this.#timeMs() / 1000} 秒）`)),
      this.#timeMs(),
    );
    const softTimer = clock.setTimeout(
      () => closing.abort(),
      this.#deps.softMs ?? Math.min(WATCH_SOFT_MS, (this.#timeMs() * 5) / 6),
    );
    // 每轮现取：立即暂停以后恢复时 RunScopes 换了新的信号（runtime/run-manager.ts 的 resume）
    const signal = AbortSignal.any([this.#deps.scopes.signal(run.id), stop.signal]);
    const started = clock.now();
    const work = this.#work(run, branch, bet, request, signal, started, closing.signal)
      .catch((error) => this.#deps.log?.(`任务 ${run.id} 的巡检器这一轮出错：${errorText(error)}`))
      .finally(() => {
        clock.clearTimeout(timer);
        clock.clearTimeout(softTimer);
        if (this.#rounds.get(branch.id) === round) this.#rounds.delete(branch.id);
        this.#inflight.delete(work);
        // 看完一轮：判下一轮什么时候看
        this.#schedule(run.id, branch.id);
      });
    this.#inflight.add(work);
  }

  async #work(
    run: Run,
    branch: Branch,
    bet: Bet,
    request: WatchRequest,
    signal: AbortSignal,
    started: number,
    closing: AbortSignal,
  ): Promise<void> {
    const { watcher, inputs, queries, log } = this.#deps;
    if (!watcher) return;
    const pace = this.#paceOf(run, branch);
    const attemptedHintSeq = pace.attemptedHintSeq;
    let label = bet.label;
    let targetSeq = request.untilSeq;
    let result: Awaited<ReturnType<WatcherAgent['watch']>>;
    try {
      if (inputs) {
        try {
          await inputs.collect(run, branch.id, signal);
        } finally {
          // 采集可能先持久化部分状态再失败；这些写入属于本次尝试，不能绕过失败退避。
          pace.attemptedHintSeq = Math.max(pace.attemptedHintSeq, queries.lastSeq());
        }
      }
      signal.throwIfAborted();
      if (watchTaskComplete(queries, run.id, branch.id)) return;
      // 输入采集完成后只冻结一次；截止点、计数和模型读取的是同一份窗口。
      targetSeq = queries.lastSeq();
      request = freezeWatchWindow(queries, run.id, request, targetSeq);
      // 采集产生的状态已纳入本轮；失败时也遵守退避，不因自身写入再唤醒。
      pace.attemptedHintSeq = Math.max(pace.attemptedHintSeq, targetSeq);
      if (inputs) request = await inputs.read(run, request, signal);
      signal.throwIfAborted();
      if (watchTaskComplete(queries, run.id, branch.id)) return;
      // 采集与读取会让出事件循环；主模型可能刚开始请求，延后而不消费提示、周期或失败次数。
      if (this.#deps.mainLlmInFlight?.(branch.id)) {
        pace.attemptedHintSeq = attemptedHintSeq;
        return;
      }
      pace.cadenceAt = this.#deps.clock.now();
      label = `${bet.label}看到第 ${request.toolCalls} 次工具调用`;
      result = await watcher.watch({ run, request, author: bet.model, signal, closing });
    } catch (error) {
      // 暂停、路线结束、Melina 退出停下的，任务收尾、结束、取消时 RunScopes 停下的：不算没做成
      if (
        signal.reason instanceof Halt ||
        this.#deps.scopes.signal(run.id).aborted ||
        (isMelinaError(error) && error.code === 'conflict')
      )
        return;
      const cause = signal.reason instanceof WatchFailure ? signal.reason : error;
      this.#failed(
        run.id,
        branch.id,
        `${label}：${errorText(error)}`,
        cause instanceof WatchFailure
          ? cause.reason
          : isMelinaError(cause) && cause.code === 'invalid'
            ? 'validation'
            : 'unknown',
      );
      return;
    }
    const note = result.published;
    const before = this.#pace.get(branch.id);
    const now = this.#deps.clock.now();
    const progressed = note.basedOnSeq > (request.previous?.basedOnSeq ?? 0);
    // 实时水位用于滞后报告；追赶只针对启动时已有的积压，不追逐在途新增的零星材料。
    const current = this.#deps.queries.getBranch(branch.id) ?? branch;
    const backlog = watchBacklog(
      this.#deps.queries,
      current,
      note.basedOnSeq,
      note.toolCalls,
      note.stateSeq ?? note.basedOnSeq,
    );
    const lag = watchLag(this.#deps.queries, current, note, now, backlog);
    const consumed = note.basedOnSeq >= result.windowUntilSeq;
    this.#pace.set(branch.id, {
      seen: note.toolCalls,
      seenSeq: note.basedOnSeq,
      stateSeq: note.stateSeq ?? note.basedOnSeq,
      attemptedHintSeq: before?.attemptedHintSeq ?? 0,
      failures: 0,
      window: recoverWindow(request.window, progressed && consumed && !closing.aborted),
      catchingUp: progressed && note.basedOnSeq < Math.max(targetSeq, result.windowUntilSeq) && backlog.unread,
      since: before?.since ?? now,
      cadenceAt: now,
    });
    const secs = Math.round((now - started) / 1000);
    log?.(
      `任务 ${run.id} 的巡检器交了第 ${note.rev} 版看法（${bet.label}看到第 ${note.toolCalls} 次工具调用，覆盖至 ${note.basedOnSeq}，落后 ${lag.lagTools} 步 / 最早未读积压 ${Math.round(lag.backlogAgeMs / 1000)} 秒${lag.coveredAgeMs !== undefined ? ` / 覆盖水位账龄 ${Math.round(lag.coveredAgeMs / 1000)} 秒` : ''}，${secs} 秒，${modelKey(note.model)}）`,
    );
  }

  /** 单轮复杂度失败缩窗、短冷却；外部故障按正常间隔退避。 */
  #failed(runId: Id, branchId: Id, why: string, reason: WatchFailureReason): void {
    const pace = this.#pace.get(branchId) ?? {
      failures: 0,
      since: this.#deps.clock.now(),
      seenSeq: 0,
      stateSeq: 0,
      attemptedHintSeq: 0,
    };
    pace.failedAt = this.#deps.clock.now();
    pace.failures++;
    pace.failureReason = reason;
    if (shrinksWindow(reason)) {
      const window = pace.window ?? { maxSteps: WATCH_WINDOW_STEPS, maxBytes: WATCH_WINDOW_BYTES };
      pace.window = {
        maxSteps: Math.max(1, Math.floor(window.maxSteps / 2)),
        maxBytes: Math.max(1024, Math.floor(window.maxBytes / 2)),
      };
    }
    this.#pace.set(branchId, pace);
    this.#deps.log?.(
      `任务 ${runId} 的巡检器这一轮没做成（${why}）；原因 ${reason}，接连 ${pace.failures} 轮没做成，${retryDelay(pace, this.#paceMs().everyMs) / 1000} 秒后再看`,
    );
  }

  #stopRun(runId: Id, why: string): void {
    for (const round of this.#rounds.values()) {
      if (round.runId === runId && !round.stop.signal.aborted) round.stop.abort(new Halt(why));
    }
  }

  /** 任务结束了：它的主干直解路线（几份）不用再记进度，到点的计时器也撤掉 */
  #forget(runId: Id): void {
    for (const branch of this.#deps.queries.listBranches(runId)) {
      this.#pace.delete(branch.id);
      this.#deps.clock.clearTimeout(this.#due.get(branch.id));
      this.#due.delete(branch.id);
    }
  }

  #timeMs(): number {
    return this.#deps.timeMs ?? WATCH_TIME_MS;
  }

  #paceMs(): { firstMs: number; everyMs: number } {
    return this.#deps.pace ?? { firstMs: WATCH_FIRST_MS, everyMs: WATCH_EVERY_MS };
  }
}

/** 读出来的一版去掉 seq，还原成 WatchNote（给巡检器的上一版） */
function noteOf(version: WatchNote & { seq: number }): WatchNote {
  const { seq: _seq, ...note } = version;
  return note;
}

function isEnded(run: Pick<Run, 'status'>): boolean {
  return (ENDED_RUN_STATUSES as readonly string[]).includes(run.status);
}

function retryDelay(pace: Pick<Pace, 'failures' | 'failureReason'>, everyMs: number): number {
  if (pace.failureReason === 'budget') return WATCH_RETRY_MS;
  if (shrinksWindow(pace.failureReason)) return WATCH_RETRY_MS * Math.min(2, pace.failures);
  const exponent = pace.failures - 1;
  return everyMs * Math.min(WATCH_BACKOFF_MAX, 2 ** Math.max(0, exponent));
}

function shrinksWindow(reason: WatchFailureReason | undefined): boolean {
  return reason === 'budget' || reason === 'validation' || reason === 'no_close';
}

/** 成功吃完整窗且没触及软截止才扩容；锚定本轮窗口，部分发布保持原预算。 */
function recoverWindow(window: WatchRequest['window'], grow: boolean): WatchRequest['window'] {
  if (!window) return undefined;
  const maxSteps = grow ? Math.min(WATCH_WINDOW_STEPS, window.maxSteps * 2 + 1) : window.maxSteps;
  const maxBytes = grow
    ? Math.min(
        WATCH_WINDOW_BYTES,
        Math.max(window.maxBytes * 2, Math.round(WATCH_WINDOW_BYTES * (maxSteps / WATCH_WINDOW_STEPS))),
      )
    : window.maxBytes;
  return maxSteps >= WATCH_WINDOW_STEPS && maxBytes >= WATCH_WINDOW_BYTES ? undefined : { maxSteps, maxBytes };
}
