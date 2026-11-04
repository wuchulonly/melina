//

// 没写的一律按时间先后（seq 升序），给了 limit 的保留最新的 limit 条、仍按时间先后排。

import type { BranchCard, BranchDetail, UsageResponse } from '../core/api.ts';
import { invalid } from '../core/errors.ts';
import {
  type EventType,
  type MelinaEvent,
  type ShIntent,
  type UsageBreakdown,
  type UsageTotals,
  ZERO_USAGE,
} from '../core/events.ts';
import { type Id, ROOT, type SnapshotId } from '../core/ids.ts';
import type { Page, RunStoreQueries, StoreRecord, Viewer } from '../core/interfaces/store.ts';
import type {
  Bet,
  Branch,
  BranchState,
  Candidate,
  HumanInput,
  InboxItem,
  Observation,
  Role,
  Run,
  RunStatus,
  Snapshot,
} from '../core/types.ts';
import { latestWatch } from '../projections/watch.ts';
import { watchBacklog, watchLag } from '../projections/watch-window.ts';
import { SqliteReadModel } from './sqlite-read-model.ts';
import type { Store } from './store.ts';
import { getAnyRecord, getRecordOf, rows } from './tables.ts';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export class SqliteRunStoreQueries implements RunStoreQueries {
  readonly readModel: SqliteReadModel;
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    this.readModel = new SqliteReadModel(store);
  }

  lastSeq(): number {
    return this.store.lastSeq();
  }

  // ── 记录 ────────────────────────────────────────────────────────────────

  getRun(id: Id): Run | undefined {
    return getRecordOf(this.store, 'run', id);
  }

  listRuns(filter: { status?: RunStatus[] } = {}): Run[] {
    if (filter.status) {
      return this.list<Run>(
        'SELECT data FROM runs WHERE status IN (SELECT value FROM json_each(?)) ORDER BY seq DESC',
        JSON.stringify(filter.status),
      );
    }
    return this.list<Run>('SELECT data FROM runs ORDER BY seq DESC');
  }

  getBet(id: Id): Bet | undefined {
    return getRecordOf(this.store, 'bet', id);
  }

  listBets(runId: Id): Bet[] {
    return this.list<Bet>('SELECT data FROM bets WHERE run_id = ? ORDER BY seq', runId);
  }

  getBranch(id: Id): Branch | undefined {
    return getRecordOf(this.store, 'branch', id);
  }

  listBranches(runId: Id, filter: { states?: BranchState[] } = {}): Branch[] {
    if (filter.states) {
      return this.list<Branch>(
        'SELECT data FROM branches WHERE run_id = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY seq',
        runId,
        JSON.stringify(filter.states),
      );
    }
    return this.list<Branch>('SELECT data FROM branches WHERE run_id = ? ORDER BY seq', runId);
  }

  getObservation(id: Id): Observation | undefined {
    return getRecordOf(this.store, 'observation', id);
  }

  getObservationAt(runId: Id, seq: number): Observation | undefined {
    const row = this.store.stmt('SELECT data FROM observations WHERE run_id = ? AND seq = ?').get(runId, seq) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Observation) : undefined;
  }

  /** 新的在前；先过滤再分页，搜索不会被无关观测挤出一页。 */
  observations(
    branchId: Id,
    page: { cursor?: string; limit?: number; text?: string; role?: Role; excludeWatcher?: boolean } = {},
  ): Page<Observation> {
    const limit = clampLimit(page.limit, DEFAULT_PAGE, MAX_PAGE);
    const before = page.cursor === undefined ? Number.MAX_SAFE_INTEGER : parseCursor(page.cursor);
    const terms = (page.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const search =
      "lower(json_extract(data, '$.tool') || ' ' || json_extract(data, '$.args') || ' ' || json_extract(data, '$.summary'))";
    const items = this.list<Observation>(
      `SELECT data FROM observations WHERE branch_id = ? AND seq < ?
        AND (? IS NULL OR json_extract(data, '$.role') = ?)
        AND (? = 0 OR json_extract(data, '$.role') != 'watcher')
        ${terms.map(() => `AND instr(${search}, ?) > 0`).join(' ')}
        ORDER BY seq DESC LIMIT ?`,
      branchId,
      before,
      page.role ?? null,
      page.role ?? null,
      page.excludeWatcher ? 1 : 0,
      ...terms,
      limit + 1,
    );
    if (items.length <= limit) return { items };
    const shown = items.slice(0, limit);
    return { items: shown, next: String(shown.at(-1)?.seq) };
  }

  getRecord(id: Id): StoreRecord | undefined {
    return getAnyRecord(this.store, id);
  }
  isVisible(viewer: Viewer, id: Id): boolean {
    const r = this.getRecord(id);
    if (!r) return false;
    const runId = r.kind === 'run' ? r.record.id : r.record.runId;
    if (viewer.kind === 'human') return runId === viewer.runId;
    const branch = this.getBranch(viewer.branchId);
    if (!branch || branch.runId !== runId) return false;
    if (r.kind === 'observation') return !r.record.branchId || r.record.branchId === branch.id;
    if (r.kind === 'inbox' || r.kind === 'branch')
      return (r.kind === 'branch' ? r.record.id : r.record.branchId) === branch.id;
    return true;
  }

  candidates(runId: Id): Candidate[] {
    return this.list<Candidate>('SELECT data FROM candidates WHERE run_id = ? ORDER BY seq', runId);
  }

  inbox(branchId: Id, sinceSeq: number): InboxItem[] {
    return this.list<InboxItem>(
      'SELECT data FROM branch_inbox WHERE branch_id = ? AND seq > ? ORDER BY seq',
      branchId,
      sinceSeq,
    );
  }

  humanInputs(runId: Id, opts: { sinceSeq?: number } = {}): HumanInput[] {
    return this.list<HumanInput>(
      'SELECT data FROM human_inputs WHERE run_id = ? AND seq > ? ORDER BY seq',
      runId,
      opts.sinceSeq ?? 0,
    );
  }

  snapshots(runId: Id, opts: { branchId?: Id } = {}): Snapshot[] {
    if (opts.branchId) {
      return this.list<Snapshot>(
        'SELECT data FROM snapshots WHERE run_id = ? AND branch_id = ? ORDER BY seq',
        runId,
        opts.branchId,
      );
    }
    return this.list<Snapshot>('SELECT data FROM snapshots WHERE run_id = ? ORDER BY seq', runId);
  }

  /** 从这个 snapshot 往上到 root 的祖先，含自己，root 在最后 */
  lineage(snapshot: SnapshotId): SnapshotId[] {
    if (snapshot === ROOT) return [ROOT];
    const ids = this.store
      .stmt(
        `WITH RECURSIVE up(id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT s.parent, up.depth + 1 FROM snapshots s JOIN up ON s.id = up.id WHERE up.id <> 'root'
         )
         SELECT id FROM up ORDER BY depth`,
      )
      .pluck()
      .all(snapshot) as SnapshotId[];
    if (ids.at(-1) !== ROOT) ids.push(ROOT);
    return ids;
  }
  branchDetail(runId: Id, branchId: Id, page: { cursor?: string; limit?: number } = {}): BranchDetail | undefined {
    const branch = this.getBranch(branchId);
    if (!branch || branch.runId !== runId) return undefined;
    const bet = this.getBet(branch.betId);
    if (!bet) return undefined;
    const note = latestWatch(this, runId, branchId);
    const { seq: _seq, ...watch } = note ?? {};
    return {
      branch,
      bet,
      observations: this.observations(branchId, page),
      ...(note
        ? {
            watch: watch as NonNullable<BranchDetail['watch']>,
            watchLag: watchLag(
              this,
              branch,
              note,
              this.store.now().getTime(),
              watchBacklog(this, branch, note.basedOnSeq, note.toolCalls, note.stateSeq ?? note.basedOnSeq),
            ),
          }
        : {}),
      lastSeq: this.lastSeq(),
    };
  }

  /** 分支卡片（GET /runs/:id） */
  branchCard(branch: Branch): BranchCard {
    return { branch, bet: this.getBet(branch.betId) as Bet };
  }

  // ── 事件 ──────────────────────────────────────────────────────────────────

  events(filter: { since: number; runId?: Id; types?: EventType[]; limit?: number }): MelinaEvent[] {
    const where = ['seq > ?'];
    const params: unknown[] = [filter.since];
    if (filter.runId) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.types) {
      where.push('type IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(filter.types));
    }
    let sql = `SELECT seq, run_id AS runId, type, at, data FROM events WHERE ${where.join(' AND ')} ORDER BY seq`;
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    return (this.store.stmt(sql).all(...params) as EventRow[]).map(decodeEvent);
  }

  /** 只有意图、没有 Observation 的 sh 调用。 */
  pendingShIntents(runId: Id): ShIntent[] {
    return this.list<ShIntent>(
      `SELECT data FROM events e
        WHERE run_id = ? AND type = 'sh.intent'
          AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = json_extract(e.data, '$.id'))
        ORDER BY seq`,
      runId,
    );
  }

  // ── 用量 ──────────────────────────────────────────────────────────────────

  usageTotals(runId: Id): UsageTotals {
    const row = this.store
      .stmt(
        `SELECT coalesce(sum(input), 0) AS input, coalesce(sum(cache_read), 0) AS cacheRead,
                coalesce(sum(cache_write), 0) AS cacheWrite, coalesce(sum(output), 0) AS output,
                coalesce(sum(usd), 0) AS usd
           FROM usage_ledger WHERE run_id = ?`,
      )
      .get(runId) as UsageTotals | undefined;
    return row ? roundUsage(row) : { ...ZERO_USAGE };
  }

  usageBreakdown(runId: Id): UsageBreakdown {
    const byRole = (
      this.store
        .stmt(`SELECT role, ${USAGE_SUMS} FROM usage_ledger WHERE run_id = ? GROUP BY role ORDER BY role`)
        .all(runId) as (UsageTotals & { role: Role })[]
    ).map((r) => ({ ...roundUsage(r), role: r.role }));
    const byBranch = (
      this.store
        .stmt(
          `SELECT branch_id AS branchId, ${USAGE_SUMS} FROM usage_ledger
            WHERE run_id = ? AND branch_id IS NOT NULL GROUP BY branch_id ORDER BY branch_id`,
        )
        .all(runId) as (UsageTotals & { branchId: Id })[]
    ).map((r) => ({ ...roundUsage(r), branchId: r.branchId }));
    return { byRole, byBranch };
  }

  /** GET /usage：按模型、按天（本地时区）、按角色汇总 */
  usageReport(): UsageResponse {
    const sums = USAGE_SUMS;
    const total = roundUsage(this.store.stmt(`SELECT ${sums} FROM usage_ledger`).get() as UsageTotals);
    const byModel = (
      this.store
        .stmt(
          `SELECT provider, model, ${sums} FROM usage_ledger
            WHERE kind = 'model' AND provider IS NOT NULL AND model IS NOT NULL
            GROUP BY provider, model ORDER BY provider, model`,
        )
        .all() as (UsageTotals & { provider: string; model: string })[]
    ).map((r) => ({ ...roundUsage(r), provider: r.provider, model: r.model }));
    const byDay = (
      this.store
        .stmt(`SELECT date(at, 'localtime') AS day, ${sums} FROM usage_ledger GROUP BY day ORDER BY day`)
        .all() as (UsageTotals & { day: string })[]
    ).map((r) => ({ ...roundUsage(r), day: r.day }));
    const byRole = (
      this.store.stmt(`SELECT role, ${sums} FROM usage_ledger GROUP BY role ORDER BY role`).all() as (UsageTotals & {
        role: Role;
      })[]
    ).map((r) => ({ ...roundUsage(r), role: r.role }));
    return { total, byModel, byDay, byRole };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private list<T>(sql: string, ...params: unknown[]): T[] {
    return rows<T>(this.store.stmt(sql).all(...params));
  }
}

interface EventRow {
  seq: number;
  runId: Id | null;
  type: EventType;
  at: string;
  data: string;
}

function decodeEvent(row: EventRow): MelinaEvent {
  return { seq: row.seq, runId: row.runId, type: row.type, at: row.at, data: JSON.parse(row.data) } as MelinaEvent;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

function parseCursor(cursor: string): number {
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) throw invalid(`cursor 不对：${cursor}`);
  return n;
}

/** 浮点累加的误差去掉：美元保留 6 位小数 */
const USAGE_SUMS = `coalesce(sum(input), 0) AS input, coalesce(sum(cache_read), 0) AS cacheRead,
  coalesce(sum(cache_write), 0) AS cacheWrite, coalesce(sum(output), 0) AS output, coalesce(sum(usd), 0) AS usd`;

function roundUsage(u: UsageTotals): UsageTotals {
  return {
    input: u.input,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    output: u.output,
    usd: Math.round(u.usd * 1e6) / 1e6,
  };
}
