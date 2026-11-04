// 存个阶段版（RunStoreWriter.deliverVersion）：episode 不收尾、Run 不结束；snapshot、暂存的事实、这一版、分支的 lastSnapshot
// 在一个事务里写；收尾交候选照旧切 settling；取消、放弃时 result 只能带交的一版。
import { afterEach, describe, expect, it } from 'vitest';
import { handleOf } from '../../../src/core/ids.ts';
import type { DeliverVersionInput } from '../../../src/core/interfaces/store.ts';
import type { Branch, Observation } from '../../../src/core/types.ts';
import { closeEpisode, newRun, observe, snapshotId, startBranch, type TestRunStore, testRunStore } from './kit.ts';

const runStores: TestRunStore[] = [];
function runStore(): TestRunStore {
  const b = testRunStore();
  runStores.push(b);
  return b;
}
afterEach(() => {
  for (const b of runStores.splice(0)) b.close();
});
function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (
      (
        error as {
          code?: string;
        }
      ).code ?? 'thrown'
    );
  }
  return undefined;
}
/** 存个阶段版的输入：两条完成标准都用同一条观测作证 */
function version(
  b: TestRunStore,
  branch: Branch,
  _o: Observation,
  over: Partial<DeliverVersionInput> = {},
): DeliverVersionInput {
  const current = b.queries.getBranch(branch.id) as Branch;
  const snap = snapshotId();
  return {
    branchId: branch.id,
    episode: current.episode,
    snapshot: { id: snap },
    candidate: {
      runId: branch.runId,
      branchId: branch.id,
      snapshot: snap,
      claim: '覆盖率到了 82%',
      interim: true,
    },
    ...over,
  };
}
describe('存个阶段版（deliverVersion）', () => {
  it('收尾交候选照旧切 settling；进了收尾以后交的一版不收', () => {
    const b = runStore();
    const run = newRun(b);
    const a = startBranch(b, run, { kind: 'direct', label: '主干直解路线' }).branch;
    const c = startBranch(b, run, { kind: 'direct', label: '另一条' }).branch;
    const oa = observe(b, a);
    b.writer.deliverVersion(version(b, a, oa));
    const snap = snapshotId();
    const closed = closeEpisode(b, a, {
      outcome: 'submitted',
      snapshot: { id: snap },
      candidate: {
        runId: run.id,
        branchId: a.id,
        snapshot: snap,
        claim: '做完了',
      },
    });
    expect(closed.run?.mode).toBe('settling');
    expect(closed.candidate?.interim).toBeUndefined();
    const oc = observe(b, c);
    expect(code(() => b.writer.deliverVersion(version(b, c, oc)))).toBe('conflict');
  });
  it('一版可以只覆盖证明了的那几条（一版是保底）', () => {
    const b = runStore();
    const run = newRun(b);
    const a = startBranch(b, run, { kind: 'direct', label: '主干直解路线' }).branch;
    const o = observe(b, a);
    const partial = version(b, a, o);
    const out = b.writer.deliverVersion(partial);
    expect(out.candidate).toMatchObject({ interim: true });
    expect(b.queries.getRun(run.id)?.mode).toBe('direct');
  });
  it('收尾交的候选不能标 interim：那是存个阶段版的', () => {
    const b = runStore();
    const run = newRun(b);
    const a = startBranch(b, run, { kind: 'direct', label: '主干直解路线' }).branch;
    observe(b, a);
    const snap = snapshotId();
    expect(
      code(() =>
        closeEpisode(b, a, {
          outcome: 'submitted',
          snapshot: { id: snap },
          candidate: {
            runId: run.id,
            branchId: a.id,
            snapshot: snap,
            claim: '做完了',
            interim: true,
          },
        }),
      ),
    ).toBe('invalid');
  });
  it('取消、放弃时 result 可以带交的一版；结束以后分支停下、这一版还在', () => {
    const b = runStore();
    const run = newRun(b);
    const a = startBranch(b, run, { kind: 'direct', label: '主干直解路线' }).branch;
    const o = observe(b, a);
    const v = b.writer.deliverVersion(version(b, a, o)).candidate;
    const ended = b.writer.endRun(run.id, {
      status: 'cancelled',
      endReason: '你取消了任务',
      result: { candidateId: v.id, knowledgeReport: handleOf('#') },
      branchNote: '你取消了任务',
    });
    expect(ended).toMatchObject({ status: 'cancelled', result: { candidateId: v.id } });
    expect(b.queries.getBranch(a.id)?.state).toBe('cancelled');
  });
});
