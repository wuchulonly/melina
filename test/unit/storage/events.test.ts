// 进程内事件总线：订阅过滤；stream 先补发历史再接着推，中间不漏不重（SSE 和 SDK 用）；
// 读得慢的 stream 只攒有限的几条，攒满了改从 events 表补。
import { afterEach, describe, expect, it } from 'vitest';
import type { MelinaEvent } from '../../../src/core/events.ts';
import type { Id } from '../../../src/core/ids.ts';
import { openRunStore, type RunStore } from '../../../src/storage/state.ts';
import { newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

const runStores: (TestRunStore | RunStore)[] = [];
afterEach(() => {
  for (const b of runStores.splice(0)) b.close();
});
function runStore(): TestRunStore {
  const b = testRunStore();
  runStores.push(b);
  return b;
}
async function take(it: AsyncIterator<MelinaEvent>, n: number): Promise<MelinaEvent[]> {
  const out: MelinaEvent[] = [];
  while (out.length < n) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}
describe('订阅', () => {
  it('按 runId、types 过滤', () => {
    const b = runStore();
    const seen: string[] = [];
    const run = newRun(b);
    b.bus.subscribe((e) => seen.push(e.type), { runId: run.id, types: ['branch.updated'] });
    const other = newRun(b);
    startBranch(b, other);
    startBranch(b, run);
    expect(seen).toEqual(['branch.updated']);
  });
  it('取消订阅后不再收到', () => {
    const b = runStore();
    const seen: number[] = [];
    const off = b.bus.subscribe((e) => seen.push(e.seq));
    newRun(b);
    off();
    newRun(b);
    expect(seen).toEqual([1, 2]);
  });
});
describe('stream：先补历史，再推新的', () => {
  it('从 since 之后补发，接着推新提交的；不漏不重', async () => {
    const b = runStore();
    const run = newRun(b);
    const { branch } = startBranch(b, run);
    const controller = new AbortController();
    const it = b.bus.stream(2, { runId: run.id, signal: controller.signal })[Symbol.asyncIterator]();
    const history = await take(it, 3);
    expect(history.map((e) => e.seq)).toEqual([3, 4, 5]);
    observe(b, branch);
    observe(b, branch);
    const live = await take(it, 2);
    expect(live.map((e) => e.type)).toEqual(['observation.created', 'observation.created']);
    expect(live.map((e) => e.seq)).toEqual([6, 7]);
    controller.abort();
    expect((await it.next()).done).toBe(true);
  });
  it('补历史的过程中又有新写入：照样按 seq 连续', async () => {
    const b = runStore();
    const run = newRun(b);
    const { branch } = startBranch(b, run);
    for (let i = 0; i < 5; i++) observe(b, branch);
    const controller = new AbortController();
    const it = b.bus.stream(0, { signal: controller.signal })[Symbol.asyncIterator]();
    const got: number[] = [];
    // 历史 10 条（建 Run 2、开分支 3、Observation 5），中途再写 1 条
    for (let i = 0; i < 11; i++) {
      const r = await it.next();
      if (r.done) break;
      got.push(r.value.seq);
      if (i === 2) observe(b, branch); // 在补历史的中途写入
    }
    controller.abort();
    expect(got).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });
  it('单个 Run 的流不带 system.updated，全局流带', async () => {
    const b = runStore();
    const run = newRun(b);
    b.writer.emitSystem({
      providers: [],
      toolExec: { limit: 2, running: 0, queued: 0, auto: true },
      disk: { freeBytes: 1, minBytes: 1, ok: true },
      runs: { running: 1, paused: 0 },
    });
    const controller = new AbortController();
    const all = b.bus.stream(0, { signal: controller.signal })[Symbol.asyncIterator]();
    expect((await take(all, 3)).map((e) => e.type)).toEqual(['run.created', 'completion.drafted', 'system.updated']);
    const one = b.bus.stream(0, { runId: run.id, signal: controller.signal })[Symbol.asyncIterator]();
    expect((await take(one, 2)).map((e) => e.type)).toEqual(['run.created', 'completion.drafted']);
    controller.abort();
  });
});
describe('读得慢的 stream：待发队列有上限', () => {
  /** 队列上限调成 max 的 RunStore；记下哪几次攒满了 */
  function slowRunStore(max: number) {
    const overflows: {
      runId?: Id;
      cursor: number;
    }[] = [];
    let t = Date.parse('2026-10-02T00:00:00.000Z');
    const tick = () => {
      t += 1000;
      return new Date(t);
    };
    const b = openRunStore({
      db: ':memory:',
      now: tick,
      streamQueueMax: max,
      onStreamOverflow: (info) => overflows.push(info),
    });
    runStores.push(b);
    const subscriptions = () =>
      (
        b.bus as unknown as {
          subscriptions: Set<unknown>;
        }
      ).subscriptions.size;
    return { b, overflows, subscriptions };
  }
  it('攒满就退订、扔掉攒的，内存不再涨；再来取时从表里接着补，照样按 seq 连续、不漏不重', async () => {
    const { b, overflows, subscriptions } = slowRunStore(5);
    const run = newRun(b);
    const { branch } = startBranch(b, run);
    const controller = new AbortController();
    const it = b.bus.stream(b.queries.lastSeq(), { runId: run.id, signal: controller.signal })[Symbol.asyncIterator]();
    const first = it.next(); // 开始等：已经订阅上了
    expect(subscriptions()).toBe(1);
    observe(b, branch);
    expect((await first).value?.type).toBe('observation.created');
    const from = b.queries.lastSeq();
    // 读的人停着不取，写 30 条：攒到 5 条就退订、扔掉
    for (let i = 0; i < 30; i++) observe(b, branch);
    expect(subscriptions()).toBe(0);
    const got = await take(it, 30);
    expect(got.map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => from + 1 + i));
    expect(overflows).toEqual([{ runId: run.id, cursor: from }]);
    // 跟上来以后照常推新的
    observe(b, branch);
    expect((await take(it, 1))[0]?.seq).toBe(from + 31);
    expect(subscriptions()).toBe(1);
    controller.abort();
    expect((await it.next()).done).toBe(true);
    expect(subscriptions()).toBe(0);
  });
  it('补历史补到一半攒满了：照样补完、不重，连着推后面的', async () => {
    const { b, overflows } = slowRunStore(3);
    const run = newRun(b);
    const { branch } = startBranch(b, run);
    for (let i = 0; i < 10; i++) observe(b, branch);
    const controller = new AbortController();
    const it = b.bus.stream(0, { signal: controller.signal })[Symbol.asyncIterator]();
    const got: number[] = [];
    for (const e of await take(it, 4)) got.push(e.seq);
    for (let i = 0; i < 20; i++) observe(b, branch); // 补历史的中途写进来一大串
    const total = b.queries.lastSeq();
    for (const e of await take(it, total - 4)) got.push(e.seq);
    expect(got).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(overflows.length).toBeGreaterThan(0);
    controller.abort();
  });
  it('跟得上的不受影响：一条条取，从不攒满', async () => {
    const { b, overflows } = slowRunStore(2);
    const run = newRun(b);
    const { branch } = startBranch(b, run);
    const controller = new AbortController();
    const it = b.bus.stream(b.queries.lastSeq(), { signal: controller.signal })[Symbol.asyncIterator]();
    for (let i = 0; i < 20; i++) {
      const next = it.next();
      observe(b, branch);
      expect((await next).value?.type).toBe('observation.created');
    }
    expect(overflows).toEqual([]);
    controller.abort();
  });
});
