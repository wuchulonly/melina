// 崩溃恢复：恢复任务、分支与未完成的准备或收尾工作。
// 1. 扫描 running、paused 的 Run；暂停的恢复完仍是暂停。数据目录的文件锁由进程入口在打开 RunStore 之前拿好（api/data-lock.ts，
// 恢复时才拿，第二个进程在那之前已经写过库了）。
// 2. 在跑的分支：丢弃在途 episode，停掉容器，restore 到 lastSnapshot（后台进程随之结束，装过的东西还在，下个 episode 开始时起容器）；

// 3. 只有意图、没有结果的 sh 调用：不自动重放，往那条分支的收件箱放一条提示，由 Explorer 先查清。

// 4. 准备到一半的（Scoper 没起草完、初始求解分支没开全）接着准备；收尾到一半的接着交付。
// 开头先删上次留下的临时容器，和已经结束的任务、分支还留着的容器（结束那一刻崩了，没来得及删；「本机资源耗尽」）。
// 只删这个数据目录里的任务的：同一个容器引擎上可能还开着别的 Melina（跑分时每组一个），它们的容器不归这里管。
// 每恢复一个 Run 记一条 run.recovered（哪些分支退回了上次收尾、哪些 act 不知道生效没有、是不是重新起草完成标准），
// 时间线上人看得到 Melina 重启过；给 Explorer 的还是收件箱里的提示，排在 run.recovered 后面（前端靠这个顺序去重）。

import type { Id } from '../core/ids.ts';
import type { ContainerRef, ContainerRuntime } from '../core/interfaces/container.ts';
import type { Recovery, RecoveryReport } from '../core/interfaces/runtime.ts';
import type { RunStoreQueries, RunStoreWriter } from '../core/interfaces/store.ts';
import type { WorkspaceProviders } from '../core/interfaces/workspace.ts';
import { ENDED_RUN_STATUSES, type Run } from '../core/types.ts';
import { errorText } from './async.ts';
import type { BranchEnv } from './branch-env.ts';
import { isTerminal, type RuntimeBranchManager } from './branch-manager.ts';
import { preparationPending } from './run-bootstrap.ts';
import { type RunSecretsHook, type RuntimeRunManager, scoperPending } from './run-manager.ts';
import { RECOVERED_NOTICE, unknownCommandNotice } from './templates.ts';

export interface RecoveryDeps {
  queries: RunStoreQueries;
  writer: Pick<RunStoreWriter, 'appendInbox' | 'recordRecovery'>;
  workspaces: WorkspaceProviders;
  env: BranchEnv;
  /**
   * 有的话：开头删掉这个数据目录里的任务上次留下的临时容器，和已经结束的任务、分支还留着的容器
   * ；列不出的运行时（开发机的 proot）调它自己的 removeEphemeral
   */
  containers?: ContainerRuntime | undefined;
  branches: RuntimeBranchManager;
  runs: RuntimeRunManager;
  /** 工作目录和附件里原有的密钥：打码表只在内存里，重启后给在跑的任务重新登记 */
  secrets?: Pick<RunSecretsHook, 'add'> | undefined;
  onRecover?: (runId: Id) => Promise<void>;
  log?: (text: string) => void;
}

/** 容器运行时在接口之外的两个方法 */
interface LeftoverContainers {
  removeEphemeral?: () => Promise<string[]>;
  managed?: () => Promise<{ ref: ContainerRef; ephemeral: boolean; labels: Record<string, string> }[]>;
}

export class RuntimeRecovery implements Recovery {
  private readonly deps: RecoveryDeps;

  constructor(deps: RecoveryDeps) {
    this.deps = deps;
  }

  async run(): Promise<RecoveryReport> {
    const q = this.deps.queries;
    await this.removeLeftovers();
    const report: RecoveryReport = { runs: [], branches: [], unknownCommands: [], rescoped: [] };
    for (const run of q.listRuns({ status: ['running', 'paused'] })) {
      report.runs.push(run.id);
      try {
        await this.recoverRun(run, report);
      } catch (error) {
        this.deps.log?.(`恢复任务 ${run.id} 时出错：${errorText(error)}`);
      }
    }
    return report;
  }

