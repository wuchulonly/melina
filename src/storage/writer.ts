// RunStoreWriter：所有 RunStore 写入的唯一入口。按记录类型校验、落库、写事件日志，在同一个事务里完成；
// 一个方法一个事务，提交后把这次的事件按 seq 顺序交给 EventBus。
//
// 校验分三层：
// 1. schema：写进去的每条记录、每条事件的 data 都按 src/core 的 schema 校验（EVENT_DATA）。
// 2. 引用：消息、候选和快照关联的记录必须在同一个 Run 里存在、类型对。
// 3. 状态：Run 已结束就拒收（Observation 和用量除外，迟到的照记）；分支不在跑、episode 号对不上就拒收；
//    分支和 Run 的状态只按状态机走；进入 settling 之后再提交的候选整个收尾都拒收，交的一版也不收。
// 出错抛 MelinaError：invalid（不合格式、引用不存在或看不到）、not_found、conflict（状态不对）。

import { closeTransition } from '../core/branch-state.ts';
import { conflict, invalid, notFound } from '../core/errors.ts';
import {
  EVENT_DATA,
  type EventDataMap,
  type EventType,
  type RunRecovered,
  type ShIntent,
  type SystemStatus,
  type UsageUpdated,
  type VersionPicked,
} from '../core/events.ts';
import { type Handle, type Id, newId, ROOT, type SnapshotId } from '../core/ids.ts';
import type {
  BranchPatch,
  CloseEpisodeInput,
  CloseEpisodeResult,
  DeliverVersionInput,
  DeliverVersionResult,
  HumanInputResult,
  NewBet,
  NewBranch,
  NewCandidate,
  NewHumanInput,
  NewInboxItem,
  NewObservation,
  NewRun,
  RunEnding,
  RunPatch,
  RunStoreWriter,
  StoreRecord,
  WatchInput,
} from '../core/interfaces/store.ts';
import {
  type Bet,
  type Branch,
  type BranchState,
  type Candidate,
  ENDED_RUN_STATUSES,
  type InboxItem,
  type Observation,
  type Run,
  type RunMode,
  type RunStatus,
  ScoperOutput,
  TERMINAL_BRANCH_STATES,
  UsageRow,
  type WatchNote,
} from '../core/types.ts';
import { check } from '../core/validate.ts';
import type { LocalEventBus } from './events.ts';
import type { SqliteRunStoreQueries } from './queries.ts';
import type { Store, Tx } from './store.ts';
import { insertRecord, type RecordKind, type RecordOf, updateRecord } from './tables.ts';
import { prepareWatch } from './watch-checks.ts';

export interface WriterOptions {
  store: Store;
  queries: SqliteRunStoreQueries;
  bus: LocalEventBus;
  /** 分配 id，默认 ULID */
  newId?: () => Id;
  /** 引用的句柄必须已经在 Artifact store 里。不给就不查 */
  handleExists?: (runId: Id, handle: Handle) => boolean;
}

/** 直解可以进入交付；进入交付后不再回到探索。 */
const MODE_NEXT: Record<RunMode, readonly RunMode[]> = {
  direct: ['settling'],
  settling: [],
};

/** updateBranch 能做的状态变化；succeeded 只能随 closeEpisode 的收尾内容一起写 */
const BRANCH_NEXT: Record<BranchState, readonly BranchState[]> = {
  starting: ['running', 'paused', 'cancelled', 'failed'],
  running: ['paused', 'cancelled', 'failed'],
  paused: ['running', 'cancelled', 'failed'],
  succeeded: [],
  cancelled: [],
  failed: [],
};

/** closeEpisode 按 episode 的结果能转到的状态 */
const CLOSE_NEXT: Record<CloseEpisodeInput['outcome'], readonly BranchState[]> = {
  submitted: ['succeeded'],
  ended: ['running', 'paused'],
  failed: ['running', 'paused', 'failed'],
};

/** system.updated 留多久（pruneSystemEvents）：24 小时，最新的一条总留着 */
export const SYSTEM_EVENTS_KEEP_MS = 24 * 60 * 60_000;
/** 多久清一次（进程入口按它排）：启动时一次，之后每小时 */
export const SYSTEM_EVENTS_PRUNE_EVERY_MS = 60 * 60_000;
/** 一次最多删几条 */
export const SYSTEM_EVENTS_PRUNE_BATCH = 5000;

