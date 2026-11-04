// Scheduler：只做机械决定——谁先跑、能同时跑几个。队列只在内存里，重启后由恢复流程重建。
//
// 三层：
// - 准入层（episodeSlot）：一个 episode 一个名额。用某家模型的 episode 不超过这家的上限，剩余磁盘不够时不放行新分支；
//   任务暂停时只停这一层。
// - 调用层（modelSlot）：每次模型调用一个名额，调用完就还。每家同时在途的调用不超过这家的上限；

// - 工具层（toolSlot）：每次在容器里执行环境工具一个名额，执行完就还；所有 Run 加起来不超过本机的上限（limits.toolExec）。
//   episode 大部分时间在等模型，不占这一层。任务暂停不停这一层。
//
// 谁先：多个 Run 先平分（谁手里的名额少谁先），Run 内按作业优先级，
// episode 之间再按分支的调度权重分（stride：每放行一次，分支的进度加 1/权重，进度小的先）。用不完的让给别的 Run。
//
// 上限都是 auto：limits.modelCalls 默认不封顶，收到限流信号（429、503、529）才封在当时在途调用数的一半（最低 1，一分钟内只收一次），
// 之后有作业在等这家时每分钟放宽 1；带 Retry-After 就让这家的新调用等到那个时间。limits.toolExec 以可用 CPU 核数起步，
// 有命令排队、CPU 和内存、进程名额有余量时逐步放宽，不以核数封顶；吃紧时减少后续放行，不中止已经执行的命令。
// CPU 有 cgroup v2 的压力（PSI）就看它；没有才看一分钟平均负载和本机核数（容器的 loadavg 不能和容器配额比）。
// 模型页填了 RPM、TPM 的供应商另有令牌桶。

import { readFileSync } from 'node:fs';
import { availableParallelism, cpus as hostCpus, loadavg } from 'node:os';
import { MelinaError } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import {
  type CapacityLine,
  JOB_PRIORITY,
  type JobKind,
  type Scheduler,
  type SchedulerStatus,
  type Slot,
} from '../core/interfaces/scheduler.ts';
import type { Branch } from '../core/types.ts';
import { abortError, type Clock, realClock } from './async.ts';
import { localResourcePressure } from './resource-pressure.ts';

export interface SchedulerLimits {
  /** limits.modelCalls：没写的供应商、写 auto 的都是不封顶 */
  modelCalls: Record<string, number | 'auto'>;
  /** limits.toolExec：同时执行的环境工具命令数（工具层） */
  toolExec: number | 'auto';
  /** limits.diskFreeMin（字节） */
  diskFreeMin: number;
}

export interface ProviderRate {
  provider: string;
  rpm?: number;
  tpm?: number;
}

export interface SchedulerOptions {
  /** 现在的上限（GlobalConfig.limits），每次放行前现读，改了马上生效 */
  limits: () => SchedulerLimits;
  /** 模型页里各供应商的 RPM、TPM（ModelsConfig.providers），不填就只看限流信号 */
  rates?: () => readonly ProviderRate[];
  /** 剩余磁盘（字节）；不给就不按磁盘准入 */
  diskFree?: () => Promise<number>;
  /** 自动并发的起始值：默认 availableParallelism()，不是硬上限 */
  cpus?: () => number;
  /**
   * CPU 压力（0–100，最近 10 秒里至少有一个任务在等 CPU 的时间占比）：默认读 cgroup v2 的 cpu.pressure；
   * 读不到（返回 undefined）才看 load。给了 load 而没给 pressure 时只看 load（测试用）
   */
  pressure?: () => number | undefined;
  /** 内存和进程名额：true 收紧，false 有余量，undefined 保持；默认读宿主内存和当前 cgroup、父组 */
  resourcePressure?: () => boolean | undefined;
  /** 一分钟的平均负载，和 hostCpus 比；默认 os.loadavg()、os.cpus().length（给了 cpus 没给 hostCpus 时和 cpus 比） */
  load?: () => number;
  hostCpus?: () => number;

  jobOf?: (branch: Branch) => JobKind;
  /** 分支现在的调度权重：prioritize 改了以后，排着队的也按新的算 */
  weightOf?: (branchId: Id) => number | undefined;
  clock?: Clock;
  /** 名额、排队、上限有变化：进程入口据此发 system.updated（自己合并） */
  onChange?: () => void;
}

