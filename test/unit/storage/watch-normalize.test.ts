import { describe, expect, it } from 'vitest';
import type { StoreRecord } from '../../../src/core/interfaces/store.ts';
import { type SubmitWatchInput, watchFromArgs } from '../../../src/core/tools.ts';
import { WATCH_INPUT } from '../../../src/core/watch-input.ts';
import { projectWatchMap } from '../../../src/core/watch-map.ts';
import {
  allWatchAttempts,
  mergeWatch,
  normalizeWatchDraft,
  validateWatchDraft,
  watchSubmissionIssues,
} from '../../../src/projections/watch.ts';

const input = (directions: NonNullable<SubmitWatchInput['directions']>) =>
  watchFromArgs({ standing: '核对结果', advice: '', directions });
const direction = {
  id: 'route',
  direction: '验证输入',
  status: 'works' as const,
  result: '执行完成',
  evidence: [] as string[],
};
const recordOf = (id: string) =>
  id.startsWith('o')
    ? ({ kind: 'observation', record: { id, seq: Number(id.slice(1)), role: 'explorer', tool: 'sh' } } as StoreRecord)
    : undefined;
function accept(previous: Parameters<typeof normalizeWatchDraft>[0], draft: ReturnType<typeof input>) {
  const normalized = normalizeWatchDraft(previous, draft, recordOf);
  expect(watchSubmissionIssues(previous, normalized.draft, recordOf)).toEqual([]);
  return { ...normalized, body: mergeWatch(previous, normalized.draft) };
}

