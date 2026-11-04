// 几个标签页共用一条全局事件流（src/api/shared-stream.ts）：只有领头的连 SSE，别的跟着收；领头的关了，下一个接手按 seq 续上。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MelinaEvent } from '../../src/core/events.ts';
import { type ChannelLike, type LocksLike, SharedMelinaStream } from '../src/api/shared-stream.ts';
import type { EventSourceLike } from '../src/api/stream.ts';

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent<string>) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  send(seq: number) {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify({ seq, type: 'run.updated', runId: 'R', at: '', data: {} }) }),
    );
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

/** 一把锁：先到先得，放开了给排着的下一个；排队时 abort 就退出 */
class FakeLocks implements LocksLike {
  private held = false;
  private queue: { cb: () => Promise<void>; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  request(_name: string, options: { signal?: AbortSignal }, cb: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = { cb, resolve, reject };
      options.signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new DOMException('aborted', 'AbortError'));
        }
      });
      this.queue.push(entry);
      this.next();
    });
  }
  private next() {
    if (this.held) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.held = true;
    entry.cb().then(() => {
      this.held = false;
      entry.resolve(undefined);
      this.next();
    });
  }
}

/** 同名频道之间互发（不发给自己），和 BroadcastChannel 一样 */
function bus() {
  const members = new Set<ChannelLike>();
  return (_name: string): ChannelLike => {
    const ch: ChannelLike = {
      onmessage: null,
      postMessage(message: unknown) {
        for (const m of members) if (m !== ch) m.onmessage?.(new MessageEvent('message', { data: message }));
      },
      close() {
        members.delete(ch);
      },
    };
    members.add(ch);
    return ch;
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  FakeSource.all = [];
});
afterEach(() => vi.useRealTimers());

function tab(locks: LocksLike, channel: (name: string) => ChannelLike) {
  const events: [number, boolean][] = [];
  const states: string[] = [];
  const opens: boolean[] = [];
  const stream = new SharedMelinaStream({
    url: (s) => (s === undefined ? '/api/events' : `/api/events?since=${s}`),
    onEvent: (e: MelinaEvent, fromPeer) => events.push([e.seq, fromPeer]),
    onState: (s) => states.push(s),
    onOpen: ({ reconnect }) => opens.push(reconnect),
    locks,
    channel,
    create: (url) => new FakeSource(url),
    retryDelays: [100],
  });
  return { stream, events, states, opens };
}

describe('SharedMelinaStream', () => {
  it('三个标签页只开一条 SSE，事件转给别的标签页', async () => {
    const locks = new FakeLocks();
    const ch = bus();
    const a = tab(locks, ch);
    const b = tab(locks, ch);
    const c = tab(locks, ch);
    a.stream.start();
    await flush();
    b.stream.start();
    c.stream.start();
    await flush();
    expect(FakeSource.all).toHaveLength(1);
    expect(a.stream.leading).toBe(true);
    expect(b.stream.leading).toBe(false);
    const s = FakeSource.all[0] as FakeSource;
    s.open();
    s.send(5);
    s.send(6);
    expect(a.events).toEqual([
      [5, false],
      [6, false],
    ]);
    expect(b.events).toEqual([
      [5, true],
      [6, true],
    ]);
    expect(c.states.at(-1)).toBe('open');
    expect(b.opens).toEqual([false]);
  });

  it('后来的标签页一打开就知道已经连上了', async () => {
    const locks = new FakeLocks();
    const ch = bus();
    const a = tab(locks, ch);
    a.stream.start();
    await flush();
    (FakeSource.all[0] as FakeSource).open();
    const b = tab(locks, ch);
    b.stream.start();
    await flush();
    expect(b.states.at(-1)).toBe('open');
    expect(b.opens).toEqual([false]);
  });

  it('领头的关了，下一个接手，按收到过的最后一个 seq 续上', async () => {
    const locks = new FakeLocks();
    const ch = bus();
    const a = tab(locks, ch);
    const b = tab(locks, ch);
    a.stream.start();
    await flush();
    b.stream.start();
    await flush();
    const first = FakeSource.all[0] as FakeSource;
    first.open();
    first.send(9);
    a.stream.stop();
    await flush();
    expect(first.closed).toBe(true);
    expect(b.stream.leading).toBe(true);
    const second = FakeSource.all[1] as FakeSource;
    expect(second.url).toBe('/api/events?since=9');
    second.open();
    second.send(9); // Melina 补发和之前收到的重叠
    second.send(10);
    expect(b.events).toEqual([
      [9, true],
      [10, false],
    ]);
    expect(b.opens).toEqual([false, true]); // 接手这一下按重连算：GET 全部重拉
  });

  it('领头的重连上了，跟着的也重拉', async () => {
    vi.useFakeTimers();
    const locks = new FakeLocks();
    const ch = bus();
    const a = tab(locks, ch);
    const b = tab(locks, ch);
    a.stream.start();
    await flush();
    b.stream.start();
    await flush();
    const first = FakeSource.all[0] as FakeSource;
    first.open();
    first.readyState = 2;
    first.onerror?.(new Event('error'));
    expect(b.states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(100);
    (FakeSource.all[1] as FakeSource).open();
    expect(b.opens).toEqual([false, true]);
  });

  it('没有 Web Locks 时每个标签页自己连', async () => {
    const a = tab(null as unknown as LocksLike, bus());
    const stream = new SharedMelinaStream({
      url: () => '/api/events',
      onEvent: () => {},
      locks: null,
      create: (url) => new FakeSource(url),
    });
    a.stream.start();
    stream.start();
    await flush();
    expect(FakeSource.all).toHaveLength(2);
    expect(stream.leading).toBe(true);
  });

  it('排队时 stop：不再接手', async () => {
    const locks = new FakeLocks();
    const ch = bus();
    const a = tab(locks, ch);
    const b = tab(locks, ch);
    a.stream.start();
    await flush();
    b.stream.start();
    b.stream.stop();
    a.stream.stop();
    await flush();
    expect(FakeSource.all).toHaveLength(1);
  });
});