/** 比 core 的 Scheduler 多的几样：给 runtime 自己和进程入口用 */
export interface MelinaScheduler extends Scheduler {
  /** 已取得模型调用名额；排队、工具执行和整个 episode 不算在途请求。 */
  modelInFlight(branchId: Id, job: JobKind): boolean;
  /** onQueued：没能马上放行、开始排队时调一次（分支的 queued 据此变成 true） */
  episodeSlot(branch: Branch, provider: string, signal?: AbortSignal, onQueued?: () => void): Promise<Slot>;
  /** 停掉计时器（负载采样、磁盘、放宽、令牌桶） */
  dispose(): void;
}

const MINUTE = 60_000;
/** 计时器按毫秒算；频繁补桶累积的浮点尾数不能把恰好补满变成还要等 1 毫秒。 */
const TIMER_EPSILON_MS = 1e-6;
/** 歇了很久再来的，进度最多比活跃的少这么多（约两次放行），不能攒着份额一次用掉 */
const CREDIT = 2;
const LOAD_SAMPLE_MS = 5_000;
/** CPU 压力超过这个（%）就收紧，低于 PRESSURE_LOW 才放宽，中间不动（不来回跳） */
const PRESSURE_HIGH = 50;
const PRESSURE_LOW = 25;
const DISK_SAMPLE_MS = 15_000;

interface WaiterBase {
  id: number;
  runId: Id;
  provider: string;
  priority: number;
  enqueuedAt: number;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  resolve: (slot: Slot) => void;
  reject: (error: unknown) => void;
}

interface EpisodeWaiter extends WaiterBase {
  layer: 'episode';
  branchId: Id;
  weight: number;
  /** 新分支（还没建 workspace）：要看磁盘 */
  needsDisk: boolean;
}

interface CallWaiter extends WaiterBase {
  layer: 'call';
  job: JobKind;
  branchId: Id | undefined;
  estTokens: number;
}

interface ToolWaiter extends WaiterBase {
  layer: 'tool';
  branchId: Id | undefined;
}

type Waiter = EpisodeWaiter | CallWaiter | ToolWaiter;

type EpisodeSpec = Pick<
  EpisodeWaiter,
  'layer' | 'branchId' | 'weight' | 'needsDisk' | 'runId' | 'provider' | 'priority'
>;
type CallSpec = Pick<CallWaiter, 'layer' | 'job' | 'branchId' | 'estTokens' | 'runId' | 'provider' | 'priority'>;
type ToolSpec = Pick<ToolWaiter, 'layer' | 'branchId' | 'runId' | 'provider' | 'priority'>;

/** 一次 pump 里读一次的配置：limits()、rates() 可能要查库，不在每个排队的作业上都读一遍 */
interface Frame {
  limits: SchedulerLimits;
  rates: readonly ProviderRate[];
}

interface Held {
  layer: Waiter['layer'];
  runId: Id;
  provider: string;
  branchId: Id | undefined;
  estTokens: number;
  job: JobKind | undefined;
  released: boolean;
}

/** 令牌桶：容量是每分钟的量，按毫秒匀速补；level 可以被实际用量压成负数，补回来之前不放行 */
class Bucket {
  capacity: number;
  level: number;
  private updatedAt: number;

  constructor(capacity: number, now: number) {
    this.capacity = capacity;
    this.level = capacity;
    this.updatedAt = now;
  }

  refill(now: number): void {
    if (now > this.updatedAt) {
      this.level = Math.min(this.capacity, this.level + ((now - this.updatedAt) * this.capacity) / MINUTE);
      this.updatedAt = now;
    }
  }

  resize(capacity: number): void {
    if (capacity === this.capacity) return;
    this.level = Math.min(capacity, this.level + Math.max(0, capacity - this.capacity));
    this.capacity = capacity;
  }

  /** 要用掉 need 还要等多久；need 比容量还大时等到满桶就放（否则永远放不出去） */
  waitFor(need: number, reserved: number): number {
    const want = Math.min(need, this.capacity);
    const have = this.level - reserved;
    if (have >= want) return 0;
    return Math.max(0, Math.ceil(((want - have) * MINUTE) / this.capacity - TIMER_EPSILON_MS));
  }
}

