import { describe, expect, it } from 'vitest';
import { previousWatchSection, watchMap } from '../../../src/context/watch.ts';
import { newId } from '../../../src/core/ids.ts';
import type { SubmitWatchArgs } from '../../../src/core/tools.ts';
import type { WatchNote } from '../../../src/core/types.ts';
import { mergeWatch } from '../../../src/projections/watch.ts';

const draft: SubmitWatchArgs = {
  standing: '原前提仍需验证',
  advice: '处理流程 | 输入条件不明 | 对照有效请求',
  directions: [
    {
      id: 'route',
      direction: '验证处理流程',
      status: 'failed',
      result: '原输入下未命中',
      doubt: '可能未进入处理流程，改变单个输入检查响应',
      evidence: [],
      attempts: [{ id: 't1', action: '使用原输入测试', result: '未命中', evidence: [newId()] }],
    },
  ],
  tension: [],
};
function note(): WatchNote {
  return {
    branchId: newId(),
    rev: 1,
    toolCalls: 1,
    basedOnSeq: 1,
    model: { provider: 'test', model: 'test', tier: 'fast' },
    ...mergeWatch(undefined, draft),
  };
}
describe('方向承载实验判断与疑点', () => {
  it('跨轮保留实际尝试与完整疑点，决策简报同步展示影响判断的缺口', () => {
    const before = note();
    const next = mergeWatch(before, {
      ...draft,
      directions: [{ ...draft.directions[0]!, attempts: [], doubt: '先对照入口，再判断机制' }],
    });
    expect(next.directions[0]?.attempts).toEqual(before.directions[0]?.attempts);
    const current = { ...before, ...next };
    expect(previousWatchSection(current)).toContain('先对照入口，再判断机制');
    expect(watchMap(current)).toContain('OPEN_QUESTIONS:\n- 验证处理流程：先对照入口，再判断机制');
    expect(watchMap(current)).toContain('验证处理流程（未奏效）：原输入下未命中');
    expect(before.directions[0]?.doubt).toContain('改变单个输入');
  });
});
