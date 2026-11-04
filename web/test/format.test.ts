// 数字和时间的写法（src/lib/format.ts）、柱状图的刻度（DailyBars）、路由匹配（router）。

import { describe, expect, it } from 'vitest';
import { matchPath } from '../src/app/router.tsx';
import {
  baseName,
  formatBytes,
  formatDateTime,
  formatDay,
  formatDuration,
  formatRelative,
  formatTokens,
  formatUsd,
  splitReading,
  totalTokens,
} from '../src/lib/format.ts';
import { runStatusLook, workspaceLabel } from '../src/lib/labels.ts';
import { dayLabel, niceTicks } from '../src/pages/overview/DailyBars.tsx';
import { lastDays } from '../src/pages/overview/Usage.tsx';

describe('数字', () => {
  it('token：上万用「万」，上亿用「亿」', () => {
    expect(formatTokens(8532)).toBe('8,532');
    expect(formatTokens(142_400)).toBe('14.2 万');
    expect(formatTokens(6_848_000)).toBe('685 万');
    expect(formatTokens(100_000)).toBe('10 万');
    expect(formatTokens(124_000_000)).toBe('1.24 亿');
  });

  it('token 一共：输入、缓存命中、缓存写入、输出加起来', () => {
    expect(totalTokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, usd: 0 })).toBe(10);
  });

  it('费用', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(27.4)).toBe('$27.40');
    expect(formatUsd(1204.5)).toBe('$1,205');
  });

  it('磁盘', () => {
    expect(formatBytes(120 * 1024 ** 3)).toBe('120 GB');
    expect(formatBytes(7.25 * 1024 ** 3)).toBe('7.3 GB');
    expect(formatBytes(980 * 1024 ** 2)).toBe('980 MB');
  });

  it('读数拆成符号、数字、单位，拼回去和原文一样', () => {
    const join = (p: ReturnType<typeof splitReading>) => (p ? `${p.pre}${p.num}${p.gap}${p.unit}` : null);
    expect(splitReading('$27.40')).toEqual({ pre: '$', num: '27.40', gap: '', unit: '' });
    expect(splitReading('<$0.01')).toEqual({ pre: '<$', num: '0.01', gap: '', unit: '' });
    expect(splitReading('$1,205')).toEqual({ pre: '$', num: '1,205', gap: '', unit: '' });
    expect(splitReading('685 万')).toEqual({ pre: '', num: '685', gap: ' ', unit: '万' });
    expect(splitReading('1.24 亿')).toEqual({ pre: '', num: '1.24', gap: ' ', unit: '亿' });
    expect(splitReading('455 ms')).toEqual({ pre: '', num: '455', gap: ' ', unit: 'ms' });
    expect(splitReading('82%')).toEqual({ pre: '', num: '82', gap: '', unit: '%' });
    expect(splitReading('-5 个')).toEqual({ pre: '', num: '-5', gap: ' ', unit: '个' });
    expect(splitReading('120 GB')).toEqual({ pre: '', num: '120', gap: ' ', unit: 'GB' });
    expect(splitReading('8,532')).toEqual({ pre: '', num: '8,532', gap: '', unit: '' });
    for (const s of ['$27.40', '<$0.01', '685 万', '82%', '455 ms', '0.1235 req/s'])
      expect(join(splitReading(s))).toBe(s);
    // 不是一个读数的照原样写
    expect(splitReading('—')).toBeNull();
    expect(splitReading('不到 1 分钟')).toBeNull();
    expect(splitReading('1 小时 9 分')).toBeNull();
    expect(splitReading('')).toBeNull();
  });
});