interface ProviderState {
  /** 收到限流信号后封的上限；undefined 是没收过 */
  throttle: number | undefined;
  throttledAt: number | undefined;
  relaxTimer: unknown;
  retryAt: number | undefined;
  requests: Bucket | undefined;
  tokens: Bucket | undefined;
  /** 放行了、还没还的调用预估的 token（令牌桶在实际用量回来之前先按预估扣着） */
  reservedTokens: number;
}

export function createScheduler(options: SchedulerOptions): MelinaScheduler {
  return new RuntimeScheduler(options);
}

class RuntimeScheduler implements MelinaScheduler {
  private readonly opts: SchedulerOptions;
  private readonly clock: Clock;
  private readonly waiters: Waiter[] = [];
  private readonly held = new Set<Held>();
  private readonly providers = new Map<string, ProviderState>();
  private readonly pausedRuns = new Set<Id>();
  /**
   * stride（按累计放行数轮转）：
   * - branchPass：分支的进度，每放行一个 episode 加 1/权重，进度小的先。
   * - runShare：每条队（准入层一条，调用层每家一条）上每个 Run 的进度，每放行一次加 1。手里的名额数一样时（比如上限是 1、轮流还），
   *   进度小的 Run 先，别的 Run 的后台作业不会被一直压着。
   * 新来的从别的活跃者（在排队或拿着名额的）里最小的进度起；歇了很久再来的最多只比它们少 CREDIT，不能攒着份额一次用掉。
   */
  private readonly branchPass = new Map<Id, number>();
  private readonly runShare = new Map<string, number>();
  private nextId = 1;
  private autoToolExec: number;
  private diskFreeBytes: number | undefined;
  private diskCheckedAt = Number.NEGATIVE_INFINITY;
  private diskChecking = false;
  private frame: Frame | undefined;
  private wakeTimer: unknown;
  private wakeAt = Number.POSITIVE_INFINITY;
  private loadTimer: unknown;
  private diskTimer: unknown;
  private disposed = false;

  constructor(options: SchedulerOptions) {
    this.opts = options;
    this.clock = options.clock ?? realClock;
    this.autoToolExec = this.cpus();
    this.loadTimer = this.clock.setTimeout(() => this.sampleLoad(), LOAD_SAMPLE_MS);
    if (options.diskFree) this.refreshDisk();
  }

  // ── 准入层 ──────────────────────────────────────────────────────────────

  episodeSlot(branch: Branch, provider: string, signal?: AbortSignal, onQueued?: () => void): Promise<Slot> {
    const job = this.opts.jobOf?.(branch) ?? 'explorer_episode';
    return this.enqueue(
      {
        layer: 'episode',
        branchId: branch.id,
        weight: branch.weight,
        needsDisk: branch.workspace === undefined,
        runId: branch.runId,
        provider,
        priority: JOB_PRIORITY[job],
      },
      signal,
      onQueued,
    );
  }

  // ── 工具层 ──────────────────────────────────────────────────────────────

  toolSlot(req: { runId: Id; branchId?: Id }, signal?: AbortSignal): Promise<Slot> {
    return this.enqueue(
      { layer: 'tool', branchId: req.branchId, runId: req.runId, provider: LOCAL, priority: 0 },
      signal,
    );
  }

  // ── 调用层 ──────────────────────────────────────────────────────────────

  modelSlot(
    req: { runId: Id; provider: string; job: JobKind; branchId?: Id; estTokens?: number },
    signal?: AbortSignal,
  ): Promise<Slot> {
    return this.enqueue(
      {
        layer: 'call',
        job: req.job,
        branchId: req.branchId,
        estTokens: Math.max(0, Math.round(req.estTokens ?? 0)),
        runId: req.runId,
        provider: req.provider,
        priority: JOB_PRIORITY[req.job],
      },
      signal,
    );
  }

