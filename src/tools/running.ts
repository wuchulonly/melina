// 正在跑的 sh 命令：只在内存里记哪条路线的命令正在跑，
// 一条命令跑完时就知道这段时间里同一个任务里还有哪些路线也在跑命令。撞了共用的资源上限时，读结论的人据此看是谁在占（sh.ts）。
// 不进 RunStore：撞了上限的那条 Observation 自己带着这份名单（Contention.alongside）。重启后从零开始，丢掉的只是重启那一刻的。

import type { Id } from '../core/ids.ts';

interface Running {
  runId: Id;
  branchId: Id | undefined;
  /** 这条命令跑的时候也在跑命令的别的路线，按先后 */
  seen: Set<Id>;
}

export class RunningCommands {
  readonly #now = new Set<Running>();

  /**
   * 一条命令开始跑。返回的函数在它跑完时调：给出这段时间里同一个任务里也在跑命令的别的路线（去重，按先后）。
   * 不属于任何路线的调用（Scoper）不进别人的名单
   */
  start(runId: Id, branchId: Id | undefined): () => Id[] {
    const me: Running = { runId, branchId, seen: new Set() };
    for (const other of this.#now) {
      if (other.runId !== runId) continue;
      if (other.branchId !== undefined && other.branchId !== branchId) me.seen.add(other.branchId);
      if (branchId !== undefined && branchId !== other.branchId) other.seen.add(branchId);
    }
    this.#now.add(me);
    return () => {
      this.#now.delete(me);
      return [...me.seen];
    };
  }
}
