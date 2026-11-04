// 交付最近一次挑中的阶段版，未挑选时取最先保存的版本。
import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../../src/core/types.ts';
import { currentVersion } from '../../../src/projections/versions.ts';
import { MODEL } from './kit.ts';

let seq = 0;
/** 建立一条按保存顺序编号的候选。 */
function candidate(interim = true): Candidate {
  seq++;
  return {
    id: `c${seq}`,
    runId: 'r',
    seq,
    branchId: 'b',
    snapshot: `s${seq}`,
    claim: `第 ${seq} 版`,
    ...(interim ? { interim: true } : {}),
  };
}
const pick = (c: Candidate, versions: readonly Candidate[]) => ({
  candidateId: c.id,
  model: MODEL,
  basedOnSeq: 0,
  why: '当前版本更完整',
  versions: versions.map((v) => v.id),
});
describe('currentVersion', () => {
  it('没挑过：交付最先保存的那一版', () => {
    const first = candidate();
    const bold = candidate();
    expect(currentVersion([first, bold], [])?.id).toBe(first.id);
  });
  it('挑过：最近一次挑中的那一版，不看先后、不看自报', () => {
    const a = candidate();
    const b = candidate();
    const c = candidate();
    expect(currentVersion([a, b, c], [pick(c, [a, b, c])])?.id).toBe(c.id);
    expect(currentVersion([a, b, c], [pick(c, [a, b]), pick(b, [a, b, c])])?.id).toBe(b.id);
  });
  it('挑中之后又存了阶段版、还没再挑（以前的 Run 跑着时挑过）：还是挑中的那一版', () => {
    const a = candidate();
    const b = candidate();
    const c = candidate();
    expect(currentVersion([a, b, c], [pick(a, [a, b])])?.id).toBe(a.id);
  });
  it('收尾交的候选不算一版；没交过一版就没有', () => {
    expect(currentVersion([candidate(false)], [])).toBeUndefined();
    expect(currentVersion([], [])).toBeUndefined();
  });
});
