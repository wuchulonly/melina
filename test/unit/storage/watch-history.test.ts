import { afterEach, describe, expect, it } from 'vitest';
import type { SubmitWatchArgs } from '../../../src/core/tools.ts';
import { WatchNote } from '../../../src/core/types.ts';
import { isValid } from '../../../src/core/validate.ts';
import { latestWatch, watchEvidence } from '../../../src/projections/watch.ts';
import { newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

let runStore: TestRunStore;
afterEach(() => runStore?.close());
function scene() {
  runStore = testRunStore();
  const run = newRun(runStore);
  const { branch, bet } = startBranch(runStore, run, { kind: 'direct' });
  const evidence = observe(runStore, branch, '当前条件没有出现业务标记');
  const draft: SubmitWatchArgs = {
    standing: '当前请求可能缺少必要条件',
    advice: '核对处理路径',
    directions: [
      {
        id: 'route',
        direction: '检查业务处理路径',
        status: 'unclear',
        result: '保留认证状态执行，但没有观察到业务标记',
        doubt: '可能未进入处理流程；用有效对照区分',
        evidence: [evidence.id],
        attempts: [{ id: 't1', action: '保留认证状态发送请求', result: '没有业务标记', evidence: [evidence.id] }],
      },
    ],
    tension: [],
  };
  const note = runStore.writer.recordWatch({
    runId: run.id,
    branchId: branch.id,
    basedOnSeq: runStore.queries.lastSeq(),
    toolCalls: 1,
    model: bet.model,
    draft,
  });
  return { run, branch, bet, evidence, draft, note };
}
describe('方向图的持久化与历史', () => {
  it('持久化只保存方向图，读取与再发布保留尝试历史', () => {
    const s = scene();
    const previous = latestWatch(runStore.queries, s.run.id, s.branch.id)!;
    const { seq: _seq, ...note } = previous;
    expect(isValid(WatchNote, note)).toBe(true);
    expect(watchEvidence(note)).toEqual([s.evidence.id]);
    for (const field of ['verified', 'untried', 'confirmedIds', 'angleIds', 'contradictions'])
      expect(note).not.toHaveProperty(field);
    const next = runStore.writer.recordWatch({
      runId: s.run.id,
      branchId: s.branch.id,
      basedOnSeq: runStore.queries.lastSeq(),
      toolCalls: 1,
      model: s.bet.model,
      draft: { ...s.draft, directions: [] },
    });
    expect(next.rev).toBe(2);
    expect(next.directions).toEqual(s.note.directions);
    expect(runStore.queries.events({ since: 0, runId: s.run.id, types: ['watch.noted'] })[0]!.data).toEqual(s.note);
  });
});
