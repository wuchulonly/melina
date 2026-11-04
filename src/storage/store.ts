// RunStore 的数据库连接：SQLite（WAL），建表，事务和全局 seq。
// 只给 storage/ 自己用；别的模块写用 RunStoreWriter，读用 RunStoreQueries。
//
// 新库执行 schema.sql；仅接受当前 schema 版本。
// seq 由这里分配：事务里先占号，提交成功才算数，回滚时退回去；events.seq 是 AUTOINCREMENT，删掉的号不复用。

import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { MelinaError } from '../core/errors.ts';
import type { EventDataMap, EventType, MelinaEvent } from '../core/events.ts';
import type { Id } from '../core/ids.ts';

export type Db = Database.Database;
type Statement = Database.Statement;

export const SCHEMA_VERSION = 1001;

export interface StoreOptions {
  /** SQLite 文件；':memory:' 用于测试 */
  path: string;
  /** 事件的时间，默认当前时间；测试传固定的时钟 */
  now?: () => Date;
}

/** 一个事务里要写的事件：提交后按 seq 顺序发给 EventBus */
export class Tx {
  readonly events: MelinaEvent[] = [];
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 占下一个 seq（记录的 seq 字段就是它） */
  nextSeq(): number {
    return this.store.takeSeq();
  }

  /** 写一条事件：seq 先用 nextSeq() 占好，data 是写进去的那条记录或事件自己的数据 */
  event<K extends EventType>(seq: number, type: K, runId: Id | null, data: EventDataMap[K]): MelinaEvent {
    const at = this.store.now().toISOString();
    this.store
      .stmt('INSERT INTO events (seq, run_id, type, at, data) VALUES (?, ?, ?, ?, ?)')
      .run(seq, runId, type, at, JSON.stringify(data));
    const event = { seq, runId, type, at, data } as MelinaEvent;
    this.events.push(event);
    return event;
  }
}

export class Store {
  readonly db: Db;
  readonly now: () => Date;
  private readonly statements = new Map<string, Statement>();
  private committedSeq: number;
  private pendingSeq: number;
  private writing = false;

  constructor(options: StoreOptions) {
    this.db = new Database(options.path);
    this.now = options.now ?? (() => new Date());
    if (options.path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // WAL 下 NORMAL：进程崩溃不丢已提交的事务；断电可能丢最后几个，恢复时回到更早的 lastSnapshot，仍然一致
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    initializeSchema(this.db);
    this.committedSeq = readLastSeq(this.db);
    this.pendingSeq = this.committedSeq;
  }

  /** 已提交的最新 seq */
  lastSeq(): number {
    return this.committedSeq;
  }

  stmt(sql: string): Statement {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  takeSeq(): number {
    if (!this.writing) throw internal('只能在 write() 里占 seq');
    this.pendingSeq += 1;
    return this.pendingSeq;
  }

  /**
   * 一个事务：fn 里写业务表和 events，返回后提交；抛错就整个回滚，占的 seq 退回去。
   * 提交后的事件交给 publish（按 seq 升序）。不能嵌套：一个方法一个事务（interfaces/store.ts）。
   * 事务一开始就拿写锁（IMMEDIATE），再按库里最新的 seq 接着占：同一个库别的连接写过事件（另一个进程打开了这个库），
   * 这里也不会拿旧的号撞 events 的主键
   */
  write<T>(fn: (tx: Tx) => T, publish: (events: MelinaEvent[]) => void): T {
    if (this.writing) throw internal('RunStore 的写入不能嵌套');
    this.writing = true;
    const tx = new Tx(this);
    let result: T;
    try {
      result = this.db
        .transaction(() => {
          this.syncSeq();
          return fn(tx);
        })
        .immediate();
      this.committedSeq = this.pendingSeq;
    } catch (error) {
      this.pendingSeq = this.committedSeq;
      throw error;
    } finally {
      this.writing = false;
    }
    if (tx.events.length > 0) publish(tx.events);
    return result;
  }

  close(): void {
    this.db.close();
  }

  /** 事务开头（已经拿着写锁）：库里的 seq 比记着的大，就从库里的接着占 */
  private syncSeq(): void {
    const last = Math.max(
      (this.stmt(LAST_SEQ_SQL.sequence).pluck().get() as number | undefined) ?? 0,
      (this.stmt(LAST_SEQ_SQL.table).pluck().get() as number | null) ?? 0,
    );
    if (last > this.committedSeq) this.committedSeq = last;
    this.pendingSeq = this.committedSeq;
  }
}

/** 最新的 seq：AUTOINCREMENT 记下的最大号（删掉的也算， 不复用）和表里的最大号，取大的 */
const LAST_SEQ_SQL = {
  sequence: "SELECT seq FROM sqlite_sequence WHERE name = 'events'",
  table: 'SELECT max(seq) FROM events',
} as const;

function internal(message: string): MelinaError {
  return new MelinaError('internal', message);
}
function initializeSchema(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === SCHEMA_VERSION) return;
  if (version !== 0) throw internal('数据目录格式不受支持，请使用新的数据目录');
  db.transaction(() => {
    db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

function readLastSeq(db: Db): number {
  const fromSequence = db.prepare(LAST_SEQ_SQL.sequence).pluck().get() as number | undefined;
  const fromTable = db.prepare(LAST_SEQ_SQL.table).pluck().get() as number | null;
  return Math.max(fromSequence ?? 0, fromTable ?? 0);
}
