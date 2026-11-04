// 仿真环境的随机数：同一个种子生成同样的序列；子序列互不影响；区间两头都取得到。

import { describe, expect, it } from 'vitest';
import { deriveSeed, Rng } from '../../sim/kit/rng.ts';

describe('Rng', () => {
  it('同一个种子同样的序列，不同的种子不一样', () => {
    const a = new Rng('x');
    const b = new Rng('x');
    const c = new Rng('y');
    const seqA = Array.from({ length: 20 }, () => a.int(0, 1_000_000));
    const seqB = Array.from({ length: 20 }, () => b.int(0, 1_000_000));
    const seqC = Array.from({ length: 20 }, () => c.int(0, 1_000_000));
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('子序列不受父序列抽了多少的影响', () => {
    const a = new Rng('root');
    const b = new Rng('root');
    b.float();
    b.float();
    expect(a.fork('part').hex(16)).toBe(b.fork('part').hex(16));
    expect(a.fork('part').hex(16)).not.toBe(a.fork('other').hex(16));
  });

  it('int 两头都取得到，不出界', () => {
    const r = new Rng('range');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it('shuffle、sample 不改原数组，sample 不重复', () => {
    const r = new Rng('s');
    const items = [1, 2, 3, 4, 5, 6];
    const shuffled = r.shuffle(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...shuffled].sort()).toEqual(items);
    const picked = r.sample(items, 4);
    expect(new Set(picked).size).toBe(4);
  });

  it('deriveSeed 由几段确定，段落边界分得清', () => {
    expect(deriveSeed('m', 'task', 1)).toBe(deriveSeed('m', 'task', 1));
    expect(deriveSeed('m', 'task', 1)).not.toBe(deriveSeed('m', 'task', 2));
    expect(deriveSeed('ab', 'c')).not.toBe(deriveSeed('a', 'bc'));
    expect(deriveSeed('m', 'task', 1)).toMatch(/^[0-9a-f]{16}$/);
  });
});
