// 数据库文件与结构版本：WAL、外键、事件序号和持久化。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleOf } from '../../../src/core/ids.ts';
import { openRunStore } from '../../../src/storage/state.ts';
import { SCHEMA_VERSION } from '../../../src/storage/store.ts';
import { newRun, observe, startBranch } from './kit.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'melina-db-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
describe('数据库文件', () => {
  it('新库启用 WAL、外键并创建当前格式', () => {
    const path = join(dir, 'melina.db');
    const runStore = openRunStore({ db: path });
    runStore.close();
    const db = new Database(path);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[];
    expect(tables).toContain('run_records');
    db.close();
  });
  it('不支持的记录类型报错，不当作记录缺失', () => {
    const path = join(dir, 'melina.db');
    const runStore = openRunStore({ db: path });
    try {
      const run = newRun(runStore);
      const db = new Database(path);
      try {
        db.prepare('INSERT INTO run_records (id, run_id, kind, seq) VALUES (?, ?, ?, ?)').run(
          'unsupported-record',
          run.id,
          'unsupported',
          run.seq,
        );
      } finally {
        db.close();
      }
      expect(() => runStore.queries.getRecord('unsupported-record')).toThrow('不支持的记录类型：unsupported');
      expect(runStore.queries.getRecord('missing-record')).toBeUndefined();
    } finally {
      runStore.close();
    }
  });
  it('跟着 Run 级联删除的子表都有以 run_id 开头的索引：删一个 Run 不扫整张表', () => {
    const path = join(dir, 'melina.db');
    openRunStore({ db: path }).close();
    const db = new Database(path);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[];
    const missing: string[] = [];
    for (const t of tables) {
      const fks = db.prepare('SELECT "table", "from" FROM pragma_foreign_key_list(?)').all(t) as {
        table: string;
        from: string;
      }[];
      for (const fk of fks.filter((f) => f.table === 'runs')) {
        const indexes = db.prepare('SELECT name FROM pragma_index_list(?)').pluck().all(t) as string[];
        const leading = indexes.some(
          (i) => db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').pluck().get(i) === fk.from,
        );
        if (!leading) missing.push(`${t}.${fk.from}`);
      }
    }
    db.close();
    expect(missing).toEqual([]);
  });
  it('重开后数据都在，seq 接着往上数；删掉 Run 后号也不复用', () => {
    const path = join(dir, 'melina.db');
    let runStore = openRunStore({ db: path });
    const run = newRun(runStore);
    const { branch } = startBranch(runStore, run);
    observe(runStore, branch);
    runStore.writer.endRun(run.id, {
      status: 'cancelled',
      result: { knowledgeReport: handleOf('x') },
      branchNote: '你取消了任务',
    });
    const last = runStore.queries.lastSeq();
    runStore.writer.deleteRun(run.id);
    runStore.close();
    runStore = openRunStore({ db: path });
    expect(runStore.queries.lastSeq()).toBe(last);
    const next = newRun(runStore);
    expect(next.seq).toBe(last + 1);
    runStore.close();
    // 再开一次：迁移不会重跑
    runStore = openRunStore({ db: path });
    expect(runStore.queries.getRun(next.id)?.goal.statement).toBe(next.goal.statement);
    runStore.close();
  });
  it('同一个库别的连接（另一个进程）写过事件，这边接着写不撞号，seq 照样全局递增', () => {
    const path = join(dir, 'melina.db');
    const live = openRunStore({ db: path }); // 在跑的 Melina
    const run = newRun(live);
    const other = openRunStore({ db: path }); // 另一个进程打开了同一个库
    const status = {
      providers: [],
      toolExec: { limit: 2, running: 0, queued: 0, auto: true },
      disk: { freeBytes: 1, minBytes: 1, ok: true },
      runs: { running: 1, paused: 0 },
    };
    const foreign = other.writer.emitSystem(status);
    expect(foreign).toBe(live.queries.lastSeq() + 1);
    const mine = live.writer.recordHumanInput({ runId: run.id, text: '继续任务' }).input.seq;
    expect(mine).toBe(foreign + 1);
    expect(live.queries.lastSeq()).toBe(mine);
    // 反过来也一样
    expect(other.writer.emitSystem({ ...status, runs: { running: 0, paused: 1 } })).toBe(mine + 1);
    const seqs = live.queries.events({ since: 0 }).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    other.close();
    live.close();
  });
  it.each([1, 1000, SCHEMA_VERSION + 1])('拒绝不支持的格式版本 %s', (version) => {
    const path = join(dir, 'melina.db');
    openRunStore({ db: path }).close();
    const db = new Database(path);
    db.pragma(`user_version = ${version}`);
    db.close();
    expect(() => openRunStore({ db: path })).toThrow(/格式不受支持/);
  });
});
