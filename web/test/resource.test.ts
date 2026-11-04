// GET 缓存（src/api/resource.ts）：合并请求、旧数据先用、拉的时候又过期了要再拉一次。

import { afterEach, describe, expect, it } from 'vitest';
import {
  invalidate,
  invalidateSettled,
  mutateResource,
  type ResourceDef,
  readResource,
  resetResources,
  setResource,
  subscribeResource,
} from '../src/api/resource.ts';

afterEach(() => resetResources());

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function counter<T>(key: string) {
  const calls: { resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];
  const def: ResourceDef<T> = {
    key,
    fetch: () => {
      const d = deferred<T>();
      calls.push(d);
      return d.promise;
    },
  };
  return { def, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('资源缓存', () => {
  it('第一个订阅的人触发请求；同一个 key 只拉一次', async () => {
    const { def, calls } = counter<number>('a');
    const off1 = subscribeResource(def, () => {});
    const off2 = subscribeResource(def, () => {});
    expect(calls).toHaveLength(1);
    expect(readResource('a').loading).toBe(true);
    calls[0]?.resolve(1);
    await tick();
    expect(readResource('a')).toMatchObject({ data: 1, loading: false, refreshing: false });
    off1();
    off2();
  });

  it('过期了：有人在看马上重拉，期间旧数据还在', async () => {
    const { def, calls } = counter<number>('b');
    subscribeResource(def, () => {});
    calls[0]?.resolve(1);
    await tick();
    invalidate('b');
    expect(calls).toHaveLength(2);
    expect(readResource('b')).toMatchObject({ data: 1, refreshing: true });
    calls[1]?.resolve(2);
    await tick();
    expect(readResource('b').data).toBe(2);
  });

  it('拉的过程中又过期了：拉完再拉一次，旧的结果不算数', async () => {
    const { def, calls } = counter<number>('c');
    subscribeResource(def, () => {});
    invalidate('c');
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(1);
    await tick();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(2);
    await tick();
    expect(readResource('c').data).toBe(2);
  });

  it('没人看的只标记过期，下次有人看再拉', async () => {
    const { def, calls } = counter<number>('d');
    const off = subscribeResource(def, () => {});
    calls[0]?.resolve(1);
    await tick();
    off();
    invalidate('d');
    expect(calls).toHaveLength(1);
    subscribeResource(def, () => {});
    expect(calls).toHaveLength(2);
  });

  it('按前缀过期：run:<id> 连同 run:<id>:progress 一起', async () => {
    const a = counter<number>('run:X');
    const b = counter<number>('run:X:progress');
    const c = counter<number>('runs');
    subscribeResource(a.def, () => {});
    subscribeResource(b.def, () => {});
    subscribeResource(c.def, () => {});
    invalidate('run:X');
    expect([a.calls.length, b.calls.length, c.calls.length]).toEqual([1, 1, 1]);
    for (const x of [a, b, c]) x.calls[0]?.resolve(0);
    await tick();
    invalidate('run:X');
    expect([a.calls.length, b.calls.length, c.calls.length]).toEqual([2, 2, 1]);
  });

  it('出错：留着旧数据，报错误', async () => {
    const { def, calls } = counter<number>('e');
    subscribeResource(def, () => {});
    calls[0]?.resolve(1);
    await tick();
    invalidate('e');
    calls[1]?.reject(new Error('连不上'));
    await tick();
    expect(readResource('e')).toMatchObject({ data: 1, refreshing: false });
    expect(readResource('e').error?.message).toBe('连不上');
  });

  it('setResource 直接换数据，正在拉的作废', async () => {
    const { def, calls } = counter<number>('f');
    subscribeResource(def, () => {});
    setResource('f', 9);
    calls[0]?.resolve(1);
    await tick();
    expect(readResource('f').data).toBe(9);
    mutateResource<number>('f', (n) => n + 1);
    expect(readResource('f').data).toBe(10);
  });

  it('订阅的人在数据变化时收到通知', async () => {
    const { def, calls } = counter<number>('g');
    let n = 0;
    subscribeResource(def, () => n++);
    const before = n;
    calls[0]?.resolve(1);
    await tick();
    expect(n).toBeGreaterThan(before);
  });

  it('拉的过程中过期了、拉完时没人在看：记成过期，下次有人看再拉', async () => {
    const { def, calls } = counter<number>('h');
    const off = subscribeResource(def, () => {});
    invalidate('h');
    off();
    calls[0]?.resolve(1);
    await tick();
    expect(calls).toHaveLength(1);
    subscribeResource(def, () => {});
    expect(calls).toHaveLength(2);
  });
});

describe('长任务别白白重画', () => {
  it('拉回来和手上的一样（same）：留着旧对象，也不通知', async () => {
    const calls: { resolve: (v: { seq: number; text: string }) => void }[] = [];
    const def: ResourceDef<{ seq: number; text: string }> = {
      key: 'same',
      fetch: () => {
        const d = deferred<{ seq: number; text: string }>();
        calls.push(d);
        return d.promise;
      },
      same: (a, b) => a.seq === b.seq,
    };
    let notified = 0;
    subscribeResource(def, () => notified++);
    calls[0]?.resolve({ seq: 5, text: '第一次' });
    await tick();
    const first = readResource('same').data;
    notified = 0;
    invalidate('same');
    calls[1]?.resolve({ seq: 5, text: '同一个 seq 的另一个对象' });
    await tick();
    expect(readResource('same').data).toBe(first);
    expect(notified).toBe(0);
    invalidate('same');
    calls[2]?.resolve({ seq: 6, text: '新的' });
    await tick();
    expect(readResource('same').data).toEqual({ seq: 6, text: '新的' });
    expect(notified).toBe(1);
  });

  it('事件流第一次连上：只重拉已经拉完的，还在拉的不再拉第二遍', async () => {
    const done = counter<number>('settled');
    const pending = counter<number>('pending');
    subscribeResource(done.def, () => {});
    subscribeResource(pending.def, () => {});
    done.calls[0]?.resolve(1);
    await tick();
    invalidateSettled();
    expect(done.calls).toHaveLength(2);
    pending.calls[0]?.resolve(1);
    await tick();
    expect(pending.calls).toHaveLength(1);
  });
});
