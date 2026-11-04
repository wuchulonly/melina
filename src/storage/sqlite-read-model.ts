import type { MelinaEvent } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { EventWindow, StoreReadModel, WatchEvent } from '../core/interfaces/store.ts';
import type { Observation } from '../core/types.ts';
import { WATCH_INPUT } from '../core/watch-input.ts';
import { LOCAL_EVENT_TYPES, STATE_TOOLS } from '../projections/read-model.ts';
import type { Store } from './store.ts';
import { rows } from './tables.ts';

export class SqliteReadModel implements StoreReadModel {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  watches(runId: Id, branchId: Id, until: number | undefined, latest: boolean): WatchEvent[] {
    const sql = `SELECT seq, run_id AS runId, 'watch.noted' AS type, at, data FROM watch_notes
      WHERE run_id = ? AND branch_id = ? AND seq <= ? ORDER BY seq ${latest ? 'DESC LIMIT 1' : 'ASC'}`;
    return this.decode(sql, [runId, branchId, until ?? Number.MAX_SAFE_INTEGER]) as WatchEvent[];
  }

  stateObservations(runId: Id, branchId: Id, until: number): Observation[] {
    return rows<Observation>(
      this.store
        .stmt(`SELECT data FROM observations
      WHERE run_id = ? AND branch_id = ? AND json_extract(data, '$.role') = 'watcher'
        AND tool IN (SELECT value FROM json_each(?)) AND seq <= ? ORDER BY seq`)
        .all(runId, branchId, JSON.stringify(STATE_TOOLS), until),
    );
  }

  platformObservations(runId: Id, branchId: Id, until: number, refs: readonly Id[], before: number): Observation[] {
    return rows<Observation>(
      this.store
        .stmt(`SELECT data FROM observations
      WHERE run_id = ? AND branch_id = ? AND json_extract(data, '$.role') = 'watcher' AND tool = ?
        AND seq < ? AND (seq <= ? OR id IN (SELECT value FROM json_each(?))) ORDER BY seq DESC LIMIT 32`)
        .all(runId, branchId, WATCH_INPUT.platform, before, until, JSON.stringify(refs)),
    );
  }

  events(window: EventWindow, limit: number): MelinaEvent[] {
    const types = [...new Set(window.types)];
    if (!types.length) return [];
    const params: unknown[] = [];
    // 每种类型单独走索引，再归并 seq；跨分支的 Observation 不进入 JS。
    const selects = types.map((type) => {
      params.push(window.runId, type, window.since ?? 0, window.until ?? Number.MAX_SAFE_INTEGER);
      let where = 'run_id = ? AND type = ? AND seq > ? AND seq <= ?';
      if (LOCAL_EVENT_TYPES.has(type)) {
        where += " AND coalesce(json_extract(data, '$.branchId'), json_extract(data, '$.id')) = ?";
        params.push(window.branchId);
      }
      return `SELECT seq, run_id AS runId, type, at, data FROM events WHERE ${where}`;
    });
    params.push(limit);
    return this.decode(
      `${selects.join(' UNION ALL ')} ORDER BY seq ${window.reverse ? 'DESC' : 'ASC'} LIMIT ?`,
      params,
    );
  }

  private decode(sql: string, params: unknown[]): MelinaEvent[] {
    const records = this.store.stmt(sql).all(...params) as { data: string }[];
    return records.map((record) => ({ ...record, data: JSON.parse(record.data) }) as MelinaEvent);
  }
}