export function isRunEnded(status: RunStatus): boolean {
  return (ENDED_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isBranchEnded(state: BranchState): boolean {
  return (TERMINAL_BRANCH_STATES as readonly BranchState[]).includes(state);
}

export class SqliteRunStoreWriter implements RunStoreWriter {
  private readonly store: Store;
  private readonly q: SqliteRunStoreQueries;
  private readonly bus: LocalEventBus;
  private readonly newId: () => Id;
  private readonly handleExists: ((runId: Id, handle: Handle) => boolean) | undefined;

  constructor(options: WriterOptions) {
    this.store = options.store;
    this.q = options.queries;
    this.bus = options.bus;
    this.newId = options.newId ?? newId;
    this.handleExists = options.handleExists;
  }

  // ── Run ─────────────────────────────────────────────────────────────────

  createRun(input: NewRun): Run {
    return this.write((tx) => {
      if (this.q.getRecord(input.id)) throw conflict(`id ${input.id} 已经用过了`);
      if (input.continuedFrom && !this.q.getRun(input.continuedFrom)) {
        throw invalid(`continuedFrom 指向的 Run ${input.continuedFrom} 不存在`);
      }
      for (const m of input.goal.materials) this.checkHandle(input.id, m.handle, `附件「${m.name}」`);
      return this.insert(tx, 'run', 'run.created', (seq) => ({ ...input, seq, mode: 'direct', status: 'running' }));
    });
  }

  updateRun(id: Id, patch: RunPatch): Run {
    return this.write((tx) => {
      const run = this.liveRun(id);
      // 结束只走 endRun：终态和其余分支、提问要在一个事务里写完
      if (patch.status !== undefined && isRunEnded(patch.status)) {
        throw invalid(`结束 Run 用 endRun，updateRun 不写终态（${patch.status}）`);
      }
      const next: Run = {
        ...run,
        ...(patch.mode ? { mode: patch.mode } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      };
      if (next.mode !== run.mode && !MODE_NEXT[run.mode].includes(next.mode)) {
        throw conflict(`Run 的模式不能从 ${run.mode} 改成 ${next.mode}`);
      }
      if (next.status !== run.status) {
        if (next.status === 'running' && run.status !== 'paused')
          throw conflict(`Run 不能从 ${run.status} 回到 running`);
        if (next.status === 'paused' && run.status !== 'running')
          throw conflict(`Run 不能从 ${run.status} 改成 paused`);
        if (next.status === 'paused' && next.mode === 'settling') throw conflict('收尾中的任务不能暂停');
      }
      if (sameJson(run, next)) return run;
      return this.update(tx, 'run', 'run.updated', next);
    });
  }

  endRun(id: Id, ending: RunEnding): Run {
    return this.write((tx) => {
      const run = this.liveRun(id);
      if (!isRunEnded(ending.status)) throw invalid(`endRun 只写终态，${ending.status} 用 updateRun`);
      // 谁先提交就交付谁。进了 settling 的只能交付；done 一定是收尾交付的那个候选
      if (ending.status === 'done') {
        if (run.mode !== 'settling') {
          throw conflict('没有提交的候选，不能完成任务');
        }
        if (!ending.result.candidateId) throw invalid('done 的 result 要带交付的候选');
      } else if (run.mode === 'settling') {
        throw conflict(`任务正在收尾，已经有路线交了结果，只能交付，不能是 ${ending.status}`);
      }
      if (!ending.branchNote.trim()) throw invalid('branchNote 不能是空的：停下的分支要写清为什么停');
      this.checkHandle(id, ending.result.knowledgeReport, '知识报告');
      if (ending.result.patch) this.checkHandle(id, ending.result.patch, 'patch');
      if (ending.result.candidateId) {
        const rec = this.mustBeIn(id, ending.result.candidateId, ['candidate'], 'result.candidateId');
        // 取消、放弃、出错时交付的是交的一版；收尾交的候选只能随 done 交付
        if (ending.status !== 'done' && rec.kind === 'candidate' && !rec.record.interim) {
          throw invalid(`${ending.status} 的 result 只能带交的一版，${ending.result.candidateId} 是收尾交的候选`);
        }
      }
      // 1. 还开着的分支转 cancelled，Bet 跟着关（和 updateBranch 结束分支时一样）
      for (const branch of this.q.listBranches(id)) {
        if (isBranchEnded(branch.state)) continue;
        const next = merge(branch, {
          state: 'cancelled' as const,
          stateNote: ending.branchNote,
          queued: false,
          pendingPause: undefined,
        });
        this.closeBetOf(tx, this.update(tx, 'branch', 'branch.updated', next));
      }
      // Run 的终态，事件排在最后
      const next: Run = {
        ...run,
        status: ending.status,
        endedAt: this.store.now().toISOString(),
        ...(ending.endReason ? { endReason: ending.endReason } : {}),
        result: ending.result,
      };
      return this.update(tx, 'run', 'run.updated', next);
    });
  }

  draftCompletion(runId: Id, out: ScoperOutput): Run {
    check(ScoperOutput, out, 'Scoper 的输出');
    return this.write((tx) => {
      const run = this.liveRun(runId);
      const drafted = this.store
        .stmt("SELECT 1 FROM events WHERE run_id = ? AND type = 'completion.drafted' LIMIT 1")
        .get(run.id);
      if (drafted) throw conflict('Scoper 已经起草过了：完成标准开跑后只读');
      // 建任务时给定的完成标准和领域优先；Scoper 仍补充约束、共用系统、开题画像及准备命令。
      const next: Run = {
        ...run,
        goal: {
          ...run.goal,
          completion: run.goal.completion ?? out.completion,
          constraints: out.constraints,
          domain: run.goal.domain ?? out.domain,
          ...(out.sharedSystems ? { sharedSystems: out.sharedSystems } : {}),
          ...(out.profile ? { profile: out.profile } : {}),
        },
        workspace: {
          ...run.workspace,
          ...(run.workspace.setup === undefined && out.setup !== undefined ? { setup: out.setup } : {}),
        },
      };
      return this.update(tx, 'run', 'completion.drafted', next);
    });
  }
  createBet(input: NewBet): Bet {
    return this.write((tx) => {
      const run = this.liveRun(input.runId);
      if (run.mode === 'settling') throw conflict('任务正在交付');
      const continuation = input.continuation;
      if (continuation) {
        const existing = this.q
          .listBets(run.id)
          .find((b) => b.continuation?.key === continuation.key && b.continuation.slot === continuation.slot);
        if (existing) return existing;
      }
      this.mustBeSnapshot(run.id, input.startFrom.snapshot, '起点');
      if (input.diffFrom) this.mustBeIn(run.id, input.diffFrom.branchId, ['branch'], '源路线');
      const { id, ...rest } = input;
      return this.insert(tx, 'bet', 'bet.created', (seq) => ({ ...rest, id: this.freshId(id), seq, status: 'active' }));
    });
  }

  closeBet(id: Id): Bet {
    return this.write((tx) => {
      const bet = this.must(this.q.getBet(id), `Bet ${id}`);
      if (bet.status === 'closed') return bet;
      this.liveRun(bet.runId);
      return this.update(tx, 'bet', 'bet.updated', { ...bet, status: 'closed' });
    });
  }
  createBranch(input: NewBranch): Branch {
    return this.write((tx) => {
      const run = this.liveRun(input.runId);
      const bet = this.must(this.q.getBet(input.betId), '路线');
      if (bet.runId !== run.id || bet.status !== 'active') throw conflict('路线不属于当前任务或已关闭');
      if (this.q.listBranches(run.id).some((b) => b.betId === bet.id)) throw conflict('路线已经有分支');
      this.mustBeSnapshot(run.id, input.lastSnapshot, '起点');
      if (input.parentBranchId) this.mustBeIn(run.id, input.parentBranchId, ['branch'], '源分支');
      return this.insert(tx, 'branch', 'branch.created', (seq) => ({
        id: this.freshId(input.id),
        runId: run.id,
        seq,
        betId: bet.id,
        state: 'starting',
        queued: true,
        lastSnapshot: input.lastSnapshot,
        seenSeq: seq - 1,
        episode: 1,
        toolCalls: 0,
        failures: 0,
        weight: input.weight ?? 1,
        ...(input.parentBranchId ? { parentBranchId: input.parentBranchId } : {}),
      }));
    });
  }

  updateBranch(id: Id, patch: BranchPatch): Branch {
    return this.write((tx) => {
      const branch = this.mustBranch(id);
      this.liveRun(branch.runId);
      if (isBranchEnded(branch.state)) throw conflict(`分支 ${id} 已经结束（${branch.state}）`);
      const next = merge(branch, patch);
      if (next.state !== branch.state && !BRANCH_NEXT[branch.state].includes(next.state)) {
        throw conflict(`分支 ${id} 不能从 ${branch.state} 改成 ${next.state}`);
      }
      if (patch.lastSnapshot !== undefined) this.mustBeSnapshot(branch.runId, patch.lastSnapshot, 'lastSnapshot');
      if (next.state !== 'running' && next.pendingPause !== undefined) delete next.pendingPause;
      if (sameJson(branch, next)) return branch;
      const updated = this.update(tx, 'branch', 'branch.updated', next);
      if (isBranchEnded(updated.state)) this.closeBetOf(tx, updated);
      return updated;
    });
  }

  checkpointBranch(id: Id, snapshot: { id: SnapshotId }, live?: { episode: number; handoff: string }): Branch {
    return this.write((tx) => {
      const branch = this.mustBranch(id);
      const run = this.liveRun(branch.runId);
      if (live) {
        if (
          run.status !== 'running' ||
          run.mode === 'settling' ||
          branch.state !== 'running' ||
          branch.episode !== live.episode ||
          this.q.getBet(branch.betId)?.kind !== 'direct'
        )
          throw conflict('分支已停止或换代，这次存档作废');
      } else if (run.status !== 'paused') throw conflict('宿主存档只在任务已暂停、进程已停止后写入');
      if (isBranchEnded(branch.state)) throw conflict(`分支 ${id} 已经结束（${branch.state}）`);
      if (this.q.getRecord(snapshot.id) || snapshot.id === ROOT) throw conflict(`snapshot ${snapshot.id} 已经有了`);
      const snap = this.insert(tx, 'snapshot', 'snapshot.created', (seq) => ({
        id: snapshot.id,
        runId: run.id,
        seq,
        branchId: branch.id,
        episode: branch.episode,
        parent: branch.lastSnapshot,
      }));
      return this.update(tx, 'branch', 'branch.updated', {
        ...branch,
        lastSnapshot: snap.id,
        ...(live ? { handoff: live.handoff } : {}),
      });
    });
  }
  closeEpisode(input: CloseEpisodeInput): CloseEpisodeResult {
    return this.write((tx) => {
      const branch = this.mustBranch(input.branchId);
      const run = this.liveRun(branch.runId);
      this.must(this.q.getBet(branch.betId), '路线');
      if (branch.state !== 'running' || branch.episode !== input.episode) throw conflict('分支已停止或会话已换代');
      this.checkCloseShape(input);
      const result: CloseEpisodeResult = { branch, seq: 0 };
      const snapshot = input.snapshot;
      if (snapshot) {
        if (this.q.getRecord(snapshot.id) || snapshot.id === ROOT) throw conflict('快照已存在');
        result.snapshot = this.insert(tx, 'snapshot', 'snapshot.created', (seq) => ({
          id: snapshot.id,
          runId: run.id,
          seq,
          branchId: branch.id,
          episode: branch.episode,
          parent: branch.lastSnapshot,
        }));
      }
      if (input.candidate) {
        const saved = this.insertCandidate(tx, input, run, branch);
        result.candidate = saved.candidate;
        result.run = saved.run;
      }
      const notice = input.notice;
      if (notice)
        this.insert(tx, 'inbox', 'inbox.created', (seq) => ({
          id: this.newId(),
          runId: run.id,
          seq,
          branchId: branch.id,
          kind: 'notice',
          text: notice,
        }));
      const seq = tx.nextSeq();
      tx.event(seq, 'episode.closed', run.id, {
        branchId: branch.id,
        episode: branch.episode,
        outcome: input.outcome,
        ...(input.failure ? { failure: input.failure } : {}),
      });
      result.seq = seq;
      result.branch = this.update(tx, 'branch', 'branch.updated', this.branchAfterClose(input, run, branch));
      if (isBranchEnded(result.branch.state)) this.closeBetOf(tx, result.branch);
      return result;
    });
  }
  deliverVersion(input: DeliverVersionInput): DeliverVersionResult {
    return this.write((tx) => {
      const branch = this.runningBranch(input.branchId, input.candidate.runId);
      const run = this.liveRun(branch.runId);
      if (run.mode === 'settling' || input.episode !== branch.episode) throw conflict('会话已停止或任务正在交付');
      if (input.candidate.interim !== true) throw invalid('阶段版本必须标明 interim');
      if (input.snapshot.id === ROOT || this.q.getRecord(input.snapshot.id)) throw conflict('快照已存在');
      const snapshot = this.insert(tx, 'snapshot', 'snapshot.created', (seq) => ({
        id: input.snapshot.id,
        runId: run.id,
        seq,
        branchId: branch.id,
        episode: branch.episode,
        parent: branch.lastSnapshot,
      }));
      const candidate = this.insertCandidateRecord(tx, input.candidate, run, branch, snapshot.id, '阶段版本');
      return {
        branch: this.update(tx, 'branch', 'branch.updated', { ...branch, lastSnapshot: snapshot.id }),
        snapshot,
        candidate,
      };
    });
  }

  // ── 工具产生的记录（ToolGateway） ───────────────────────────────────────

  appendObservation(input: NewObservation, opts: { countsAsToolCall: boolean }): Observation {
    return this.write((tx) => {
      const run = this.mustRun(input.runId); // Run 结束后迟到的 Observation 照记，审计用
      const branch = input.branchId ? this.mustBranch(input.branchId) : undefined;
      if (branch && branch.runId !== run.id) throw invalid(`分支 ${branch.id} 不属于 Run ${run.id}`);
      this.checkHandle(run.id, input.output, 'Observation.output');
      const { id, ...rest } = input;
      const observation = this.insert(tx, 'observation', 'observation.created', (seq) => ({
        ...rest,
        id: this.freshId(id),
        seq,
      }));
      if (branch && opts.countsAsToolCall) {
        // 工具调用数：同一个事务里加 1，不另发 branch.updated，收尾的那条带上最新值
        updateRecord(this.store, 'branch', { ...branch, toolCalls: branch.toolCalls + 1 });
      }
      return observation;
    });
  }

  appendShIntent(runId: Id, intent: ShIntent): number {
    return this.write((tx) => {
      this.liveRun(runId);
      const branch = this.runningBranch(intent.branchId, runId);
      if (intent.episode !== branch.episode)
        throw conflict(`sh.intent 的 episode 号对不上（分支在第 ${branch.episode} 个）`);
      if (this.q.getRecord(intent.id)) throw conflict(`id ${intent.id} 已经用过了`);
      return this.eventOnly(tx, 'sh.intent', runId, intent);
    });
  }

  appendInbox(input: NewInboxItem): InboxItem {
    return this.write((tx) => {
      this.liveRun(input.runId);
      this.mustBeIn(input.runId, input.branchId, ['branch'], 'branchId');
      if (input.ref) this.mustBeIn(input.runId, input.ref, undefined, 'ref');
      const { id, ...rest } = input;
      return this.insert(tx, 'inbox', 'inbox.created', (seq) => ({ ...rest, id: this.freshId(id), seq }));
    });
  }
  recordHumanInput(input: NewHumanInput): HumanInputResult {
    return this.write((tx) => {
      const run = this.liveRun(input.runId);
      if (run.mode === 'settling') throw conflict('任务正在交付');
      if (input.key) {
        const old = this.q.humanInputs(run.id).find((i) => i.key === input.key);
        if (old) {
          if (old.text !== input.text || !sameJson(old.acceptance, input.acceptance))
            throw conflict('相同输入键的内容不同');
          return { input: old, inbox: [] };
        }
      }
      if (input.acceptance && input.acceptance.accepted > input.acceptance.total) throw invalid('验收数超过总数');
      const saved = this.insert(tx, 'input', 'input.created', (seq) => ({ ...input, id: this.freshId(input.id), seq }));
      const inbox = this.q
        .listBranches(run.id)
        .filter((b) => !isBranchEnded(b.state))
        .map((b) =>
          this.insert(tx, 'inbox', 'inbox.created', (seq) => ({
            id: this.newId(),
            runId: run.id,
            seq,
            branchId: b.id,
            kind: 'human',
            text: input.text,
            ref: saved.id,
          })),
        );
      return { input: saved, inbox };
    });
  }

  recordRecovery(runId: Id, data: RunRecovered): number {
    return this.write((tx) => {
      this.liveRun(runId);
      for (const id of data.branches) this.mustBeIn(runId, id, ['branch'], 'branches');
      return this.eventOnly(tx, 'run.recovered', runId, data);
    });
  }

  /** 挑版：比过的几版都是这个 Run 交的一版、不重复，挑中的在里面；任务结束以后不收 */
  recordPick(runId: Id, pick: VersionPicked): number {
    return this.write((tx) => {
      this.liveRun(runId);
      if (new Set(pick.versions).size !== pick.versions.length) throw invalid('versions 里有重复的版本');
      for (const id of pick.versions) {
        const rec = this.mustBeIn(runId, id, ['candidate'], 'versions');
        if (rec.kind === 'candidate' && !rec.record.interim) throw invalid(`${id} 是收尾交的候选，不是一版`);
      }
      if (!pick.versions.includes(pick.candidateId)) throw invalid('挑中的那一版要在比过的几版里面');
      if (pick.basedOnSeq > this.store.lastSeq()) throw invalid(`basedOnSeq ${pick.basedOnSeq} 比现在最新的 seq 还大`);
      return this.eventOnly(tx, 'version.picked', runId, pick);
    });
  }

  /**
   * 巡检器的一版看法：拿这条路线最新的一版和草稿合并（projections/watch.ts），rev 加 1。只看主干直解路线；
   * 不能比上一版看得早（同一条路线同时只有一轮，runtime/watch.ts）；证据要是这条路线看得到的记录（看法会给它看，
   * 它和别的路线隔开）；任务结束、在收尾，或者这条路线已经结束以后不收（没人读了， 迟到写入）
   */
  recordWatch(input: WatchInput): WatchNote {
    return this.write((tx) => {
      const run = this.liveRun(input.runId);
      if (run.mode === 'settling') throw conflict('任务在收尾');
      const branch = this.mustBranch(input.branchId);
      if (branch.runId !== input.runId) throw invalid(`分支 ${input.branchId} 不属于 Run ${input.runId}`);
      if (this.q.getBet(branch.betId)?.kind !== 'direct') throw invalid('巡检器只看主干直解路线那条路线');
      if (isBranchEnded(branch.state)) throw conflict(`这条路线已经结束了（${branch.state}）`);
      if (input.basedOnSeq > this.store.lastSeq())
        throw invalid(`basedOnSeq ${input.basedOnSeq} 比现在最新的 seq 还大`);
      const note = prepareWatch(this.q, input, branch, this.store.lastSeq(), (id, what) =>
        this.mustSee(branch, id, undefined, what),
      );
      this.eventOnly(tx, 'watch.noted', input.runId, note);
      return note;
    });
  }

  appendUsage(list: UsageRow[]): void {
    if (list.length === 0) return;
    const rowsToWrite = list.map((r, i) => check(UsageRow, r, `第 ${i + 1} 行用量`));
    this.write(() => {
      const stmt = this.store.stmt(
        `INSERT INTO usage_ledger (run_id, branch_id, role, kind, at, ms, provider, model, input, cache_read,
           cache_write, output, usd, tool, exit_code, bytes, handle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rowsToWrite) {
        stmt.run(
          r.runId,
          r.branchId ?? null,
          r.role,
          r.kind,
          r.at,
          r.ms,
          r.provider ?? null,
          r.model ?? null,
          r.tokens.input,
          r.tokens.cacheRead,
          r.tokens.cacheWrite,
          r.tokens.output,
          r.usd,
          r.tool ?? null,
          r.exitCode ?? null,
          r.bytes ?? null,
          r.handle ?? null,
        );
      }
    });
  }

  emitUsage(runId: Id, usage: UsageUpdated): number {
    return this.write((tx) => {
      this.mustRun(runId); // 结束后迟到的用量照发
      return this.eventOnly(tx, 'usage.updated', runId, usage);
    });
  }

  emitSystem(status: SystemStatus): number {
    return this.write((tx) => this.eventOnly(tx, 'system.updated', null, status));
  }

  pruneSystemEvents(options: { keepMs?: number; limit?: number } = {}): number {
    const keepMs = options.keepMs ?? SYSTEM_EVENTS_KEEP_MS;
    const cutoff = new Date(this.store.now().getTime() - keepMs).toISOString();
    return this.write(
      () =>
        this.store
          .stmt(
            `DELETE FROM events WHERE seq IN (
               SELECT seq FROM events
                WHERE run_id IS NULL AND type = 'system.updated' AND julianday(at) < julianday(?)
                  AND seq < (SELECT max(seq) FROM events WHERE run_id IS NULL AND type = 'system.updated')
                ORDER BY seq LIMIT ?)`,
          )
          .run(cutoff, options.limit ?? SYSTEM_EVENTS_PRUNE_BATCH).changes,
    );
  }

  /** DELETE /runs/:id：只删已结束的；记录跟着 runs 级联删除，事件另删，账本留着 */
  deleteRun(runId: Id): void {
    this.write(() => {
      const run = this.mustRun(runId);
      if (!isRunEnded(run.status)) throw conflict('只能删除已结束的任务');
      this.store.stmt('DELETE FROM events WHERE run_id = ?').run(runId);
      this.store.stmt('DELETE FROM runs WHERE id = ?').run(runId);
    });
  }

  // ── 内部：写 ────────────────────────────────────────────────────────────

  private write<T>(fn: (tx: Tx) => T): T {
    return this.store.write(fn, (events) => this.bus.publish(events));
  }

  /** 插一条记录，发它的 .created 事件（data 就是这条记录）；按事件的 schema 校验 */
  private insert<K extends RecordKind>(
    tx: Tx,
    kind: K,
    type: EventType,
    build: (seq: number) => RecordOf<K>,
  ): RecordOf<K> {
    const seq = tx.nextSeq();
    const record = check(EVENT_DATA[type], build(seq), recordName(kind)) as RecordOf<K>;
    insertRecord(this.store, kind, record);
    tx.event(seq, type, recordRun(kind, record), record as never);
    return record;
  }

  /** 改写可变记录（Run、Bet、Branch），发 .updated（或 completion.drafted） */
  private update<K extends 'run' | 'bet' | 'branch'>(
    tx: Tx,
    kind: K,
    type: EventType,
    record: RecordOf<K>,
  ): RecordOf<K> {
    const checked = check(EVENT_DATA[type], record, recordName(kind)) as RecordOf<K>;
    updateRecord(this.store, kind, checked);
    tx.event(tx.nextSeq(), type, recordRun(kind, checked), checked as never);
    return checked;
  }

  private eventOnly<K extends EventType>(tx: Tx, type: K, runId: Id | null, data: EventDataMap[K]): number {
    check(EVENT_DATA[type], data, `${type} 的数据`);
    const seq = tx.nextSeq();
    tx.event(seq, type, runId, data);
    return seq;
  }

  private closeBetOf(tx: Tx, branch: Branch): void {
    const bet = this.q.getBet(branch.betId);
    if (bet && bet.status === 'active') this.update(tx, 'bet', 'bet.updated', { ...bet, status: 'closed' });
  }
  private checkCloseShape(input: CloseEpisodeInput): void {
    if ((input.outcome === 'submitted') !== Boolean(input.candidate)) throw invalid('最终提交必须包含候选');
    if (input.candidate && !input.snapshot) throw invalid('最终提交必须保存快照');
    if (input.outcome === 'failed' && (input.handoff || input.candidate || input.seenSeq !== undefined))
      throw invalid('失败会话不能提交交接或候选');
  }

  private insertCandidate(
    tx: Tx,
    input: CloseEpisodeInput,
    run: Run,
    branch: Branch,
  ): { candidate: Candidate; run: Run } {
    const c = input.candidate as NonNullable<CloseEpisodeInput['candidate']>;
    if (run.mode === 'settling') throw conflict('已经有分支先提交了候选，这次提交作废（先提交的赢）');
    if (c.interim) throw invalid('收尾交的是候选，不是一版：interim 只给 deliver');
    const candidate = this.insertCandidateRecord(tx, c, run, branch, input.snapshot?.id, '候选');
    const settling = this.update(tx, 'run', 'run.updated', { ...run, mode: 'settling' });
    return { candidate, run: settling };
  }
  private insertCandidateRecord(
    tx: Tx,
    c: NewCandidate,
    run: Run,
    branch: Branch,
    snapshot: SnapshotId | undefined,
    what: string,
  ): Candidate {
    if (c.branchId !== branch.id || c.runId !== run.id || c.snapshot !== snapshot)
      throw invalid(`${what}的分支、任务或快照不匹配`);
    if (c.artifact) this.checkHandle(run.id, c.artifact, `${what}的交付物`);
    const { id, ...rest } = c;
    return this.insert(tx, 'candidate', 'candidate.created', (seq) => ({ ...rest, id: this.freshId(id), seq }));
  }

  private branchAfterClose(input: CloseEpisodeInput, run: Run, current: Branch): Branch {
    const failed = input.outcome === 'failed';
    const transition = closeTransition({
      outcome: input.outcome,
      failures: current.failures,
      maxFailures: run.config.episode.maxFailures,
      pendingPause: current.pendingPause,
      runPaused: run.status === 'paused',
    });
    const { failures, stateNote: note } = transition;
    let state = transition.state;
    const override = input.next ?? {};
    if (override.state !== undefined) state = override.state;
    if (!CLOSE_NEXT[input.outcome].includes(state)) {
      throw conflict(`episode 以 ${input.outcome} 收尾，分支不能转成 ${state}`);
    }
    if (!failed && input.seenSeq !== undefined) {
      if (input.seenSeq < current.seenSeq || input.seenSeq > this.store.lastSeq()) {
        throw invalid(`seenSeq ${input.seenSeq} 不对：要在 ${current.seenSeq} 和现在的 seq 之间`);
      }
    }
    const next: Branch = {
      ...current,
      ...override,
      state,
      lastSnapshot: input.snapshot?.id ?? current.lastSnapshot,
      ...(input.handoff ? { handoff: input.handoff } : {}),
      seenSeq: !failed && input.seenSeq !== undefined ? input.seenSeq : current.seenSeq,
      episode: current.episode + 1,
      failures,
      queued: override.queued ?? (state === 'running' ? (transition.queued ?? current.queued) : false),
    };
    const stateNote = 'stateNote' in override ? override.stateNote : note;
    if (stateNote === undefined) delete next.stateNote;
    else next.stateNote = stateNote;
    if (state !== 'running') delete next.pendingPause;
    return next;
  }

  private mustSee(branch: Branch, id: Id, kinds: readonly RecordKind[] | undefined, what: string): StoreRecord {
    const record = this.mustBeIn(branch.runId, id, kinds, what);
    if (!this.q.isVisible({ kind: 'branch', branchId: branch.id }, id)) throw invalid(`${what}引用了别的分支的记录`);
    return record;
  }

  private mustBeIn(runId: Id, id: Id, kinds: readonly RecordKind[] | undefined, what: string): StoreRecord {
    const rec = this.q.getRecord(id);
    if (!rec || (rec.kind === 'run' ? rec.record.id : rec.record.runId) !== runId)
      throw invalid(`${what} 引用的 ${id} 在这个任务里不存在`);
    if (kinds && !kinds.includes(rec.kind)) {
      throw invalid(`${what} 引用的 ${id} 是 ${recordName(rec.kind)}，应该是 ${kinds.map(recordName).join('或')}`);
    }
    return rec;
  }

  private mustBeSnapshot(runId: Id, snapshot: SnapshotId, what: string): void {
    if (snapshot === ROOT) return;
    this.mustBeIn(runId, snapshot, ['snapshot'], what);
  }

  private checkHandle(runId: Id, handle: Handle, what: string): void {
    if (this.handleExists && !this.handleExists(runId, handle)) {
      throw invalid(`${what} 的句柄 ${handle} 在 Artifact store 里还没有内容：先写文件，再引用`);
    }
  }

  // ── 内部：取记录 ────────────────────────────────────────────────────────

  private must<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw notFound(`${what} 不存在`);
    return value;
  }

  private mustRun(id: Id): Run {
    return this.must(this.q.getRun(id), `Run ${id}`);
  }

  /** 没结束的 Run：结束后只收 Observation 和用量 */
  private liveRun(id: Id): Run {
    const run = this.mustRun(id);
    if (isRunEnded(run.status)) throw conflict(`任务已经结束（${run.status}）`);
    return run;
  }

  private mustBranch(id: Id): Branch {
    return this.must(this.q.getBranch(id), `分支 ${id}`);
  }

  /** 在跑的分支：episode 里的工具才写得进来，分支结束或还没开始的拒收 */
  private runningBranch(id: Id, runId: Id): Branch {
    const branch = this.mustBranch(id);
    if (branch.runId !== runId) throw invalid(`分支 ${id} 不属于 Run ${runId}`);
    if (branch.state !== 'running') throw conflict(`分支 ${id} 不在运行（${branch.state}）`);
    return branch;
  }

  private freshId(id: Id | undefined): Id {
    if (id === undefined) return this.newId();
    if (this.q.getRecord(id)) throw conflict(`id ${id} 已经用过了`);
    return id;
  }
}

/** 浅合并；patch 里值为 undefined 的键表示删掉这个可选字段 */
function merge<T extends object, P extends object>(base: T, patch: P): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as T;
}

function recordRun(kind: RecordKind, record: unknown): Id {
  const r = record as { id: Id; runId?: Id };
  return kind === 'run' ? r.id : (r.runId as Id);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const RECORD_NAMES: Record<RecordKind, string> = {
  run: 'Run',
  bet: 'Bet',
  branch: '分支',
  observation: 'Observation',
  candidate: '候选',
  snapshot: 'snapshot',
  inbox: '收件箱条目',
  input: 'HumanInput',
};

function recordName(kind: RecordKind): string {
  return RECORD_NAMES[kind];
}