describe('一层证据与宿主尝试记录', () => {
  it('未试备选与已试方向都增量保留；空更新不退休，退休与恢复须显式指定', () => {
    const idea = { ...direction, status: 'untried' as const, result: '有线索，值得尝试' };
    const first = accept(
      undefined,
      input([
        { ...direction, id: 'tried', evidence: ['o1'] },
        { ...idea, id: 'stale' },
        { ...idea, id: 'keep' },
        { ...idea, id: 'tested' },
        { ...direction, id: 'unknown', status: 'unclear' },
      ]),
    ).body;
    const original = structuredClone(first);
    const second = accept(
      first,
      input([
        { ...idea, id: 'keep' },
        { ...direction, id: 'tested', evidence: ['o2'] },
      ]),
    ).body;
    expect(first).toEqual(original);
    expect(second.directions.find((d) => d.id === 'stale')).toEqual(first.directions[1]);
    expect(second.directions.find((d) => d.id === 'unknown')).toEqual(first.directions[4]);
    expect(projectWatchMap(second).angles.map((d) => d.id)).toEqual(['stale', 'keep']);
    expect(projectWatchMap(second).confirmed.map((d) => d.id)).toEqual(['tried', 'tested']);
    expect(second.directions.find((d) => d.id === 'tested')!.attempts).toMatchObject([{ evidence: ['o2'] }]);
    expect(accept(second, input([])).body.directions).toEqual(second.directions);
    const retired = accept(second, input([{ ...idea, id: 'stale', retired: true }])).body;
    const stillRetired = accept(retired, input([{ ...idea, id: 'stale' }])).body;
    expect(projectWatchMap(stillRetired).angles.map((d) => d.id)).toEqual(['keep']);
    const restored = accept(stillRetired, input([{ ...idea, id: 'stale', retired: false }])).body;
    expect(projectWatchMap(restored).angles.map((d) => d.id)).toEqual(['stale', 'keep']);
  });

  it.each(['trying', 'works', 'failed', 'unclear'] as const)('%s 自动保存执行结果，不复制判断材料', (status) => {
    const submitted = input([{ ...direction, status, evidence: ['input', 'o1', 'o1'] }]);
    const original = structuredClone(submitted);
    const first = accept(undefined, submitted);
    expect(first.body.directions[0]).toMatchObject({
      status,
      evidence: ['input', 'o1'],
      attempts: [{ id: 't1', action: direction.direction, result: direction.result, evidence: ['o1'] }],
    });
    expect(first.warnings).toEqual([]);
    expect(submitted).toEqual(original);
    expect(accept(first.body, submitted).body.directions).toEqual(first.body.directions);
    expect(accept(undefined, first.draft).draft).toEqual(first.draft);
    expect(projectWatchMap(first.body).confirmed.map((d) => d.id)).toEqual(['route']);
  });

  it('结论改写或证据重排不增加次数；新执行依据保存新的结果快照', () => {
    const first = accept(undefined, input([{ ...direction, evidence: ['o1', 'o2'] }])).body;
    const rewritten = accept(first, input([{ ...direction, result: '修订结论', evidence: ['o2', 'o1'] }])).body;
    expect(allWatchAttempts(rewritten.directions[0]!)).toEqual(allWatchAttempts(first.directions[0]!));
    expect(rewritten.directions[0]!.result).toBe('修订结论');
    const next = accept(rewritten, input([{ ...direction, evidence: ['o1', 'o3'] }])).body;
    expect(next.directions[0]!.attempts.at(-1)).toMatchObject({ id: 't2', evidence: ['o3'] });
  });

  it('跨轮自动编号并归档，重提旧证据不新增，原版保持不变', () => {
    let current: Parameters<typeof accept>[0];
    for (let i = 1; i <= 25; i++) current = accept(current, input([{ ...direction, evidence: [`o${i}`] }])).body;
    const first = current!;
    expect(first.directions[0]!.attempts).toHaveLength(20);
    expect(first.directions[0]!.archivedAttempts).toHaveLength(5);
    expect(first.directions[0]!.attempts[0]!.id).toBe('t6');
    const next = accept(first, input([{ ...direction, evidence: ['o1', 'o25', 'o26'] }])).body;
    expect(allWatchAttempts(next.directions[0]!)).toHaveLength(26);
    expect(next.directions[0]!.attempts.at(-1)).toMatchObject({ id: 't26', evidence: ['o26'] });
    expect(allWatchAttempts(first.directions[0]!)).toHaveLength(25);
    expect(allWatchAttempts(accept(next, input([{ ...direction, evidence: ['o26'] }])).body.directions[0]!)).toEqual(
      allWatchAttempts(next.directions[0]!),
    );
  });

  it('活跃方向自动入图，已试改为 untried 仍保留在 CONFIRMED，退休与恢复显式控制', () => {
    const first = accept(
      undefined,
      input([
        ...Array.from({ length: 10 }, (_, i) => ({ ...direction, id: `tried${i}`, evidence: [`o${i}`] })),
        ...Array.from({ length: 6 }, (_, i) => ({
          ...direction,
          id: `idea${i}`,
          status: 'untried' as const,
          priority: (i % 4) + 1,
        })),
      ]),
    ).body;
    expect(projectWatchMap(first).confirmed).toHaveLength(8);
    expect(projectWatchMap(first).angles.map((d) => d.id)).toEqual(['idea0', 'idea4', 'idea1', 'idea5']);
    const changed = accept(first, input([{ ...direction, id: 'tried0', status: 'untried', priority: 1 }]));
    expect(changed.body.directions[0]!.status).toBe('unclear');
    expect(projectWatchMap(changed.body).confirmed.map((d) => d.id)).toContain('tried0');
    expect(projectWatchMap(changed.body).angles.map((d) => d.id)).not.toContain('tried0');
    const retired = accept(first, input([{ ...direction, id: 'tried0', retired: true }])).body;
    expect(retired.directions[0]).toMatchObject({ retired: true, status: 'works' });
    expect(projectWatchMap(retired).confirmed.map((d) => d.id)).not.toContain('tried0');
    expect(accept(retired, input([{ ...direction, id: 'tried0' }])).body.directions[0]!.retired).toBe(true);
    const restored = accept(retired, input([{ ...direction, id: 'tried0', retired: false }])).body;
    expect(projectWatchMap(restored).confirmed.map((d) => d.id)).toContain('tried0');
    const retiredIdea = accept(first, input([{ ...direction, id: 'idea0', status: 'untried', retired: true }])).body;
    expect(projectWatchMap(retiredIdea).angles.map((d) => d.id)).not.toContain('idea0');
  });

  it('已有尝试全在归档中时仍算已试，新记录编号连续', () => {
    const old = accept(undefined, input([{ ...direction, evidence: ['o1'] }])).body;
    old.directions[0]!.archivedAttempts = old.directions[0]!.attempts;
    old.directions[0]!.attempts = [];
    // 兼容历史数据：即使旧状态为 untried，归档中的真实尝试也不能随遗漏退休。
    old.directions[0]!.status = 'untried';
    expect(accept(old, input([])).body.directions[0]).toEqual(old.directions[0]);
    expect(projectWatchMap(old).confirmed.map((d) => d.id)).toEqual(['route']);
    const next = accept(old, input([{ ...direction, evidence: ['o2'] }])).body;
    expect(allWatchAttempts(next.directions[0]!).map((a) => a.id)).toEqual(['t1', 't2']);
  });

  it('无执行依据的 trying 保留描述与疑点，无法确认执行不入备选', () => {
    const submitted = input([{ ...direction, status: 'trying', result: '命令正在运行，尚无结果', doubt: '等待返回' }]);
    const normalized = normalizeWatchDraft(undefined, submitted, recordOf);
    expect(normalized.draft.directions[0]).toMatchObject({
      status: 'unclear',
      result: '命令正在运行，尚无结果',
      doubt: '等待返回',
      attempts: [],
    });
    expect(normalized.warnings).toEqual([expect.stringContaining('trying 已修正为 unclear')]);
    expect(watchSubmissionIssues(undefined, normalized.draft, recordOf)).toEqual([]);
    expect(projectWatchMap(mergeWatch(undefined, normalized.draft))).toEqual({ confirmed: [], angles: [] });
  });

  it('冻结执行证据可直接引用，未知引用退回且不自动改写无据结论', () => {
    const records = new Map<string, StoreRecord>([
      ['o1', recordOf('o1')!],
      ['o2', recordOf('o2')!],
      ['input', { kind: 'input', record: { id: 'input', seq: 3, text: '人的判断' } } as StoreRecord],
      [
        'speech',
        { kind: 'observation', record: { id: 'speech', role: 'explorer', tool: WATCH_INPUT.speech } } as StoreRecord,
      ],
    ]);
    const validate = (submitted: ReturnType<typeof input>) =>
      validateWatchDraft(undefined, submitted, {
        records,
        resolve: (id) => id,
      });
    for (const evidence of [['input'], ['speech']]) {
      const checked = validate(input([{ ...direction, evidence }]));
      expect(checked.draft.directions[0]!.attempts).toEqual([]);
      expect(checked.errors).toEqual([expect.stringContaining('至少一次尝试')]);
    }
    expect(validate(input([{ ...direction, evidence: ['missing'] }])).errors).toContainEqual(
      expect.stringContaining('missing 不在本轮可见证据中'),
    );
    const unread = validate(input([{ ...direction, evidence: ['o1', 'o2'] }]));
    expect(unread.draft.directions[0]).toMatchObject({ status: 'works', attempts: [{ evidence: ['o1', 'o2'] }] });
    expect(unread.warnings).toEqual([]);
    const fresh = validate(input([{ ...direction, result: '据说已完成' }]));
    expect(fresh.errors).toEqual([expect.stringContaining('至少一次尝试')]);
    expect(fresh.draft.directions[0]).toMatchObject({
      status: 'works',
      attempts: [],
      result: '据说已完成',
    });
  });
});
