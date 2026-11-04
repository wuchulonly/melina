// 对外的 Run 状态转换与事件调度；准备、输入和终态交付委派给各自的模块。
import type { InputRequest, RunResultResponse } from '../core/api.ts';
import { conflict } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import type { CreateRunInput, RunManager } from '../core/interfaces/runtime.ts';
import type { Branch, HumanInput, Run } from '../core/types.ts';
import { isTerminal } from './branch-manager.ts';
import { RunBootstrap } from './run-bootstrap.ts';
import { RunInput } from './run-input.ts';
import { isEnded, RunLifecycle, type RunManagerDeps } from './run-lifecycle.ts';
import { RunSettle } from './run-settle.ts';
import { CANCELLED_REASON, RESUMED_NOTICE, RUN_PAUSE_HINT } from './templates.ts';

export { scoperPending } from './run-bootstrap.ts';
export type { RunManagerDeps, RunSecretsHook } from './run-lifecycle.ts';
export { finalCandidate, versionToDeliver } from './run-settle.ts';

export class RuntimeRunManager implements RunManager {
  private readonly deps: RunManagerDeps;
  private readonly lifecycle: RunLifecycle;
  private readonly bootstrap: RunBootstrap;
  private readonly settlement: RunSettle;
  private readonly inputs: RunInput;
  private unsubscribe: (() => void) | undefined;
  private started = false;

  constructor(deps: RunManagerDeps) {
    this.deps = deps;
    this.lifecycle = new RunLifecycle(deps);
    this.settlement = new RunSettle(this.lifecycle);
    this.bootstrap = new RunBootstrap(this.lifecycle, (runId, reason) =>
      this.settlement.end(runId, { status: 'failed', reason }),
    );
    this.inputs = new RunInput(this.lifecycle, (runId) => this.settlement.assertNotClosing(runId));
  }

  async create(input: CreateRunInput): Promise<Run> {
    await this.deps.beforeCreate?.(input);
    return this.bootstrap.create(input);
  }

  /** 重启或宿主恢复后，从缺少的准备步骤继续。 */
  prepare(runId: Id): Promise<void> {
    return this.bootstrap.prepare(runId);
  }

  input(runId: Id, req: InputRequest): Promise<HumanInput> {
    return this.inputs.input(runId, req);
  }

  settle(runId: Id): Promise<void> {
    return this.settlement.settle(runId);
  }

  delete(runId: Id): Promise<void> {
    return this.settlement.delete(runId);
  }

  result(runId: Id): Promise<RunResultResponse> {
    return this.settlement.result(runId);
  }

  // ── 任务暂停和恢复 ────────────────────────────────────────────────

  pause(runId: Id): Promise<Run> {
    return this.lifecycle.locks.run(runId, async () => {
      const { writer, branches, env, queries: q } = this.deps;
      const run = this.lifecycle.mustRun(runId);
      if (isEnded(run)) throw conflict('任务已经结束，不能暂停');
      this.settlement.assertNotClosing(runId);
      if (run.mode === 'settling') throw conflict('任务正在收尾，不能暂停');
      if (run.status === 'paused') return run;
      const next = writer.updateRun(runId, { status: 'paused' });
      this.deps.scheduler.pauseRun(runId);
      // 正在跑的：收到收尾提示，收完尾停容器（收尾时看到任务暂停了就停）；没在跑 episode 的现在就停
      for (const ep of branches.running(runId)) branches.steer(ep.branchId, RUN_PAUSE_HINT);
      for (const b of q.listBranches(runId, { states: ['running'] })) {
        if (!branches.episode(b.id) && b.workspace) await env.stop(b);
      }
      return next;
    });
  }

  /** 宿主租约到期时立即停下：中止进程并保存宿主工作区，Run 和各条路线继续存在 */
  interrupt(runId: Id): Promise<Run> {
    return this.lifecycle.locks.run(runId, async () => {
      const { writer, queries: q, branches, env, runners, scheduler, scopes, workspaces } = this.deps;
      const run = this.lifecycle.mustRun(runId);
      if (isEnded(run)) throw conflict('任务已经结束，不能立即暂停');
      this.settlement.assertNotClosing(runId);
      if (run.mode === 'settling') throw conflict('任务正在收尾，不能立即暂停');
      if (run.status !== 'paused') writer.updateRun(runId, { status: 'paused' });
      scheduler.pauseRun(runId);
      scopes.abort(runId, '宿主暂停现场：实例即将更换，停止在途调用');
      // 后台进程也必须停；等 runner 退出以后再停一遍，覆盖正在创建容器的竞态。
      const stop = async () => {
        for (const b of q.listBranches(runId)) if (!isTerminal(b.state) && b.workspace) await env.stop(b, true);
        await env.removeScoper(runId, true);
      };
      await stop();
      await branches.quiesce(runId, '宿主暂停现场：实例即将更换');
      await Promise.all(q.listBranches(runId).map((b) => runners.idle(b.id)));
      await stop();
      for (const b of q.listBranches(runId)) {
        if (isTerminal(b.state) || !b.workspace) continue;
        const snapshot = await workspaces.forRun(run).snapshot(b.workspace, 'host-interrupt');
        await branches.checkpoint(b.id, { id: snapshot });
      }
      return this.lifecycle.mustRun(runId);
    });
  }