  throttled(provider: string, signal: { status: number; retryAfterMs?: number }): void {
    const now = this.clock.now();
    const st = this.provider(provider);
    if (st.throttledAt === undefined || now - st.throttledAt >= MINUTE) {
      // 封在当时在途调用数的一半，最低 1；一分钟内的信号不再重复减
      const inFlight = this.count('call', { provider });
      const next = Math.max(1, Math.floor(inFlight / 2));
      st.throttle = st.throttle === undefined ? next : Math.min(st.throttle, next);
      st.throttledAt = now;
      this.startRelax(provider);
    }
    if (signal.retryAfterMs !== undefined && signal.retryAfterMs > 0) {
      st.retryAt = Math.max(st.retryAt ?? 0, now + signal.retryAfterMs);
    }
    this.changed();
    this.pump();
  }

  consumed(provider: string, tokens: number): void {
    const st = this.provider(provider);
    this.syncRates(provider, st);
    if (!st.tokens || tokens <= 0) return;
    st.tokens.refill(this.clock.now());
    st.tokens.level -= tokens;
    this.pump();
  }

  // ── 任务暂停、Run 结束 ────────────────────────────────────────────

  pauseRun(runId: Id): void {
    this.pausedRuns.add(runId);
    this.changed();
  }

  resumeRun(runId: Id): void {
    if (this.pausedRuns.delete(runId)) {
      this.changed();
      this.pump();
    }
  }

