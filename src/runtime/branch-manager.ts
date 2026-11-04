// 不合状态机的由 RunStoreWriter 拒绝（conflict）。另外登记正在跑的 episode：kill 立即中止它，追加内容（steer）交给它。
//

// Run 收尾或取消时其余的 → cancelled，系统错误或连续失败 → failed。任务暂停时分支状态不变，只是不再被调度。
//
// kill、取消先中止在跑的 episode；它要是已经交上了收尾（收尾工具被接受了，比如提交了候选），等 runner 把这次收尾落库再执行：
// 落库后分支已经结束（交了候选、探索结束）的，kill 被拒，取消什么都不做（core/interfaces/agents.ts 的 EpisodeOutcome）。

import { constants as fsConstants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { closeTransition } from '../core/branch-state.ts';
import { conflict, MelinaError, notFound } from '../core/errors.ts';
import type { Handle, Id, SnapshotId } from '../core/ids.ts';
import type { EpisodeHandle, EpisodeOutcome } from '../core/interfaces/agents.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import { CONTAINER_PATHS } from '../core/interfaces/container.ts';
import type { BranchCommand, BranchManager } from '../core/interfaces/runtime.ts';
import type {
  CloseEpisodeInput,
  DeliverVersionResult,
  NewCandidate,
  RunStoreQueries,
  RunStoreWriter,
} from '../core/interfaces/store.ts';
import { type Bet, type Branch, type BranchState, type Run, TERMINAL_BRANCH_STATES } from '../core/types.ts';
import { errorText, SerialQueue } from './async.ts';
import { CANCEL_NOTES, FAILURE_WHY, failedEpisodeNotice, pauseHint } from './templates.ts';

export interface BranchManagerDeps {
  writer: RunStoreWriter;
  queries: RunStoreQueries;
  artifacts: ArtifactStore;
  /**
   * 先冻结挂着这个 workspace 的容器再在宿主机上读（和打 snapshot 一样）：读交付物时用。
   * 进程入口接容器运行时的 withWorkspaceFrozen；没有容器（测试）就不给
   */
  freeze?: <T>(path: string, work: () => Promise<T>) => Promise<T>;
  log?: (text: string) => void;
}

/** 正在跑的 episode */
export interface RunningEpisode {
  branchId: Id;
  runId: Id;
  handle: EpisodeHandle;
  abort: AbortController;

  startSeq: number;
  /** 给它看过的分支消息到哪个 seq（Layout.seenSeq，之后追加的内容往后挪） */
  seenSeq: number;
  /** runner 处理完这个 episode（收尾落库，或者丢掉）时兑现：detach、forget 时 */
  settled: Promise<void>;
  settle: () => void;
}
export interface VersionDraft {
  episode: number;
  claim: string;
  artifact?: string | undefined;
}

/** 交付物最大多大（主要交付物是单个文件时， end_episode.candidate 的 artifact） */
const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

/** 存个阶段版时打的 snapshot 的标签：只记在 workspace 自己的存储里（WorkspaceProvider.snapshot 的 label），RunStore 上的 Snapshot 不带 */
export const VERSION_LABEL = 'version';

export function isTerminal(state: BranchState): boolean {
  return (TERMINAL_BRANCH_STATES as readonly BranchState[]).includes(state);
}

export class RuntimeBranchManager implements BranchManager {
  private readonly deps: BranchManagerDeps;
  private readonly queue = new SerialQueue();
  private readonly episodes = new Map<Id, RunningEpisode>();
  /** closeEpisode 要用的开始 seq：detach 之后、收尾之前还要 */
  private readonly starts = new Map<Id, number>();

  constructor(deps: BranchManagerDeps) {
    this.deps = deps;
  }

  // ── 命令 ────────────────────────────────────────────────────────────────

  apply(command: BranchCommand): Promise<Branch> {
    if (command.kind === 'cancel') {
      return this.stopping(command.branchId, CANCEL_NOTES.cancelled, undefined, () => this.applyNow(command));
    }
    return this.queue.run(() => this.applyNow(command));
  }

  /** Run 收尾、取消、放弃、出错时停下其余分支：stateNote 写清为什么停 */
  cancel(branchId: Id, note: string): Promise<Branch> {
    return this.stopping(branchId, note, undefined, () => this.cancelNow(branchId, note));
  }

  /**
   * kill、取消：先查（不合规的 kill 不能让在跑的 episode 白丢），再中止在跑的 episode。它的收尾工具要是已经被接受了
   * （done 交回了 close），等 runner 把这次收尾落库（或丢掉）再执行，免得把交上来的候选、证伪当成迟到写入丢掉。
   * 等的时候不占着命令队列：收尾落库自己也要排这个队
   */
  private async stopping(
    branchId: Id,
    reason: string,
    check: (() => unknown) | undefined,
    then: () => Branch,
  ): Promise<Branch> {
    if (check) await this.queue.run(check);
    const ep = this.episodes.get(branchId);
    if (ep) {
      this.abortEpisode(branchId, reason);
      await drained(ep);
    }
    return this.queue.run(then);
  }

  /**
   * Run 要结束了（取消、放弃、出错）：中止它在跑的 episode，已经交上收尾的（收尾工具被接受了，比如提交了候选）等 runner
   * 落库再回来。不写分支状态：其余分支由 RunStore 在结束 Run 的那一个事务里转 cancelled（RunStoreWriter.endRun），
   * 结束之前进程没了，库里就没有停了一半的分支
   */
  async quiesce(runId: Id, reason: string): Promise<void> {
    const eps = this.running(runId);
    for (const ep of eps) this.abortEpisode(ep.branchId, reason);
    await Promise.all(eps.map(drained));
  }

  /** 宿主中断的工作区存档仍经分支单写者落库 */
  checkpoint(branchId: Id, snapshot: { id: SnapshotId }, live?: { episode: number; handoff: string }): Promise<Branch> {
    return this.queue.run(() => {
      if (!this.deps.writer.checkpointBranch) throw conflict('RunStore 不支持宿主中断时保存工作区');
      return this.deps.writer.checkpointBranch(branchId, snapshot, live);
    });
  }

  private applyNow(cmd: BranchCommand): Branch {
    const { writer } = this.deps;
    switch (cmd.kind) {
      case 'open':
        return this.open(cmd.runId, cmd.bet, cmd.parentBranchId);
      case 'started': {
        const b = this.branch(cmd.branchId);
        if (b.state === 'starting') {
          return writer.updateBranch(b.id, { state: 'running', queued: false, workspace: cmd.workspace });
        }
        if (b.state === 'running') return writer.updateBranch(b.id, { queued: false, workspace: cmd.workspace });
        throw conflict(`分支 ${b.id} 是 ${b.state}，不能开始跑`);
      }
      case 'queued': {
        const b = this.branch(cmd.branchId);
        if (b.queued === cmd.queued || isTerminal(b.state)) return b;
        return writer.updateBranch(b.id, { queued: cmd.queued });
      }
      case 'pause':
        return this.pause(cmd.branchId, cmd.reason);
      case 'resume':
        return this.resume(cmd.branchId);
      case 'prioritize': {
        const b = this.branch(cmd.branchId);
        if (isTerminal(b.state)) throw conflict(`分支 ${b.id} 已经结束（${b.state}）`);
        return writer.updateBranch(b.id, { weight: cmd.weight });
      }
      case 'cancel':
        return this.cancelNow(cmd.branchId, CANCEL_NOTES.cancelled);
      case 'fail':
        return this.end(cmd.branchId, 'failed', cmd.reason, `分支出错：${cmd.reason}`);
    }
  }

  private open(runId: Id, betInput: Bet, parentBranchId?: Id): Branch {
    const { writer, queries: q } = this.deps;
    const bet = q.getBet(betInput.id) ?? betInput;
    if (bet.runId !== runId) throw conflict(`Bet ${bet.id} 不属于任务 ${runId}`);
    const run = q.getRun(runId);
    if (run?.mode === 'settling') throw conflict('任务正在收尾，不再开新分支');
    const parent = parentBranchId ?? bet.diffFrom?.branchId;
    return writer.createBranch({
      runId,
      betId: bet.id,
      lastSnapshot: bet.startFrom.snapshot,
      ...(parent ? { parentBranchId: parent } : {}),
    });
  }

  private pause(branchId: Id, reason: string): Branch {
    const { writer } = this.deps;
    const b = this.branch(branchId);
    if (b.state === 'paused') return b;
    if (isTerminal(b.state)) throw conflict(`分支 ${b.id} 已经结束（${b.state}）`);
    const ep = this.episodes.get(branchId);
    if (ep && b.state === 'running') {
      const next = writer.updateBranch(b.id, { pendingPause: reason });
      this.safeSteer(ep, pauseHint(reason));
      return next;
    }
    return writer.updateBranch(b.id, { state: 'paused', stateNote: reason, queued: false });
  }

  /** resume：重新排队；还没收尾的暂停直接撤掉 */
  private resume(branchId: Id): Branch {
    const { writer } = this.deps;
    const b = this.branch(branchId);
    if (b.state === 'running' || b.state === 'starting') {
      if (b.pendingPause === undefined) return b;
      return writer.updateBranch(b.id, { pendingPause: undefined });
    }
    if (b.state !== 'paused') throw conflict(`分支 ${b.id} 是 ${b.state}，不能恢复`);
    if (this.deps.queries.getRun(b.runId)?.mode === 'settling') throw conflict('任务正在收尾，不再恢复分支');
    return writer.updateBranch(b.id, { state: 'running', queued: true, stateNote: undefined });
  }

  private cancelNow(branchId: Id, note: string): Branch {
    return this.end(branchId, 'cancelled', note, note);
  }

  private end(branchId: Id, state: 'cancelled' | 'failed', note: string, abortReason: string): Branch {
    const b = this.branch(branchId);
    if (isTerminal(b.state)) return b;
    this.abortEpisode(b.id, abortReason);
    return this.deps.writer.updateBranch(b.id, { state, stateNote: note, queued: false });
  }

  recover(branchId: Id): Promise<Branch> {
    return this.queue.run(() => {
      const { writer } = this.deps;
      const b = this.branch(branchId);
      if (b.state !== 'running') return b;
      if (b.pendingPause !== undefined) {
        return writer.updateBranch(b.id, { state: 'paused', stateNote: b.pendingPause, queued: false });
      }
      return b.queued ? b : writer.updateBranch(b.id, { queued: true });
    });
  }

  // ── 收尾 ───────────────────────────────────────────────────

  closeEpisode(branch: Branch, outcome: EpisodeOutcome, snapshot: SnapshotId | undefined): Promise<Branch> {
    return this.queue.run(async () => {
      const input = await this.closeInput(branch.id, outcome, snapshot);
      const result = this.deps.writer.closeEpisode(input);
      this.starts.delete(branch.id);
      return result.branch;
    });
  }

  /** 收尾内容不合规被 RunStore 拒了（invalid）：只更新 lastSnapshot、记一次失败，照样往收件箱放提示 */
  closeAsFailed(
    branch: Branch,
    outcome: EpisodeOutcome,
    snapshot: SnapshotId | undefined,
    why: string,
  ): Promise<Branch> {
    return this.queue.run(async () => {
      const input = await this.closeInput(branch.id, { ...outcome, failure: 'model_error' }, snapshot, true);
      input.notice = failedEpisodeNotice(why);
      const result = this.deps.writer.closeEpisode(input);
      this.starts.delete(branch.id);
      return result.branch;
    });
  }

  /**
   * 存个阶段版：BranchRunners 打好的 snapshot 交给 RunStore 写成一版，episode 不收尾、Run 不结束（RunStoreWriter.deliverVersion）。
   * 交付物（artifact）和收尾交候选一样存进 Artifact store。分支不在跑、episode 号对不上、Run 在收尾或已结束时 RunStore 拒（conflict）
   */
  deliverVersion(branchId: Id, version: VersionDraft, snapshot: SnapshotId): Promise<DeliverVersionResult> {
    return this.queue.run(async () => {
      const b = this.branch(branchId);
      const run = this.deps.queries.getRun(b.runId);
      if (!run) throw notFound(`分支 ${b.id} 的任务不存在`);
      const candidate: NewCandidate = {
        runId: b.runId,
        branchId: b.id,
        snapshot,
        claim: version.claim,
        interim: true,
      };
      if (version.artifact) {
        const stored = await this.storeArtifact(run, b, version.artifact);
        if (stored) {
          candidate.artifact = stored.handle;
          candidate.artifactPath = stored.path;
        }
      }
      return this.deps.writer.deliverVersion({
        branchId: b.id,
        episode: version.episode,
        snapshot: { id: snapshot },
        candidate,
      });
    });
  }
  private async closeInput(
    branchId: Id,
    outcome: EpisodeOutcome,
    snapshot: SnapshotId | undefined,
    forceFailure = false,
  ): Promise<CloseEpisodeInput> {
    const b = this.branch(branchId);
    const run = this.deps.queries.getRun(b.runId);
    if (!run) throw notFound('任务不存在');
    const close = forceFailure ? undefined : outcome.close;
    const kind = close?.kind === 'candidate' ? 'submitted' : close ? 'ended' : 'failed';
    const t = closeTransition({
      outcome: kind,
      failures: b.failures,
      maxFailures: run.config.episode.maxFailures,
      pendingPause: b.pendingPause,
      detail: outcome.failureDetail,
      runPaused: run.status === 'paused',
    });
    const input: CloseEpisodeInput = {
      branchId: b.id,
      episode: b.episode,
      outcome: kind,
      ...(snapshot ? { snapshot: { id: snapshot } } : {}),
      next: { state: t.state, stateNote: t.stateNote, ...(t.queued !== undefined ? { queued: t.queued } : {}) },
    };
    if (!close) {
      input.failure = outcome.failure ?? 'no_close';
      input.notice = failedEpisodeNotice(outcome.failureDetail ?? FAILURE_WHY[input.failure]);
      return input;
    }
    input.seenSeq = Math.max(b.seenSeq, Math.min(outcome.seenSeq, this.deps.queries.lastSeq()));
    if (close.kind === 'continue') input.handoff = close.handoff;
    if (close.kind === 'candidate') {
      if (!snapshot) throw conflict('最终提交需要快照');
      const candidate: NewCandidate = { runId: b.runId, branchId: b.id, snapshot, claim: close.claim };
      if (close.artifact) {
        const stored = await this.storeArtifact(run, b, close.artifact);
        if (stored) {
          candidate.artifact = stored.handle;
          candidate.artifactPath = stored.path;
        }
      }
      input.candidate = candidate;
    }
    return input;
  }

  /**
   * 主要交付物是单个文件时（end_episode.candidate 的 artifact）：打完 snapshot 后把 workspace 里的这个文件存进 Artifact store。
   * 路径可以写相对 workspace 的，也可以写容器里的 /workspace/…；跟着符号链接走出 workspace 的、不是普通文件的、太大的都不收。
   *
   * 这时容器还活着（后台进程跨 episode 存活）：以前先 realpath 认路径、再按路径读，中间被换成指向宿主机文件的符号链接，
   * Melina 就会把宿主机上它读得到的文件（密钥、数据目录里的东西）当交付物存下来。现在两道：
   * 读的时候先冻结挂着这个 workspace 的容器（freeze，和打 snapshot 一样）；读本身先打开、再认打开的到底是哪个文件，只从这个 fd 读。
   */
  private async storeArtifact(
    run: Run,
    b: Branch,
    path: string,
  ): Promise<{ handle: Handle; path: string } | undefined> {
    const ws = b.workspace?.path;
    if (!ws) return undefined;
    const inContainer = `${CONTAINER_PATHS.workspace}/`;
    const rel = path.startsWith(inContainer) ? path.slice(inContainer.length) : path;
    if (isAbsolute(rel)) {
      this.deps.log?.(`交付物 ${path} 不在 workspace 里，没收`);
      return undefined;
    }
    try {
      const read = () => readWorkspaceFile(ws, rel, ARTIFACT_MAX_BYTES);
      const file = await (this.deps.freeze ? this.deps.freeze(ws, read) : read());
      if (typeof file === 'string') {
        this.deps.log?.(`交付物 ${path} ${file}，没收`);
        return undefined;
      }
      const handle = await this.deps.artifacts.put(run.id, file.content);
      return { handle, path: file.path };
    } catch (error) {
      this.deps.log?.(`交付物 ${path} 读不出来：${errorText(error)}`);
      return undefined;
    }
  }

  // ── 正在跑的 episode ────────────────────────────────────────────────────

  attach(branchId: Id, episode: EpisodeHandle, abort: AbortController): void {
    const b = this.deps.queries.getBranch(branchId);
    this.attachEpisode(branchId, episode, abort, {
      startSeq: this.deps.queries.lastSeq(),
      seenSeq: b?.seenSeq ?? 0,
      runId: b?.runId ?? '',
    });
  }

  /** runner 用的版本：开始的 seq 和 Layout.seenSeq 由它给（拼上下文和开始之间没有别的写入） */
  attachEpisode(
    branchId: Id,
    episode: EpisodeHandle,
    abort: AbortController,
    info: { runId: Id; startSeq: number; seenSeq: number },
  ): void {
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.episodes.get(branchId)?.settle();
    this.episodes.set(branchId, { branchId, handle: episode, abort, ...info, settled, settle });
    this.starts.set(branchId, info.startSeq);
  }

  /** runner 处理完了（收尾落库，或者落不了库）：等着它的 kill、取消接着执行 */
  detach(branchId: Id): void {
    const ep = this.episodes.get(branchId);
    this.episodes.delete(branchId);
    ep?.settle();
  }

  /** episode 丢掉了（kill、取消、退出）：开始的 seq 也不要了 */
  forget(branchId: Id): void {
    const ep = this.episodes.get(branchId);
    this.episodes.delete(branchId);
    this.starts.delete(branchId);
    ep?.settle();
  }

  steer(branchId: Id, text: string, seenSeq?: number): boolean {
    const ep = this.episodes.get(branchId);
    if (!ep) return false;
    if (!this.safeSteer(ep, text, seenSeq)) return false;
    if (seenSeq !== undefined && seenSeq > ep.seenSeq) ep.seenSeq = seenSeq;
    return true;
  }

  /** 正在跑的 episode（给追加内容的 Courier 和任务暂停用） */
  running(runId?: Id): RunningEpisode[] {
    return [...this.episodes.values()].filter((e) => runId === undefined || e.runId === runId);
  }

  episode(branchId: Id): RunningEpisode | undefined {
    return this.episodes.get(branchId);
  }

  /** 中止正在跑的 episode：在途的模型调用和工具进程都收到取消信号 */
  abortEpisode(branchId: Id, reason: string): boolean {
    const ep = this.episodes.get(branchId);
    if (!ep) return false;
    if (!ep.abort.signal.aborted) ep.abort.abort(new MelinaError('conflict', reason));
    return true;
  }

  private safeSteer(ep: RunningEpisode, text: string, seenSeq?: number): boolean {
    try {
      ep.handle.steer(text, seenSeq);
      return true;
    } catch (error) {
      this.deps.log?.(`给分支 ${ep.branchId} 追加内容失败：${errorText(error)}`);
      return false;
    }
  }

  private branch(id: Id): Branch {
    const b = this.deps.queries.getBranch(id);
    if (!b) throw notFound(`分支 ${id} 不存在`);
    return b;
  }
}

/**
 * 在宿主机上读 workspace 里的一个文件（交付物）：先认路径（realpath 落在 workspace 里、是普通文件、不太大），再打开，
 * 打开以后再认一遍打开的到底是哪个文件，内容只从这个 fd 读。打开带 O_NOFOLLOW（最后一段是符号链接不跟）、O_NONBLOCK（FIFO 卡不住）。
 * Linux 上 /proc/self/fd/<fd> 指向真正打开的文件，中间哪一级目录被换成了符号链接也认得出在 workspace 外面；
 * 没有 /proc 的系统比 inode，打开的和刚才认的不是同一个文件就不收。不收时返回原因（给日志）
 */
export async function readWorkspaceFile(
  ws: string,
  rel: string,
  maxBytes: number,
): Promise<{ content: Buffer; path: string } | string> {
  const tooBig = `超过 ${Math.round(maxBytes / (1024 * 1024))} MiB`;
  const root = await realpath(ws);
  const real = await realpath(resolve(root, rel));
  const inside = insideOf(root, real);
  if (inside === undefined) return '指到了 workspace 外面';
  const before = await lstat(real);
  if (!before.isFile()) return '不是普通文件';
  if (before.size > maxBytes) return tooBig;
  const fh = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return '不是普通文件';
    const opened = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => undefined);
    const moved =
      opened !== undefined ? insideOf(root, opened) === undefined : st.dev !== before.dev || st.ino !== before.ino;
    if (moved) return '读的时候被换成了 workspace 外面的文件';
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) return tooBig;
    }
    return { content: Buffer.concat(chunks, total), path: inside.split(sep).join('/') };
  } finally {
    await fh.close();
  }
}

/** path 在 root 里面时返回相对路径（root 本身不算） */
function insideOf(root: string, path: string): string | undefined {
  const inside = relative(root, path);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  return inside;
}

/** 中止以后等它处理完：收尾工具已经被接受了的，等 runner 把这次收尾落库（或丢掉），免得把交上来的候选、证伪当成迟到写入丢掉 */
async function drained(ep: RunningEpisode): Promise<void> {
  const outcome = await ep.handle.done.catch(() => undefined);
  if (outcome?.close) await ep.settled;
}