describe('时间', () => {
  const now = new Date(2026, 9, 2, 14, 30).getTime();

  it('相对时间', () => {
    expect(formatRelative(new Date(now - 20_000).toISOString(), now)).toBe('刚刚');
    expect(formatRelative(new Date(now - 3.6 * 60_000).toISOString(), now)).toBe('3 分钟前');
    expect(formatRelative(new Date(now - 2.5 * 3_600_000).toISOString(), now)).toBe('2 小时前');
    expect(formatRelative(new Date(2026, 9, 1, 9, 5).toISOString(), now)).toBe('昨天 09:05');
    expect(formatRelative(new Date(2026, 8, 28, 2, 10).toISOString(), now)).toBe('9月28日 02:10');
    expect(formatRelative(new Date(now + 40_000).toISOString(), now)).toBe('40 秒后');
  });

  it('不是今年的带年份', () => {
    expect(formatDateTime(new Date(2025, 0, 3, 8, 0).toISOString(), now)).toBe('2025年1月3日 08:00');
  });

  it('只写哪一天（时间线里换了一天时用）', () => {
    expect(formatDay(new Date(2026, 9, 2, 0, 5).toISOString(), now)).toBe('今天');
    expect(formatDay(new Date(2026, 9, 1, 23, 59).toISOString(), now)).toBe('昨天');
    expect(formatDay(new Date(2026, 8, 28, 2, 10).toISOString(), now)).toBe('9月28日');
    expect(formatDay(new Date(2025, 0, 3, 8, 0).toISOString(), now)).toBe('2025年1月3日');
    expect(formatDay('不是时间', now)).toBe('—');
  });

  it('时长', () => {
    expect(formatDuration(30_000)).toBe('不到 1 分钟');
    expect(formatDuration(12 * 60_000)).toBe('12 分钟');
    expect(formatDuration(72 * 60_000)).toBe('1 小时 12 分');
    expect(formatDuration(51 * 3_600_000)).toBe('2 天 3 小时');
  });
});

describe('柱状图', () => {
  it('刻度取整齐的数，最上面一格盖住最大值', () => {
    expect(niceTicks(15.1)).toEqual([0, 10, 20]);
    expect(niceTicks(3.3)).toEqual([0, 2, 4]);
    expect(niceTicks(0)).toEqual([0, 1]);
    const t = niceTicks(0.37);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBeGreaterThanOrEqual(0.37);
  });

  it('最近 n 天，以今天结尾，没有记录的补 0', () => {
    const now = new Date(2026, 9, 2, 12).getTime();
    const days = lastDays([{ day: '2026-10-01', input: 1, cacheRead: 0, cacheWrite: 0, output: 1, usd: 1.6 }], 3, now);
    expect(days).toEqual([
      { day: '2026-09-30', usd: 0, tokens: 0 },
      { day: '2026-10-01', usd: 1.6, tokens: 2 },
      { day: '2026-10-02', usd: 0, tokens: 0 },
    ]);
    expect(dayLabel('2026-10-02', '2026-10-02')).toBe('今天');
    expect(dayLabel('2026-09-28', '2026-10-02')).toBe('9/28');
  });
});

describe('路由和叫法', () => {
  it('matchPath', () => {
    expect(matchPath('/runs/:id/*', '/runs/abc')).toEqual({ id: 'abc', '*': '' });
    expect(matchPath('/runs/:id/*', '/runs/abc/result')).toEqual({ id: 'abc', '*': 'result' });
    expect(matchPath('/runs/:id', '/runs')).toBeNull();
    expect(matchPath('/models', '/settings')).toBeNull();
  });

  it('收尾中单独说', () => {
    expect(runStatusLook('running', 'settling').label).toBe('收尾中');
    expect(runStatusLook('running', 'direct').label).toBe('进行中');
    // 放弃了是灰的，和页头横幅、终点卡一样；琥珀色只留给需要你的事
    expect(runStatusLook('failed', 'direct').tone).toBe('red');
  });

  it('baseName', () => {
    expect(baseName('/home/me/shop-api')).toBe('shop-api');
    expect(baseName('/home/me/shop-api/')).toBe('shop-api');
  });

  it('新建的空目录按最后一段是 ULID 认，接着做沿用的也认得出', () => {
    expect(workspaceLabel('/home/me/.melina/workspaces/01M3QX6NM02CYR3D4N05G3GPFX')).toBe('新建的空目录');
    expect(workspaceLabel('/home/me/shop-api')).toBe('shop-api');
  });
});
