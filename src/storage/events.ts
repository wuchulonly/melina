// 进程内事件总线：只通知「有新数据」，数据本身从 RunStore 读。
// RunStoreWriter 提交事务后把这次写的事件按 seq 顺序交给 publish；stream 先补发历史再接着推新的（SSE、SDK 的 run.events() 用）。
//
// 顺序保证：所有订阅者都按 seq 升序收到事件。监听函数里再写 RunStore（新事务、新事件）时，新事件排在当前这批后面，
// 不会插队；监听函数抛错只记日志，不影响别的订阅者和写入方。
//
// stream 的待发队列有上限：读的人跟不上（浏览器标签页冻住、网络慢，SSE 写不出去就不往下取），
// 攒到 STREAM_QUEUE_MAX 条就退订、扔掉攒的，等它再来取时重新订阅、从 events 表接着补（表里什么都有，队列只是少读一次库）。
// 读的人看不出来：照样按 seq 连续、不漏不重，连接也不断，不用客户端重连再整页重拉。

import type { EventType, MelinaEvent } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { EventBus } from '../core/interfaces/store.ts';

export interface EventFilter {
  runId?: Id;
  types?: EventType[];
}

/** 从 events 表按 seq 读历史：seq 大于 since 的，按 seq 升序，最多 limit 条 */
export type EventHistory = (filter: { since: number; runId?: Id; limit: number }) => MelinaEvent[];

interface Subscription {
  listener: (event: MelinaEvent) => void;
  filter: EventFilter;
}

const HISTORY_PAGE = 500;

/**
 * 每个 stream 最多攒多少条还没取走的新事件。按这几个开发库里事件的平均大小（约 1 KB）约 2 MB，
 * 最大的 Observation（约 9 KB）全攒满也就 20 MB 上下；再多就改从 events 表补
 */
export const STREAM_QUEUE_MAX = 2000;

export class LocalEventBus implements EventBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly pending: MelinaEvent[] = [];
  private draining = false;
  private readonly history: EventHistory;
  private readonly lastSeq: () => number;
  private readonly onListenerError: (error: unknown, event: MelinaEvent) => void;
  private readonly maxQueued: number;
  private readonly onOverflow: ((info: { runId?: Id; cursor: number }) => void) | undefined;

  constructor(options: {
    history: EventHistory;
    lastSeq: () => number;
    onListenerError?: (error: unknown, event: MelinaEvent) => void;
    /** stream 的待发队列上限，默认 STREAM_QUEUE_MAX（测试里调小） */
    maxQueued?: number;
    /** 有 stream 攒满、改从表里补时通知（测试、日志用） */
    onOverflow?: (info: { runId?: Id; cursor: number }) => void;
  }) {
    this.history = options.history;
    this.lastSeq = options.lastSeq;
    this.onListenerError =
      options.onListenerError ??
      ((error, event) => console.error(`事件 ${event.seq} ${event.type} 的监听函数出错`, error));
    this.maxQueued = Math.max(1, options.maxQueued ?? STREAM_QUEUE_MAX);
    this.onOverflow = options.onOverflow;
  }

  subscribe(listener: (event: MelinaEvent) => void, filter: EventFilter = {}): () => void {
    const sub: Subscription = { listener, filter };
    this.subscriptions.add(sub);
    return () => {
      this.subscriptions.delete(sub);
    };
  }

  /** RunStoreWriter 提交后调：按顺序发给所有订阅者 */
  publish(events: readonly MelinaEvent[]): void {
    this.pending.push(...events);
    if (this.draining) return; // 监听函数里又写了 RunStore：排在这批后面
    this.draining = true;
    try {
      for (let event = this.pending.shift(); event; event = this.pending.shift()) {
        for (const sub of [...this.subscriptions]) {
          if (!this.subscriptions.has(sub) || !matches(sub.filter, event)) continue;
          try {
            sub.listener(event);
          } catch (error) {
            this.onListenerError(error, event);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  stream(since: number, filter: { runId?: Id; signal?: AbortSignal } = {}): AsyncIterable<MelinaEvent> {
    return { [Symbol.asyncIterator]: () => this.iterate(since, filter) };
  }

  private async *iterate(since: number, filter: { runId?: Id; signal?: AbortSignal }): AsyncGenerator<MelinaEvent> {
    const { runId, signal } = filter;
    if (signal?.aborted) return;
    let wake: (() => void) | undefined;
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort);
    let cursor = since;
    try {
      // 一轮：订阅，补历史，推队列里的新事件；队列攒满了就退订、扔掉，下一轮从 cursor 接着补
      while (!signal?.aborted) {
        const queue: MelinaEvent[] = [];
        let overflowed = false;
        let unsubscribe = () => {};
        // 先订阅再读历史：订阅之后提交的进队列，之前提交的从表里读；中间不漏，重叠的按 seq 去掉
        unsubscribe = this.subscribe(
          (event) => {
            if (overflowed) return;
            if (queue.length >= this.maxQueued) {
              overflowed = true;
              queue.length = 0;
              unsubscribe();
            } else {
              queue.push(event);
            }
            wake?.();
          },
          runId ? { runId } : {},
        );
        try {
          const until = this.lastSeq();
          while (cursor < until && !signal?.aborted) {
            const page = this.history({ since: cursor, ...(runId ? { runId } : {}), limit: HISTORY_PAGE });
            if (page.length === 0) break;
            for (const event of page) {
              if (event.seq > until) break;
              cursor = event.seq;
              yield event;
              if (signal?.aborted) return;
            }
            if ((page.at(-1)?.seq ?? until) >= until) break;
          }
          while (!signal?.aborted && !overflowed) {
            const event = queue.shift();
            if (event) {
              if (event.seq > cursor) {
                cursor = event.seq;
                yield event;
              }
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        } finally {
          unsubscribe();
        }
        if (overflowed && !signal?.aborted) this.onOverflow?.({ ...(runId ? { runId } : {}), cursor });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function matches(filter: EventFilter, event: MelinaEvent): boolean {
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.types && !filter.types.includes(event.type)) return false;
  return true;
}