  dropRun(runId: Id): void {
    this.pausedRuns.delete(runId);
    for (const key of [...this.runShare.keys()]) if (key.endsWith(`\u0000${runId}`)) this.runShare.delete(key);
    for (const w of [...this.waiters]) {
      if (w.runId !== runId) continue;
      this.remove(w);
      w.reject(new MelinaError('conflict', '任务已经结束，不再排队'));
    }
    this.changed();
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  capacity(runId?: Id): CapacityLine[] {
    const lines: CapacityLine[] = [];
    for (const provider of this.knownProviders()) {
      lines.push({
        provider,
        limit: finite(this.limitOf(provider)),
        running: this.count('episode', { provider, runId }),
        queued: this.queuedCount('episode', { provider, runId }),
      });
    }
    lines.push({
      provider: LOCAL,
      limit: this.toolExecLimit(),
      running: this.count('tool', { runId }),
      queued: this.queuedCount('tool', { runId }),
    });
    return lines;
  }

  status(): SchedulerStatus {
    const limits = this.opts.limits();
    const now = this.clock.now();
    return {
      providers: this.knownProviders().map((provider) => {
        const st = this.providers.get(provider);
        return {
          provider,
          limit: finite(this.limitOf(provider)),
          inFlight: this.count('call', { provider }),
          queued: this.queuedCount('call', { provider }),
          episodes: {
            running: this.count('episode', { provider }),
            queued: this.queuedCount('episode', { provider }),
          },
          ...(st?.retryAt !== undefined && st.retryAt > now ? { retryAt: new Date(st.retryAt).toISOString() } : {}),
        };
      }),
      toolExec: {
        limit: this.toolExecLimit(),
        running: this.count('tool', {}),
        queued: this.queuedCount('tool', {}),
        auto: limits.toolExec === 'auto',
      },
      disk: {
        freeBytes: this.diskFreeBytes ?? 0,
        minBytes: limits.diskFreeMin,
        ok: this.diskOk(),
      },
    };
  }

  modelInFlight(branchId: Id, job: JobKind): boolean {
    return [...this.held].some((h) => h.layer === 'call' && h.branchId === branchId && h.job === job);
  }

  dispose(): void {
    this.disposed = true;
    this.clock.clearTimeout(this.loadTimer);
    this.clock.clearTimeout(this.diskTimer);
    this.clock.clearTimeout(this.wakeTimer);
    for (const st of this.providers.values()) this.clock.clearTimeout(st.relaxTimer);
  }

  // ── 内部：排队和放行 ────────────────────────────────────────────────────

  private enqueue(
    spec: EpisodeSpec | CallSpec | ToolSpec,
    signal: AbortSignal | undefined,
    onQueued?: () => void,
  ): Promise<Slot> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.disposed) return Promise.reject(new MelinaError('unavailable', 'Melina 正在退出，不再放行'));
    return new Promise<Slot>((resolve, reject) => {
      const waiter = {
        ...spec,
        id: this.nextId++,
        enqueuedAt: this.clock.now(),
        signal,
        onAbort: undefined,
        resolve,
        reject,
      } as Waiter;
      if (signal) {
        waiter.onAbort = () => {
          if (this.remove(waiter)) {
            this.changed();
            reject(abortError(signal));
          }
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      if (waiter.layer !== 'tool') this.provider(waiter.provider);
      this.liftShare(waiter);
      if (waiter.layer === 'episode') {
        // 新来的分支从本 Run 别的活跃分支里最小的进度起，歇了很久再来的最多落后 CREDIT
        this.liftBranch(waiter);
        if (waiter.needsDisk) this.refreshDiskIfStale();
      }
      this.waiters.push(waiter);
      this.pump();
      if (this.waiters.includes(waiter)) {
        this.changed();
        try {
          onQueued?.();
        } catch {
          // 回调出错不影响排队
        }
      }
    });
  }

  /** 能放的都放：每次挑一个最该先放的，直到挑不出来；再按时间约束定下次醒来的时间 */
  private pump(): void {
    if (this.disposed || this.frame) return;
    this.frame = { limits: this.opts.limits(), rates: this.opts.rates?.() ?? [] };
    let granted = false;
    try {
      for (;;) {
        const now = this.clock.now();
        const best = this.pick(now);
        if (!best) break;
        this.grant(best);
        granted = true;
      }
      this.scheduleWake();
    } finally {
      this.frame = undefined;
    }
    if (granted) this.changed();
  }

  private limits(): SchedulerLimits {
    return this.frame?.limits ?? this.opts.limits();
  }

  private rates(): readonly ProviderRate[] {
    return this.frame?.rates ?? this.opts.rates?.() ?? [];
  }

  /** Run 在这条队上的进度：新来的从别的活跃 Run 里最小的进度起，歇了很久再来的最多落后 CREDIT */
  private liftShare(w: Waiter): void {
    const lane = laneOf(w);
    let floor = Number.POSITIVE_INFINITY;
    const consider = (runId: Id) => {
      if (runId !== w.runId) floor = Math.min(floor, this.runShare.get(`${lane}\u0000${runId}`) ?? 0);
    };
    for (const x of this.waiters) if (laneOf(x) === lane) consider(x.runId);
    for (const h of this.held) if (laneOf(h) === lane) consider(h.runId);
    const key = shareKey(w);
    this.runShare.set(key, lift(this.runShare.get(key), floor));
  }

  /** 分支的进度：同上，和同一个 Run 里别的在排队或在跑的分支比 */
  private liftBranch(w: EpisodeWaiter): void {
    let floor = Number.POSITIVE_INFINITY;
    const consider = (runId: Id, branchId: Id | undefined) => {
      if (runId === w.runId && branchId !== undefined && branchId !== w.branchId) {
        floor = Math.min(floor, this.branchPass.get(branchId) ?? 0);
      }
    };
    for (const x of this.waiters) if (x.layer === 'episode') consider(x.runId, x.branchId);
    for (const h of this.held) if (h.layer === 'episode') consider(h.runId, h.branchId);
    this.branchPass.set(w.branchId, lift(this.branchPass.get(w.branchId), floor));
  }

  private pick(now: number): Waiter | undefined {
    const blocked = this.timeBlocked(now);
    let best: Waiter | undefined;
    let bestKey: number[] | undefined;
    for (const w of this.waiters) {
      if (w.layer === 'call' && blocked.has(w.provider)) continue;
      if (!this.admissible(w, now)) continue;
      const key = this.keyOf(w);
      if (!bestKey || lessThan(key, bestKey)) {
        best = w;
        bestKey = key;
      }
    }
    return best;
  }

  /** 排序键：手里的名额数、Run 的进度、作业优先级、分支的进度、先来后到；小的先 */
  private keyOf(w: Waiter): number[] {
    const share = this.runShare.get(shareKey(w)) ?? 0;
    if (w.layer === 'episode') {
      return [
        0,
        this.count('episode', { runId: w.runId }),
        share,
        w.priority,
        this.branchPass.get(w.branchId) ?? 0,
        w.id,
      ];
    }
    if (w.layer === 'tool') return [2, this.count('tool', { runId: w.runId }), share, 0, 0, w.id];
    return [1, this.count('call', { runId: w.runId, provider: w.provider }), share, w.priority, 0, w.id];
  }

  private timeBlocked(now: number): Set<string> {
    const heads = new Map<string, { w: CallWaiter; key: number[] }>();
    for (const w of this.waiters) {
      if (w.layer !== 'call') continue;
      if (this.count('call', { provider: w.provider }) >= this.limitOf(w.provider)) continue;
      const key = this.keyOf(w);
      const head = heads.get(w.provider);
      if (!head || lessThan(key, head.key)) heads.set(w.provider, { w, key });
    }
    const blocked = new Set<string>();
    for (const [provider, head] of heads) if (this.callWait(head.w, now) > 0) blocked.add(provider);
    return blocked;
  }

  private admissible(w: Waiter, now: number): boolean {
    const limit = this.limitOf(w.provider);
    if (w.layer === 'episode') {
      if (this.pausedRuns.has(w.runId)) return false;
      if (this.count('episode', { provider: w.provider }) >= limit) return false;
      if (w.needsDisk && !this.diskOk()) return false;
      return true;
    }
    if (w.layer === 'tool') return this.count('tool', {}) < this.toolExecLimit();
    if (this.count('call', { provider: w.provider }) >= limit) return false;
    return this.callWait(w, now) === 0;
  }

  /** 调用要等多久：Retry-After 和令牌桶；0 是现在就能放 */
  private callWait(w: CallWaiter, now: number): number {
    const st = this.provider(w.provider);
    this.syncRates(w.provider, st);
    let wait = st.retryAt !== undefined && st.retryAt > now ? st.retryAt - now : 0;
    if (st.requests) {
      st.requests.refill(now);
      wait = Math.max(wait, st.requests.waitFor(1, 0));
    }
    if (st.tokens) {
      st.tokens.refill(now);
      wait = Math.max(wait, st.tokens.waitFor(w.estTokens, st.reservedTokens));
    }
    return wait;
  }

  private grant(w: Waiter): void {
    this.remove(w);
    const held: Held = {
      layer: w.layer,
      runId: w.runId,
      provider: w.provider,
      branchId: w.branchId,
      estTokens: w.layer === 'call' ? w.estTokens : 0,
      job: w.layer === 'call' ? w.job : undefined,
      released: false,
    };
    this.held.add(held);
    const sk = shareKey(w);
    this.runShare.set(sk, (this.runShare.get(sk) ?? 0) + 1);
    if (w.layer === 'episode') {
      const pass = this.branchPass.get(w.branchId) ?? 0;
      const weight = this.opts.weightOf?.(w.branchId) ?? w.weight;
      this.branchPass.set(w.branchId, pass + 1 / Math.max(weight, 0.01));
    } else if (w.layer === 'call') {
      const st = this.provider(w.provider);
      if (st.requests) st.requests.level -= 1;
      st.reservedTokens += w.estTokens;
    }
    w.resolve({ release: () => this.release(held) });
  }

  private release(held: Held): void {
    if (held.released) return;
    held.released = true;
    this.held.delete(held);
    if (held.layer === 'call') {
      const st = this.provider(held.provider);
      st.reservedTokens = Math.max(0, st.reservedTokens - held.estTokens);
    }
    this.changed();
    this.pump();
  }

  private remove(w: Waiter): boolean {
    const i = this.waiters.indexOf(w);
    if (i < 0) return false;
    this.waiters.splice(i, 1);
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
    return true;
  }

  /** Retry-After 和令牌桶挡住的调用：到点再 pump 一次 */
  private scheduleWake(): void {
    const now = this.clock.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const w of this.waiters) {
      if (w.layer !== 'call') continue;
      if (this.count('call', { provider: w.provider }) >= this.limitOf(w.provider)) continue;
      const wait = this.callWait(w, now);
      if (wait > 0) soonest = Math.min(soonest, now + wait);
    }
    if (soonest === this.wakeAt) return;
    this.clock.clearTimeout(this.wakeTimer);
    this.wakeAt = soonest;
    if (soonest === Number.POSITIVE_INFINITY) return;
    this.wakeTimer = this.clock.setTimeout(
      () => {
        this.wakeAt = Number.POSITIVE_INFINITY;
        this.pump();
      },
      Math.max(1, soonest - now),
    );
  }

