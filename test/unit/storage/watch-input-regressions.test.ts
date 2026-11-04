import { afterEach, describe, expect, it } from 'vitest';
import { watchFromArgs } from '../../../src/core/tools.ts';
import { allWatchAttempts, normalizeWatchDraft, watchSubmissionIssues } from '../../../src/projections/watch.ts';
import { newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

let runStore: TestRunStore;
afterEach(() => runStore?.close());
describe('Watcher 简化输入仍保留执行依据约束', () => {
  it.each(['trying', 'works', 'failed'] as const)('%s 未归一化就写入仍须通过累计尝试校验', (status) => {
    const { draft } = normalizeWatchDraft(
      undefined,
      watchFromArgs({
        standing: '核对依据',
        advice: '',
        directions: [{ id: 'route', direction: '检查路径', status, result: '声称已尝试', evidence: [] }],
      }),
    );
    expect(draft.directions[0]?.status).toBe(status);
    expect(watchSubmissionIssues(undefined, draft, () => undefined).join('；')).toContain('至少一次尝试');
  });
  it('无依据的结论不能落库，宿主也不偷偷改写模型结论', () => {
    runStore = testRunStore();
    const run = newRun(runStore);
    const { bet, branch } = startBranch(runStore, run, { kind: 'direct' });
    const input = watchFromArgs({
      standing: '核对鉴权',
      advice: '',
      directions: [
        { id: 'auth', direction: '鉴权路径', status: 'works', result: '声称返回数据', priority: 1, evidence: [] },
      ],
    });
    const write = (draft: typeof input) =>
      runStore.writer.recordWatch({
        runId: run.id,
        branchId: branch.id,
        basedOnSeq: runStore.queries.lastSeq(),
        toolCalls: 0,
        model: bet.model,
        draft,
      });
    expect(() => write(input)).toThrow('至少一次尝试');
    expect(runStore.queries.events({ runId: run.id, since: 0, types: ['watch.noted'] })).toEqual([]);
    const normalized = normalizeWatchDraft(undefined, input, () => undefined);
    expect(normalized.draft).toEqual(input);
    expect(() => write(normalized.draft)).toThrow('至少一次尝试');
  });
  it('真实执行由宿主记录并滚动归档，跨轮重复提交不增加次数', () => {
    runStore = testRunStore();
    const run = newRun(runStore);
    const { bet, branch } = startBranch(runStore, run, { kind: 'direct' });
    let previous: ReturnType<typeof runStore.writer.recordWatch> | undefined;
    const evidence = Array.from({ length: 22 }, (_, i) => observe(runStore, branch, `测试 ${i}`));
    for (const o of evidence) {
      const input = watchFromArgs({
        standing: '测试通过',
        advice: '',
        directions: [{ id: 'tests', direction: '测试', status: 'works', result: o.summary, evidence: [o.id] }],
      });
      const { draft } = normalizeWatchDraft(previous, input, (id) => runStore.queries.getRecord(id));
      expect(watchSubmissionIssues(previous, draft, (id) => runStore.queries.getRecord(id))).toEqual([]);
      previous = runStore.writer.recordWatch({
        runId: run.id,
        branchId: branch.id,
        basedOnSeq: runStore.queries.lastSeq(),
        toolCalls: 22,
        model: bet.model,
        draft,
      });
      const repeated = normalizeWatchDraft(previous, input, (id) => runStore.queries.getRecord(id));
      expect(repeated.draft.directions[0]!.attempts).toEqual([]);
    }
    expect(previous!.directions[0]!.attempts).toHaveLength(20);
    expect(previous!.directions[0]!.archivedAttempts).toHaveLength(2);
    expect(allWatchAttempts(previous!.directions[0]!).map((a) => a.id)).toEqual(evidence.map((_, i) => `t${i + 1}`));
  });
});
