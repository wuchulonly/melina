// 一家配几个 API key：用排在最前面、能用的那个；用不了的到点只放一个调用去试，试探又失败隔得翻倍；
// key 的值换了就当新的。
import { describe, expect, it } from 'vitest';
import { createKeyPool, UNREADABLE_KEY } from '../../../src/models/keys.ts';

const K1 = { id: 'k1', name: '公司账号', key: 'sk-1' };
const K2 = { id: 'k2', key: 'sk-2' };
const K3 = { id: 'k3', key: 'sk-3' };

describe('key 池', () => {
  it('一直用排在最前面的；用不了的跳过，到点只放一个调用去试', () => {
    let now = 0;
    const pool = createKeyPool({ probeIntervalMs: 60_000, now: () => now });
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: false });
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: false }); // 不轮流用
    pool.failure('p', K1, '402：Insufficient Balance');
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K2, probe: false });
    now = 59_999;
    expect(pool.pick('p', [K1, K2])?.key).toBe(K2);
    now = 60_000;
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: true });
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K2, probe: false }); // 已经有一个在试
    pool.success('k1');
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: false });
  });

  it('试探又失败：隔得翻倍，到上限为止（周额度用完的 key 不每分钟撞一次）', () => {
    let now = 0;
    const pool = createKeyPool({ probeIntervalMs: 100, maxProbeIntervalMs: 350, now: () => now });
    /** 到 at 才能试（早一毫秒都不行），试了又失败 */
    const failsAt = (at: number) => {
      now = at - 1;
      expect(pool.pick('p', [K1]), `${at} 以前`).toBeUndefined();
      now = at;
      expect(pool.pick('p', [K1])?.probe, `${at}`).toBe(true);
      pool.failure('p', K1, "403：You've reached your weekly (7-day) usage limit");
    };
    pool.failure('p', K1, "403：You've reached your weekly (7-day) usage limit");
    failsAt(100); // 隔一个周期
    failsAt(300); // 又失败：隔两个周期
    failsAt(650); // 该隔四个周期，到了上限
    failsAt(1000);
  });

  it('一起撞上的在途调用只算一次；试探没有结果（release）不算失败、马上可以再试；通了以后从头算', () => {
    let now = 0;
    const pool = createKeyPool({ probeIntervalMs: 100, now: () => now });
    // 记成用不了以前就在途的三个调用一起撞上额度：只算一次，一个周期后就试
    for (let i = 0; i < 3; i++) pool.failure('p', K1, '402：Insufficient Balance');
    now = 100;
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: true });
    pool.release('k1'); // 被取消、供应商那边出错：交还机会
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: true });
    pool.failure('p', K1, '402：Insufficient Balance'); // 这才是试探又失败：隔两个周期
    now = 299;
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K2, probe: false });
    now = 300;
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: true });
    pool.success('k1');
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: false });
    pool.failure('p', K1, '402：Insufficient Balance'); // 又用不了：从一个周期算起
    now = 399;
    expect(pool.pick('p', [K1, K2])?.key).toBe(K2);
    now = 400;
    expect(pool.pick('p', [K1, K2])).toEqual({ key: K1, probe: true });
  });

  it('key 的值换了、模型页改过（reset）：间隔从头算', () => {
    let now = 0;
    const pool = createKeyPool({ probeIntervalMs: 100, now: () => now });
    pool.failure('p', K1, '402');
    now = 100;
    pool.pick('p', [K1]);
    pool.failure('p', K1, '402'); // 接连失败两次：本该隔两个周期
    const refilled = { ...K1, key: 'sk-1-new' };
    pool.failure('p', refilled, '402'); // 换了值还不行：当新的，一个周期后试
    now = 200;
    expect(pool.pick('p', [refilled])?.probe).toBe(true);
    pool.failure('p', refilled, '402');
    pool.reset('p');
    pool.failure('p', refilled, '402');
    now = 300;
    expect(pool.pick('p', [refilled])?.probe).toBe(true);
  });

  it('skip 跳过这次调用试过的；force（熔断的试探）不看时间；available 只看不占', () => {
    const now = 0;
    const pool = createKeyPool({ probeIntervalMs: 100, now: () => now });
    pool.failure('p', K1, '402');
    pool.failure('p', K2, '402');
    expect(pool.available([K1, K2])).toBe(false);
    expect(pool.pick('p', [K1, K2])).toBeUndefined();
    expect(pool.available([K1, K2], { force: true })).toBe(true);
    expect(pool.available([K1, K2], { force: true, skip: new Set(['k1', 'k2']) })).toBe(false);
    expect(pool.pick('p', [K1, K2], { force: true, skip: new Set(['k1']) })).toEqual({ key: K2, probe: true });
    expect(pool.reason('k1')).toBe('402');
    expect(pool.reason('k3')).toBeUndefined();
  });

  it('key 的值换了（人在模型页重新填了）就当新的', () => {
    const pool = createKeyPool({ now: () => 0 });
    pool.failure('p', K1, '402');
    expect(pool.pick('p', [K1, K2])?.key).toBe(K2);
    const refilled = { ...K1, key: 'sk-1-new' };
    expect(pool.pick('p', [refilled, K2])).toEqual({ key: refilled, probe: false });
  });

  it('状况：第一个能用的在用，其余能用的备用，用不了的写原因；解不开的算用不了', () => {
    const pool = createKeyPool({ now: () => 0 });
    pool.failure('p', K1, '402：Insufficient Balance');
    const listed = [
      { id: 'k1', name: '公司账号', hasKey: true },
      { id: 'k2', hasKey: true },
      { id: 'k4', name: '旧的', hasKey: false },
      { id: 'k3', hasKey: true },
    ];
    expect(pool.status(listed, [K1, K2, K3])).toEqual([
      { id: 'k1', name: '公司账号', state: 'down', reason: '402：Insufficient Balance' },
      { id: 'k2', state: 'active' },
      { id: 'k4', name: '旧的', state: 'down', reason: UNREADABLE_KEY },
      { id: 'k3', state: 'standby' },
    ]);
  });

  it('reset 清掉一家或所有家；状态变了就通知', () => {
    const pool = createKeyPool({ now: () => 0 });
    const seen: string[] = [];
    const off = pool.onChange((p) => seen.push(p));
    pool.failure('a', K1, '402');
    pool.failure('b', K2, '402');
    pool.reset('a');
    expect(pool.reason('k1')).toBeUndefined();
    expect(pool.reason('k2')).toBe('402');
    pool.reset();
    expect(pool.reason('k2')).toBeUndefined();
    off();
    pool.failure('a', K1, '402');
    expect(seen).toEqual(['a', 'b', 'a', 'b']);
  });
});
