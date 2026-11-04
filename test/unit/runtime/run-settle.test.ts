import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEnding } from '../../../src/core/interfaces/store.ts';
import type { Branch, Candidate, Run } from '../../../src/core/types.ts';
import { realClock } from '../../../src/runtime/async.ts';
import { RunLifecycle, type RunManagerDeps } from '../../../src/runtime/run-lifecycle.ts';
import { RunSettle } from '../../../src/runtime/run-settle.ts';

const active: RunSettle[] = [];
afterEach(async () => {
  for (const settlement of active.splice(0)) {
    settlement.stop();
    await settlement.idle();
  }
});

function fixture(mode: Run['mode'] = 'settling', retryDelay = 10) {
  let run = { id: 'run-id', mode, status: 'running', workspace: { kind: 'dir-copy' } } as Run;
  const owner = {
    id: 'winner',
    runId: run.id,
    state: mode === 'settling' ? 'succeeded' : 'running',
    workspace: { path: '/tmp/melina-settle-winner' },
    toolCalls: 10,
    seq: 1,
  } as Branch;
  const sibling = { ...owner, id: 'sibling', state: 'running', toolCalls: 5, seq: 2 } as Branch;
  const candidate = { id: 'candidate-id', branchId: owner.id, snapshot: 'candidate-snapshot' } as Candidate;
  const provider = {
    deliver: vi.fn(async () => ({ patch: 'art://delivered-patch' })),
    snapshot: vi.fn(async () => 'stopped-snapshot'),
  };
  const knowledge = { write: vi.fn(async () => ({ report: 'art://report', patch: 'art://unfinished-patch' })) };
  const writer = {
    endRun: vi.fn((_id: string, ending: RunEnding) => {
      run = { ...run, status: ending.status, result: ending.result };
      return run;
    }),
  };
  const branches = { cancel: vi.fn(async () => {}), quiesce: vi.fn(async () => {}) };
  const deps = {
    queries: {
      getRun: () => run,
      getBranch: (id: string) => (id === owner.id ? owner : sibling),
      listBranches: () => [owner, sibling],
      candidates: () => (mode === 'settling' ? [candidate] : []),
      events: () => [],
    },
    writer,
    branches,
    knowledge,
    workspaces: { forRun: () => provider },
    scheduler: { dropRun: vi.fn() },
    env: { removeScoper: vi.fn(async () => {}) },
    scopes: { abort: vi.fn() },
    clock: realClock,
    commitRetryDelaysMs: [retryDelay],
  } as unknown as RunManagerDeps;
  const settlement = new RunSettle(new RunLifecycle(deps));
  active.push(settlement);
  return { settlement, provider, knowledge, writer, branches, owner, current: () => run };
}

describe('Run 终态交付', () => {
  it('并发收尾只交付一次，并在 endRun 提交候选、patch 和报告', async () => {
    const { settlement, provider, writer, branches, current } = fixture();
    await Promise.all([settlement.settle('run-id'), settlement.settle('run-id')]);

    expect(provider.deliver).toHaveBeenCalledTimes(1);
    expect(branches.cancel).toHaveBeenCalledWith('sibling', expect.any(String));
    expect(writer.endRun).toHaveBeenCalledTimes(1);
    expect(current()).toMatchObject({
      status: 'done',
      result: { candidateId: 'candidate-id', patch: 'art://delivered-patch', knowledgeReport: 'art://report' },
    });
  });

  it('提交失败后后台重试报告和事务，交付不重复', async () => {
    const { settlement, provider, knowledge, writer, current } = fixture();
    writer.endRun.mockImplementationOnce(() => {
      throw new Error('磁盘满了');
    });
    await expect(settlement.settle('run-id')).rejects.toThrow('后台接着重试');
    expect(() => settlement.assertNotClosing('run-id')).toThrow('Melina 在后台重试');

    await vi.waitFor(() => expect(current().status).toBe('done'), { interval: 5 });
    await settlement.idle();
    expect(provider.deliver).toHaveBeenCalledTimes(1);
    expect(knowledge.write).toHaveBeenCalledTimes(2);
    expect(writer.endRun).toHaveBeenCalledTimes(2);
    expect(() => settlement.assertNotClosing('run-id')).not.toThrow();
  });

  it('退出时中断提交重试，保持未提交的 Run 可在重启后续接', async () => {
    const { settlement, provider, writer, current } = fixture('settling', 60_000);
    writer.endRun.mockImplementation(() => {
      throw new Error('磁盘满了');
    });
    await expect(settlement.settle('run-id')).rejects.toThrow('后台接着重试');
    settlement.stop();
    await settlement.idle();

    expect(provider.deliver).toHaveBeenCalledTimes(1);
    expect(writer.endRun).toHaveBeenCalledTimes(1);
    expect(current().status).toBe('running');
  });

  it('取消时从停止后的主路线快照提取未完成 patch', async () => {
    const { settlement, provider, knowledge, branches, owner, current } = fixture('direct');
    await settlement.end('run-id', { status: 'cancelled', reason: '用户取消' });

    expect(branches.quiesce).toHaveBeenCalledWith('run-id', expect.any(String));
    expect(provider.snapshot).toHaveBeenCalledWith(owner.workspace, 'stop');
    expect(knowledge.write).toHaveBeenCalledWith('run-id', {
      mainRoute: owner.id,
      ending: { status: 'cancelled', reason: '用户取消' },
      stopSnapshot: 'stopped-snapshot',
    });
    expect(current()).toMatchObject({
      status: 'cancelled',
      result: { patch: 'art://unfinished-patch', knowledgeReport: 'art://report' },
    });
  });
});