  // ── 内部：上限 ──────────────────────────────────────────────────────────

  private limitOf(provider: string): number {
    const configured = this.limits().modelCalls[provider];
    const base = typeof configured === 'number' ? configured : Number.POSITIVE_INFINITY;
    const throttle = this.providers.get(provider)?.throttle;
    return Math.min(base, throttle ?? Number.POSITIVE_INFINITY);
  }

  private toolExecLimit(): number {
    const configured = this.limits().toolExec;
    return typeof configured === 'number' ? configured : this.autoToolExec;
  }

  private cpus(): number {
    return Math.max(1, Math.floor(this.opts.cpus?.() ?? availableParallelism()));
  }

  /** 工具并发：核数只作起点；每次最多加四分之一且不超过需求，资源吃紧时减四分之一。 */
  private sampleLoad(): void {
    if (this.disposed) return;
    if (this.limits().toolExec === 'auto') {
      const busy = this.cpuBusy();
      const resources = (this.opts.resourcePressure ?? localResourcePressure)();
      const before = this.autoToolExec;
      if (busy === true || resources === true) {
        this.autoToolExec = Math.max(1, Math.floor(before * 0.75));
      } else if (busy === false && resources === false) {
        const running = this.count('tool', {});
        const queued = this.queuedCount('tool', {});
        const wanted = Math.max(this.cpus(), running + queued);
        this.autoToolExec = Math.min(wanted, before + Math.max(1, Math.floor(before / 4)));
      }
      if (this.autoToolExec !== before) this.changed();
    }
    // 手动设置或取消上限也可能腾出名额；采样时重新放行，不依赖已有命令结束才生效。
    this.pump();
    this.loadTimer = this.clock.setTimeout(() => this.sampleLoad(), LOAD_SAMPLE_MS);
  }