  resume(runId: Id): Promise<Run> {
    return this.lifecycle.locks.run(runId, async () => {
      const { writer, queries: q } = this.deps;
      const run = this.lifecycle.mustRun(runId);
      if (isEnded(run)) throw conflict('任务已经结束，不能恢复');
      this.settlement.assertNotClosing(runId);
      if (run.status !== 'paused') return run;
      const interrupted = this.deps.scopes.signal(runId).aborted;
      if (interrupted) this.deps.scopes.forget(runId);
      const next = writer.updateRun(runId, { status: 'running' });
      for (const b of q.listBranches(runId)) {
        if (!isTerminal(b.state)) writer.appendInbox({ runId, branchId: b.id, kind: 'notice', text: RESUMED_NOTICE });
      }
      this.deps.scheduler.resumeRun(runId);
      if (interrupted) {
        for (const b of q.listBranches(runId)) if (!isTerminal(b.state)) this.deps.runners.ensure(b.id);
        this.lifecycle.background(this.prepare(runId));
      }
      return next;
    });
  }

  // ── 结束 ──────────────────────────────────────────────────────────

  async cancel(runId: Id): Promise<Run> {
    const run = this.lifecycle.mustRun(runId);
    if (isEnded(run)) throw conflict('任务已经结束');
    this.settlement.assertNotClosing(runId);
    if (run.mode === 'settling') throw conflict('任务正在收尾，已经有路线交了结果');
    // 先中止在途的：准备中的 Scoper、在跑的 episode 马上停下，再按顺序结束
    this.deps.scopes.abort(runId, CANCELLED_REASON);
    return this.settlement.end(runId, { status: 'cancelled', reason: CANCELLED_REASON });
  }

  // ── 进程启动、退出 ──────────────────────────────────────────────────────

  /** 恢复后开始调度：容器跟着分支状态走，未完成的交付继续收尾。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.settlement.start();
    const { queries: q, scheduler } = this.deps;
    this.unsubscribe = this.deps.bus.subscribe((e) => {
      if (!e.runId) return;
      switch (e.type) {
        case 'run.updated':
          if (e.data.mode === 'settling' && !isEnded(e.data)) this.lifecycle.background(this.settle(e.data.id));
          return;
        case 'branch.updated':
          this.onBranch(e.data);
          return;
        case 'episode.closed':
          this.onClosed(e.runId, e.data.branchId);
          return;
        default:
          return;
      }
    });
    for (const run of q.listRuns({ status: ['paused'] })) {
      scheduler.pauseRun(run.id);
    }
    this.deps.runners.start();
    for (const run of q.listRuns({ status: ['running', 'paused'] })) {
      // 收尾到一半崩了的（暂停中提交的候选也照常交付，）
      if (run.mode === 'settling') this.lifecycle.background(this.settle(run.id));
    }
  }

  /**
   * 退出：在途作业作废，不写任何收尾。已经开始的取消、放弃、出错例外：episode 都停了以后
   * 只差拼知识报告和 endRun 那一个事务，等它写完再走，人点了取消、嫌慢退出 Melina，重启后任务不会又跑起来
   */
  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.deps.scopes.abortAll('Melina 正在退出');
    this.settlement.stop();
    await this.deps.runners.stop();
    await this.settlement.idle();
    this.deps.scheduler.dispose();
  }

  /** 容器跟着分支状态走：结束就删，暂停就停。 */
  private onBranch(branch: Branch): void {
    if (isTerminal(branch.state)) void this.deps.env.remove(branch);
    else if (branch.state === 'paused' && branch.workspace) void this.deps.env.stop(branch);
  }

  /** 任务暂停时收完尾的分支：停容器，后台进程随之结束 */
  private onClosed(runId: Id, branchId: Id): void {
    const run = this.deps.queries.getRun(runId);
    const branch = this.deps.queries.getBranch(branchId);
    if (run?.status === 'paused' && branch?.state === 'running' && branch.workspace) void this.deps.env.stop(branch);
  }
}
