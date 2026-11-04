import { describe, expect, it } from 'vitest';
import { handleOf, newId } from '../../../src/core/ids.ts';
import type { Observation } from '../../../src/core/types.ts';
import { watchRepeatSignals } from '../../../src/projections/watch-signals.ts';

const branchId = newId();
function observation(seq: number, over: Partial<Observation> = {}): Observation {
  return {
    id: newId(),
    runId: newId(),
    branchId,
    seq,
    role: 'explorer',
    episode: 1,
    tool: 'sh',
    args: { cmd: 'check service', timeoutMs: 1000 },
    summary: 'still pending',
    output: handleOf(`output-${seq}`),
    snapshot: 'root',
    exitCode: 0,
    ...over,
  };
}
const repeated = () => [observation(1), observation(2), observation(3)];

describe('冻结执行窗口的连续重复信号', () => {
  it('至少三次且有新增执行才报告；保留原记录，不把不同输出句柄猜成结果变化', () => {
    const records = repeated();
    expect(watchRepeatSignals(records, branchId, 2, 3)[0]?.observations).toEqual(records);
    expect(watchRepeatSignals(records, branchId, 0, 2)).toEqual([]);
    expect(watchRepeatSignals(records, branchId, 3, 3)).toEqual([]);
  });

  it.each<Partial<Observation>>([
    { args: { cmd: 'check another service', timeoutMs: 1000 } },
    { args: { cmd: 'check service', timeoutMs: 2000 } },
    { summary: 'new evidence' },
    { exitCode: 1 },
    { error: 'timeout' },
    { expect: 'different expected outcome' },
    { episode: 2 },
    { snapshot: 'next' },
    { tool: 'edit' },
    { tool: 'read' },
    { args: { cmd: 'check service', background: true } },
  ])('改变执行条件或读写插入打断重复：%j', (change) => {
    const records = [observation(1), observation(2), observation(3, change), observation(4)];
    expect(watchRepeatSignals(records, branchId, 0, 4)).toEqual([]);
  });

  it('不混入其他分支、观察者或冻结后的记录，输入排序与原记录不变', () => {
    const own = repeated();
    const records = [
      own[2]!,
      observation(5),
      observation(2, { branchId: newId() }),
      own[0]!,
      observation(2, { role: 'watcher' }),
      own[1]!,
    ];
    const original = structuredClone(records);
    expect(watchRepeatSignals(records, branchId, 2, 3)[0]?.observations).toEqual(own);
    expect(records).toEqual(original);
  });

  it('最多返回最近三段；后台启动永远不会形成重复信号', () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      Array.from({ length: 3 }, (_, n) => observation(index * 3 + n + 1, { args: { cmd: `check-${index}` } })),
    ).flat();
    expect(watchRepeatSignals(records, branchId, 0, 15).map((s) => s.observations[0]!.seq)).toEqual([7, 10, 13]);
    expect(
      watchRepeatSignals(
        repeated().map((o) => ({ ...o, args: { cmd: 'check', background: true } })),
        branchId,
        0,
        3,
      ),
    ).toEqual([]);
  });
});
