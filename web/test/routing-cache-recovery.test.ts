// 里前端那几条。坏地址不白屏；按过「现在重试」以后照样认得出半开的连接；
// 没人看的缓存只留最近用过的；总览的用量最多每 10 秒重拉一次。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atMostEvery, USAGE_REFRESH_MS } from '../src/api/live.tsx';
import { IDLE_LIMIT, readResource, resetResources, subscribeResource } from '../src/api/resource.ts';
import { type EventSourceLike, MelinaStream } from '../src/api/stream.ts';
import { matchPath } from '../src/app/router.tsx';

describe('坏地址', () => {
  it('坏的百分号编码原样留着，不抛错（以前外壳渲染时抛 URIError，整页白屏）', () => {
    expect(matchPath('/runs/:id/*', '/runs/%zz')).toEqual({ id: '%zz', '*': '' });
    expect(matchPath('/runs/:id/*', '/runs/a%20b/result')).toEqual({ id: 'a b', '*': 'result' });
  });
});

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent<string>) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private readonly named = new Map<string, (ev: MessageEvent<string>) => void>();
  constructor() {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
    this.named.set(type, listener);
  }
  ping() {
    this.named.get('ping')?.(new MessageEvent('ping', { data: '{}' }));
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  blip() {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

describe('按过「现在重试」以后照样看门', () => {
  beforeEach(() => {
    FakeSource.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('新连接收到心跳以后，太久没动静照样关掉重连', () => {
    const stream = new MelinaStream({
      url: () => '/api/events',
      onEvent: () => {},
      create: () => new FakeSource(),
      retryDelays: [100],
      staleMs: 3000,
    });
    stream.start();
    const first = FakeSource.all[0] as FakeSource;
    first.open();
    first.ping(); // 看门狗看着第一条
    first.blip(); // 浏览器在自己重连，页面上写「连不上」，人按了「现在重试」
    stream.retryNow();
    const second = FakeSource.all[1] as FakeSource;
    expect(first.closed).toBe(true);
    second.open();
    second.ping();
    vi.advanceTimersByTime(5000); // 第二条半开了：什么都没再收到
    expect(second.closed).toBe(true);
    vi.advanceTimersByTime(100);
    expect(FakeSource.all).toHaveLength(3);
    stream.stop();
  });
});

describe('没人看的缓存只留最近用过的', () => {
  afterEach(() => resetResources());

  it(`超过 ${IDLE_LIMIT} 个就扔最久没用的；有人订阅的不扔`, async () => {
    const def = (key: string) => ({ key, fetch: async () => key });
    const kept = subscribeResource(def('kept'), () => {});
    for (let i = 0; i < IDLE_LIMIT + 5; i++) {
      const stop = subscribeResource(def(`progress:${i}`), () => {});
      await Promise.resolve();
      await Promise.resolve();
      stop();
    }
    expect(readResource('kept').data).toBe('kept');
    expect(readResource('progress:0').data).toBeUndefined(); // 最早的扔了
    expect(readResource(`progress:${IDLE_LIMIT + 4}`).data).toBe(`progress:${IDLE_LIMIT + 4}`); // 最近的留着
    kept();
  });
});

describe('总览的用量节流', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('一秒一条用量事件：第一条马上拉，之后最多每 10 秒一次，最后一条之后一定再拉一次', () => {
    let pulls = 0;
    const usage = atMostEvery(USAGE_REFRESH_MS, () => pulls++);
    usage.touch();
    vi.advanceTimersByTime(0);
    expect(pulls).toBe(1);
    for (let i = 0; i < 25; i++) {
      vi.advanceTimersByTime(1000);
      usage.touch();
    }
    expect(pulls).toBe(3); // 第 0、10、20 秒
    vi.advanceTimersByTime(USAGE_REFRESH_MS);
    expect(pulls).toBe(4); // 最后那几条也拉到了
    usage.stop();
  });
});
