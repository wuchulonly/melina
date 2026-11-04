// 接着跑时哪些世界算跑完。

import { describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '../../../src/core/events.ts';
import { completeWorlds } from '../../eval/results.ts';
import type { TrialResult } from '../../eval/trial.ts';

function trial(over: Partial<TrialResult>): TrialResult {
  return {
    task: 'code-x',
    env: 'code',
    difficulty: 'hard',
    contender: 'melina',
    rep: 0,
    seed: 's',
    status: 'done',
    submitted: true,
    delivered: true,
    checkPass: true,
    checkSummary: '',
    tokens: 0,
    usage: ZERO_USAGE,
    wallMs: 1,
    routes: 1,
    branches: 1,
    attempts: 1,
    runIds: [],
    envRequests: 0,
    startedAt: '2026-10-12T00:00:00Z',
    ...over,
  };
}

const sides = ['melina', 'baseline'];

describe('completeWorlds', () => {
  it('几方都有同一批的有效结果才算跑完', () => {
    const results = [
      trial({ contender: 'melina', rep: 0, batch: 'b1' }),
      trial({ contender: 'baseline', rep: 0, batch: 'b1' }),
      // 缺一方
      trial({ contender: 'melina', rep: 1, batch: 'b1' }),
      // 一方是跑分出错
      trial({ contender: 'melina', rep: 2, batch: 'b1' }),
      trial({ contender: 'baseline', rep: 2, batch: 'b1', status: 'error' }),
    ];
    expect([...completeWorlds(results, sides)]).toEqual(['code-x|0']);
  });

  it('整组重跑到一半被打断：Melina 是新一批、基线还是旧一批，这组还要整组重跑', () => {
    const results = [
      trial({ contender: 'melina', rep: 0, batch: 'b1', status: 'error' }),
      trial({ contender: 'baseline', rep: 0, batch: 'b1' }),
      trial({ contender: 'melina', rep: 0, batch: 'b2' }), // 第二批只跑完了 Melina，基线那次被 Ctrl-C 打断、没记
    ];
    expect(completeWorlds(results, sides).size).toBe(0);
    // 第三批整组重跑完：取最后一次，两边同一批
    const rerun = [
      ...results,
      trial({ contender: 'melina', rep: 0, batch: 'b3' }),
      trial({ contender: 'baseline', rep: 0, batch: 'b3' }),
    ];
    expect([...completeWorlds(rerun, sides)]).toEqual(['code-x|0']);
  });

  it('历史结果没有批次：两边都缺省时算同批；新旧混合时不算', () => {
    const old = [trial({ contender: 'melina' }), trial({ contender: 'baseline' })];
    expect(completeWorlds(old, sides).size).toBe(1);
    expect(
      completeWorlds([trial({ contender: 'melina' }), trial({ contender: 'baseline', batch: 'b1' })], sides).size,
    ).toBe(0);
  });
});