  private async recoverRun(run: Run, report: RecoveryReport): Promise<void> {
    const { queries: q, workspaces, env, branches, writer } = this.deps;
    // 先把密钥登记回打码表，再让任何分支、Scoper 跑起来（打码表只在内存里）
    await this.step(`任务 ${run.id} 的密钥登记`, async () => {
      await this.deps.secrets?.add(run);
    });
    const provider = workspaces.forRun(run);
    const restored: Id[] = [];
    for (const b of q.listBranches(run.id)) {
      if (b.state === 'running' && b.workspace) {
        try {
          // restore 之前先停掉这个 workspace 的容器
          await env.stop(b);
          await provider.restore(b.workspace, b.lastSnapshot);
        } catch (error) {
          // 改不回上次收尾时的样子：workspace 的状态说不清了，这条分支不再跑，原因写进 stateNote
          this.deps.log?.(`分支 ${b.id} 恢复失败：${errorText(error)}`);
          await branches
            .apply({
              kind: 'fail',
              branchId: b.id,
              reason: `崩溃恢复时没能把 workspace 改回上次收尾时的样子：${errorText(error)}`,
            })
            .catch((e) => this.deps.log?.(`分支 ${b.id} 转 failed 失败：${errorText(e)}`));
          continue;
        }
        restored.push(b.id);
      } else if (b.state === 'paused' && b.workspace) {
        await env.stop(b);
      }
    }
    // 只有意图、没有结果的 sh 调用：只提示崩溃时在途的那个 episode 的（更早的上次恢复时已经提示过）
    const commands = q.pendingShIntents(run.id).filter((intent) => {
      const b = q.getBranch(intent.branchId);
      return !!b && !isTerminal(b.state) && intent.episode === b.episode;
    });
    // 先记 run.recovered，再往各分支的收件箱放提示：顺序定死，前端看到它就不再按这次恢复的提示各写一条「Melina 重启过」
    await this.step(`任务 ${run.id} 的重启记录`, () => {
      writer.recordRecovery(run.id, {
        branches: restored,
        unknownCommands: commands.map((a) => a.id),
        rescoped: scoperPending(q, run),
      });
    });
    // 可选扩展在容器停止后恢复；它补发的收件箱也必须排在 run.recovered 之后。
    await this.step(`任务 ${run.id} 的扩展状态恢复`, async () => {
      await this.deps.onRecover?.(run.id);
    });
    for (const id of restored) {
      await this.step(`分支 ${id} 恢复后的提示`, async () => {
        writer.appendInbox({ runId: run.id, branchId: id, kind: 'notice', text: RECOVERED_NOTICE });
        await branches.recover(id);
      });
      report.branches.push(id);
    }
    await this.step(`任务 ${run.id} 的命令提示`, () => {
      for (const intent of commands) {
        writer.appendInbox({
          runId: run.id,
          branchId: intent.branchId,
          kind: 'notice',
          text: unknownCommandNotice(intent.cmd, intent.expect),
        });
        report.unknownCommands.push(intent.id);
      }
    });
    const pending = scoperPending(q, run);
    const preparing = preparationPending(q, run);
    if (pending) report.rescoped.push(run.id);
    // 不等它（Scoper 要好几分钟），但出错要记下来：以前 void 掉，准备出错后转 failed 也没写进去时什么都看不到
    if (preparing) {
      this.deps.runs
        .prepare(run.id)
        .catch((error: unknown) => this.deps.log?.(`任务 ${run.id} 恢复后接着准备出错：${errorText(error)}`));
    }
  }

  private async step(what: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.deps.log?.(`${what}出错：${errorText(error)}`);
    }
  }

  /**
   * 上次留下的容器，只看这个数据目录里的任务的（melina.run 标签是库里有的 Run）：同一个容器引擎上可能还开着别的 Melina（跑分时每组一个），
   * 它们的容器认不出、也不归这里管，一律不碰。
   * 临时容器（Scoper、setup 用的）都删：恢复时这个进程里还没有在途的；分支容器只删任务已经结束、分支已经结束（或没了）的——
   * 结束那一刻 Melina 崩了，onBranch 还没来得及删。在跑的、暂停的分支的容器留着，下面照常恢复。
   * 列不出容器的运行时（开发机的 proot）交给它自己的 removeEphemeral（它按自己的根目录认上一个进程留下的）
   */
  private async removeLeftovers(): Promise<void> {
    const extra = this.deps.containers as (ContainerRuntime & LeftoverContainers) | undefined;
    if (!extra) return;
    if (typeof extra.managed !== 'function') {
      if (typeof extra.removeEphemeral !== 'function') return;
      try {
        await extra.removeEphemeral();
      } catch (error) {
        this.deps.log?.(`删上次留下的临时容器出错：${errorText(error)}`);
      }
      return;
    }
    let all: Awaited<ReturnType<NonNullable<LeftoverContainers['managed']>>>;
    try {
      all = await extra.managed();
    } catch (error) {
      this.deps.log?.(`列上次留下的容器出错：${errorText(error)}`);
      return;
    }
    const q = this.deps.queries;
    for (const c of all) {
      const runId = c.labels['melina.run'];
      const run = runId ? q.getRun(runId) : undefined;
      if (!run) continue;
      const branchId = c.labels['melina.branch'];
      const branch = branchId ? q.getBranch(branchId) : undefined;
      const stale = c.ephemeral || isEndedRun(run) || (branchId !== undefined && (!branch || isTerminal(branch.state)));
      if (!stale) continue;
      try {
        await extra.remove(c.ref);
        this.deps.log?.(
          `删掉了上次留下的${c.ephemeral ? '临时容器' : '容器'} ${c.ref.name}${c.ephemeral ? '' : '（任务或分支已经结束）'}`,
        );
      } catch (error) {
        this.deps.log?.(`删上次留下的容器 ${c.ref.name} 出错：${errorText(error)}`);
      }
    }
  }
}

function isEndedRun(run: Run): boolean {
  return (ENDED_RUN_STATUSES as readonly string[]).includes(run.status);
}
