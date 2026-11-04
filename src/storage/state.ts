// 打开一份 RunStore：SQLite（WAL）、RunStoreWriter、RunStoreQueries、事件总线和 Artifact store 接在一起。
// 进程入口调 openRunStore，把 writer、queries、bus、artifacts 按接口分给各模块；别的模块不 import 这里的实现类。

import type { Handle, Id } from '../core/ids.ts';
import { FileArtifactStore } from './artifacts.ts';
import { LocalEventBus } from './events.ts';
import { SqliteRunStoreQueries } from './queries.ts';
import { Store } from './store.ts';
import { SqliteRunStoreWriter } from './writer.ts';

export interface RunStoreOptions {
  /** SQLite 文件；':memory:' 用于测试 */
  db: string;
  /** Artifact store 的目录；不给就没有 Artifact store，写入时也不查句柄 */
  artifacts?: string;
  /** 写入时查引用的句柄在不在 Artifact store 里，给了 artifacts 时默认查 */
  verifyHandles?: boolean;
  /** 事件的时间，默认当前时间 */
  now?: () => Date;
  /** 分配 id，默认 ULID */
  newId?: () => Id;
  /** 事件监听函数出错时，默认打日志 */
  onListenerError?: (error: unknown) => void;
  /** 事件流（stream）的待发队列上限，默认 STREAM_QUEUE_MAX（events.ts；测试里调小） */
  streamQueueMax?: number;
  /** 有事件流攒满、改从 events 表补时通知 */
  onStreamOverflow?: (info: { runId?: Id; cursor: number }) => void;
}

export interface RunStore {
  writer: SqliteRunStoreWriter;
  queries: SqliteRunStoreQueries;
  bus: LocalEventBus;
  artifacts?: FileArtifactStore;
  close(): void;
}

export function openRunStore(options: RunStoreOptions): RunStore {
  const store = new Store({ path: options.db, ...(options.now ? { now: options.now } : {}) });
  const queries = new SqliteRunStoreQueries(store);
  const bus = new LocalEventBus({
    history: (f) => queries.events({ since: f.since, ...(f.runId ? { runId: f.runId } : {}), limit: f.limit }),
    lastSeq: () => store.lastSeq(),
    ...(options.onListenerError ? { onListenerError: options.onListenerError } : {}),
    ...(options.streamQueueMax !== undefined ? { maxQueued: options.streamQueueMax } : {}),
    ...(options.onStreamOverflow ? { onOverflow: options.onStreamOverflow } : {}),
  });
  const artifacts = options.artifacts ? new FileArtifactStore(options.artifacts) : undefined;
  const verify = options.verifyHandles ?? artifacts !== undefined;
  const handleExists =
    verify && artifacts ? (runId: Id, handle: Handle) => artifacts.hasSync(runId, handle) : undefined;
  const writer = new SqliteRunStoreWriter({
    store,
    queries,
    bus,
    ...(options.newId ? { newId: options.newId } : {}),
    ...(handleExists ? { handleExists } : {}),
  });
  return {
    writer,
    queries,
    bus,
    ...(artifacts ? { artifacts } : {}),
    close: () => store.close(),
  };
}
