// SSE 客户端（src/api/stream.ts）：断线按 since 续传、重复的丢掉、每次连上都通知调用方重拉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MelinaEvent } from '../../src/core/events.ts';
import { type EventSourceLike, MelinaStream } from '../src/api/stream.ts';

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent<string>) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  readonly url: string;
  private readonly named = new Map<string, (ev: MessageEvent<string>) => void>();
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
    this.named.set(type, listener);
  }
  /** Melina 的心跳（具名事件 ping） */
  ping() {
    this.named.get('ping')?.(new MessageEvent('ping', { data: '{}' }));
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  send(seq: number, type = 'run.updated') {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify({ seq, type, runId: 'R', at: '', data: {} }) }),
    );
  }
  /** 浏览器自己在重连 */
  blip() {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }
  /** 断了，浏览器不再重连（比如返回了错误） */
  die() {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

beforeEach(() => {
  FakeSource.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function make(since?: number, extra: Partial<ConstructorParameters<typeof MelinaStream>[0]> = {}) {
  const events: number[] = [];
  const states: string[] = [];
  const opens: boolean[] = [];
  const stream = new MelinaStream({
    url: (s) => (s === undefined ? '/api/events' : `/api/events?since=${s}`),
    onEvent: (e: MelinaEvent) => events.push(e.seq),
    onState: (s) => states.push(s),
    onOpen: ({ reconnect }) => opens.push(reconnect),
    create: (url) => new FakeSource(url),
    retryDelays: [100, 200],
    ...(since !== undefined ? { since } : {}),
    ...extra,
  });
  return { stream, events, states, opens };
}

describe('MelinaStream', () => {
  it('第一次连接不带 since，只要之后的新事件', () => {
    const { stream } = make();
    stream.start();
    expect(FakeSource.all[0]?.url).toBe('/api/events');
  });

  it('给了起点就从那里补', () => {
    const { stream } = make(42);
    stream.start();
    expect(FakeSource.all[0]?.url).toBe('/api/events?since=42');
  });

  it('seq 不大于收到过的直接丢掉', () => {
    const { stream, events } = make();
    stream.start();
    const s = FakeSource.all[0] as FakeSource;
    s.open();
    s.send(5);
    s.send(6);
    s.send(6);
    s.send(4);
    s.send(7);
    expect(events).toEqual([5, 6, 7]);
    expect(stream.lastSeq).toBe(7);
  });

  it('连接彻底断了：等一会儿按最后的 seq 重连，重连上了告诉调用方', () => {
    const { stream, events, opens, states } = make();
    stream.start();
    const first = FakeSource.all[0] as FakeSource;
    first.open();
    first.send(10);
    first.die();
    expect(first.closed).toBe(true);
    expect(states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(99);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const second = FakeSource.all[1] as FakeSource;
    expect(second.url).toBe('/api/events?since=10');
    second.open();
    second.send(10); // 补发和推送重叠
    second.send(11);
    expect(events).toEqual([10, 11]);
    expect(opens).toEqual([false, true]);
    expect(states.at(-1)).toBe('open');
  });

  it('连续失败时间隔拉长，到头了就按最长的间隔一直试', () => {
    const { stream } = make();
    stream.start();
    (FakeSource.all[0] as FakeSource).die();
    vi.advanceTimersByTime(100);
    (FakeSource.all[1] as FakeSource).die();
    vi.advanceTimersByTime(199);
    expect(FakeSource.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    (FakeSource.all[2] as FakeSource).die();
    vi.advanceTimersByTime(200);
    expect(FakeSource.all).toHaveLength(4);
  });

  it('浏览器自己在重连时不另开连接，只报状态', () => {
    const { stream, states } = make();
    stream.start();
    const s = FakeSource.all[0] as FakeSource;
    s.open();
    s.blip();
    vi.advanceTimersByTime(10_000);
    expect(FakeSource.all).toHaveLength(1);
    expect(states.at(-1)).toBe('reconnecting');
  });

  it('stop 以后不再重连', () => {
    const { stream } = make();
    stream.start();
    const s = FakeSource.all[0] as FakeSource;
    s.die();
    stream.stop();
    vi.advanceTimersByTime(10_000);
    expect(FakeSource.all).toHaveLength(1);
  });

  it('不是 JSON 的消息不处理', () => {
    const { stream, events } = make();
    stream.start();
    const s = FakeSource.all[0] as FakeSource;
    s.onmessage?.(new MessageEvent('message', { data: 'oops' }));
    s.send(1);
    expect(events).toEqual([1]);
  });

  it('收到过心跳以后太久没动静：当连接半死了，关掉按 since 重连', () => {
    const { stream, opens } = make(undefined, { staleMs: 3000 });
    stream.start();
    const first = FakeSource.all[0] as FakeSource;
    first.open();
    first.send(8);
    first.ping();
    vi.advanceTimersByTime(2000);
    first.ping(); // 心跳照常来，不动
    vi.advanceTimersByTime(3000);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(2000); // 最后一次动静过了 4 秒
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(100);
    const second = FakeSource.all[1] as FakeSource;
    expect(second.url).toBe('/api/events?since=8');
    second.open();
    expect(opens).toEqual([false, true]);
  });

  it('没发过心跳的老 Melina 不看门', () => {
    const { stream } = make(undefined, { staleMs: 3000 });
    stream.start();
    (FakeSource.all[0] as FakeSource).open();
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(1);
  });

  it('切到后台待够了就断开，回到前台按 since 续上；没待够就不断', () => {
    const listeners = new Set<() => void>();
    const vis = {
      hidden: false,
      addEventListener: (_: 'visibilitychange', l: () => void) => listeners.add(l),
      removeEventListener: (_: 'visibilitychange', l: () => void) => listeners.delete(l),
    };
    const flip = (hidden: boolean) => {
      vis.hidden = hidden;
      for (const l of listeners) l();
    };
    const { stream, events } = make(0, { pauseWhenHidden: 1000, visibility: vis });
    stream.start();
    const first = FakeSource.all[0] as FakeSource;
    first.open();
    first.send(3);
    flip(true);
    vi.advanceTimersByTime(500);
    flip(false); // 半秒就回来了
    vi.advanceTimersByTime(5000);
    expect(first.closed).toBe(false);
    flip(true);
    vi.advanceTimersByTime(1000);
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.all).toHaveLength(1); // 后台时不重连
    flip(false);
    const second = FakeSource.all[1] as FakeSource;
    expect(second.url).toBe('/api/events?since=3');
    second.open();
    second.send(4);
    expect(events).toEqual([3, 4]);
    stream.stop();
    expect(listeners.size).toBe(0);
  });
});
