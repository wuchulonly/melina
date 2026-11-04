import { afterEach, describe, expect, it } from 'vitest';
import type { SemanticDigest } from '../../../src/core/telemetry.ts';
import { watchFromArgs } from '../../../src/core/tools.ts';
import {
  allWatchAttempts,
  mergeWatch,
  normalizeWatchDraft,
  validateWatchDraft,
} from '../../../src/projections/watch.ts';
import { newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

let runStore: TestRunStore;
afterEach(() => runStore?.close());
const direction = { id: 'content-discovery', direction: '内容发现', status: 'works' as const, result: '发现内容' };
const input = (evidence: string[]) =>
  watchFromArgs({ standing: '核对内容发现', advice: '', directions: [{ ...direction, evidence }] });
const telemetry = (evidence: string[]): SemanticDigest => ({
  stage: 'verification',
  trajectory: 'advancing',
  bottleneck: 'none',
  confidence: 0.8,
  evidence,
});
function setup() {
  runStore = testRunStore();
  const run = newRun(runStore);
  const { branch } = startBranch(runStore, run, { kind: 'direct' });
  const observations = Array.from({ length: 4 }, (_, i) => observe(runStore, branch, `探测 ${i}`));
  const humanInput = runStore.writer.recordHumanInput({ runId: run.id, text: '内容发现的判断材料' }).input;
  const records = new Map([...observations, humanInput].map((r) => [r.id, runStore.queries.getRecord(r.id)!]));
  const refs = new Map(['o310684', 'o310811', 'o311667', 'o311690'].map((ref, i) => [ref, observations[i]!.id]));
  const resolve = (ref: string) => refs.get(ref) ?? ref;
  const window = { records, resolve };
  const previous = mergeWatch(
    undefined,
    normalizeWatchDraft(undefined, input(['o310684', 'o310811'].map(resolve)), (id) => records.get(id)).draft,
  );
  return { window, previous, humanInput };
}

describe('Watcher 一层证据校验', () => {
  it.each([
    { phase: '首次提交', attempts: 1, closing: false },
    { phase: '重试', attempts: 2, closing: false },
    { phase: '收尾', attempts: 1, closing: true },
  ])('$phase 保留有效证据，笔误告警，历史尝试自动继承', (phase) => {
    const { window, previous } = setup();
    const original = structuredClone(previous);
    const submitted = input(['o310684', 'o311811', 'o311667', 'o311690']);
    const checked = validateWatchDraft(previous, submitted, { ...window, ...phase });
    expect(checked.errors).toEqual([]);
    expect(checked.warnings).toEqual([expect.stringContaining('方向 content-discovery 的证据 o311811')]);
    expect(mergeWatch(previous, checked.draft).directions[0]).toMatchObject({
      status: 'works',
      evidence: ['o310684', 'o311667', 'o311690'].map(window.resolve),
      attempts: [
        { id: 't1', evidence: ['o310684', 'o310811'].map(window.resolve) },
        { id: 't2', evidence: ['o311667', 'o311690'].map(window.resolve) },
      ],
    });
    expect(previous).toEqual(original);
    expect(submitted.directions[0]!.evidence).toContain('o311811');
  });
  it('过滤笔误后去重，跨轮重试不重复保存；辅助材料只留在方向依据中', () => {
    const { window, previous, humanInput } = setup();
    const submitted = input([humanInput.id, 'o311811', 'o311667']);
    const checked = validateWatchDraft(previous, submitted, window);
    expect(checked.errors).toEqual([]);
    expect(checked.draft.directions[0]).toMatchObject({
      evidence: [humanInput.id, window.resolve('o311667')],
      attempts: [{ evidence: [window.resolve('o311667')] }],
    });
    const merged = mergeWatch(previous, checked.draft);
    expect(allWatchAttempts(merged.directions[0]!)).toHaveLength(2);
    const replay = validateWatchDraft(merged, submitted, window);
    expect(replay.errors).toEqual([]);
    expect(mergeWatch(merged, replay.draft).directions).toEqual(merged.directions);
  });
  it('没有有效执行依据时不容错未知引用', () => {
    const { window, previous, humanInput } = setup();
    for (const evidence of [['o311811'], [humanInput.id, 'o311811']]) {
      const checked = validateWatchDraft(previous, input(evidence), window);
      expect(checked.errors).toContainEqual(expect.stringContaining('o311811 不在本轮可见证据中'));
    }
  });
  it('冻结证据无需原文覆盖证明，更新与备选同时保留', () => {
    const { window, previous } = setup();
    const submitted = input(['o311667', 'o311690']);
    submitted.directions.push({
      id: 'next',
      direction: '检查备选',
      status: 'untried',
      result: '有线索',
      evidence: [],
      attempts: [],
    });
    const checked = validateWatchDraft(previous, submitted, window);
    expect(checked.errors).toEqual([]);
    expect(checked.draft.directions.map((d) => d.id)).toEqual(['content-discovery', 'next']);
    const merged = mergeWatch(previous, checked.draft);
    expect(allWatchAttempts(merged.directions[0]!)).toHaveLength(2);
    expect(merged.directions[1]!.id).toBe('next');
  });
  it('telemetry 的未知引用过滤、空报告省略，冻结证据直接接受', () => {
    const { window, previous } = setup();
    const checked = validateWatchDraft(
      previous,
      { ...input([]), telemetry: telemetry(['o311667', 'unknown']) },
      window,
    );
    expect(checked.errors).toEqual([]);
    expect(checked.draft.telemetry?.evidence).toEqual([window.resolve('o311667')]);
    const empty = validateWatchDraft(previous, { ...input([]), telemetry: telemetry(['unknown']) }, window);
    expect(empty.errors).toEqual([]);
    expect(empty.draft.telemetry).toBeUndefined();
    const unread = validateWatchDraft(previous, { ...input([]), telemetry: telemetry(['o311690']) }, window);
    expect(unread.errors).toEqual([]);
    expect(unread.draft.telemetry?.evidence).toEqual([window.resolve('o311690')]);
    expect(unread.warnings).toEqual([]);
  });
});
