// Run 的收尾与终态交付：候选 / 未完成 patch、密钥检查、知识报告和 endRun 事务重试。
import { readFile, rm, stat } from 'node:fs/promises';
import type { RunResultResponse } from '../core/api.ts';
import { conflict, MelinaError, notFound } from '../core/errors.ts';
import { type Handle, type Id, ROOT, type SnapshotId } from '../core/ids.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import type { WorkspaceProvider } from '../core/interfaces/workspace.ts';
import type { Candidate, Run, RunResult } from '../core/types.ts';
import { currentVersion, picksOf } from '../projections/versions.ts';
import { errorText, sleep } from './async.ts';
import { isTerminal } from './branch-manager.ts';
import { type Ending, mainRoute } from './knowledge.ts';
import { isEnded, type RunLifecycle, type RunManagerDeps } from './run-lifecycle.ts';
import { CANCEL_NOTES, leakedReason, PATCH_ONLY_REASON } from './templates.ts';

/** 交付前查 patch 时最多读多大（再大就不查、照常交付，记一条日志）。 */
const LEAK_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMMIT_RETRY_DELAYS = [5_000, 30_000, 120_000];
/** 停下时给主路线拍 snapshot 最多等多久；snapshot 本身停不下来，超时只是不再等它 */
const STOP_SNAPSHOT_MS = 60_000;
/** 停下时拍的 snapshot 的 label：只用来算没做完的 patch，不进 RunStore */
const STOP_LABEL = 'stop';

/** 写结果没写进去时给人看的说法：「取消的结果没写进去」 */
const ENDING_WORDS: Record<Ending['status'], string> = {
  done: '交付',
  cancelled: '取消',
  failed: '出错结束',
};

export class RunSettle {
  /** 已经开始的交付、取消、放弃、出错：退出时连同清理一起等完（stop） */
  private readonly endings = new Set<Promise<unknown>>();
  /** 写结果出错、正在后台重试的结束和收尾：Run 和它在说什么（「取消」「交付」……） */
  private readonly closing = new Map<Id, string>();
  /** Melina 退出：停掉写结果的重试 */
  private stopping = new AbortController();
  private readonly deps: RunManagerDeps;
  private readonly lifecycle: RunLifecycle;

  constructor(lifecycle: RunLifecycle) {
    this.lifecycle = lifecycle;
    this.deps = lifecycle.deps;
  }

  start(): void {
    if (this.stopping.signal.aborted) this.stopping = new AbortController();
  }

