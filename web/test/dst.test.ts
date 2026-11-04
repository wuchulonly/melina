// 最近 14 天按日历往回数：夏令时结束那天有 25 个小时，按 24 小时往回减会把某一天算两遍。
// 用美国西部时间测（2026-11-01 夏令时结束）；vitest 每个测试文件在自己的进程里跑，改 TZ 不影响别的文件。

process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { lastDays } from '../src/pages/overview/Usage.tsx';

describe('最近几天', () => {
  it('跨过夏令时结束那天，日期不重复也不跳', () => {
    const now = new Date(2026, 10, 8, 23, 30).getTime(); // 11 月 8 日晚上 11 点半
    const days = lastDays([], 14, now).map((d) => d.day);
    expect(new Set(days).size).toBe(14);
    expect(days[0]).toBe('2026-10-26');
    expect(days.at(-1)).toBe('2026-11-08');
  });

  it('夏令时开始那天也一样', () => {
    const now = new Date(2026, 2, 9, 0, 30).getTime(); // 3 月 9 日凌晨
    const days = lastDays([], 3, now).map((d) => d.day);
    expect(days).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
  });
});
