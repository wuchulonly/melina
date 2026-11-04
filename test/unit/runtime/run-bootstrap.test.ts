import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GLOBAL_CONFIG, type RunConfigOverride, resolveRunConfig } from '../../../src/core/config.ts';
import type { RunStoreQueries } from '../../../src/core/interfaces/store.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import type { Run } from '../../../src/core/types.ts';
import { preparationPending, RunBootstrap } from '../../../src/runtime/run-bootstrap.ts';
import { RunLifecycle, type RunManagerDeps } from '../../../src/runtime/run-lifecycle.ts';

const first: ModelRef = { provider: 'provider-a', model: 'model-a', tier: 'strong' };
const second: ModelRef = { provider: 'provider-b', model: 'model-b', tier: 'strong' };

function bootstrap() {
  const createRun = vi.fn((input: Partial<Run>) => ({ ...input, seq: 1, mode: 'direct', status: 'running' }) as Run);
  const deps = {
    writer: { createRun },
    queries: {},
    registry: { tier: () => [first, second] },
    config: { global: () => DEFAULT_GLOBAL_CONFIG },
    paths: { dataDir: '/var/lib/melina' },
    workspaces: { detect: async () => 'dir-copy' },
    clock: { now: () => 0 },
  } as unknown as RunManagerDeps;
  const instance = new RunBootstrap(new RunLifecycle(deps), vi.fn());
  vi.spyOn(instance, 'prepare').mockResolvedValue();
  return instance;
}

describe('准备阶段解析 Bet 0 副本', () => {
  it('显式模型数组保留重复项与顺序，不再按 copies 扩增', async () => {
    const run = await bootstrap().create({
      statement: '完成任务',
      materials: [],
      workspace: '/tmp/melina-bootstrap-project',
      config: { bet0: { models: [first, second, first], copies: 5 }, watch: { disabledBet0Copies: [3] } },
    });
    expect(run.config.bet0.models).toEqual([first, second, first]);
    expect(run.config.watch?.disabledBet0Copies).toEqual([3]);
  });

  it('档位模型按 copies 派生，保持档位顺序循环选择', async () => {
    const run = await bootstrap().create({
      statement: '完成任务',
      materials: [],
      workspace: '/tmp/melina-bootstrap-project',
      config: { bet0: { models: { tier: 'strong' }, copies: 3 } },
    });
    expect(run.config.bet0.models).toEqual([first, second, first]);
  });

  it.each<NonNullable<RunConfigOverride['bet0']>>([
    { models: [first, second], copies: 5 },
    { models: { tier: 'strong' }, copies: 2 },
  ])('按生效的路数拒绝越界观察编号：%j', async (bet0) => {
    const instance = bootstrap();
    await expect(
      instance.create({
        statement: '完成任务',
        materials: [],
        workspace: '/tmp/melina-bootstrap-project',
        config: { bet0, watch: { disabledBet0Copies: [3] } },
      }),
    ).rejects.toThrow('watch.disabledBet0Copies 编号必须在 1–2 之间');
    expect(instance.prepare).not.toHaveBeenCalled();
  });

  it.each([[0], [-1], [1.5], [1, 1]])('拒绝无效或重复观察编号：%j', async (...disabledBet0Copies) => {
    await expect(
      bootstrap().create({
        statement: '完成任务',
        materials: [],
        workspace: '/tmp/melina-bootstrap-project',
        config: { watch: { disabledBet0Copies } },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('重启后补齐准备阶段', () => {
  it('收尾时按创建顺序识别已打开的首条路线，不依赖查询顺序', () => {
    const run = {
      id: 'run-id',
      mode: 'settling',
      config: resolveRunConfig({ bet0: { models: [first, first] } }),
    } as Run;
    const queries = {
      listBets: () => [
        { id: 'second', seq: 2, model: first },
        { id: 'first', seq: 1, model: first },
      ],
      listBranches: () => [{ betId: 'first' }],
    } as unknown as RunStoreQueries;
    expect(preparationPending(queries, run)).toBe(false);
  });

  it.each([
    { bets: 2, branches: 2, scoped: true, pending: true },
    { bets: 3, branches: 2, scoped: true, pending: true },
    { bets: 3, branches: 3, scoped: false, pending: true },
    { bets: 3, branches: 3, scoped: true, pending: false },
  ])('重复模型各自需要已打开的分支：$bets 张卡、$branches 条分支、Scoper=$scoped', (state) => {
    const run = {
      id: 'run-id',
      mode: 'direct',
      config: resolveRunConfig({ bet0: { models: [first, first, first] } }),
    } as Run;
    const queries = {
      listBets: () => Array.from({ length: state.bets }, (_, i) => ({ id: `bet-${i}`, kind: 'direct', model: first })),
      listBranches: () => Array.from({ length: state.branches }, (_, i) => ({ betId: `bet-${i}` })),
      events: () => (state.scoped ? [{ type: 'completion.drafted' }] : []),
    } as unknown as RunStoreQueries;

    expect(preparationPending(queries, run)).toBe(state.pending);
  });

  it('接力分支不能补足缺失的初始副本', () => {
    const run = { id: 'run-id', mode: 'direct', config: resolveRunConfig({ bet0: { models: [first, first] } }) } as Run;
    const queries = {
      listBets: () => [
        { id: 'initial', model: first },
        { id: 'relay', model: first, continuation: { key: 'progress:1' } },
      ],
      listBranches: () => [{ betId: 'initial' }, { betId: 'relay' }],
      events: () => [{ type: 'completion.drafted' }],
    } as unknown as RunStoreQueries;
    expect(preparationPending(queries, run)).toBe(true);
  });
});
