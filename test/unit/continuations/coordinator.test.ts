import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bet0ModelsOf, type RunConfigOverride } from '../../../src/core/config.ts';
import type { ContinuationState } from '../../../src/core/continuation.ts';
import { handleOf } from '../../../src/core/ids.ts';
import type { Branch } from '../../../src/core/types.ts';
import { ContinuationCoordinator, type ContinuationDeps } from '../../../src/runtime/continuations.ts';
import { FakeClock } from '../runtime/kit.ts';
import { newRun, observe, snapshotId, startBranch, testRunStore } from '../storage/kit.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(
  options: {
    maxActive?: number;
    accessToolCalls?: number;
    momentumToolCalls?: number;
    bet0?: RunConfigOverride['bet0'];
  } = {},
) {
  const store = testRunStore();
  const clock = new FakeClock();
  const dataDir = mkdtempSync(join(tmpdir(), 'melina-continuations-'));
  const run = newRun(store, {
    config: {
      bet0: {
        models: Array.from({ length: 3 }, () => ({
          provider: 'deepseek',
          model: 'deepseek-flash',
          tier: 'fast' as const,
        })),
        copies: 3,
        ...options.bet0,
      },
      continuation: {
        enabled: true,
        forkCopies: 2,
        maxActive: options.maxActive ?? 5,
        momentumToolCalls: options.momentumToolCalls ?? 12,
        accessToolCalls: options.accessToolCalls ?? 50,
      },
    },
  });
  const parents = bet0ModelsOf(run.config).map((model) => startBranch(store, run, { model }).branch);
  for (const branch of parents) observe(store, branch);
  const pins = new Set<string>();
  const checkpoints = vi.fn(async (id: string, handoff: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const branch = store.queries.getBranch(id)!;
    const saved = store.writer.checkpointBranch(id, { id: snapshotId() }, { episode: branch.episode, handoff });
    pins.add(saved.lastSnapshot);
    return saved;
  });
  const opened: Branch[] = [];
  const activeCounts: number[] = [];
  const cancel = vi.fn(async (id: string, note: string) =>
    store.writer.updateBranch(id, { state: 'cancelled', stateNote: note, queued: false }),
  );
  const generate = vi.fn<ContinuationDeps['generate']>(async ({ prompt }) => {
    const request = JSON.parse(prompt) as { maxDirections: number; routes: { branchId: string }[] };
    return JSON.stringify({
      summary: '已验证入口在 /workspace/entry.txt；重启代理后访问内网，Groovy 路线尚未排查。',
      hasAccess: true,
      sourceBranchId:
        request.routes.find((route) => route.branchId === parents[1]?.id)?.branchId ?? request.routes[0]!.branchId,
      directions: Array.from({ length: request.maxDirections }, (_, i) => `检查新的入口 ${i + 1}`),
    });
  });
  const deps: ContinuationDeps = {
    queries: store.queries,
    writer: store.writer,
    bus: store.bus,
    clock,
    dataDir,
    generate,
    redact: (text) => text,
    scopes: { signal: () => new AbortController().signal },
    runners: {
      checkpoint: checkpoints,
      preserveCheckpoint: (snapshot) => {
        pins.add(snapshot);
      },
      releaseCheckpoint: (snapshot) => {
        pins.delete(snapshot);
      },
      handoffMaterial: () => '完整会话的压缩摘要：最初已验证的凭证保存在 /workspace/entry.txt',
    },
    branches: {
      cancel,
      async apply(command) {
        if (command.kind !== 'open') throw new Error('本场景只会开分支');
        const branch = store.writer.createBranch({
          runId: command.runId,
          betId: command.bet.id,
          lastSnapshot: command.bet.startFrom.snapshot,
        });
        opened.push(branch);
        activeCounts.push(
          store.queries
            .listBranches(run.id)
            .filter((item) => !['failed', 'cancelled', 'succeeded'].includes(item.state)).length,
        );
        return branch;
      },
    },
  };
  const coordinators: ContinuationCoordinator[] = [];
  const create = () => {
    const coordinator = new ContinuationCoordinator(deps);
    coordinators.push(coordinator);
    return coordinator;
  };
  const coordinator = create();
  const step = async (ms = 0, target = coordinator) => {
    clock.advance(ms);
    await target.settle();
  };
  const state = () => JSON.parse(readFileSync(join(dataDir, run.id, 'continuation.json'), 'utf8')) as ContinuationState;
  const receipt = (accepted = 1, total = 6, task = 'multi-flags') =>
    store.writer.recordHumanInput({
      runId: run.id,
      text: '平台已通过第一个目标',
      acceptance: { task, accepted, total },
    });
  const calls = (count = options.momentumToolCalls ?? 12, branches = parents) => {
    for (const branch of branches) for (let i = 0; i < count; i++) observe(store, branch);
  };
  const stall = async () => {
    await step(30_000);
    calls();
    await step(30_000);
  };
  const platform = (accepted = 1, total = 6, origins = [parents[1] ?? parents[0]!], task = 'multi-flags') => {
    const flags = Array.from({ length: accepted }, (_, i) => {
      const source = origins[i % origins.length]!;
      const evidence = observe(store, source, `flag ${i + 1}`);
      return {
        id: `flag-${i + 1}`,
        label: `flag ${i + 1}`,
        source: { runId: run.id, branchId: source.id, observationId: evidence.id },
      };
    });
    const watcher = store.queries.getBranch(parents[0]!.id)!;
    return store.writer.appendObservation(
      {
        runId: run.id,
        branchId: watcher.id,
        episode: watcher.episode,
        role: 'watcher',
        tool: 'platform_status',
        args: {
          task,
          total,
          remaining: total - accepted,
          hintStatus: 'none',
          hint: '',
          accepted: flags,
          rejectedCount: 0,
        },
        summary: '权威验收状态',
        output: handleOf('权威验收状态'),
        snapshot: watcher.lastSnapshot,
      },
      { countsAsToolCall: false },
    );
  };
  cleanups.push(async () => {
    for (const c of coordinators) await c.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    store,
    clock,
    run,
    parents,
    pins,
    checkpoints,
    opened,
    generate,
    coordinator,
    create,
    step,
    state,
    receipt,
    calls,
    stall,
    platform,
    cancel,
    activeCounts,
    deps,
  };
}

describe('摘要续接', () => {
  it('连得三个 Flag 合并水位，只在最后一次得分后满 12 次调用才分叉，入口巡检不能抢跑', async () => {
    const s = setup({ accessToolCalls: 2 });
    const source = s.parents[1]!;
    s.coordinator.start(s.run.id);
    for (const accepted of [1, 2, 3]) {
      s.platform(accepted);
      await s.step(30_000);
      s.calls(11, [source]);
      await s.step(30_000);
      expect(s.generate).not.toHaveBeenCalled();
      expect(s.state().acceptance[0]?.best).toBe(accepted);
    }
    s.calls(1, [source]);
    await s.step(30_000);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.checkpoints).toHaveBeenCalledTimes(1);
    expect(s.opened).toHaveLength(2);
    expect(s.state().handled).toEqual(['accepted:multi-flags:3']);
    expect(s.store.queries.getBet(s.opened[0]!.betId)?.continuation).toMatchObject({
      task: 'multi-flags',
      baseWatermark: 3,
    });
  });

  it('按累计回执里最近得分的路线计算动量，其他路线的调用不能触发它的分叉', async () => {
    const s = setup({ momentumToolCalls: 3 });
    s.platform(3, 6, [s.parents[0]!, s.parents[1]!, s.parents[2]!]);
    s.coordinator.start(s.run.id);
    await s.step();
    s.calls(20, [s.parents[0]!]);
    s.calls(2, [s.parents[2]!]);
    await s.step(30_000);
    expect(s.generate).not.toHaveBeenCalled();
    s.calls(1, [s.parents[2]!]);
    await s.step(30_000);
    expect(s.checkpoints.mock.calls.map(([id]) => id)).toEqual([s.parents[2]!.id]);
  });

  it('来源不明的回执只把达到动量阈值的路线交给计划生成器', async () => {
    const s = setup();
    s.receipt();
    s.coordinator.start(s.run.id);
    await s.step();
    s.calls(12, [s.parents[2]!]);
    await s.step(30_000);
    expect(
      JSON.parse(s.generate.mock.calls[0]![0].prompt).routes.map((route: { branchId: string }) => route.branchId),
    ).toEqual([s.parents[2]!.id]);
    expect(s.checkpoints.mock.calls.map(([id]) => id)).toEqual([s.parents[2]!.id]);
  });

  it('回执到达时没有可运行路线，路线就绪后才开始记录动量', async () => {
    const s = setup();
    for (const branch of s.parents) s.store.writer.updateBranch(branch.id, { queued: true });
    s.receipt();
    s.coordinator.start(s.run.id);
    await s.step();
    expect(s.state().acceptance[0]?.branches).toEqual([]);
    s.store.writer.updateBranch(s.parents[1]!.id, { queued: false });
    await s.stall();
    expect(s.checkpoints.mock.calls.map(([id]) => id)).toEqual([s.parents[1]!.id]);
  });

  it('已知只有一个未验收目标时，首次入口检查也最多开一路接力', async () => {
    const s = setup({ accessToolCalls: 2 });
    s.receipt(0, 1);
    s.calls(1, [s.parents[0]!]);
    s.coordinator.start(s.run.id);
    await s.step();
    expect(s.opened).toHaveLength(1);
    expect(s.store.queries.getBet(s.opened[0]!.betId)?.continuation).toMatchObject({
      task: 'multi-flags',
      baseWatermark: 0,
    });
  });

  it('重复回执和重启都不重置得分时的工具调用游标', async () => {
    const s = setup();
    s.platform();
    s.coordinator.start(s.run.id);
    await s.step();
    const baseline = s.state().acceptance[0]!.branches![0]!.toolCallsAtAccept;
    s.calls(11, [s.parents[1]!]);
    s.receipt();
    await s.step(30_000);
    expect(s.generate).not.toHaveBeenCalled();
    await s.coordinator.close();
    const restarted = s.create();
    await restarted.restore();
    restarted.start(s.run.id);
    s.calls(1, [s.parents[1]!]);
    await s.step(0, restarted);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.state().acceptance[0]!.branches![0]!.toolCallsAtAccept).toBe(baseline);
  });

  it.each([0, 1])('独立入口只有 %s 个时不凑满两份，零入口的决定也持久化去重', async (count) => {
    const s = setup();
    s.platform();
    s.generate.mockResolvedValue(
      JSON.stringify({
        summary: '当前链路由原会话继续',
        hasAccess: true,
        directions: count ? ['检查另一台内网主机的独立入口'] : [],
      }),
    );
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.opened).toHaveLength(count);
    expect(s.checkpoints).toHaveBeenCalledTimes(count ? 1 : 0);
    await s.coordinator.close();
    const restarted = s.create();
    await restarted.restore();
    restarted.start(s.run.id);
    s.calls(30);
    await s.step(30_000, restarted);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.cancel).not.toHaveBeenCalled();
  });

  it('只剩一个 Flag 时分叉上限为一，全部验收后不再检查入口或分叉', async () => {
    const s = setup({ accessToolCalls: 2 });
    s.platform(5);
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(JSON.parse(s.generate.mock.calls[0]![0].prompt)).toMatchObject({ maxDirections: 1, remainingTargets: 1 });
    expect(s.opened).toHaveLength(1);
    s.platform(6);
    await s.step(30_000);
    s.calls(100);
    s.receipt(2);
    await s.step(30_000);
    expect(s.state().acceptance[0]?.best).toBe(6);
    expect(s.generate).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2])('满五路时按新水位的 %s 个独立入口回收对应数量的旧接力', async (count) => {
    const s = setup();
    s.platform();
    s.coordinator.start(s.run.id);
    await s.stall();
    const old = [...s.opened];
    s.platform(4);
    await s.step(30_000);
    expect(s.cancel).not.toHaveBeenCalled();
    s.generate.mockResolvedValueOnce(
      JSON.stringify({
        summary: '已到达水位 4 的新边界',
        hasAccess: true,
        directions: Array.from({ length: count }, (_, i) => `独立服务 ${i + 1}`),
      }),
    );
    s.calls();
    await s.step(30_000);
    expect(s.cancel).toHaveBeenCalledTimes(count);
    expect(s.opened).toHaveLength(2 + count);
    expect(s.checkpoints).toHaveBeenCalledTimes(count ? 2 : 1);
    expect(s.cancel.mock.calls.every(([id]) => old.some((branch) => branch.id === id))).toBe(true);
    expect(s.parents.every((branch) => s.store.queries.getBranch(branch.id)?.state === 'running')).toBe(true);
    expect(s.activeCounts.every((active) => active <= 5)).toBe(true);
    for (const branch of s.opened.slice(2)) {
      expect(s.store.queries.getBet(branch.betId)?.continuation).toMatchObject({
        task: 'multi-flags',
        baseWatermark: 4,
      });
      expect(branch.lastSnapshot).not.toBe(old[0]!.lastSnapshot);
    }
  });

  it('旧接力成为最新水位的来源时保留它，从它的快照只替换另一条旧接力', async () => {
    const s = setup();
    s.platform();
    s.coordinator.start(s.run.id);
    await s.stall();
    const source = s.opened[0]!;
    s.store.writer.updateBranch(source.id, {
      state: 'running',
      queued: false,
      workspace: { path: `/tmp/relay/${source.id}` },
    });
    s.platform(4, 6, [source]);
    await s.step(30_000);
    s.calls(12, [source]);
    await s.step(30_000);
    expect(s.cancel.mock.calls.map(([id]) => id)).toEqual([s.opened[1]!.id]);
    expect(s.checkpoints.mock.calls.at(-1)?.[0]).toBe(source.id);
    expect(s.store.queries.getBranch(source.id)?.state).toBe('running');
    expect(s.opened).toHaveLength(3);
    expect(s.activeCounts.every((active) => active <= 5)).toBe(true);
  });

  it('保留近期得分的旧接力，等它的动量耗尽后优先替换较低水位', async () => {
    const s = setup();
    s.platform();
    s.coordinator.start(s.run.id);
    await s.stall();
    const productive = s.opened[0]!;
    s.store.writer.updateBranch(productive.id, {
      state: 'running',
      queued: false,
      workspace: { path: '/tmp/productive' },
    });
    s.platform(2, 8, [productive]);
    await s.step(30_000);
    s.platform(4, 8);
    await s.stall();
    expect(s.cancel.mock.calls.map(([id]) => id)).toEqual([s.opened[1]!.id]);
    expect(s.opened).toHaveLength(3);
    s.calls(12, [productive]);
    s.platform(5, 8);
    await s.stall();
    expect(s.cancel.mock.calls[1]?.[0]).toBe(productive.id);
    expect(s.activeCounts.every((active) => active <= 5)).toBe(true);
  });

  it('十个 Flag 长链逐代替换，任意时刻都不超过五路', async () => {
    const s = setup();
    s.coordinator.start(s.run.id);
    for (let accepted = 1; accepted < 10; accepted++) {
      s.platform(accepted, 10);
      await s.stall();
      const latest = s.store.queries
        .listBranches(s.run.id)
        .filter((branch) => branch.state !== 'cancelled' && !s.parents.some((parent) => parent.id === branch.id));
      expect(latest).toHaveLength(2);
      expect(
        latest.every(
          (branch) => (s.store.queries.getBet(branch.betId)?.continuation?.baseWatermark ?? 0) >= accepted - 1,
        ),
      ).toBe(true);
    }
    expect(s.generate).toHaveBeenCalledTimes(9);
    expect(s.activeCounts.every((active) => active <= 5)).toBe(true);
  });

  it('生成摘要期间再次得分，丢弃旧水位结果并重新等待动量耗尽', async () => {
    const s = setup();
    s.platform();
    const generate = s.generate.getMockImplementation()!;
    s.generate.mockImplementationOnce(async (request) => {
      s.platform(2);
      return generate(request);
    });
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.state().acceptance[0]?.best).toBe(2);
    expect(s.checkpoints).not.toHaveBeenCalled();
    expect(s.opened).toHaveLength(0);
    await s.stall();
    expect(s.generate).toHaveBeenCalledTimes(2);
    expect(s.opened).toHaveLength(2);
    expect(s.state().handled).toEqual(['accepted:multi-flags:2']);
  });

  it('保存快照期间再次得分，释放旧快照保护且不持久化旧计划', async () => {
    const s = setup();
    s.platform();
    const checkpoint = s.checkpoints.getMockImplementation()!;
    s.checkpoints.mockImplementationOnce(async (...args) => {
      const saved = await checkpoint(...args);
      s.platform(2);
      return saved;
    });
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.opened).toHaveLength(0);
    expect(s.pins.size).toBe(0);
    expect(s.state().pending).toBeUndefined();
    await s.stall();
    expect(s.opened).toHaveLength(2);
    expect(s.state().handled).toEqual(['accepted:multi-flags:2']);
  });

  it('重启恢复时废弃被新水位取代的待执行计划，关闭未启动的 Bet 并释放快照', async () => {
    const s = setup();
    s.platform();
    const apply = s.deps.branches.apply;
    s.deps.branches.apply = async () => {
      throw new Error('暂时不能启动分支');
    };
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.state().pending?.baseWatermark).toBe(1);
    await s.coordinator.close();
    s.platform(4);
    const restarted = s.create();
    await restarted.restore();
    expect(s.pins.size).toBe(1);
    s.deps.branches.apply = apply;
    restarted.start(s.run.id);
    await s.step(0, restarted);
    expect(s.state().pending).toBeUndefined();
    expect(s.pins.size).toBe(0);
    expect(
      s.store.queries
        .listBets(s.run.id)
        .filter((bet) => bet.continuation?.baseWatermark === 1)
        .every((bet) => bet.status === 'closed'),
    ).toBe(true);
    expect(s.opened).toHaveLength(0);
    s.calls();
    await s.step(30_000, restarted);
    expect(s.opened).toHaveLength(2);
    expect(s.opened.every((branch) => s.store.queries.getBet(branch.betId)?.continuation?.baseWatermark === 4)).toBe(
      true,
    );
  });

  it('等待旧分支停止时再次得分，停止后也不能启动过期水位的计划', async () => {
    const s = setup();
    s.platform();
    s.coordinator.start(s.run.id);
    await s.stall();
    s.platform(4);
    const cancel = s.cancel.getMockImplementation()!;
    s.cancel.mockImplementationOnce(async (...args) => {
      const stopped = await cancel(...args);
      s.platform(5);
      return stopped;
    });
    await s.stall();
    expect(s.state().acceptance[0]?.best).toBe(5);
    expect(s.state().pending).toBeUndefined();
    expect(s.opened).toHaveLength(2);
    expect(s.pins.size).toBe(0);
    await s.stall();
    expect(s.opened).toHaveLength(3);
    expect(s.store.queries.getBet(s.opened[2]!.betId)?.continuation?.baseWatermark).toBe(5);
    expect(s.activeCounts.every((active) => active <= 5)).toBe(true);
  });

  it('替换等待中暂停任务会立即中止调度，迟到的取消结果不能再开分支', async () => {
    const s = setup();
    s.platform();
    s.coordinator.start(s.run.id);
    await s.stall();
    s.platform(4);
    await s.step(30_000);
    let release!: () => void;
    const boundary = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = s.cancel.getMockImplementation()!;
    s.cancel.mockImplementationOnce(async (...args) => {
      await boundary;
      return cancel(...args);
    });
    s.calls();
    s.clock.advance(30_000);
    await vi.waitFor(() => expect(s.cancel).toHaveBeenCalledTimes(1));
    s.store.writer.updateRun(s.run.id, { status: 'paused' });
    await s.coordinator.settle();
    expect(s.opened).toHaveLength(2);
    expect(s.state().pending?.baseWatermark).toBe(4);
    release();
    await s.cancel.mock.results[0]!.value;
    expect(s.opened).toHaveLength(2);
    s.store.writer.updateRun(s.run.id, { status: 'running' });
    await s.step();
    expect(s.opened).toHaveLength(4);
    expect(s.activeCounts.every((active) => active <= 5)).toBe(true);
  });

  it('部分验收停滞后生成一次交接，从同一快照开两路干净会话，重启也不重复', async () => {
    const s = setup();
    s.receipt();
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.generate.mock.calls[0]![0].prompt).toContain('最初已验证的凭证');
    expect(s.checkpoints.mock.calls.map(([id]) => id)).toEqual([s.parents[1]!.id]);
    expect(s.opened).toHaveLength(2);
    expect(new Set(s.opened.map((branch) => branch.lastSnapshot)).size).toBe(1);
    expect(s.opened.every((branch) => branch.lastSnapshot !== 'root')).toBe(true);
    expect(s.parents.every((branch) => s.store.queries.getBranch(branch.id)?.state === 'running')).toBe(true);
    expect(s.pins.size).toBe(0);
    expect(s.state().handled).toEqual(['accepted:multi-flags:1']);
    await s.coordinator.close();
    const restarted = s.create();
    await restarted.restore();
    restarted.start(s.run.id);
    s.receipt();
    await s.step(30_000, restarted);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.store.queries.listBets(s.run.id)).toHaveLength(5);
  });

  it('没有空位时保留验收触发条件，空位释放后再分叉', async () => {
    const s = setup({ maxActive: 3 });
    s.receipt();
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.generate).not.toHaveBeenCalled();
    for (const branch of [s.parents[0]!, s.parents[2]!]) s.store.writer.updateBranch(branch.id, { state: 'failed' });
    await s.step(30_000);
    expect(s.opened).toHaveLength(2);
    expect(s.generate).toHaveBeenCalledTimes(1);
  });

  it.each([1, 3])('没有外部回执时保留 %s 路长会话，跨过巡检周期也不换代', async (copies) => {
    const s = setup({
      bet0: {
        models: Array.from({ length: copies }, () => ({ provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' })),
      },
    });
    s.coordinator.start(s.run.id);
    await s.step();
    for (const minutes of [7, 4, 5, 44]) {
      for (const branch of s.parents) observe(s.store, branch);
      await s.step(minutes * 60_000);
      expect(s.generate).not.toHaveBeenCalled();
      expect(s.checkpoints).not.toHaveBeenCalled();
      expect(s.store.queries.listBranches(s.run.id).map((branch) => branch.id)).toEqual(
        s.parents.map((branch) => branch.id),
      );
      expect(s.parents.every((branch) => s.store.queries.getBranch(branch.id)?.state === 'running')).toBe(true);
    }
  });

  it('另一个任务的水位不能抢占当前任务的接力槽位', async () => {
    const s = setup();
    s.receipt();
    s.coordinator.start(s.run.id);
    await s.stall();
    for (const branch of s.opened) {
      s.store.writer.updateBranch(branch.id, {
        state: 'running',
        queued: false,
        workspace: { path: `/tmp/relay/${branch.id}` },
      });
      observe(s.store, branch);
    }
    s.store.writer.recordHumanInput({
      runId: s.run.id,
      text: '另一组目标有部分验收',
      acceptance: { task: 'another-task', accepted: 1, total: 2 },
    });
    await s.step(30_000);
    s.calls();
    await s.step(60 * 60_000);
    expect(s.opened).toHaveLength(2);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.store.queries.listBranches(s.run.id).every((branch) => branch.state === 'running')).toBe(true);
    s.store.writer.updateBranch(s.parents[0]!.id, { state: 'failed' });
    await s.step(30_000);
    expect(s.opened).toHaveLength(3);
    expect(s.generate).toHaveBeenCalledTimes(2);
    expect(s.state().handled).toContain('accepted:another-task:1');
  });

  it('全部路线失败后不再按计时器创建替代路线', async () => {
    const s = setup();
    s.coordinator.start(s.run.id);
    await s.step();
    for (const branch of s.parents) s.store.writer.updateBranch(branch.id, { state: 'failed' });
    await s.step(60 * 60_000);
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.opened).toHaveLength(0);
    expect(s.checkpoints).not.toHaveBeenCalled();
    expect(s.pins.size).toBe(0);
  });

  it('未确认入口时等待新增工具调用再检查，重启保留检查水位', async () => {
    const s = setup({ accessToolCalls: 2 });
    observe(s.store, s.parents[0]!);
    s.generate.mockResolvedValueOnce(
      JSON.stringify({ summary: '还没有验证可用入口', hasAccess: false, directions: ['检查服务 A', '检查服务 B'] }),
    );
    s.coordinator.start(s.run.id);
    await s.step();
    await s.step(30_000);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.opened).toHaveLength(0);
    expect(s.checkpoints).not.toHaveBeenCalled();
    await s.coordinator.close();
    const restarted = s.create();
    await restarted.restore();
    restarted.start(s.run.id);
    observe(s.store, s.parents[0]!);
    await s.step(30_000, restarted);
    expect(s.generate).toHaveBeenCalledTimes(1);
    observe(s.store, s.parents[0]!);
    await s.step(30_000, restarted);
    expect(s.generate).toHaveBeenCalledTimes(2);
    expect(s.opened).toHaveLength(2);
    expect(s.checkpoints.mock.calls.map(([id]) => id)).toEqual([s.parents[0]!.id]);
  });

  it('交接方向无效时完整保留旧路线', async () => {
    const s = setup();
    s.receipt();
    s.generate.mockResolvedValue(
      JSON.stringify({ summary: '已有入口', hasAccess: true, directions: ['同一方向', '同一方向'] }),
    );
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.opened).toHaveLength(0);
    expect(s.parents.every((branch) => s.store.queries.getBranch(branch.id)?.state === 'running')).toBe(true);
    expect(s.checkpoints).not.toHaveBeenCalled();
  });

  it('摘要生成中暂停任务，迟到结果不能开分支', async () => {
    const s = setup();
    s.receipt();
    let finish!: (text: string) => void;
    s.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    s.coordinator.start(s.run.id);
    await s.step();
    s.calls();
    s.clock.advance(30_000);
    await vi.waitFor(() => expect(s.generate).toHaveBeenCalledTimes(1));
    s.store.writer.updateRun(s.run.id, { status: 'paused' });
    await s.coordinator.settle();
    finish(
      JSON.stringify({
        summary: '已有入口',
        hasAccess: true,
        sourceBranchId: s.parents[1]!.id,
        directions: ['A', 'B'],
      }),
    );
    await Promise.resolve();
    expect(s.checkpoints).not.toHaveBeenCalled();
    expect(s.opened).toHaveLength(0);
  });

  it('接力摘要生成时任务进入交付，立即停止开新路线', async () => {
    const s = setup();
    s.receipt();
    const generate = s.generate.getMockImplementation()!;
    s.generate.mockImplementationOnce(async (request) => {
      s.store.writer.updateRun(s.run.id, { mode: 'settling' });
      return generate(request);
    });
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.opened).toHaveLength(0);
    expect(s.checkpoints).not.toHaveBeenCalled();
    expect(s.store.queries.getRun(s.run.id)!.mode).toBe('settling');
  });

  it('重试持久化计划时复用已写 Bet，不重复快照或分支', async () => {
    const s = setup();
    s.receipt();
    const apply = s.deps.branches.apply;
    let fail = true;
    s.deps.branches.apply = async (command) => {
      if (fail) {
        fail = false;
        throw new Error('瞬时创建失败');
      }
      return apply(command);
    };
    s.coordinator.start(s.run.id);
    await s.stall();
    expect(s.state().pending).toBeDefined();
    expect(s.store.queries.listBets(s.run.id)).toHaveLength(5);
    await s.coordinator.close();
    const restarted = s.create();
    await restarted.restore();
    restarted.start(s.run.id);
    await s.step(0, restarted);
    expect(s.state().pending).toBeUndefined();
    expect(s.opened).toHaveLength(2);
    expect(s.checkpoints).toHaveBeenCalledTimes(1);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.store.queries.listBets(s.run.id)).toHaveLength(5);
    expect(s.pins.size).toBe(0);
  });
  it('暂停期间不处理接力，恢复后处理积累的验收结果', async () => {
    const s = setup();
    s.coordinator.start(s.run.id);
    await s.step();
    await s.step(100_000);
    s.store.writer.updateRun(s.run.id, { status: 'paused' });
    s.receipt();
    await s.step(600_000);
    expect(s.generate).not.toHaveBeenCalled();
    s.store.writer.updateRun(s.run.id, { status: 'running' });
    await s.stall();
    expect(s.opened).toHaveLength(2);
    expect(s.parents.every((branch) => s.store.queries.getBranch(branch.id)?.state === 'running')).toBe(true);
  });

  it('暂停状态启动后只监听事件，恢复时才处理积累的验收', async () => {
    const s = setup();
    s.store.writer.updateRun(s.run.id, { status: 'paused' });
    s.receipt();
    s.coordinator.start();
    await s.step(600_000);
    expect(s.generate).not.toHaveBeenCalled();

    s.store.writer.updateRun(s.run.id, { status: 'running' });
    await s.stall();
    expect(s.opened).toHaveLength(2);
  });

  it('任务已中止但终态尚未写入时，后续事件不再唤起摘要调度', async () => {
    const s = setup();
    const scope = new AbortController();
    s.deps.scopes.signal = () => scope.signal;
    s.coordinator.start();
    await s.step();
    scope.abort(new Error('任务正在取消'));
    await s.step(30_000);
    const scheduled = vi.spyOn(s.clock, 'setTimeout');

    s.receipt();
    observe(s.store, s.parents[0]!);
    await s.step(600_000);
    expect(scheduled).not.toHaveBeenCalled();
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.opened).toHaveLength(0);
  });

  it('关闭后任务事件不会再启动摘要任务', async () => {
    const s = setup();
    s.coordinator.start();
    await s.step();
    await s.coordinator.close();
    s.receipt();
    s.store.writer.updateRun(s.run.id, { status: 'paused' });
    s.store.writer.updateRun(s.run.id, { status: 'running' });
    await s.step(600_000);
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.opened).toHaveLength(0);
  });

  it('单目标交付阶段版后仍在原会话持续推进', async () => {
    const s = setup({ bet0: { models: [{ provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' }] } });
    const branch = s.parents[0]!;
    s.store.writer.recordHumanInput({
      runId: s.run.id,
      text: '只有一个待验收目标',
      acceptance: { task: 'single-target', accepted: 0, total: 1 },
    });
    s.coordinator.start(s.run.id);
    await s.step();
    const snapshot = snapshotId();
    s.store.writer.deliverVersion({
      branchId: branch.id,
      episode: branch.episode,
      snapshot: { id: snapshot },
      candidate: { runId: s.run.id, branchId: branch.id, snapshot, claim: '阶段成果已完成', interim: true },
    });
    await s.step(60 * 60_000);
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.opened).toHaveLength(0);
    expect(s.store.queries.getBranch(branch.id)).toMatchObject({ state: 'running', lastSnapshot: snapshot });
    expect(s.store.queries.getRun(s.run.id)?.status).toBe('running');
  });
  it('步数检查确认已有入口后，从该路线分叉两份且不停止原路线', async () => {
    const s = setup({ accessToolCalls: 2 });
    observe(s.store, s.parents[0]!);
    s.coordinator.start(s.run.id);
    await s.step();
    expect(s.checkpoints.mock.calls.map(([id]) => id)).toEqual([s.parents[0]!.id]);
    expect(s.opened).toHaveLength(2);
    expect(s.parents.every((branch) => s.store.queries.getBranch(branch.id)?.state === 'running')).toBe(true);
    expect(s.state().handled).toEqual([`access:${s.parents[0]!.id}`]);
  });
});
