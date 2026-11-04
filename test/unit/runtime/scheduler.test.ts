// Scheduler：准入层、调用层和工具层，Run 之间先平分、Run 内按优先级和权重、任务暂停、限流收紧和放宽、Retry-After、令牌桶、磁盘、
// 本机名额按 CPU 压力自动调。
import { describe, expect, it } from 'vitest';
import { newId } from '../../../src/core/ids.ts';
import type { Slot } from '../../../src/core/interfaces/scheduler.ts';
import type { Branch } from '../../../src/core/types.ts';
import { createScheduler, type ProviderRate, type SchedulerLimits } from '../../../src/runtime/scheduler.ts';
import { FakeClock } from './kit.ts';

const R1 = newId();
const R2 = newId();
function branch(runId: string, over: Partial<Branch> = {}): Branch {
  return {
    id: newId(),
    runId,
    seq: 1,
    betId: newId(),
    state: 'running',
    queued: false,
    workspace: { path: '/tmp/ws' },
    lastSnapshot: 'root',
    seenSeq: 0,
    episode: 1,
    toolCalls: 0,
    failures: 0,
    weight: 1,
    ...over,
  };
}
function setup(
  over: {
    limits?: Partial<SchedulerLimits>;
    rates?: ProviderRate[];
    disk?: number;
    load?: number;
    pressure?: number;
    resourcePressure?: boolean;
    recon?: Set<string>;
    weights?: Map<string, number>;
  } = {},
) {
  const clock = new FakeClock();
  const limits: SchedulerLimits = { modelCalls: {}, toolExec: 4, diskFreeMin: 100, ...over.limits };
  let disk = over.disk ?? 1000;
  let load = over.load ?? 0;
  let pressure = over.pressure;
  let resources: boolean | undefined = over.resourcePressure ?? false;
  const s = createScheduler({
    limits: () => limits,
    rates: () => over.rates ?? [],
    clock,
    cpus: () => 4,
    load: () => load,
    ...(over.pressure !== undefined ? { pressure: () => pressure } : {}),
    resourcePressure: () => resources,
    diskFree: async () => disk,
    jobOf: () => 'explorer_episode',
    ...(over.weights ? { weightOf: (id: string) => over.weights?.get(id) } : {}),
  });
  return {
    s,
    clock,
    limits,
    setDisk: (n: number) => {
      disk = n;
    },
    setLoad: (n: number) => {
      load = n;
    },
    setPressure: (n: number | undefined) => {
      pressure = n;
    },
    setResourcePressure: (busy: boolean | undefined) => {
      resources = busy;
    },
  };
}
/** 记下放行的先后 */
function track() {
  const order: string[] = [];
  const slots = new Map<string, Slot>();
  const take = (name: string) => (slot: Slot) => {
    order.push(name);
    slots.set(name, slot);
  };
  const release = (name: string) => {
    slots.get(name)?.release();
    slots.delete(name);
  };
  return { order, take, release, slots };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
it('模型在途只统计本分支已占用的对应调用，排队、工具和 episode 不计入', async () => {
  const { s } = setup({ limits: { modelCalls: { deepseek: 1 } } });
  const b = branch(R1);
  const episode = await s.episodeSlot(b, 'deepseek');
  const tool = await s.toolSlot({ runId: R1, branchId: b.id });
  expect(s.modelInFlight(b.id, 'explorer_episode')).toBe(false);
  const watcher = await s.modelSlot({ runId: R1, branchId: b.id, provider: 'deepseek', job: 'watcher_call' });
  const waiting = s.modelSlot({ runId: R1, branchId: b.id, provider: 'deepseek', job: 'explorer_episode' });
  expect(s.modelInFlight(b.id, 'watcher_call')).toBe(true);
  expect(s.modelInFlight(b.id, 'explorer_episode')).toBe(false);
  watcher.release();
  const main = await waiting;
  expect(s.modelInFlight(b.id, 'explorer_episode')).toBe(true);
  expect(s.modelInFlight(newId(), 'explorer_episode')).toBe(false);
  main.release();
  expect(s.modelInFlight(b.id, 'explorer_episode')).toBe(false);
  tool.release();
  episode.release();
  s.dispose();
});
describe('准入层', () => {
  it('episode 不占本机的名额：toolExec 是 1，没封顶的供应商照样放三个（改的口径）', async () => {
    const { s } = setup({ limits: { toolExec: 1 } });
    const t = track();
    const bs = [branch(R1), branch(R1), branch(R1)];
    bs.forEach((b, i) => void s.episodeSlot(b, 'deepseek').then(t.take(`b${i}`)));
    await flush();
    expect(t.order).toEqual(['b0', 'b1', 'b2']);
    expect(s.status().toolExec).toMatchObject({ limit: 1, running: 0, queued: 0 });
    expect(s.status().providers[0]?.episodes).toEqual({ running: 3, queued: 0 });
    s.dispose();
  });
  it('封了顶的供应商：多出来的 episode 排队，还一个放一个', async () => {
    const { s } = setup({ limits: { modelCalls: { deepseek: 2 } } });
    const t = track();
    const bs = [branch(R1), branch(R1), branch(R1)];
    bs.forEach((b, i) => void s.episodeSlot(b, 'deepseek').then(t.take(`b${i}`)));
    await flush();
    expect(t.order).toEqual(['b0', 'b1']);
    expect(s.status().providers[0]?.episodes).toEqual({ running: 2, queued: 1 });
    t.release('b0');
    await flush();
    expect(t.order).toEqual(['b0', 'b1', 'b2']);
    s.dispose();
  });
  it('某家封了顶：用这家模型的 episode 不超过它，别家的照常放', async () => {
    const { s } = setup({ limits: { modelCalls: { deepseek: 1 }, toolExec: 4 } });
    const t = track();
    void s.episodeSlot(branch(R1), 'deepseek').then(t.take('d1'));
    void s.episodeSlot(branch(R1), 'deepseek').then(t.take('d2'));
    void s.episodeSlot(branch(R1), 'anthropic').then(t.take('a1'));
    await flush();
    expect(t.order).toEqual(['d1', 'a1']);
    expect(s.capacity(R1)).toEqual([
      { provider: 'anthropic', limit: null, running: 1, queued: 0 },
      { provider: 'deepseek', limit: 1, running: 1, queued: 1 },
      { provider: 'local', limit: 4, running: 0, queued: 0 },
    ]);
    s.dispose();
  });
  it('多个 Run 先平分：分支多的 Run 挤不掉别的 Run', async () => {
    const { s } = setup({ limits: { modelCalls: { p: 2 } } });
    const t = track();
    for (let i = 0; i < 4; i++) void s.episodeSlot(branch(R1), 'p').then(t.take(`A${i}`));
    for (let i = 0; i < 2; i++) void s.episodeSlot(branch(R2), 'p').then(t.take(`B${i}`));
    await flush();
    expect(t.order).toEqual(['A0', 'A1']); // B 来之前 A 先用上了
    t.release('A0');
    await flush();
    expect(t.order.at(-1)).toBe('B0'); // A 手里还有一个，B 一个没有：B 先
    t.release('A1');
    await flush();
    expect(t.order.at(-1)).toBe('A2'); // A 手里没了、B 有一个：A 先
    t.release('B0');
    await flush();
    expect(t.order.at(-1)).toBe('B1');
    s.dispose();
  });
  /** 几条分支轮流要名额：拿到就跑一下、还掉、再要；数前 n 次放行各给了谁 */
  async function compete(s: ReturnType<typeof setup>['s'], branches: Record<string, Branch>, n: number) {
    const order: string[] = [];
    let stop = false;
    const loop = async (name: string, b: Branch) => {
      while (!stop) {
        const slot = await s.episodeSlot(b, 'p');
        order.push(name);
        if (order.length >= n) stop = true;
        await flush();
        slot.release();
      }
    };
    await Promise.all(Object.entries(branches).map(([name, b]) => loop(name, b)));
    return order.slice(0, n);
  }
  it('episode 之间按调度权重分：三条分支抢一个名额，权重 2 的分到一半，权重 1 的各四分之一', async () => {
    const { s } = setup({ limits: { modelCalls: { p: 1 } } });
    const order = await compete(
      s,
      { heavy: branch(R1, { weight: 2 }), a: branch(R1, { weight: 1 }), b: branch(R1, { weight: 1 }) },
      40,
    );
    const share = (name: string) => order.filter((x) => x === name).length / order.length;
    expect(share('heavy')).toBeGreaterThan(0.42);
    expect(share('heavy')).toBeLessThan(0.58);
    expect(share('a')).toBeGreaterThan(0.18);
    expect(share('b')).toBeGreaterThan(0.18);
    s.dispose();
  });
  it('prioritize 改了权重：排着队的也按新的算', async () => {
    const a = branch(R1);
    const b = branch(R1);
    const c = branch(R1);
    const weights = new Map([
      [a.id, 1],
      [b.id, 4],
      [c.id, 1],
    ]);
    const { s } = setup({ limits: { modelCalls: { p: 1 } }, weights });
    const order = await compete(s, { a, b, c }, 30);
    const share = (name: string) => order.filter((x) => x === name).length / order.length;
    expect(share('b')).toBeGreaterThan(share('a') + 0.15);
    expect(share('b')).toBeGreaterThan(share('c') + 0.15);
    s.dispose();
  });
  it('任务暂停只停准入层：这个 Run 的 episode 不放行，调用照常；恢复后放行', async () => {
    const { s } = setup();
    const t = track();
    s.pauseRun(R1);
    void s.episodeSlot(branch(R1), 'p').then(t.take('ep'));
    void s.modelSlot({ runId: R1, provider: 'p', job: 'scoper_call' }).then(t.take('call'));
    void s.episodeSlot(branch(R2), 'p').then(t.take('other'));
    await flush();
    expect(t.order).toEqual(['call', 'other']);
    s.resumeRun(R1);
    await flush();
    expect(t.order).toEqual(['call', 'other', 'ep']);
    s.dispose();
  });
  it('Run 结束：排着队的都被拒；等待中取消的从队里拿掉', async () => {
    const { s } = setup({ limits: { modelCalls: { p: 1 } } });
    const hold = await s.episodeSlot(branch(R2), 'p');
    const dropped = s.episodeSlot(branch(R1), 'p');
    const ac = new AbortController();
    const aborted = s.episodeSlot(branch(R2), 'p', ac.signal);
    s.dropRun(R1);
    await expect(dropped).rejects.toThrow('任务已经结束');
    ac.abort(new Error('不等了'));
    await expect(aborted).rejects.toThrow('不等了');
    expect(s.status().providers[0]?.episodes.queued).toBe(0);
    hold.release();
    s.dispose();
  });
  it('没能马上放行时调一次 onQueued；马上放行的不调', async () => {
    const { s } = setup({ limits: { modelCalls: { p: 1 } } });
    let queued = 0;
    const a = await s.episodeSlot(branch(R1), 'p', undefined, () => queued++);
    expect(queued).toBe(0);
    const b = s.episodeSlot(branch(R1), 'p', undefined, () => queued++);
    expect(queued).toBe(1);
    a.release();
    (await b).release();
    s.dispose();
  });
  it('剩余磁盘不够：新分支不放行，已经有 workspace 的照常；磁盘腾出来后放行', async () => {
    const { s, clock, setDisk } = setup({ disk: 10 });
    await flush(); // 第一次看磁盘
    const t = track();
    void s.episodeSlot(branch(R1, { state: 'starting', workspace: undefined }), 'p').then(t.take('new'));
    void s.episodeSlot(branch(R1), 'p').then(t.take('old'));
    await flush();
    expect(t.order).toEqual(['old']);
    expect(s.status().disk).toEqual({ freeBytes: 10, minBytes: 100, ok: false });
    setDisk(1000);
    clock.advance(15000);
    await flush();
    await flush();
    expect(t.order).toEqual(['old', 'new']);
    s.dispose();
  });
  it('limits.toolExec 为 auto：负载高时收紧，回落且没有排队时只恢复到初始并发', async () => {
    const { s, clock, setLoad } = setup({ limits: { toolExec: 'auto' } });
    expect(s.status().toolExec).toMatchObject({ limit: 4, auto: true });
    setLoad(9);
    clock.advance(5000);
    expect(s.status().toolExec.limit).toBe(3);
    clock.advance(5000);
    expect(s.status().toolExec.limit).toBe(2);
    setLoad(1);
    clock.advance(5000);
    clock.advance(5000);
    clock.advance(5000);
    expect(s.status().toolExec.limit).toBe(4);
    s.dispose();
  });
  it('limits.toolExec 为 auto：有 CPU 压力（PSI）就只看它，超过一半收紧、低于四分之一加回、中间不动', async () => {
    // 负载给得很高：有 PSI 时不看它（容器里的 loadavg 是整台宿主机的）
    const { s, clock, setPressure } = setup({ limits: { toolExec: 'auto' }, load: 50, pressure: 80 });
    clock.advance(5000);
    clock.advance(5000);
    expect(s.status().toolExec.limit).toBe(2);
    setPressure(40);
    clock.advance(5000);
    clock.advance(5000);
    expect(s.status().toolExec.limit).toBe(2);
    setPressure(10);
    clock.advance(5000);
    expect(s.status().toolExec.limit).toBe(3);
    setPressure(undefined); // 读不到 PSI：退回看负载，50 超过核数
    clock.advance(5000);
    expect(s.status().toolExec.limit).toBe(2);
    s.dispose();
  });
});
describe('工具层', () => {
  it('等待网络的命令排着队、资源有余量：自动并发可以超过核数，逐步放行到当前需求', async () => {
    const { s, clock } = setup({ limits: { toolExec: 'auto' }, pressure: 0 });
    const t = track();
    for (let i = 0; i < 10; i++) void s.toolSlot({ runId: R1 }).then(t.take(String(i)));
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 4, running: 4, queued: 6, auto: true });
    clock.advance(5000);
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 5, running: 5, queued: 5 });
    clock.advance(25000);
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 10, running: 10, queued: 0 });
    clock.advance(60000);
    expect(s.status().toolExec.limit).toBe(10); // 没有新需求，不能无限长大
    for (const name of [...t.slots.keys()]) t.release(name);
    clock.advance(5000);
    expect(s.status().toolExec).toMatchObject({ limit: 4, running: 0, queued: 0 });
    s.dispose();
  });
  it('放宽时仍先给手里命令少的 Run：分支多的任务不能把新增名额全拿走', async () => {
    const { s, clock } = setup({ limits: { toolExec: 'auto' }, pressure: 0 });
    const t = track();
    for (let i = 0; i < 6; i++) void s.toolSlot({ runId: R1 }).then(t.take(`A${i}`));
    for (let i = 0; i < 2; i++) void s.toolSlot({ runId: R2 }).then(t.take(`B${i}`));
    await flush();
    clock.advance(10000);
    await flush();
    expect(t.order).toEqual(['A0', 'A1', 'A2', 'A3', 'B0', 'B1']);
    s.dispose();
  });
  it('已经超过核数后 CPU 吃紧：收紧后续放行，已执行的命令继续占有名额直到完成', async () => {
    const { s, clock, setPressure } = setup({ limits: { toolExec: 'auto' }, pressure: 0 });
    const t = track();
    for (let i = 0; i < 10; i++) void s.toolSlot({ runId: R1 }).then(t.take(String(i)));
    await flush();
    clock.advance(10000);
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 6, running: 6, queued: 4 });
    setPressure(80);
    clock.advance(5000);
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 4, running: 6, queued: 4 });
    t.release('0');
    t.release('1');
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 4, running: 4, queued: 4 });
    t.release('2');
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 4, running: 4, queued: 3 });
    s.dispose();
  });
  it('CPU 有余量但内存或进程名额吃紧：照样收紧；处在阈值中间不放宽，恢复后重新放行', async () => {
    const { s, clock, setResourcePressure } = setup({
      limits: { toolExec: 'auto' },
      pressure: 0,
      resourcePressure: true,
    });
    const t = track();
    for (let i = 0; i < 6; i++) void s.toolSlot({ runId: R1 }).then(t.take(String(i)));
    await flush();
    clock.advance(5000);
    expect(s.status().toolExec).toMatchObject({ limit: 3, running: 4, queued: 2 });
    setResourcePressure(undefined);
    clock.advance(10000);
    expect(s.status().toolExec.limit).toBe(3);
    setResourcePressure(false);
    clock.advance(10000);
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 5, running: 5, queued: 1 });
    s.dispose();
  });
  it('读不到 PSI 时负载接近满核：不继续放宽；负载回落后才放行排队命令', async () => {
    const { s, clock, setLoad } = setup({ limits: { toolExec: 'auto' }, load: 4 });
    const t = track();
    for (let i = 0; i < 6; i++) void s.toolSlot({ runId: R1 }).then(t.take(String(i)));
    await flush();
    clock.advance(10000);
    expect(s.status().toolExec).toMatchObject({ limit: 4, running: 4, queued: 2 });
    setLoad(1);
    clock.advance(5000);
    await flush();
    expect(s.status().toolExec).toMatchObject({ limit: 5, running: 5, queued: 1 });
    s.dispose();
  });
  it('手动提高并发不受自动收紧影响，也不必等占名额的命令结束才放行', async () => {
    const { s, clock, limits } = setup({ limits: { toolExec: 2 }, pressure: 80, resourcePressure: true });
    const t = track();
    for (let i = 0; i < 3; i++) void s.toolSlot({ runId: R1 }).then(t.take(String(i)));
    await flush();
    clock.advance(5000);
    expect(s.status().toolExec).toMatchObject({ limit: 2, running: 2, queued: 1, auto: false });
    limits.toolExec = 3;
    clock.advance(5000);
    await flush();
    expect(s.status().toolExec).toEqual({ limit: 3, running: 3, queued: 0, auto: false });
    s.dispose();
  });
  it('同时执行的命令不超过 limits.toolExec，还一个放一个；status、capacity 数的是命令', async () => {
    const { s } = setup({ limits: { toolExec: 2 } });
    const t = track();
    void s.toolSlot({ runId: R1, branchId: 'a' }).then(t.take('a'));
    void s.toolSlot({ runId: R1, branchId: 'b' }).then(t.take('b'));
    void s.toolSlot({ runId: R1, branchId: 'c' }).then(t.take('c'));
    await flush();
    expect(t.order).toEqual(['a', 'b']);
    expect(s.status().toolExec).toEqual({ limit: 2, running: 2, queued: 1, auto: false });
    expect(s.capacity(R1).at(-1)).toEqual({ provider: 'local', limit: 2, running: 2, queued: 1 });
    expect(s.status().providers).toEqual([]); // 工具层不算哪家供应商
    t.release('a');
    await flush();
    expect(t.order).toEqual(['a', 'b', 'c']);
    s.dispose();
  });
  it('多个 Run 先平分：手里命令少的 Run 先', async () => {
    const { s } = setup({ limits: { toolExec: 2 } });
    const t = track();
    void s.toolSlot({ runId: R1 }).then(t.take('A0'));
    void s.toolSlot({ runId: R1 }).then(t.take('A1'));
    await flush();
    void s.toolSlot({ runId: R1 }).then(t.take('A2'));
    void s.toolSlot({ runId: R2 }).then(t.take('B0'));
    await flush();
    t.release('A0');
    await flush();
    expect(t.order).toEqual(['A0', 'A1', 'B0']); // A 手里还有一个，B 一个没有：B 先
    t.release('A1');
    await flush();
    expect(t.order).toEqual(['A0', 'A1', 'B0', 'A2']);
    s.dispose();
  });
  it('任务暂停不挡工具层（在跑的 episode 要做完手上的命令再收尾）；Run 结束时排着的被拒；取消的拿掉', async () => {
    const { s } = setup({ limits: { toolExec: 1 } });
    s.pauseRun(R1);
    const first = await s.toolSlot({ runId: R1 });
    const dropped = s.toolSlot({ runId: R1 });
    const ac = new AbortController();
    const aborted = s.toolSlot({ runId: R2 }, ac.signal);
    s.dropRun(R1);
    await expect(dropped).rejects.toThrow('任务已经结束');
    ac.abort(new Error('不等了'));
    await expect(aborted).rejects.toThrow('不等了');
    expect(s.status().toolExec.queued).toBe(0);
    first.release();
    expect(s.status().toolExec.running).toBe(0);
    s.dispose();
  });
  it('episode、模型调用、命令三层各算各的：命令名额满了不挡 episode 和模型调用', async () => {
    const { s } = setup({ limits: { toolExec: 1, modelCalls: { p: 1 } } });
    const t = track();
    void s.toolSlot({ runId: R1 }).then(t.take('tool'));
    void s.episodeSlot(branch(R1), 'p').then(t.take('ep'));
    void s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode' }).then(t.take('call'));
    void s.toolSlot({ runId: R1 }).then(t.take('tool2'));
    await flush();
    expect(t.order).toEqual(['tool', 'ep', 'call']);
    s.dispose();
  });
});
describe('调用层', () => {
  it('同一任务内 Scoper 优先；任务之间公平分配', async () => {
    const { s } = setup({ limits: { modelCalls: { p: 1 } } });
    const t = track();
    void s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode' }).then(t.take('first'));
    await flush();
    void s.modelSlot({ runId: R1, provider: 'p', job: 'handoff_call' }).then(t.take('handoff'));
    void s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode' }).then(t.take('explorer'));
    void s.modelSlot({ runId: R1, provider: 'p', job: 'scoper_call' }).then(t.take('scoper'));
    void s.modelSlot({ runId: R2, provider: 'p', job: 'handoff_call' }).then(t.take('other-run'));
    await flush();
    t.release('first');
    await flush();
    t.release(t.order.at(-1) as string);
    await flush();
    t.release(t.order.at(-1) as string);
    await flush();
    t.release(t.order.at(-1) as string);
    await flush();
    // R2 从 R1 的进度起：同进度时 Scoper 优先；随后轮到 R2，再处理 R1 的执行和交接调用
    expect(t.order).toEqual(['first', 'scoper', 'other-run', 'explorer', 'handoff']);
    s.dispose();
  });
  it('收到限流信号：封在当时在途调用数的一半，一分钟内不再减；之后有作业在等时每分钟放宽 1', async () => {
    const { s, clock } = setup();
    const held = await Promise.all(
      [1, 2, 3, 4].map(() => s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode' })),
    );
    s.throttled('p', { status: 429 });
    expect(s.status().providers.find((p) => p.provider === 'p')?.limit).toBe(2);
    s.throttled('p', { status: 429 }); // 一分钟内的信号不再重复减
    expect(s.status().providers.find((p) => p.provider === 'p')?.limit).toBe(2);
    const t = track();
    void s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode' }).then(t.take('x'));
    held[0]?.release();
    held[1]?.release();
    await flush();
    expect(t.order).toEqual([]); // 还有 2 个在途，封在 2
    clock.advance(60000);
    await flush();
    expect(s.status().providers.find((p) => p.provider === 'p')?.limit).toBe(3);
    expect(t.order).toEqual(['x']);
    clock.advance(60000); // 没作业在等，不放宽
    expect(s.status().providers.find((p) => p.provider === 'p')?.limit).toBe(3);
    s.dispose();
  });
  it('带 Retry-After：这家的新调用等到那个时间', async () => {
    const { s, clock } = setup();
    s.throttled('p', { status: 429, retryAfterMs: 5000 });
    const t = track();
    void s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode' }).then(t.take('x'));
    void s.modelSlot({ runId: R1, provider: 'q', job: 'explorer_episode' }).then(t.take('other'));
    await flush();
    expect(t.order).toEqual(['other']);
    expect(s.status().providers.find((p) => p.provider === 'p')?.retryAt).toBe(new Date(5000).toISOString());
    clock.advance(4999);
    await flush();
    expect(t.order).toEqual(['other']);
    clock.advance(1);
    await flush();
    expect(t.order).toEqual(['other', 'x']);
    s.dispose();
  });
  it('TPM：排在最前面的大调用等桶补满时，后面的小调用不插队，大调用不会饿死', async () => {
    const { s, clock } = setup({ rates: [{ provider: 'p', tpm: 100000 }] });
    const t = track();
    // 九个 1 万 token 的 Explorer 调用轮着用，桶里剩不到 6 万
    const small = Array.from({ length: 9 }, (_, i) => `e${i}`);
    for (const name of small) {
      void s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode', estTokens: 10000 }).then(t.take(name));
    }
    await flush();
    void s.modelSlot({ runId: R1, provider: 'p', job: 'scoper_call', estTokens: 60000 }).then(t.take('scoper'));
    for (let round = 0; round < 20 && !t.order.includes('scoper'); round++) {
      for (const name of [...t.slots.keys()]) {
        if (name === 'scoper') continue;
        t.release(name);
        s.consumed('p', 10000);
        void s
          .modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode', estTokens: 10000 })
          .then(t.take(`${name}+`));
      }
      clock.advance(30000);
      await flush();
    }
    expect(t.order).toContain('scoper');
    s.dispose();
  });
  it('令牌桶：RPM 用完了等补；TPM 按预估先扣，实际用量回来再算', async () => {
    const { s, clock } = setup({ rates: [{ provider: 'p', rpm: 2, tpm: 1000 }] });
    const t = track();
    for (const name of ['a', 'b', 'c']) {
      void s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode', estTokens: 100 }).then(t.take(name));
    }
    await flush();
    expect(t.order).toEqual(['a', 'b']);
    clock.advance(30000); // 补回 1 个请求
    await flush();
    expect(t.order).toEqual(['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) t.release(name);
    s.consumed('p', 1000); // 实际用掉的比预估多：桶空了
    void s.modelSlot({ runId: R1, provider: 'p', job: 'explorer_episode', estTokens: 500 }).then(t.take('d'));
    await flush();
    expect(t.order).not.toContain('d');
    clock.advance(60000);
    await flush();
    expect(t.order).toContain('d');
    s.dispose();
  });
});