  /**
   * CPU 是不是吃紧：true 减、false 加、undefined 不动。先看本容器的 CPU 压力（PSI）；读不到再拿一分钟的平均负载和本机的核数比。
   * 原来拿 loadavg 和 availableParallelism 比：容器里的 loadavg 是整台宿主机的，配额又比宿主机的核数少，几乎一直「超了」，
   * 上限一路减到 1
   */
  private cpuBusy(): boolean | undefined {
    const pressure = this.opts.pressure ?? (this.opts.load ? undefined : cgroupCpuPressure);
    const p = pressure?.();
    if (p !== undefined) return p > PRESSURE_HIGH ? true : p < PRESSURE_LOW ? false : undefined;
    const load = this.opts.load?.() ?? loadavg()[0] ?? 0;
    const cores = this.opts.hostCpus?.() ?? (this.opts.cpus ? this.cpus() : hostCpus().length);
    const capacity = Math.max(1, cores);
    return load > capacity ? true : load < capacity * 0.75 ? false : undefined;
  }

  /** 收紧以后：有作业在等这家时，每分钟放宽 1 */
  private startRelax(provider: string): void {
    const st = this.provider(provider);
    this.clock.clearTimeout(st.relaxTimer);
    const tick = () => {
      if (this.disposed) return;
      const waiting = this.waiters.some((w) => w.provider === provider);
      if (waiting && st.throttle !== undefined) {
        st.throttle += 1;
        this.changed();
        this.pump();
      }
      st.relaxTimer = this.clock.setTimeout(tick, MINUTE);
    };
    st.relaxTimer = this.clock.setTimeout(tick, MINUTE);
  }

  private diskOk(): boolean {
    if (!this.opts.diskFree || this.diskFreeBytes === undefined) return true;
    return this.diskFreeBytes >= this.limits().diskFreeMin;
  }

  private refreshDiskIfStale(): void {
    if (this.clock.now() - this.diskCheckedAt >= DISK_SAMPLE_MS) this.refreshDisk();
  }

