// 任务状态、执行日志、工作区快照与 Watcher 地图；事务提交后发布事件。
import type { BranchDetail, UsageResponse } from '../api.ts';
import type {
  EpisodeFailure,
  EpisodeOutcomeKind,
  EventType,
  MelinaEvent,
  RunRecovered,
  ShIntent,
  SystemStatus,
  UsageBreakdown,
  UsageTotals,
  UsageUpdated,
  VersionPicked,
} from '../events.ts';
import type { Id, SnapshotId } from '../ids.ts';
import type { ModelRef } from '../model-ref.ts';
import type { SubmitWatchArgs } from '../tools.ts';
import type {
  Bet,
  BetDraft,
  BetSource,
  Branch,
  BranchState,
  Candidate,
  HumanInput,
  InboxItem,
  Observation,
  Role,
  Run,
  RunResult,
  RunStatus,
  ScoperOutput,
  Snapshot,
  UsageRow,
  WatchNote,
} from '../types.ts';

type New<T> = Omit<T, 'id' | 'seq'> & { id?: Id };
export type NewRun = Omit<Run, 'seq' | 'mode' | 'status' | 'result' | 'endedAt' | 'endReason'>;
export type RunPatch = Partial<Pick<Run, 'mode'>> & { status?: Extract<RunStatus, 'running' | 'paused'> };
export interface RunEnding {
  status: Exclude<RunStatus, 'running' | 'paused'>;
  endReason?: string;
  result: RunResult;
  branchNote: string;
}
export type NewBet = BetDraft & { runId: Id; source: BetSource; id?: Id };
export type NewBranch = Pick<Branch, 'runId' | 'betId' | 'lastSnapshot'> &
  Partial<Pick<Branch, 'weight' | 'parentBranchId'>> & { id?: Id };
export type BranchPatch = Partial<
  Pick<Branch, 'state' | 'queued' | 'pendingPause' | 'stateNote' | 'workspace' | 'weight' | 'lastSnapshot' | 'handoff'>
>;
export type NewObservation = New<Observation>;
export type NewCandidate = New<Candidate>;
export type NewInboxItem = New<InboxItem>;
export type NewHumanInput = New<HumanInput>;
export interface CloseEpisodeInput {
  branchId: Id;
  episode: number;
  outcome: EpisodeOutcomeKind;
  failure?: EpisodeFailure;
  snapshot?: { id: SnapshotId };
  seenSeq?: number;
  handoff?: string;
  candidate?: NewCandidate;
  notice?: string;
  next?: BranchPatch;
}
export interface CloseEpisodeResult {
  branch: Branch;
  seq: number;
  snapshot?: Snapshot;
  candidate?: Candidate;
  run?: Run;
}
export interface DeliverVersionInput {
  branchId: Id;
  episode: number;
  snapshot: { id: SnapshotId };
  candidate: NewCandidate;
}
export interface DeliverVersionResult {
  branch: Branch;
  snapshot: Snapshot;
  candidate: Candidate;
}
export interface HumanInputResult {
  input: HumanInput;
  inbox: InboxItem[];
}
export interface WatchInput {
  runId: Id;
  branchId: Id;
  basedOnSeq: number;
  state?: { untilSeq: number; seenSeq: number; refs: Id[] };
  delivered?: { untilSeq: number; refs: Id[] };
  toolCalls: number;
  model: ModelRef;
  draft: SubmitWatchArgs;
}
export interface RunStoreWriter {
  createRun(run: NewRun): Run;
  updateRun(id: Id, patch: RunPatch): Run;
  endRun(id: Id, ending: RunEnding): Run;
  draftCompletion(runId: Id, out: ScoperOutput): Run;
  createBet(bet: NewBet): Bet;
  closeBet(id: Id): Bet;
  createBranch(branch: NewBranch): Branch;
  updateBranch(id: Id, patch: BranchPatch): Branch;
  closeEpisode(input: CloseEpisodeInput): CloseEpisodeResult;
  deliverVersion(input: DeliverVersionInput): DeliverVersionResult;
  appendObservation(o: NewObservation, opts: { countsAsToolCall: boolean }): Observation;
  appendShIntent(runId: Id, intent: ShIntent): number;
  appendInbox(item: NewInboxItem): InboxItem;
  recordHumanInput(input: NewHumanInput): HumanInputResult;
  checkpointBranch(branchId: Id, snapshot: { id: SnapshotId }, live?: { episode: number; handoff: string }): Branch;
  recordRecovery(runId: Id, data: RunRecovered): number;
  recordPick(runId: Id, pick: VersionPicked): number;
  recordWatch(input: WatchInput): WatchNote;
  appendUsage(rows: UsageRow[]): void;
  emitUsage(runId: Id, usage: UsageUpdated): number;
  emitSystem(status: SystemStatus): number;
  deleteRun(runId: Id): void;
}
export type Viewer = { kind: 'branch'; branchId: Id } | { kind: 'human'; runId: Id };
export type StoreRecord =
  | { kind: 'run'; record: Run }
  | { kind: 'bet'; record: Bet }
  | { kind: 'branch'; record: Branch }
  | { kind: 'observation'; record: Observation }
  | { kind: 'candidate'; record: Candidate }
  | { kind: 'snapshot'; record: Snapshot }
  | { kind: 'inbox'; record: InboxItem }
  | { kind: 'input'; record: HumanInput };
