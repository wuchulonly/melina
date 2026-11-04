// 拼成哪段文字由 ContextAssembler.explorerUpdate 定；这里只管什么时候问它、追加给谁，并记下追加到了哪个 seq，
// episode 正常收尾时 Branch.seenSeq 随同一个事务更新（Explorer 交回的 seenSeq）。
// 巡检器的看法由主干直解路线每次请求前现读，作为独立参考材料提供
// （RoleCallRequest.referenceContext），不打断它，也不在对话历史里逐版叠加。

import type { MelinaEvent } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { ContextAssembler } from '../core/interfaces/context.ts';
import type { EventBus, RunStoreQueries } from '../core/interfaces/store.ts';
import { type Clock, errorText } from './async.ts';
import type { RuntimeBranchManager } from './branch-manager.ts';

export interface CourierDeps {
  queries: RunStoreQueries;
  bus: EventBus;
  assembler: Pick<ContextAssembler, 'explorerUpdate'>;
  branches: RuntimeBranchManager;
  clock: Clock;
  /** 同一条分支的新内容攒多久再追加（几条几乎同时到的合成一段） */
  delayMs?: number;
  log?: (text: string) => void;
}

export class Courier {
  private readonly deps: CourierDeps;
  private readonly pending = new Set<Id>();
  private timer: unknown;
  private unsubscribe: (() => void) | undefined;

  constructor(deps: CourierDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bus.subscribe((e) => this.onEvent(e));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.deps.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  private onEvent(e: MelinaEvent): void {
    if (!e.runId) return;
    switch (e.type) {
      case 'inbox.created':
        if (this.deps.branches.episode(e.data.branchId)) this.schedule(e.data.branchId);
        return;
      default:
        return;
    }
  }

  private schedule(branchId: Id): void {
    this.pending.add(branchId);
    if (this.timer !== undefined) return;
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined;
      const ids = [...this.pending];
      this.pending.clear();
      for (const id of ids) this.deliver(id);
    }, this.deps.delayMs ?? 200);
  }

  /** 问 ContextAssembler 有没有新内容，有就追加 */
  deliver(branchId: Id): boolean {
    const ep = this.deps.branches.episode(branchId);
    if (!ep) return false;
    const branch = this.deps.queries.getBranch(branchId);
    if (!branch) return false;
    try {
      const update = this.deps.assembler.explorerUpdate(branch, ep.seenSeq);
      if (!update) return false;
      return this.deps.branches.steer(branchId, update.text, update.seenSeq);
    } catch (error) {
      this.deps.log?.(`给分支 ${branchId} 拼新内容失败：${errorText(error)}`);
      return false;
    }
  }
}