  stop(): void {
    this.stopping.abort(new MelinaError('unavailable', 'Melina 正在退出'));
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.endings]);
  }

  /** 放弃、取消、出错：拿着这个 Run 的锁结束它；记下在途的，退出时等它写完 */
  end(runId: Id, ending: Exclude<Ending, { status: 'done' }>): Promise<Run> {
    return this.trackEnding(this.lifecycle.locks.run(runId, () => this.finish(runId, ending)));
  }

  private trackEnding<T>(work: Promise<T>): Promise<T> {
    this.endings.add(work);
    const forget = () => {
      this.endings.delete(work);
    };
    work.then(forget, forget);
    return work;
  }

  /**
   * 放弃、取消、出错：结束前那一刻的主路线先定下来，停下在跑的 episode，拼知识报告和主路线没做完的 patch，
   * 最后一个事务结束 Run（endRun：终态和结果、其余分支转 cancelled、提问作废）。这之前不写库：中途进程没了，
   * 重启后任务照常跑；提交前不写分支终态，避免续接调度器提前另开路线。调用方已经拿着这个 Run 的锁。
   */
  private async finish(runId: Id, ending: Exclude<Ending, { status: 'done' }>): Promise<Run> {
    const { queries: q, writer, branches, knowledge } = this.deps;
    const run = this.lifecycle.mustRun(runId);
    if (isEnded(run)) return run;
    // 排在锁后面的另一次结束：前一次已经停下了一切、正在后台重试写结果，不再来一遍
    this.assertNotClosing(runId);
    if (run.mode === 'settling') return this.settleNow(runId);
    const main = mainRoute(q, runId);
    const note = CANCEL_NOTES[ending.status];
    this.deps.scopes.abort(runId, ending.reason || note);
    // 已经交上收尾的 episode 等它落库：带着候选的话任务就进了收尾，照常交付它，
    // 不能当成取消、放弃把候选丢掉
    await branches.quiesce(runId, note);
    if (this.lifecycle.mustRun(runId).mode === 'settling') return this.settleNow(runId);
    // 交过一版的：交付挑中的那一版，
    // 和收尾交付候选同一条路；交付已经做了，重试只重写知识报告和 endRun
    const version = this.deps.picks
      ? await this.deps.picks.settle(runId)
      : versionToDeliver(q, this.lifecycle.mustRun(runId));
    const handed = version ? await this.handOver(this.lifecycle.mustRun(runId), version) : undefined;
    // 没交过一版的：给主路线停下那一刻的 workspace 拍一份，没做完的 patch 从它算（：路线常常一个 episode 跑到底，
    // lastSnapshot 还是起点，取消时什么都交不出）。不进 RunStore、不改 lastSnapshot，只用来算 patch
    const stopped = version ? undefined : await this.stopSnapshot(runId, main);
    const endReason = [ending.reason, handed?.endReason].filter((r) => !!r).join('；');
    return this.commit(runId, ENDING_WORDS[ending.status], async () => {
      const { report, patch } = await knowledge.write(runId, {
        mainRoute: main,
        ending,
        ...(version ? { delivered: version } : {}),
        ...(stopped ? { stopSnapshot: stopped } : {}),
      });
      const result: RunResult =
        version && handed
          ? {
              candidateId: version.id,
              ...(handed.delivered.branch ? { branch: handed.delivered.branch } : {}),
              ...(handed.delivered.patch ? { patch: handed.delivered.patch } : {}),
              knowledgeReport: report,
            }
          : { knowledgeReport: report, ...(patch ? { patch } : {}) };
      writer.endRun(runId, {
        status: ending.status,
        ...(endReason ? { endReason } : {}),
        result,
        branchNote: note,
      });
    });
  }

  /**
   * 结束、收尾的最后一步：拼知识报告、endRun 那一个事务。走到这里时这个 Run 的在途作业和续接调度已经停止，
   * 中止撤不回，所以写不进去（磁盘满、库出错）时不能撂下：以前库里还是「在跑」、进程里却谁也不再推它，
   * 追加指令、暂停再恢复都叫不醒，收尾的还挡着取消和暂停，只能重启 Melina。
   * 现在第一次出错就把原因交回调用方（取消的人看得到），同时在后台按间隔接着写，直到写进去；这期间暂停、恢复、取消、放弃、
   * 追加指令都直接说在重试（assertNotClosing）。Melina 退出时不再重试：库里没结束，重启后照 的语义处理
   * （取消、放弃、出错的任务照常接着跑，收尾的重新交付）。
   * write 只管写结果；写进去以后的清理（afterEnd）出错只记日志，任务已经结束了。
   */
  private async commit(runId: Id, what: string, write: () => Promise<void>): Promise<Run> {
    const once = async (): Promise<Run> => {
      if (!isEnded(this.lifecycle.mustRun(runId))) await write();
      try {
        await this.afterEnd(runId);
      } catch (error) {
        this.deps.log?.(`任务 ${runId} 结束后清理出错：${errorText(error)}`);
      }
      return this.lifecycle.mustRun(runId);
    };
    try {
      return await once();
    } catch (error) {
      this.deps.log?.(`任务 ${runId} ${what}的结果没写进去，后台接着重试：${errorText(error)}`);
      this.closing.set(runId, what);
      const retry = this.retryCommit(runId, what, once);
      this.endings.add(retry);
      void retry.finally(() => this.endings.delete(retry));
      throw new MelinaError(
        'unavailable',
        `${what}的结果没写进去（${errorText(error)}）。任务已经停下，Melina 在后台接着重试，写进去以后任务就结束了`,
      );
    }
  }

  /** 写结果的重试：每次先等一会儿再拿这个 Run 的锁（第一次失败时调用方还拿着锁，等它放掉） */
  private async retryCommit(runId: Id, what: string, once: () => Promise<Run>): Promise<void> {
    const delays = this.deps.commitRetryDelaysMs ?? DEFAULT_COMMIT_RETRY_DELAYS;
    for (let attempt = 1; ; attempt++) {
      const delay = delays[Math.min(attempt, delays.length) - 1] ?? 0;
      try {
        await sleep(this.deps.clock, delay, this.stopping.signal);
      } catch {
        this.closing.delete(runId);
        this.deps.log?.(`Melina 退出时任务 ${runId} ${what}的结果还没写进去：重启后按没结束处理`);
        return;
      }
      try {
        await this.lifecycle.locks.run(runId, once);
        this.closing.delete(runId);
        this.deps.log?.(`任务 ${runId} ${what}的结果重试第 ${attempt} 次写进去了`);
        return;
      } catch (error) {
        this.deps.log?.(`任务 ${runId} ${what}的结果重试第 ${attempt} 次还是没写进去：${errorText(error)}`);
      }
    }
  }

  /** 写结果出错、正在后台重试的任务不再收别的操作：说清楚它在等什么 */
  assertNotClosing(runId: Id): void {
    const what = this.closing.get(runId);
    if (what !== undefined) {
      throw conflict(`任务正在结束：${what}的结果上次没写进去，Melina 在后台重试，写进去以后任务就结束了`);
    }
  }

  /**
   * 收尾：有分支提交了候选（closeEpisode 的同一个事务把 Run 切到了 settling）。
   * 取消其余分支（「另一条路线先交了」），交付：仓库类任务推成用户仓库的 melina/<runId> 分支，都另存相对起点的 patch；
   * 附一份知识报告，Run 转 done。任务暂停中也照常交付。
   */
  settle(runId: Id): Promise<void> {
    return this.trackEnding(
      this.lifecycle.locks.run(runId, async () => {
        await this.settleNow(runId);
      }),
    );
  }

  /** 收尾的本体；调用方已经拿着这个 Run 的锁。返回结束后的 Run */
  private async settleNow(runId: Id): Promise<Run> {
    const { queries: q, writer, branches, knowledge } = this.deps;
    let run = this.lifecycle.mustRun(runId);
    if (isEnded(run) || run.mode !== 'settling') return run;
    if (this.closing.has(runId)) return run; // 已经交付过、在后台重试写结果
    // 收尾交付的是 end_episode 交的那个候选
    const candidate = finalCandidate(q, runId);
    if (!candidate) {
      // 不该发生：RunStore 在同一个事务里写候选、切 settling
      this.deps.log?.(`任务 ${runId} 进了收尾却找不到候选`);
      return run;
    }
    this.deps.scopes.abort(runId, CANCEL_NOTES.settling);
    for (const b of q.listBranches(runId)) {
      if (b.id === candidate.branchId || isTerminal(b.state)) continue;
      try {
        await branches.cancel(b.id, CANCEL_NOTES.settling);
      } catch (error) {
        // 写不进去（磁盘满、库出错）：它的 episode 已经中止了，状态留给最后 endRun 的那一个事务一起转 cancelled，
        // 交付照常往下走。以前这里一抛出去，任务就卡在收尾中，取消、暂停都被「正在收尾」拒掉，只能重启
        this.deps.log?.(`任务 ${runId} 收尾时停分支 ${b.id} 出错，留给结束时一起停：${errorText(error)}`);
      }
    }
    run = this.lifecycle.mustRun(runId);
    const { delivered, endReason } = await this.handOver(run, candidate);
    // 交付已经做了：重试只重写知识报告和 endRun，不再推一遍分支
    return this.commit(runId, ENDING_WORDS.done, async () => {
      const { report } = await knowledge.write(runId, { ending: { status: 'done' } });
      writer.endRun(runId, {
        status: 'done',
        ...(endReason ? { endReason } : {}),
        result: {
          candidateId: candidate.id,
          ...(delivered.branch ? { branch: delivered.branch } : {}),
          ...(delivered.patch ? { patch: delivered.patch } : {}),
          knowledgeReport: report,
        },
        branchNote: CANCEL_NOTES.settling,
      });
    });
  }

  /**
   * 交付一个候选或交的一版：仓库类任务推成用户仓库的 melina/<runId> 分支，都另存相对起点的 patch；
   * 改动里有像密钥的东西只交 patch。不抛错：交付出错时任务照样结束，endReason 写明出了什么错、为什么只交了 patch
   */
  /**
   * 取消、放弃、出错时主路线停下那一刻的 snapshot：在跑的 episode 已经停下（quiesce），workspace 还在。
   * 冻结容器再拍（和收尾一样）；最多等 STOP_SNAPSHOT_MS，出错、超时只记日志，退回 lastSnapshot
   */
  private async stopSnapshot(runId: Id, main: Id | undefined): Promise<SnapshotId | undefined> {
    const run = this.lifecycle.mustRun(runId);
    const b = main ? this.deps.queries.getBranch(main) : undefined;
    if (!b?.workspace) return undefined;
    const ws = b.workspace;
    try {
      const work = this.deps.workspaces.forRun(run).snapshot(ws, STOP_LABEL);
      const timeout = new Promise<undefined>((resolve) => {
        const t = setTimeout(() => resolve(undefined), STOP_SNAPSHOT_MS);
        work.then(
          () => clearTimeout(t),
          () => clearTimeout(t),
        );
      });
      const snap = await Promise.race([work, timeout]);
      if (snap === undefined) this.deps.log?.(`任务 ${runId} 停下时给主路线拍 snapshot 超时，patch 用最近一次收尾的`);
      return snap;
    } catch (error) {
      this.deps.log?.(`任务 ${runId} 停下时给主路线拍 snapshot 出错，patch 用最近一次收尾的：${errorText(error)}`);
      return undefined;
    }
  }

  private async handOver(
    run: Run,
    candidate: Candidate,
  ): Promise<{ delivered: { branch?: string; patch?: Handle }; endReason?: string }> {
    const runId = run.id;
    let delivered: { branch?: string; patch?: Handle } = {};
    let deliverError: string | undefined;
    let leaks: string[] = [];
    const owner = this.deps.queries.getBranch(candidate.branchId);
    try {
      if (!owner?.workspace) throw new Error('交它的分支没有 workspace');
      const provider = this.deps.workspaces.forRun(run);
      const leaked = await this.leakedIn(run, provider, candidate.snapshot);
      if (leaked) {
        // 改动里有像密钥的东西：不推分支（推了就进了用户的仓库），只交相对起点的 patch
        leaks = leaked.leaks;
        delivered = { patch: leaked.patch };
        this.deps.log?.(`任务 ${runId} 交付的改动里有像密钥的东西（${leaks.join('、')}），不推分支、只交 patch`);
      } else {
        delivered = await provider.deliver(owner.workspace, candidate.snapshot);
      }
    } catch (error) {
      deliverError = errorText(error);
      this.deps.log?.(`任务 ${runId} 交付出错：${deliverError}`);
    }
    // 仓库类任务没推成分支、只交了 patch（改动里有密钥、用户仓库用了 filter，或者推的时候出错）：结果页上说一句为什么
    const pushes = run.workspace.kind === 'git-clone';
    const patchOnly = !deliverError && pushes && !delivered.branch;
    const endReason = deliverError
      ? `交付时出错：${deliverError}`
      : leaks.length > 0
        ? leakedReason(leaks, pushes)
        : patchOnly
          ? PATCH_ONLY_REASON
          : undefined;
    return { delivered, ...(endReason ? { endReason } : {}) };
  }

  /**
   * 交付前查一遍候选相对起点的改动里有没有密钥：agent 干活时会把登录拿到的 token、抓下来的数据写进工作目录，
   * 推成分支就进了用户的仓库。有的话交回那份 patch 和在哪几处；没接钩子、patch 太大、查的时候出错就照常交付（记一条日志）
   */
  private async leakedIn(
    run: Run,
    provider: WorkspaceProvider,
    snapshot: SnapshotId,
  ): Promise<{ patch: Handle; leaks: string[] } | undefined> {
    const leaksIn = this.deps.secrets?.leaksIn;
    if (!leaksIn) return undefined;
    try {
      const patch = await provider.diffSnapshots(ROOT, snapshot);
      const path = this.deps.artifacts.path(run.id, patch);
      if ((await stat(path)).size > LEAK_SCAN_MAX_BYTES) {
        this.deps.log?.(`任务 ${run.id} 交付的 patch 太大，没查密钥，照常交付`);
        return undefined;
      }
      const leaks = leaksIn.call(this.deps.secrets, await readFile(path, 'utf8'));
      return leaks.length > 0 ? { patch, leaks } : undefined;
    } catch (error) {
      this.deps.log?.(`任务 ${run.id} 交付前查密钥出错，照常交付：${errorText(error)}`);
      return undefined;
    }
  }

  private async afterEnd(runId: Id): Promise<void> {
    this.deps.scheduler.dropRun(runId);
    this.deps.secrets?.drop(runId);
    await this.deps.env.removeScoper(runId);
  }

  // ── 删除、结果 ──────────────────────────────────────────────────────────

  delete(runId: Id): Promise<void> {
    return this.lifecycle.locks.run(runId, async () => {
      const { queries: q, writer, env, artifacts, paths } = this.deps;
      const run = q.getRun(runId);
      if (!run) throw notFound(`任务 ${runId} 不存在`);
      if (!isEnded(run)) throw conflict('只能删除已经结束的任务');
      for (const b of q.listBranches(runId)) await env.remove(b);
      await env.removeScoper(runId);
      writer.deleteRun(runId);
      await artifacts.deleteRun(runId);
      await this.removeDir(paths.run(runId));
      await this.removeDir(paths.emptyRoot(runId));
      this.deps.scopes.forget(runId);
      this.deps.scheduler.dropRun(runId);
      this.deps.secrets?.drop(runId);
    });
  }

  private async removeDir(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if (!this.deps.forceRemove) throw error;
      // 容器里别的用户写的文件在宿主机上属于 subuid，Melina 自己删不掉
      await this.deps.forceRemove(path);
    }
  }

  async result(runId: Id): Promise<RunResultResponse> {
    const run = this.lifecycle.mustRun(runId);
    if (!isEnded(run) || !run.result) throw conflict('任务还没结束，没有结果');
    const r = run.result;
    const candidate = r.candidateId
      ? this.deps.queries.candidates(runId).find((c) => c.id === r.candidateId)
      : undefined;
    return {
      runId,
      status: run.status,
      ...(run.endReason ? { endReason: run.endReason } : {}),
      ...(candidate ? { candidate } : {}),
      ...(r.branch ? { branch: r.branch } : {}),
      ...(r.patch ? { patch: r.patch } : {}),
      unfinished: !candidate && r.patch !== undefined,
      ...(candidate?.artifact && candidate.artifactPath
        ? { artifact: { handle: candidate.artifact, path: candidate.artifactPath } }
        : {}),
      knowledgeReport: r.knowledgeReport,
    };
  }
}

/** end_episode 交的候选（进收尾的那个）；交的一版不算 */
export function finalCandidate(q: RunStoreQueries, runId: Id): Candidate | undefined {
  return q.candidates(runId).find((c) => !c.interim);
}

/** 任务取消、放弃、出错结束时交付的那一版：最近一次挑中的 */
export function versionToDeliver(q: RunStoreQueries, run: Run): Candidate | undefined {
  return currentVersion(q.candidates(run.id), picksOf(q, run.id));
}