  /** 剩余磁盘：每 15 秒看一次；看之前按上次的结果放行（启动时不等） */
  private refreshDisk(): void {
    const diskFree = this.opts.diskFree;
    if (!diskFree || this.diskChecking || this.disposed) return;
    this.diskChecking = true;
    this.clock.clearTimeout(this.diskTimer);
    diskFree()
      .then((bytes) => {
        const wasOk = this.diskOk();
        this.diskFreeBytes = bytes;
        if (wasOk !== this.diskOk()) this.changed();
      })
      .catch(() => {})
      .finally(() => {
        this.diskChecking = false;
        this.diskCheckedAt = this.clock.now();
        if (this.disposed) return;
        this.pump();
        this.diskTimer = this.clock.setTimeout(() => this.refreshDisk(), DISK_SAMPLE_MS);
      });
  }

  // ── 内部：计数 ──────────────────────────────────────────────────────────

  private count(layer: Held['layer'], f: { provider?: string; runId?: Id }): number {
    let n = 0;
    for (const h of this.held) {
      if (h.layer !== layer) continue;
      if (f.provider !== undefined && h.provider !== f.provider) continue;
      if (f.runId !== undefined && h.runId !== f.runId) continue;
      n++;
    }
    return n;
  }

  private queuedCount(layer: Waiter['layer'], f: { provider?: string; runId?: Id }): number {
    let n = 0;
    for (const w of this.waiters) {
      if (w.layer !== layer) continue;
      if (f.provider !== undefined && w.provider !== f.provider) continue;
      if (f.runId !== undefined && w.runId !== f.runId) continue;
      n++;
    }
    return n;
  }

  private provider(provider: string): ProviderState {
    let st = this.providers.get(provider);
    if (!st) {
      st = {
        throttle: undefined,
        throttledAt: undefined,
        relaxTimer: undefined,
        retryAt: undefined,
        requests: undefined,
        tokens: undefined,
        reservedTokens: 0,
      };
      this.providers.set(provider, st);
      this.syncRates(provider, st);
    }
    return st;
  }

  /** 模型页的 RPM、TPM 改了就跟着改桶的大小；删了就不再限 */
  private syncRates(provider: string, st: ProviderState): void {
    const rate = this.rates().find((r) => r.provider === provider);
    const now = this.clock.now();
    if (rate?.rpm) {
      if (st.requests) st.requests.resize(rate.rpm);
      else st.requests = new Bucket(rate.rpm, now);
    } else st.requests = undefined;
    if (rate?.tpm) {
      if (st.tokens) st.tokens.resize(rate.tpm);
      else st.tokens = new Bucket(rate.tpm, now);
    } else st.tokens = undefined;
  }

  private knownProviders(): string[] {
    const names = new Set<string>(this.providers.keys());
    for (const p of Object.keys(this.limits().modelCalls)) names.add(p);
    for (const r of this.rates()) names.add(r.provider);
    return [...names].sort();
  }

  private changed(): void {
    try {
      this.opts.onChange?.();
    } catch {
      // 通知出错不影响调度
    }
  }
}

/** 新来的（own 为 undefined）从 floor 起；老的最多比 floor 少 CREDIT；没有别的活跃者就照旧 */
function lift(own: number | undefined, floor: number): number {
  if (!Number.isFinite(floor)) return own ?? 0;
  if (own === undefined) return floor;
  return Math.max(own, floor - CREDIT);
}

/** 一条队：准入层一条，工具层一条，调用层每家一条 */
function laneOf(x: { layer: Waiter['layer']; provider: string }): string {
  return x.layer === 'call' ? `call:${x.provider}` : x.layer;
}

function shareKey(x: { layer: Waiter['layer']; provider: string; runId: Id }): string {
  return `${laneOf(x)}\u0000${x.runId}`;
}

/** 工具层的作业不属于哪家供应商 */
const LOCAL = 'local';

/** cgroup v2 的 CPU 压力：some avg10（0–100）；不是 Linux、没有 cgroup v2、没开 PSI 时返回 undefined */
export function cgroupCpuPressure(path = '/sys/fs/cgroup/cpu.pressure'): number | undefined {
  try {
    const m = /^some avg10=([\d.]+)/m.exec(readFileSync(path, 'utf8'));
    const value = m?.[1] === undefined ? Number.NaN : Number(m[1]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

function lessThan(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
