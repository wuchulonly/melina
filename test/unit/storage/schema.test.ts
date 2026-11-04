import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ddl = readFileSync(new URL('../../../src/storage/schema.sql', import.meta.url), 'utf8');
function open() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(ddl);
  return db;
}

describe('持久化表结构', () => {
  it('只建立当前运行、观察、交付和配置表', () => {
    const db = open();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .pluck()
        .all();
      expect(tables.sort()).toEqual(
        [
          'runs',
          'bets',
          'branches',
          'observations',
          'candidates',
          'snapshots',
          'branch_inbox',
          'human_inputs',
          'usage_ledger',
          'events',
          'providers',
          'provider_keys',
          'models',
          'settings',
          'credentials',
          'run_records',
          'watch_notes',
        ].sort(),
      );
    } finally {
      db.close();
    }
  });
  it('删除任务级联删除路线，保留用量账本', () => {
    const db = open();
    try {
      db.prepare("INSERT INTO runs VALUES ('r1',1,'done','direct','2026-10-01T00:00:00Z',NULL,'{}')").run();
      db.prepare("INSERT INTO bets VALUES ('b1','r1',2,'active','{}')").run();
      db.prepare(
        "INSERT INTO usage_ledger (run_id,role,kind,at,ms) VALUES ('r1','explorer','model','2026-10-01T00:00:00Z',10)",
      ).run();
      db.prepare("DELETE FROM runs WHERE id = 'r1'").run();
      expect(db.prepare('SELECT count(*) FROM bets').pluck().get()).toBe(0);
      expect(db.prepare('SELECT count(*) FROM usage_ledger').pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  });
  it('凭证不能同时使用两种注入方式', () => {
    const db = open();
    try {
      expect(() =>
        db
          .prepare(
            "INSERT INTO credentials VALUES ('c1','x','A','/a',NULL,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
