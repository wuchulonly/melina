// 记录类型和表的对应（schema.sql）：每张记录表是「主键 + 几列查询用的字段 + data（整条记录的 JSON）」。
// 查询列是 data 的冗余，在这里和 data 一起写；run_records 记 id → 类型，getRecord 和引用检查用。

import { MelinaError } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import type { StoreRecord } from '../core/interfaces/store.ts';
import type { Bet, Branch, Candidate, HumanInput, InboxItem, Observation, Run, Snapshot } from '../core/types.ts';
import type { Store } from './store.ts';

/** 记录类型 → 记录，和 StoreRecord 的 kind 一一对应 */
export interface RecordMap {
  run: Run;
  bet: Bet;
  branch: Branch;
  observation: Observation;
  candidate: Candidate;
  snapshot: Snapshot;
  inbox: InboxItem;
  input: HumanInput;
}
export type RecordKind = keyof RecordMap;
export type RecordOf<K extends RecordKind> = RecordMap[K];
// RecordMap 和 StoreRecord 的类型对得上
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsMatch: Same<RecordKind, StoreRecord['kind']> = true;
void kindsMatch;

interface TableSpec<T> {
  table: string;
  /** 除 data 以外的列，第一列是主键 id */
  columns: readonly string[];
  values(record: T): (string | number | null)[];
}

const spec = <T>(table: string, columns: readonly string[], values: (r: T) => (string | number | null)[]) => ({
  table,
  columns,
  values,
});

export const TABLES: { [K in RecordKind]: TableSpec<RecordOf<K>> } = {
  run: spec<Run>('runs', ['id', 'seq', 'status', 'mode', 'created_at', 'ended_at'], (r) => [
    r.id,
    r.seq,
    r.status,
    r.mode,
    r.createdAt,
    r.endedAt ?? null,
  ]),
  bet: spec<Bet>('bets', ['id', 'run_id', 'seq', 'status'], (r) => [r.id, r.runId, r.seq, r.status]),
  branch: spec<Branch>('branches', ['id', 'run_id', 'seq', 'bet_id', 'state'], (r) => [
    r.id,
    r.runId,
    r.seq,
    r.betId,
    r.state,
  ]),
  snapshot: spec<Snapshot>('snapshots', ['id', 'run_id', 'seq', 'branch_id', 'parent'], (r) => [
    r.id,
    r.runId,
    r.seq,
    r.branchId,
    r.parent,
  ]),
  observation: spec<Observation>('observations', ['id', 'run_id', 'seq', 'branch_id', 'episode', 'tool'], (r) => [
    r.id,
    r.runId,
    r.seq,
    r.branchId ?? null,
    r.episode ?? null,
    r.tool,
  ]),
  candidate: spec<Candidate>('candidates', ['id', 'run_id', 'seq', 'branch_id'], (r) => [
    r.id,
    r.runId,
    r.seq,
    r.branchId,
  ]),
  inbox: spec<InboxItem>('branch_inbox', ['id', 'run_id', 'seq', 'branch_id', 'kind'], (r) => [
    r.id,
    r.runId,
    r.seq,
    r.branchId,
    r.kind,
  ]),
  input: spec<HumanInput>('human_inputs', ['id', 'run_id', 'seq'], (r) => [r.id, r.runId, r.seq]),
};

function runIdOf(kind: RecordKind, record: { id: Id; runId?: Id }): Id {
  return kind === 'run' ? record.id : (record.runId as Id);
}

/** 插入一条记录和它在 run_records 里的索引 */
export function insertRecord<K extends RecordKind>(store: Store, kind: K, record: RecordOf<K>): void {
  const t = TABLES[kind] as TableSpec<RecordOf<K>>;
  const cols = [...t.columns, 'data'];
  store
    .stmt(`INSERT INTO ${t.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...t.values(record), JSON.stringify(record));
  const r = record as unknown as { id: Id; runId?: Id; seq: number };
  store
    .stmt('INSERT INTO run_records (id, run_id, kind, seq) VALUES (?, ?, ?, ?)')
    .run(r.id, runIdOf(kind, r), kind, r.seq);
}

/** 改写可变的记录（Run、Bet、Branch）：查询列和 data 一起改 */
export function updateRecord<K extends 'run' | 'bet' | 'branch'>(store: Store, kind: K, record: RecordOf<K>): void {
  const t = TABLES[kind] as TableSpec<RecordOf<K>>;
  const [, ...rest] = t.columns;
  const [id, ...values] = t.values(record);
  store
    .stmt(`UPDATE ${t.table} SET ${[...rest, 'data'].map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...values, JSON.stringify(record), id);
}

export function getRecordOf<K extends RecordKind>(store: Store, kind: K, id: Id): RecordOf<K> | undefined {
  const row = store.stmt(`SELECT data FROM ${TABLES[kind].table} WHERE id = ?`).get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as RecordOf<K>) : undefined;
}

/** 按 id 查任意当前类型的记录；索引中出现不支持的类型时报告数据错误。 */
export function getAnyRecord(store: Store, id: Id): StoreRecord | undefined {
  const kind = store.stmt('SELECT kind FROM run_records WHERE id = ?').pluck().get(id) as RecordKind | undefined;
  if (kind === undefined) return undefined;
  if (!Object.hasOwn(TABLES, kind)) throw new MelinaError('internal', `不支持的记录类型：${kind}`);
  const record = getRecordOf(store, kind, id);
  return record ? ({ kind, record } as StoreRecord) : undefined;
}

/** 把查询结果的 data 列解析成记录 */
export function rows<T>(list: unknown[]): T[] {
  return (list as { data: string }[]).map((r) => JSON.parse(r.data) as T);
}
