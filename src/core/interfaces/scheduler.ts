// Scheduler。实现在 src/runtime/scheduler.ts。只做机械决定：谁先跑、能跑几个。
//
// 三层：
// - 准入层（episodeSlot）：分支数不设上限，同时跑几条按容量准入。用某家模型的 episode 不超过这家的 limits.modelCalls，
//   剩余磁盘低于 limits.diskFreeMin 不放行新分支；多出来的排队，排队不花 token。任务暂停时只停这一层。
// - 调用层（modelSlot）：每次模型调用前按供应商排队拿名额，调用完就还，每家同时在途的调用不超过 limits.modelCalls。

// - 工具层（toolSlot）：每次在容器里执行环境工具（sh、read、edit、write）前拿一个名额，执行完就还；
//   所有 Run 的环境工具并发总数不超过 limits.toolExec。等待模型的 episode 不占工具名额。
//   任务暂停时，已在运行的命令仍可完成并收尾。
// 多个 Run 共用容量：先在 Run 之间平分，Run 内按作业优先级排，episode 之间再按分支权重分；
// 用不完的份额让给别的 Run，暂停的 Run 不放行新作业。队列只在内存里，重启后由恢复流程重建。

import type { Id } from '../ids.ts';
import type { Branch } from '../types.ts';

export type JobKind = 'scoper_call' | 'explorer_episode' | 'selection_call' | 'watcher_call' | 'handoff_call';

/** 作业优先级，数字越小越先 */
export const JOB_PRIORITY: Record<JobKind, number> = {
  scoper_call: 2,
  explorer_episode: 3,
  // 挑版与求解会话同级。
  selection_call: 3,

  watcher_call: 4,
  handoff_call: 5,
};

export interface Slot {
  release(): void;
}

export interface CapacityLine {
  provider: string | 'local'; // local：本机同时执行的命令（工具层），running、queued 数的是命令，不是路线
  limit: number | null; // null：不限
  running: number;
  queued: number;
}

export interface SchedulerStatus {
  providers: {
    provider: string;
    limit: number | null;
    inFlight: number;
    queued: number;
    episodes: { running: number; queued: number };
    retryAt?: string;
  }[];
  /** 工具层：同时执行的命令（各个 Run 一起算） */
  toolExec: { limit: number; running: number; queued: number; auto: boolean };
  disk: { freeBytes: number; minBytes: number; ok: boolean };
}

export interface Scheduler {
  /** 准入层：一个 episode 的名额；provider 是这条分支的模型的供应商。任务暂停时不放行 */
  episodeSlot(branch: Branch, provider: string, signal?: AbortSignal): Promise<Slot>;
  /** 调用层：一次模型调用的名额（melinaStream 调）；estTokens 给令牌桶（RPM、TPM）用 */
  modelSlot(
    req: { runId: Id; provider: string; job: JobKind; branchId?: Id; estTokens?: number },
    signal?: AbortSignal,
  ): Promise<Slot>;
  /**
   * 工具层：一次环境工具执行的名额（ToolGateway 在容器里执行 sh、read、edit、write 之前要），执行完就还；
   * branchId 是这次调用记在哪条分支上，没有就不填。任务暂停不挡这一层
   */
  toolSlot(req: { runId: Id; branchId?: Id }, signal?: AbortSignal): Promise<Slot>;
  /** 供应商回了限流信号（429，或 503、529 这类过载）：封在当时在途调用数的一半，之后每分钟放宽 1；带 Retry-After 就等到那时 */
  throttled(provider: string, signal: { status: number; retryAfterMs?: number }): void;
  /** 一次调用实际用掉的 token，令牌桶用 */
  consumed(provider: string, tokens: number): void;
  /** 任务暂停、恢复：只影响准入层 */
  pauseRun(runId: Id): void;
  resumeRun(runId: Id): void;
  /** Run 结束或删除：丢掉它排队的作业 */
  dropRun(runId: Id): void;
  capacity(runId?: Id): CapacityLine[];
  status(): SchedulerStatus;
}