export interface Page<T> {
  items: T[];
  next?: string;
}
export type WatchEvent = Extract<MelinaEvent, { type: 'watch.noted' }>;
export interface EventWindow {
  runId: Id;
  branchId: Id;
  types: readonly EventType[];
  since?: number;
  until?: number;
  reverse?: boolean;
}
export interface StoreReadModel {
  watches(runId: Id, branchId: Id, until: number | undefined, latest: boolean): WatchEvent[];
  stateObservations(runId: Id, branchId: Id, until: number): Observation[];
  platformObservations(runId: Id, branchId: Id, until: number, refs: readonly Id[], before: number): Observation[];
  events(window: EventWindow, limit: number): MelinaEvent[];
}
export interface RunStoreQueries {
  readonly readModel: StoreReadModel;
  lastSeq(): number;
  getRun(id: Id): Run | undefined;
  listRuns(filter?: { status?: RunStatus[] }): Run[];
  getBet(id: Id): Bet | undefined;
  listBets(runId: Id): Bet[];
  getBranch(id: Id): Branch | undefined;
  listBranches(runId: Id, filter?: { states?: BranchState[] }): Branch[];
  getObservation(id: Id): Observation | undefined;
  getObservationAt(runId: Id, seq: number): Observation | undefined;
  observations(
    branchId: Id,
    page?: { cursor?: string; limit?: number; text?: string; role?: Role; excludeWatcher?: boolean },
  ): Page<Observation>;
  getRecord(id: Id): StoreRecord | undefined;
  isVisible(viewer: Viewer, id: Id): boolean;
  candidates(runId: Id): Candidate[];
  inbox(branchId: Id, sinceSeq: number): InboxItem[];
  humanInputs(runId: Id, opts?: { sinceSeq?: number }): HumanInput[];
  snapshots(runId: Id, opts?: { branchId?: Id }): Snapshot[];
  lineage(snapshot: SnapshotId): SnapshotId[];
  branchDetail(runId: Id, branchId: Id, page?: { cursor?: string; limit?: number }): BranchDetail | undefined;
  events(filter: { since: number; runId?: Id; types?: EventType[]; limit?: number }): MelinaEvent[];
  pendingShIntents(runId: Id): ShIntent[];
  usageTotals(runId: Id): UsageTotals;
  usageBreakdown(runId: Id): UsageBreakdown;
  usageReport(): UsageResponse;
}
export interface EventBus {
  subscribe(listener: (event: MelinaEvent) => void, filter?: { runId?: Id; types?: EventType[] }): () => void;
  stream(since: number, filter?: { runId?: Id; signal?: AbortSignal }): AsyncIterable<MelinaEvent>;
}
