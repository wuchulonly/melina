import { afterEach, describe, expect, it } from 'vitest';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { DEFAULT_RUN_CONFIG, watchEnabled } from '../../../src/core/config.ts';
import { handleOf, type Id } from '../../../src/core/ids.ts';
import type { Branch, Run } from '../../../src/core/types.ts';
import { WATCH_WINDOW_BYTES, WATCH_WINDOW_STEPS, WatchFailure } from '../../../src/core/watch-budget.ts';
import { WATCH_INPUT } from '../../../src/core/watch-input.ts';
import { watchVersions } from '../../../src/projections/watch.ts';
import { RunScopes } from '../../../src/runtime/branch-runner.ts';
import {
  WATCH_CATCH_UP_MS,
  WATCH_EVERY_MS,
  WATCH_FIRST_MS,
  WATCH_RETRY_MS,
  WATCH_YIELD_MS,
  WatchDesk,
  type WatchDeskDeps,
} from '../../../src/runtime/watch.ts';
import { newRun, observe, startBranch, type TestRunStore, testRunStore } from '../storage/kit.ts';
import { FakeClock, FakeWatcher, type Harness, harness, tick, WATCHER_MODEL, waitFor } from './kit.ts';

const boards: TestRunStore[] = [];
const desks: WatchDesk[] = [];
let h: Harness | undefined;
afterEach(async () => {
  for (const d of desks.splice(0)) d.stop();
  for (const b of boards.splice(0)) b.close();
  await h?.close();
  h = undefined;
});
function setup(config: Partial<Run['config']> = {}, timeMs?: number, inputs?: WatchDeskDeps['inputs']) {
  const clock = new FakeClock();
  const b = testRunStore({ now: () => new Date(clock.now()) });
  boards.push(b);
  const run = newRun(b, { config: { ...config, watch: { enabled: true, ...config.watch, disabledBet0Copies: [2] } } });
  const bet0 = startBranch(b, run, { kind: 'direct', label: '主干直解路线' }).branch;
  const other = startBranch(b, run, { label: '换个算法' }).branch;
  const watcher = new FakeWatcher();
  watcher.runStore = b;
  const scopes = new RunScopes();
  const logs: string[] = [];
  const mainInFlight = new Set<Id>();
  const desk = new WatchDesk({
    queries: b.queries,
    bus: b.bus,
    watcher,
    mainLlmInFlight: (branchId) => mainInFlight.has(branchId),
    ...(inputs ? { inputs } : {}),
    scopes,
    clock,
    ...(timeMs !== undefined ? { timeMs } : {}),
    log: (t) => logs.push(t),
  });
  desks.push(desk);
  desk.start();
  return { b, run, bet0, other, watcher, scopes, clock, desk, logs, mainInFlight };
}
type Setup = ReturnType<typeof setup>;
/** 做几次工具调用：事件是在工具调用里同步发的，巡检器下一拍再判（settle 把那一拍判掉、等在跑的几轮做完） */
async function act(s: Setup, branch: Branch | Id, times: number): Promise<void> {
  for (let i = 0; i < times; i++) observe(s.b, branch, `第 ${i + 1} 次`);
  await s.desk.settle();
}
/** 时间往前走 ms，到点的计时器叫醒它，再把那一拍判掉、等在跑的几轮做完 */
async function pass(s: Setup, ms: number): Promise<void> {
  s.clock.advance(ms);
  await s.desk.settle();
}
function platformProgress(s: Setup, remaining: number, branchId = s.bet0.id) {
  const args = {
    task: 'challenge',
    total: 2,
    remaining,
    hintStatus: 'none',
    hint: '',
    accepted: remaining === 0 ? [{ id: 'flag', label: '平台确认的结果' }] : [],
    rejectedCount: 0,
  };
  return s.b.writer.appendObservation(
    {
      runId: s.run.id,
      branchId,
      role: 'watcher',
      tool: WATCH_INPUT.platform,
      args,
      summary: JSON.stringify(args),
      output: handleOf(JSON.stringify(args)),
      snapshot: 'root',
    },
    { countsAsToolCall: false },
  );
}
describe('什么时候看一轮', () => {
  it.each([false, true])('实例换代广播不提前唤醒四个分支，下一周期仍可读（已有观察=%s）', async (previous) => {
    const s = setup();
    const branches = [s.bet0, ...Array.from({ length: 3 }, () => startBranch(s.b, s.run, { kind: 'direct' }).branch)];
    if (previous) {
      for (const branch of branches) observe(s.b, branch);
      await s.desk.settle();
      await pass(s, WATCH_FIRST_MS);
      expect(s.watcher.calls).toHaveLength(branches.length);
    }
    const before = s.watcher.calls.length;
    const { input } = s.b.writer.recordHumanInput({
      runId: s.run.id,
      text: '宿主实测事实：本题实例已更换，继续原意图，不另开题。\n实例 generation 1 → 2',
    });
    for (const branch of branches.slice(1))
      s.b.writer.appendInbox({ runId: s.run.id, branchId: branch.id, kind: 'notice', ref: input.id, text: input.text });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(before);
    await pass(s, (previous ? WATCH_EVERY_MS : WATCH_FIRST_MS) - 1);
    expect(s.watcher.calls).toHaveLength(before);
    await pass(s, 1);
    const calls = s.watcher.calls.slice(before);
    expect(calls.map((call) => call.request.branchId)).toEqual(branches.map((branch) => branch.id));
    expect(calls.every((call) => call.request.state!.refs.includes(input.id))).toBe(true);
  });

  it.each([false, true])('广播验收反馈不会同时唤醒各分支，仍在下一周期可见（结构化=%s）', async (structured) => {
    const s = setup();
    const copy = startBranch(s.b, s.run, { kind: 'direct' }).branch;
    const { input } = s.b.writer.recordHumanInput({
      runId: s.run.id,
      text: structured ? '平台验收计数已更新' : '宿主平台验收反馈（不是新的解题 hint）：已通过一项',
      ...(structured ? { acceptance: { task: 'challenge', accepted: 1, total: 2 } } : {}),
    });
    s.b.writer.appendInbox({ runId: s.run.id, branchId: copy.id, kind: 'notice', ref: input.id, text: input.text });
    await s.desk.settle();
    await pass(s, WATCH_FIRST_MS - 1);
    expect(s.watcher.calls).toHaveLength(0);
    await pass(s, 1);
    expect(s.watcher.calls.map((call) => call.request.branchId)).toEqual([s.bet0.id, copy.id]);
    expect(s.watcher.calls.every((call) => call.request.state!.refs.includes(input.id))).toBe(true);
  });

  it('宿主确认全部完成时不开观察，也停止已在跑的轮次，不计为失败', async () => {
    const s = setup();
    s.watcher.gate = new Promise<void>(() => {});
    await act(s, s.bet0, 1);
    s.clock.advance(WATCH_FIRST_MS);
    await waitFor(() => s.desk.watching.length === 1, '观察启动');
    s.b.writer.recordHumanInput({
      runId: s.run.id,
      text: '平台已确认全部验收',
      acceptance: { task: 'challenge', accepted: 2, total: 2 },
    });
    await s.desk.settle();
    expect(s.desk.watching).toEqual([]);
    s.watcher.gate = undefined;
    await act(s, s.bet0, 1);
    await pass(s, WATCH_EVERY_MS * 2);
    expect(s.watcher.calls).toHaveLength(1);
    expect(s.logs.some((line) => line.includes('没做成'))).toBe(false);
  });

  it('平台 remaining 为 0 时不启动；新一轮剩余目标恢复后按周期观察', async () => {
    const s = setup();
    platformProgress(s, 0);
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls).toHaveLength(0);
    platformProgress(s, 1);
    await s.desk.settle();
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls).toHaveLength(1);
  });

  it('启动采集时才发现平台已完成，省去后续读取和模型调用', async () => {
    let reads = 0;
    const s = setup({}, undefined, {
      async collect() {
        platformProgress(s, 0);
      },
      async read(_run, request) {
        reads++;
        return request;
      },
    });
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(reads).toBe(0);
    expect(s.watcher.calls).toHaveLength(0);
    expect(s.desk.watching).toEqual([]);
  });

  it('忽略其他分支、主代理自述和无效状态中的完成声明', async () => {
    const s = setup();
    const foreign = platformProgress(s, 0, s.other.id);
    for (const role of ['explorer', 'watcher'] as const)
      s.b.writer.appendObservation(
        {
          runId: s.run.id,
          branchId: s.bet0.id,
          role,
          tool: WATCH_INPUT.platform,
          args: role === 'explorer' ? foreign.args : { remaining: 0 },
          summary: '全部完成',
          output: handleOf('全部完成'),
          snapshot: 'root',
        },
        { countsAsToolCall: false },
      );
    await s.desk.settle();
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls).toHaveLength(1);
  });

  it.each([undefined, true, false])('接力会话按独立开关观察与生成地图：%s', async (continuationEnabled) => {
    const s = setup({ watch: { enabled: true, continuationEnabled } });
    const next = startBranch(s.b, s.run, {
      continuation: {
        key: 'progress:1',
        slot: 0,
        handoff: '已保存入口与工作区',
        direction: '检查新的路径',
      },
    }).branch;
    await act(s, s.other, 1);
    await act(s, next, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls.map((call) => call.request.branchId)).toEqual(
      continuationEnabled === false ? [] : [next.id],
    );
    const assembler = new MelinaContextAssembler({ queries: s.b.queries });
    if (continuationEnabled === false) expect(assembler.watchMap(next.id)).toBeUndefined();
    else expect(assembler.watchMap(next.id)).toBeDefined();
    expect(assembler.watchMap(s.other.id)).toBeUndefined();
  });

  it('连续非零退出码不绕过首轮 1 分钟和后续 5 分钟周期', async () => {
    const s = setup();
    const execute = (exitCode: number) =>
      s.b.writer.appendObservation(
        {
          runId: s.run.id,
          branchId: s.bet0.id,
          role: 'explorer',
          tool: 'sh',
          args: {},
          summary: `exit ${exitCode}`,
          output: handleOf(`exit ${exitCode}`),
          snapshot: 'root',
          exitCode,
        },
        { countsAsToolCall: true },
      );
    execute(1);
    execute(1);
    execute(1);
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(0);
    execute(0);
    execute(1);
    execute(1);
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(0);
    await pass(s, 30000);
    expect(s.watcher.calls).toHaveLength(0);
    await pass(s, WATCH_FIRST_MS - 30000 - 1);
    expect(s.watcher.calls).toHaveLength(0);
    await pass(s, 1);
    expect(s.watcher.calls).toHaveLength(1);
    execute(1);
    execute(1);
    execute(1);
    await pass(s, 30000);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_EVERY_MS - 30000 - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1);
    expect(s.watcher.calls).toHaveLength(2);
    s.desk.kick(s.run.id);
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(2);
  });
  it('到期时让出主模型在途分支，其他空闲分支照常观察；请求结束后延迟一拍启动', async () => {
    const s = setup();
    const copy = startBranch(s.b, s.run, { kind: 'direct' }).branch;
    s.mainInFlight.add(s.bet0.id);
    await act(s, s.bet0, 1);
    await act(s, copy, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls.map((call) => call.request.branchId)).toEqual([copy.id]);
    await pass(s, WATCH_YIELD_MS);
    expect(s.watcher.calls).toHaveLength(1);
    s.mainInFlight.delete(s.bet0.id);
    await pass(s, WATCH_YIELD_MS - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1);
    expect(s.watcher.calls.map((call) => call.request.branchId)).toEqual([copy.id, s.bet0.id]);
  });
  it('真正的 hint 也避让主模型，等待不消耗提示或观察预算', async () => {
    const s = setup();
    s.mainInFlight.add(s.bet0.id);
    s.b.writer.recordHumanInput({ runId: s.run.id, text: '检查新的入口' });
    await s.desk.settle();
    await pass(s, WATCH_YIELD_MS * 3);
    expect(s.watcher.calls).toHaveLength(0);
    s.mainInFlight.clear();
    await pass(s, WATCH_YIELD_MS);
    expect(s.watcher.calls.map((call) => call.toolCalls)).toEqual([0]);
    expect(s.logs.some((line) => line.includes('没做成'))).toBe(false);
  });
  it('采集期间主模型开始请求时延后模型调用，保留新 hint 的即时唤醒资格', async () => {
    let collections = 0;
    const s = setup({}, undefined, {
      async collect() {
        if (++collections === 1) s.mainInFlight.add(s.bet0.id);
      },
      async read(_run, request) {
        return request;
      },
    });
    s.b.writer.recordHumanInput({ runId: s.run.id, text: '真正的新线索' });
    await s.desk.settle();
    expect(collections).toBe(1);
    expect(s.watcher.calls).toHaveLength(0);
    s.mainInFlight.clear();
    await pass(s, WATCH_YIELD_MS);
    expect(s.watcher.calls).toHaveLength(1);
    expect(s.logs.some((line) => line.includes('没做成'))).toBe(false);
  });
  it('采集写入部分平台状态后失败时仍退避，不被自身状态事件反复唤醒', async () => {
    let attempts = 0;
    const s = setup({}, undefined, {
      async collect() {
        attempts++;
        const summary = `部分状态 ${attempts}`;
        s.b.writer.appendObservation(
          {
            runId: s.run.id,
            branchId: s.bet0.id,
            role: 'watcher',
            tool: WATCH_INPUT.platform,
            args: {},
            summary,
            output: handleOf(summary),
            snapshot: 'root',
          },
          { countsAsToolCall: false },
        );
        throw new Error('采集后续状态失败');
      },
      async read(_run, request) {
        return request;
      },
    });
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(attempts).toBe(1);
    expect(s.watcher.calls).toHaveLength(0);
    await pass(s, WATCH_EVERY_MS - 1);
    expect(attempts).toBe(1);
    await pass(s, 1);
    expect(attempts).toBe(2);
  });
  it.each([WATCH_INPUT.platform, WATCH_INPUT.receipt, WATCH_INPUT.extension])(
    '%s 不跳过首轮等待，在途状态变化仍等下一周期，状态继续可读',
    async (tool) => {
      const s = setup();
      const save = (summary: string) =>
        s.b.writer.appendObservation(
          {
            runId: s.run.id,
            branchId: s.bet0.id,
            role: 'watcher',
            tool,
            args: {},
            summary,
            output: handleOf(summary),
            snapshot: 'root',
          },
          { countsAsToolCall: false },
        );
      let release!: () => void;
      s.watcher.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = save('首条平台更新');
      await s.desk.settle();
      expect(s.watcher.calls).toHaveLength(0);
      s.clock.advance(WATCH_FIRST_MS);
      await waitFor(() => s.watcher.calls.length === 1, '周期到达');
      expect(s.watcher.calls[0]!.request.state!.refs).toContain(first.id);
      const second = save('观察在途时的更新');
      s.clock.advance(0);
      await tick();
      expect(s.watcher.calls).toHaveLength(1);
      expect(s.watcher.calls[0]!.request.state!.refs).not.toContain(second.id);
      s.watcher.gate = undefined;
      release();
      await s.desk.settle();
      expect(s.watcher.calls).toHaveLength(1);
      await pass(s, WATCH_EVERY_MS - 1);
      expect(s.watcher.calls).toHaveLength(1);
      await pass(s, 1);
      expect(s.watcher.calls).toHaveLength(2);
      expect(s.watcher.calls[1]!.request.state!.refs).toContain(second.id);
      await pass(s, WATCH_EVERY_MS);
      expect(s.watcher.calls).toHaveLength(2);
    },
  );
  it('积压时状态已处理但历史仍只覆盖一窗，重启不重复即时唤醒，后续继续原历史', async () => {
    const s = setup();
    for (let i = 0; i < WATCH_WINDOW_STEPS * 2; i++) observe(s.b, s.bet0);
    const hint = s.b.writer.recordHumanInput({
      runId: s.run.id,
      text: '两窗执行之后的新提示',
    });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(1);
    const note = watchVersions(s.b.queries, s.run.id, s.bet0.id)[0]!;
    expect(note.toolCalls).toBe(WATCH_WINDOW_STEPS);
    expect(note.basedOnSeq).toBeLessThan(hint.input.seq);
    expect(note.stateSeq).toBeGreaterThanOrEqual(hint.inbox[0]!.seq);
    s.desk.stop();
    const resumed = new WatchDesk({
      queries: s.b.queries,
      bus: s.b.bus,
      watcher: s.watcher,
      scopes: s.scopes,
      clock: s.clock,
    });
    desks.push(resumed);
    resumed.start();
    await resumed.settle();
    expect(s.watcher.calls).toHaveLength(1);
    s.clock.advance(WATCH_CATCH_UP_MS);
    await resumed.settle();
    expect(s.watcher.calls).toHaveLength(1);
    s.clock.advance(WATCH_EVERY_MS - WATCH_CATCH_UP_MS);
    await resumed.settle();
    expect(s.watcher.calls).toHaveLength(2);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id)[1]!.toolCalls).toBe(WATCH_WINDOW_STEPS * 2);
  });
  it('先采集再冻结，采集期间到达的工具数与请求、发布计数一致，读取补充不重新冻结', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let collected = false;
    let observedRequest: Parameters<NonNullable<WatchDeskDeps['inputs']>['read']>[1] | undefined;
    const s = setup({}, undefined, {
      async collect() {
        collected = true;
        await gate;
      },
      async read(_run, request) {
        observedRequest = structuredClone(request);
        observe(s.b, s.bet0, '冻结后的执行');
        return request;
      },
    });
    observe(s.b, s.bet0, '采集前的执行');
    await s.desk.settle();
    s.clock.advance(WATCH_FIRST_MS);
    await tick();
    expect(collected).toBe(true);
    const during = observe(s.b, s.bet0, '采集中的执行');
    release();
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(1);
    expect(s.watcher.calls[0]!.request).toEqual(observedRequest);
    expect(observedRequest!.untilSeq).toBeGreaterThanOrEqual(during.seq);
    expect(observedRequest!.toolCalls).toBe(2);
    expect(observedRequest!.activity!.toolCalls).toBe(2);
    const notes = watchVersions(s.b.queries, s.run.id, s.bet0.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ basedOnSeq: observedRequest!.untilSeq, toolCalls: 2 });
    expect(s.b.queries.getBranch(s.bet0.id)!.toolCalls).toBe(3);
  });
  it('宿主刷新扩大了冻结窗口时，部分发布仍在短冷却后补看实际窗口的尾部', async () => {
    const s = setup();
    const watch = s.watcher.watch.bind(s.watcher);
    s.watcher.watch = async (input) => {
      const result = await watch(input);
      if (s.watcher.calls.length === 1) {
        const refreshed = observe(s.b, s.bet0, '准备输入时到达的材料');
        return { ...result, windowUntilSeq: refreshed.seq };
      }
      return result;
    };
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_CATCH_UP_MS);
    expect(s.watcher.calls).toHaveLength(2);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).map((note) => note.toolCalls)).toEqual([1, 2]);
  });
  it.each(['validation', 'no_close'] as const)('%s 持续失败缩窗且冷却不超过 60 秒', async (reason) => {
    const s = setup();
    const requests: Parameters<typeof s.watcher.watch>[0]['request'][] = [];
    s.watcher.watch = async ({ request }) => {
      requests.push(request);
      throw new WatchFailure(reason, '窗口过复杂');
    };
    await act(s, s.bet0, 40);
    await pass(s, WATCH_FIRST_MS);
    for (let n = 1; n <= 5; n++) {
      const delay = WATCH_RETRY_MS * Math.min(2, n);
      await pass(s, delay - 1);
      expect(requests).toHaveLength(n);
      await pass(s, 1);
    }
    expect(requests.map((r) => r.window?.maxSteps)).toEqual([60, 30, 15, 7, 3, 1]);
  });
  it('积压拆成连续的小窗口，每轮至少冷却 90 秒，工具计数不提前确认', async () => {
    const s = setup();
    await act(s, s.bet0, WATCH_WINDOW_STEPS * 2 + 5);
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_CATCH_UP_MS - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1);
    await pass(s, WATCH_CATCH_UP_MS);
    const requests = s.watcher.calls.map((c) => c.request);
    expect(requests.map((r) => r.toolCalls)).toEqual([60, 120, 125]);
    expect(requests.map((r) => r.previous?.toolCalls ?? 0)).toEqual([0, 60, 120]);
    expect(requests[1]!.previous?.basedOnSeq).toBe(requests[0]!.untilSeq);
    expect(requests[2]!.previous?.basedOnSeq).toBe(requests[1]!.untilSeq);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).map((n) => n.toolCalls)).toEqual([60, 120, 125]);
    await pass(s, WATCH_EVERY_MS);
    expect(s.watcher.calls).toHaveLength(3);
  });
  it('正常冷却期间新增积压达到一个窗口，仍等完整的 5 分钟', async () => {
    const s = setup();
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    await act(s, s.bet0, WATCH_WINDOW_STEPS);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_CATCH_UP_MS);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_EVERY_MS - WATCH_CATCH_UP_MS - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1);
    expect(s.watcher.calls.map((c) => c.request.toolCalls)).toEqual([1, 1 + WATCH_WINDOW_STEPS]);
  });
  it('预算缩窗成功后清零失败并连续追赶，追平后恢复正常窗口', async () => {
    const s = setup();
    s.watcher.beforePublish = (round) => {
      if (round === 1) throw new WatchFailure('budget', '第一轮超时');
    };
    await act(s, s.bet0, 75);
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_RETRY_MS);
    expect(s.watcher.calls.map((c) => c.request.toolCalls)).toEqual([60, 30]);
    await pass(s, WATCH_CATCH_UP_MS);
    expect(s.watcher.calls.map((c) => c.request.toolCalls)).toEqual([60, 30, 75]);
    s.watcher.fail = 1;
    await act(s, s.bet0, 2);
    await pass(s, WATCH_EVERY_MS);
    expect(s.watcher.calls.at(-1)!.request.window?.maxSteps).toBe(WATCH_WINDOW_STEPS);
    expect(s.logs.at(-1)).toContain('接连 1 轮没做成');
  });
  it('缩到最小窗口后，有积压时逐步恢复到 60 步及字节预算', async () => {
    const s = setup();
    s.watcher.beforePublish = (round) => {
      if (round <= 6) throw new WatchFailure('budget', '缩到最小窗口');
    };
    await act(s, s.bet0, 80);
    await pass(s, WATCH_FIRST_MS);
    for (let i = 0; i < 6; i++) await pass(s, WATCH_RETRY_MS);
    for (let i = 0; i < 10; i++) await pass(s, WATCH_CATCH_UP_MS);
    const windows = s.watcher.calls.map((c) => c.request.window!);
    expect(windows.slice(0, 12).map((w) => w.maxSteps)).toEqual([60, 30, 15, 7, 3, 1, 1, 3, 7, 15, 31, 60]);
    expect(windows.slice(6, 12).map((w) => w.maxBytes)).toEqual([1280, 4096, 9557, 20480, 42325, WATCH_WINDOW_BYTES]);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).at(-1)!.toolCalls).toBe(80);
  });
  it.each(['partial', 'soft'] as const)('%s 成功推进但不扩窗，冷却后接着追赶', async (kind) => {
    const s = setup({}, 180);
    const first = observe(s.b, s.bet0);
    await act(s, s.bet0, 89);
    s.watcher.beforePublish = (round, input) => {
      if (round === 1) throw new WatchFailure('budget', '先缩窗');
      if (round === 2) {
        if (kind === 'soft') {
          s.clock.advance(150);
          expect(input.closing?.aborted).toBe(true);
        } else return { basedOnSeq: first.seq, toolCalls: 1 };
      }
    };
    await pass(s, WATCH_FIRST_MS);
    await pass(s, WATCH_RETRY_MS);
    for (let i = 0; i < 4; i++) await pass(s, WATCH_CATCH_UP_MS);
    expect(s.watcher.calls.slice(0, 4).map((c) => c.request.window?.maxSteps)).toEqual([60, 30, 30, 60]);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).at(-1)!.toolCalls).toBe(90);
  });
  it('连续追赶超过一个周期后，从追平完成时重新计时，空闲检查不会推迟下轮', async () => {
    const s = setup();
    const watch = s.watcher.watch.bind(s.watcher);
    s.watcher.watch = async (input) => {
      const result = await watch(input);
      s.clock.advance(60000);
      return result;
    };
    await act(s, s.bet0, WATCH_WINDOW_STEPS * 6 + 10);
    await pass(s, WATCH_FIRST_MS);
    for (let i = 0; i < 6; i++) await pass(s, WATCH_CATCH_UP_MS);
    const count = s.watcher.calls.length;
    expect(count).toBe(7);
    expect(s.clock.now()).toBe(WATCH_FIRST_MS + 7 * 60000 + 6 * WATCH_CATCH_UP_MS);
    await pass(s, 30000);
    s.desk.kick(s.run.id);
    await s.desk.settle();
    await act(s, s.bet0, 1);
    await pass(s, WATCH_EVERY_MS - 30000 - 1);
    expect(s.watcher.calls).toHaveLength(count);
    await pass(s, 1);
    expect(s.watcher.calls).toHaveLength(count + 1);
  });
  it('发布日志按实时分支水位报告滞后，在途新增一步遵守正常冷却', async () => {
    const s = setup();
    const watch = s.watcher.watch.bind(s.watcher);
    s.watcher.watch = async (input) => {
      const result = await watch(input);
      if (s.watcher.calls.length === 1) {
        observe(s.b, s.bet0, '观察在途时又执行了一步');
        s.clock.advance(5000);
      }
      return result;
    };
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_EVERY_MS - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1);
    expect(s.watcher.calls).toHaveLength(2);
    expect(s.logs[0]).toContain('落后 1 步 / 最早未读积压 5 秒 / 覆盖水位账龄 65 秒');
    expect(s.logs[1]).toContain('落后 0 步 / 最早未读积压 0 秒 / 覆盖水位账龄 305 秒');
    expect(s.b.queries.branchDetail(s.run.id, s.bet0.id)?.watchLag).toMatchObject({
      lagTools: 0,
      backlogAgeMs: 0,
      coveredAgeMs: 305000,
    });
  });
  it('发布没有推进时不立即空转，未读材料仍保留', async () => {
    const s = setup();
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    s.watcher.beforePublish = (_round, input) => ({
      basedOnSeq: input.request.previous!.basedOnSeq,
      toolCalls: 1,
    });
    await act(s, s.bet0, 3);
    await pass(s, WATCH_EVERY_MS);
    expect(s.watcher.calls).toHaveLength(2);
    await pass(s, WATCH_EVERY_MS - 1);
    expect(s.watcher.calls).toHaveLength(2);
    await pass(s, 1);
    expect(s.watcher.calls).toHaveLength(3);
  });
  it('部分推进未覆盖到 hint 时短冷却后补看，追平后停止续轮', async () => {
    const s = setup();
    s.watcher.beforePublish = (round, _input) =>
      round === 1 ? { basedOnSeq: s.b.queries.inbox(s.bet0.id, 0).at(-1)!.seq - 1, toolCalls: 0 } : undefined;
    const hint = s.b.writer.recordHumanInput({ runId: s.run.id, text: '这条尚未覆盖完' });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_CATCH_UP_MS - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1);
    expect(s.watcher.calls).toHaveLength(2);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id)[0]!.basedOnSeq).toBeLessThan(hint.inbox[0]!.seq);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).at(-1)!.basedOnSeq).toBeGreaterThanOrEqual(
      hint.inbox[0]!.seq,
    );
    await pass(s, WATCH_EVERY_MS);
    expect(s.watcher.calls).toHaveLength(2);
  });
  it('持续预算耗尽每次只冷却 30 秒并缩窗，新 hint 不绕过冷却', async () => {
    const s = setup();
    const requests: Parameters<typeof s.watcher.watch>[0]['request'][] = [];
    s.watcher.watch = async ({ request }) => {
      requests.push(request);
      throw new WatchFailure('budget', '阅读预算耗尽');
    };
    await act(s, s.bet0, 70);
    await pass(s, WATCH_FIRST_MS);
    for (let attempt = 1; attempt < 7; attempt++) {
      s.b.writer.recordHumanInput({ runId: s.run.id, text: `新提示 ${attempt}` });
      await s.desk.settle();
      await pass(s, WATCH_RETRY_MS - 1);
      expect(requests).toHaveLength(attempt);
      await pass(s, 1);
      expect(requests).toHaveLength(attempt + 1);
    }
    expect(requests.map((r) => r.toolCalls)).toEqual([60, 30, 15, 7, 3, 1, 1]);
    expect(requests.every((r) => r.previous === undefined)).toBe(true);
    expect(requests[1]!.untilSeq).toBeLessThan(requests[0]!.untilSeq);
  });
  it('供应商失败使用正常退避；软截止不会代替硬截止取消在途请求', async () => {
    const s = setup({}, 180000);
    let closing: AbortSignal | undefined;
    let hard: AbortSignal | undefined;
    s.watcher.watch = async ({ signal, closing: soft }) => {
      closing = soft;
      hard = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    await act(s, s.bet0, 1);
    s.clock.advance(WATCH_FIRST_MS);
    await waitFor(() => hard !== undefined, '启动请求');
    s.clock.advance(150000);
    expect(closing?.aborted).toBe(true);
    expect(hard?.aborted).toBe(false);
    expect(s.desk.watching).toHaveLength(1);
    s.clock.advance(30000);
    await s.desk.settle();
    expect(hard?.aborted).toBe(true);
    s.watcher.watch = async () => {
      throw new WatchFailure('provider', '供应商明确失败');
    };
    await pass(s, WATCH_RETRY_MS);
    expect(s.logs.at(-1)).toContain('原因 provider');
    expect(s.logs.at(-1)).toContain(`${(2 * WATCH_EVERY_MS) / 1000} 秒后`);
  });
  it('新 hint 不等首次延迟和工具调用；发布后再追加指令立即重判，普通通知不触发', async () => {
    const s = setup();
    await s.desk.settle();
    s.b.writer.appendInbox({ runId: s.run.id, branchId: s.bet0.id, kind: 'notice', text: '普通检查点通知' });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(0);
    const first = s.b.writer.recordHumanInput({ runId: s.run.id, text: '先检查输入条件' });
    await s.desk.settle();
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([0]);
    expect(s.watcher.calls[0]!.request.untilSeq).toBeGreaterThanOrEqual(first.inbox[0]!.seq);
    const second = s.b.writer.recordHumanInput({
      runId: s.run.id,
      text: '更正：先检查输出约束',
    });
    await s.desk.settle();
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([0, 0]);
    const versions = watchVersions(s.b.queries, s.run.id, s.bet0.id);
    expect(versions.map((v) => v.rev)).toEqual([1, 2]);
    expect(versions[1]!.basedOnSeq).toBeGreaterThanOrEqual(second.inbox[0]!.seq);
    expect(s.clock.now()).toBe(0);
    await pass(s, 15 * 60000);
    expect(s.watcher.calls).toHaveLength(2);
  });
  it('平台广播的 notice 引用也触发；按收件分支分别处理，多份 Bet 0 都能收到人的 hint', async () => {
    const s = setup();
    const copy = startBranch(s.b, s.run, { kind: 'direct', label: '主干直解路线（另一份）' }).branch;
    const input = s.b.writer.recordHumanInput({
      runId: s.run.id,
      text: '平台新提示',
    }).input;
    for (const branch of [copy, s.other])
      s.b.writer.appendInbox({ runId: s.run.id, branchId: branch.id, kind: 'notice', text: input.text, ref: input.id });
    await s.desk.settle();
    expect(s.watcher.calls.map((c) => c.request.branchId)).toEqual([s.bet0.id, copy.id]);
    s.b.writer.recordHumanInput({ runId: s.run.id, text: '人补充了新线索' });
    await s.desk.settle();
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id)).toHaveLength(2);
    expect(watchVersions(s.b.queries, s.run.id, copy.id)).toHaveLength(2);
    expect(s.watcher.calls.every((c) => c.toolCalls === 0)).toBe(true);
  });
  it('正在看时收到多个 hint 不开并发轮；发布旧窗口后立即补看包含全部新 hint 的窗口', async () => {
    const s = setup();
    let release = () => {};
    s.watcher.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(s, s.bet0, 1);
    s.clock.advance(WATCH_FIRST_MS);
    await waitFor(() => s.watcher.calls.length === 1, '第一轮开始');
    const until = s.watcher.calls[0]!.request.untilSeq;
    s.b.writer.recordHumanInput({ runId: s.run.id, text: '新线索一' });
    const last = s.b.writer.recordHumanInput({ runId: s.run.id, text: '新线索二' });
    s.clock.advance(0);
    await tick(5);
    expect(s.watcher.calls).toHaveLength(1);
    expect(s.watcher.calls[0]!.request.untilSeq).toBe(until);
    s.watcher.gate = undefined;
    release();
    await s.desk.settle();
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([1, 1]);
    expect(s.watcher.calls[1]!.request.untilSeq).toBeGreaterThanOrEqual(last.inbox[0]!.seq);
    expect(s.watcher.calls[1]!.request.previous?.basedOnSeq).toBe(until);
    await pass(s, WATCH_EVERY_MS);
    expect(s.watcher.calls).toHaveLength(2);
  });
  it('hint 触发的失败仍退避；新 hint 可以唤醒一次，同一条不会形成紧密重试', async () => {
    const s = setup();
    s.watcher.fail = 2;
    s.b.writer.recordHumanInput({ runId: s.run.id, text: '第一条提示' });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, WATCH_EVERY_MS - 1);
    expect(s.watcher.calls).toHaveLength(1);
    s.b.writer.recordHumanInput({ runId: s.run.id, text: '修正后的提示' });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(2);
    await pass(s, 2 * WATCH_EVERY_MS - 1);
    expect(s.watcher.calls).toHaveLength(2);
    await pass(s, 1);
    expect(s.watcher.calls).toHaveLength(3);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id)).toHaveLength(1);
  });
  it('提示触发的观察被暂停后不消费提示；恢复立即补看暂停期间新来的提示', async () => {
    const s = setup();
    s.watcher.gate = new Promise<void>(() => {});
    s.b.writer.recordHumanInput({ runId: s.run.id, text: '开始核对' });
    s.clock.advance(0);
    await waitFor(() => s.desk.watching.length === 1, '提示触发观察');
    s.b.writer.updateRun(s.run.id, { status: 'paused' });
    await waitFor(() => s.desk.watching.length === 0, '观察暂停');
    const hint = s.b.writer.recordHumanInput({ runId: s.run.id, text: '暂停时补充的线索' });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(1);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id)).toHaveLength(0);
    s.watcher.gate = undefined;
    s.b.writer.updateRun(s.run.id, { status: 'running' });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(2);
    expect(s.watcher.calls[1]!.request.untilSeq).toBeGreaterThanOrEqual(hint.inbox[0]!.seq);
    expect(s.logs.some((l) => l.includes('没做成'))).toBe(false);
    expect(s.clock.now()).toBe(0);
  });
  it('重启补看未发布窗口里的 hint；已发布包含的 hint 不会再次触发', async () => {
    const s = setup();
    s.b.writer.recordHumanInput({ runId: s.run.id, text: '已看的提示' });
    await s.desk.settle();
    s.desk.stop();
    const pending = s.b.writer.recordHumanInput({ runId: s.run.id, text: '停机时来的提示' });
    for (const count of [1, 0]) {
      const watcher = new FakeWatcher();
      watcher.runStore = s.b;
      const desk = new WatchDesk({
        queries: s.b.queries,
        bus: s.b.bus,
        watcher,
        scopes: s.scopes,
        clock: s.clock,
      });
      desks.push(desk);
      desk.start();
      await desk.settle();
      expect(watcher.calls).toHaveLength(count);
      desk.stop();
    }
    const versions = watchVersions(s.b.queries, s.run.id, s.bet0.id);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.basedOnSeq).toBeGreaterThanOrEqual(pending.inbox[0]!.seq);
    expect(versions[1]!.toolCalls).toBe(0);
  });
  it('开跑 1 分钟后看第一轮，之后追平完成 5 分钟后看下一轮；看法和上一版合并写上 RunStore', async () => {
    const s = setup();
    await act(s, s.bet0, 3);
    await pass(s, 60_000 - 1);
    expect(s.watcher.calls).toEqual([]);
    await pass(s, 1);
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([3]);
    await act(s, s.bet0, 5);
    await pass(s, 5 * 60_000 - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1);
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([3, 8]);
    expect(s.watcher.calls[0]?.request.previous).toBeUndefined();
    expect(s.watcher.calls[1]?.request.previous?.rev).toBe(1);
    expect(s.watcher.calls[0]?.author).toEqual(s.b.queries.getBet(s.bet0.betId)?.model);
    const versions = watchVersions(s.b.queries, s.run.id, s.bet0.id);
    expect(versions.map((v) => [v.rev, v.toolCalls, v.advice])).toEqual([
      [1, 3, '第 1 轮的提醒'],
      [2, 8, '第 2 轮的提醒'],
    ]);
    expect(versions[0]?.model).toEqual(WATCHER_MODEL);
    // 每轮看到的 RunStore 那一刻：上下文从上一版的 basedOnSeq 之后接着看
    expect(s.watcher.calls[1]?.request.untilSeq).toBeGreaterThan(versions[0]?.basedOnSeq as number);
    expect(versions[1]?.basedOnSeq).toBe(s.watcher.calls[1]?.request.untilSeq);
  });
  it('上一版以后没有新的工具调用不看：到点了也等它下一次工具调用，来了马上看', async () => {
    const s = setup();
    await pass(s, WATCH_FIRST_MS * 2);
    expect(s.watcher.calls).toEqual([]);
    await act(s, s.bet0, 1);
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([1]);
    await pass(s, WATCH_EVERY_MS * 3);
    expect(s.watcher.calls).toHaveLength(1);
    await act(s, s.bet0, 2);
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([1, 2 + 1]);
  });
  it('同一条路线同时只有一轮：即使上一轮已超过周期，也从完成时重新冷却', async () => {
    // 默认一轮最多 4 分钟、比间隔短，到点时上一轮总看完了；这里把一轮的上限调长
    const s = setup({}, 2 * WATCH_EVERY_MS);
    let release: () => void = () => {};
    s.watcher.gate = new Promise<void>((r) => {
      release = r;
    });
    await act(s, s.bet0, 2);
    s.clock.advance(WATCH_FIRST_MS);
    await waitFor(() => s.watcher.calls.length === 1, '第一轮');
    expect(s.desk.watching).toEqual([s.bet0.id]);
    observe(s.b, s.bet0, '又做了一次');
    s.clock.advance(WATCH_EVERY_MS);
    await tick(5);
    expect(s.watcher.calls).toHaveLength(1);
    s.watcher.gate = undefined;
    release();
    await s.desk.settle();
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([2]);
    await pass(s, WATCH_EVERY_MS - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1);
    expect(s.watcher.calls.map((c) => c.toolCalls)).toEqual([2, 3]);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).map((v) => v.toolCalls)).toEqual([2, 3]);
  });
  it('没做成的一轮不马上重来：等一个间隔，接连没做成每次要等的间隔数翻倍，做成一轮就清零', async () => {
    const s = setup();
    s.watcher.fail = 2;
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(s.watcher.calls).toHaveLength(1);
    expect(s.logs.some((l) => l.includes('巡检器这一轮没做成'))).toBe(true);
    await act(s, s.bet0, 1);
    await pass(s, WATCH_EVERY_MS - 1);
    expect(s.watcher.calls).toHaveLength(1);
    await pass(s, 1); // 一个间隔
    expect(s.watcher.calls).toHaveLength(2);
    await act(s, s.bet0, 1);
    await pass(s, 2 * WATCH_EVERY_MS - 1);
    expect(s.watcher.calls).toHaveLength(2);
    await pass(s, 1); // 接连两轮没做成：两个间隔
    expect(s.watcher.calls).toHaveLength(3);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).map((v) => [v.rev, v.toolCalls])).toEqual([[1, 3]]);
    await act(s, s.bet0, 1);
    await pass(s, WATCH_EVERY_MS);
    expect(s.watcher.calls).toHaveLength(4);
  });
  it('一轮超时按没做成算', async () => {
    const s = setup({}, 30000);
    s.watcher.gate = new Promise<void>(() => {});
    await act(s, s.bet0, 1);
    s.clock.advance(WATCH_FIRST_MS);
    await waitFor(() => s.watcher.calls.length === 1, '第一轮');
    s.clock.advance(30000);
    await waitFor(() => s.desk.watching.length === 0, '超时停下');
    expect(s.logs.some((l) => l.includes('没做成') && l.includes('原因 budget'))).toBe(true);
  });
  it('按配置为 direct 路线巡检；关闭时不看', async () => {
    const s = setup();
    await act(s, s.other, 12);
    await pass(s, WATCH_FIRST_MS * 2);
    expect(s.watcher.calls).toEqual([]);
    const off = setup({ watch: { enabled: false } });
    await act(off, off.bet0, 12);
    off.b.writer.recordHumanInput({ runId: off.run.id, text: '仍然关闭观察' });
    await pass(off, WATCH_FIRST_MS * 2);
    expect(off.watcher.calls).toEqual([]);
    // 之前建的任务没有这一组：不看
    const { watch: _, ...old } = DEFAULT_RUN_CONFIG;
    expect(watchEnabled(old)).toBe(false);
    expect(watchEnabled(DEFAULT_RUN_CONFIG)).toBe(true);
  });
  it('主干直解路线开了几份：每份各看各的、各按各的钟；一份在看时另一份照样看；重启后几份都判', async () => {
    const s = setup();
    const copy = startBranch(s.b, s.run, {
      kind: 'direct',
      label: '主干直解路线（b）',
      model: { provider: 'zhipu', model: 'glm-5.3', tier: 'strong' },
    }).branch;
    let release = () => {};
    s.watcher.gate = new Promise<void>((r) => {
      release = r;
    });
    await act(s, s.bet0, 2);
    await act(s, copy, 3);
    s.clock.advance(WATCH_FIRST_MS);
    await waitFor(() => s.desk.watching.length === 2, '两份都在看');
    release();
    s.watcher.gate = undefined;
    await s.desk.settle();
    // author 是各自的模型：没写 watch.model 时巡检器就用它（agents/watcher.ts）
    expect(s.watcher.calls.map((c) => [c.request.branchId, c.toolCalls, c.author.model])).toEqual([
      [s.bet0.id, 2, s.b.queries.getBet(s.bet0.betId)?.model.model],
      [copy.id, 3, 'glm-5.3'],
    ]);
    await act(s, copy, 2);
    await pass(s, WATCH_EVERY_MS);
    expect(watchVersions(s.b.queries, s.run.id, copy.id).map((v) => v.toolCalls)).toEqual([3, 5]);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).map((v) => v.toolCalls)).toEqual([2]);
    s.desk.stop();
    observe(s.b, s.bet0, '重启前又做了一次');
    observe(s.b, copy, '重启前又做了一次');
    const watcher = new FakeWatcher();
    watcher.runStore = s.b;
    const desk = new WatchDesk({
      queries: s.b.queries,
      bus: s.b.bus,
      watcher,
      scopes: s.scopes,
      clock: s.clock,
    });
    desks.push(desk);
    desk.start();
    await desk.settle();
    expect(watcher.calls).toEqual([]);
    s.clock.advance(WATCH_EVERY_MS);
    await desk.settle();
    expect(watcher.calls.map((c) => [c.request.branchId, c.toolCalls])).toEqual([
      [s.bet0.id, 3],
      [copy.id, 6],
    ]);
  });
  it('任务暂停时停下在跑的一轮、不算没做成，暂停着不开新的；转回 running 到点就看', async () => {
    const s = setup();
    s.watcher.gate = new Promise<void>(() => {});
    await act(s, s.bet0, 2);
    s.clock.advance(WATCH_FIRST_MS);
    await waitFor(() => s.desk.watching.length === 1, '第一轮');
    s.b.writer.updateRun(s.run.id, { status: 'paused' });
    await waitFor(() => s.desk.watching.length === 0, '暂停时停下');
    observe(s.b, s.bet0, '暂停的那一刻在跑的命令跑完了');
    await pass(s, WATCH_EVERY_MS * 2);
    expect(s.watcher.calls).toHaveLength(1);
    expect(s.logs.some((l) => l.includes('没做成'))).toBe(false);
    s.watcher.gate = undefined;
    s.b.writer.updateRun(s.run.id, { status: 'running' });
    await s.desk.settle();
    expect(s.watcher.calls).toHaveLength(2);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).map((v) => v.toolCalls)).toEqual([3]);
  });
  it('收尾、取消时 RunScopes 停下在跑的一轮：不算没做成，也不再看', async () => {
    const s = setup();
    s.watcher.gate = new Promise<void>(() => {});
    await act(s, s.bet0, 2);
    s.clock.advance(WATCH_FIRST_MS);
    await waitFor(() => s.desk.watching.length === 1, '第一轮');
    s.scopes.abort(s.run.id, '任务收尾');
    await waitFor(() => s.desk.watching.length === 0, '收尾时停下');
    s.watcher.gate = undefined;
    await act(s, s.bet0, 10);
    await pass(s, WATCH_EVERY_MS * 2);
    expect(s.watcher.calls).toHaveLength(1);
    expect(s.logs.some((l) => l.includes('没做成'))).toBe(false);
  });
  it('重启：有上一版就从这一刻起等一个间隔，再从上一版看到的那次往后看', async () => {
    const s = setup();
    await act(s, s.bet0, 2);
    await pass(s, WATCH_FIRST_MS);
    s.desk.stop();
    observe(s.b, s.bet0, '重启前又做了一次');
    const watcher = new FakeWatcher();
    watcher.runStore = s.b;
    const desk = new WatchDesk({
      queries: s.b.queries,
      bus: s.b.bus,
      watcher,
      scopes: s.scopes,
      clock: s.clock,
    });
    desks.push(desk);
    desk.start();
    await desk.settle();
    expect(watcher.calls).toEqual([]);
    s.clock.advance(WATCH_EVERY_MS);
    await desk.settle();
    expect(watcher.calls.map((c) => c.toolCalls)).toEqual([3]);
    expect(watcher.calls[0]?.request.previous?.rev).toBe(1);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id).map((v) => [v.rev, v.toolCalls])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });
  it('替代实现同样必须持久化成功，不可见证据拒绝发布', async () => {
    const s = setup();
    const theirs = observe(s.b, s.other, '别的路线跑的');
    s.watcher.draft = () => ({
      standing: '第 1 条还差一点',
      directions: [
        {
          id: 'add-tests',
          direction: '补测试',
          status: 'trying',
          result: '补了 2 条',
          evidence: [theirs.id],
          attempts: [{ id: 't1', action: '补分页的测试', result: '过了', evidence: [theirs.id] }],
        },
      ],
      tension: [],
      advice: '接着补',
    });
    await act(s, s.bet0, 1);
    await pass(s, WATCH_FIRST_MS);
    expect(watchVersions(s.b.queries, s.run.id, s.bet0.id)).toEqual([]);
    expect(s.logs.some((l) => l.includes('别的分支'))).toBe(true);
  });
});
describe('整套 runtime 里（地图每次请求现读，不往对话里追加）', () => {
  it('看法写上 RunStore 以后，正在跑的 episode 下一次请求现读到的就是最新的一版；对话里不追加', async () => {
    const watcher = new FakeWatcher();
    h = await harness({ watcher, watchPace: { firstMs: 0, everyMs: 60000 } });
    const hh = h;
    let maps: (string | undefined)[] | undefined;
    let steered: string[] | undefined;
    hh.explorer.on('主干直解路线', async (ctx) => {
      const tail = ctx.input.referenceContext;
      const before = tail?.();
      for (let i = 0; i < 12; i++) {
        ctx.observe(`第 ${i + 1} 次`);
        await tick(2);
      }
      await waitFor(() => tail?.() !== undefined, '巡检器交了第一版');
      maps = [before, tail?.()];
      await tick(250); // Courier 攒 200 毫秒再追加：等过这一拍，看它没有追加
      steered = [...ctx.steered];
      return ctx.untilAborted();
    });
    const run = await hh.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => steered !== undefined, '主干直解路线读到巡检器的地图');
    expect(maps).toEqual([undefined, '【巡检器】第 1 版：第 1 轮的提醒']);
    expect(steered?.filter((t) => t.includes('巡检器'))).toEqual([]);
    expect(watcher.calls).toHaveLength(1);
    expect(watcher.calls[0]?.toolCalls).toBeGreaterThan(0);
    expect(hh.rt.watch.watching).toEqual([]);
    expect(watchVersions(hh.runStore.queries, run.id, hh.bet0(run.id).id)).toHaveLength(1);
  });
});
