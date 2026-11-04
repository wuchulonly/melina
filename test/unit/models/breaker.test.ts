// 供应商熔断：熔断、每分钟试一次、通了恢复、换备用的显示。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBreaker } from '../../../src/models/breaker.ts';

const B1 = { provider: 'b', model: 'b-1', tier: 'strong' as const };

describe('熔断器', () => {
  it('没出过错是 ok；熔断后到试探时间只放一个调用去试', () => {
    let now = 1000;
    const breaker = createBreaker({ probeIntervalMs: 60_000, now: () => now });
    expect(breaker.gate('a')).toBe('ok');
    breaker.failure('a', '503：Service Unavailable（重试 3 次仍不行）');
    expect(breaker.gate('a')).toBe('open');
    expect(breaker.isOpen('a')).toBe(true);
    now += 59_999;
    expect(breaker.gate('a')).toBe('open');
    now += 1;
    expect(breaker.gate('a')).toBe('probe');
    expect(breaker.gate('a')).toBe('open'); // 已经有一个在试
    expect(breaker.status(['a'])[0]).toMatchObject({ breaker: 'probing', reason: expect.stringContaining('503') });
  });

  it('试探成功就恢复；失败就再等一个周期', () => {
    let now = 0;
    const breaker = createBreaker({ probeIntervalMs: 100, now: () => now });
    breaker.failure('a', '401：API key 无效');
    now = 100;
    expect(breaker.gate('a')).toBe('probe');
    breaker.failure('a', '401：API key 无效');
    expect(breaker.gate('a')).toBe('open');
    now = 200;
    expect(breaker.gate('a')).toBe('probe');
    breaker.success('a');
    expect(breaker.gate('a')).toBe('ok');
    expect(breaker.status(['a'])).toEqual([{ provider: 'a', breaker: 'ok' }]);
  });

  it('试探的调用被取消没有结果：交还机会，别的调用马上可以试', () => {
    let now = 0;
    const breaker = createBreaker({ probeIntervalMs: 100, now: () => now });
    breaker.failure('a', '连不上');
    now = 100;
    expect(breaker.gate('a')).toBe('probe');
    breaker.release('a');
    expect(breaker.gate('a')).toBe('probe');
  });

  // 计时的两条用假时钟（createBreaker 在换钟之后建，拿到的 Date.now 是假的）：按真实时钟写时机器一忙就偶尔挂
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wait：到试探时间醒来，状态变化时醒来，取消时抛错', async () => {
    vi.useFakeTimers();
    const breaker = createBreaker({ probeIntervalMs: 30 });
    breaker.failure('a', '连不上');
    let woke = false;
    const due = breaker.wait('a').then(() => {
      woke = true;
    });
    await vi.advanceTimersByTimeAsync(29);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await due;
    expect(breaker.gate('a')).toBe('probe');

    const waiting = breaker.wait('a'); // 正在试探：等它的结果
    setTimeout(() => breaker.success('a'), 5);
    await vi.advanceTimersByTimeAsync(5);
    await waiting;
    expect(breaker.gate('a')).toBe('ok');

    breaker.failure('a', '连不上');
    const controller = new AbortController();
    const aborted = breaker.wait('a', controller.signal);
    controller.abort('kill');
    await expect(aborted).rejects.toThrow('kill');
  });

  it('ready 只看不占：到了试探时间是 due，有人在试是 wait', () => {
    let now = 0;
    const breaker = createBreaker({ probeIntervalMs: 100, now: () => now });
    expect(breaker.ready('a')).toBe('ok');
    breaker.failure('a', '连不上');
    expect(breaker.ready('a')).toBe('wait');
    now = 100;
    expect(breaker.ready('a')).toBe('due');
    expect(breaker.ready('a')).toBe('due');
    expect(breaker.gate('a')).toBe('probe');
    expect(breaker.ready('a')).toBe('wait');
  });

  it('占了试探机会的调用一直不回报：超过 probeTimeoutMs 再放一个去试', () => {
    let now = 0;
    const breaker = createBreaker({ probeIntervalMs: 100, probeTimeoutMs: 1000, now: () => now });
    breaker.failure('a', '连不上');
    now = 100;
    expect(breaker.gate('a')).toBe('probe');
    now = 1099;
    expect(breaker.gate('a')).toBe('open');
    now = 1100;
    expect(breaker.gate('a')).toBe('probe');
  });

  it('wait 可以同时等几家：任何一家到了试探时间就醒', async () => {
    vi.useFakeTimers();
    const breaker = createBreaker({ probeIntervalMs: 200 });
    breaker.failure('a', '连不上');
    await vi.advanceTimersByTimeAsync(150);
    breaker.failure('b', '连不上'); // b 晚熔断，a 先到时间
    let woke = false;
    const waiting = breaker.wait(['b', 'a']).then(() => {
      woke = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // a 在 200 毫秒时到试探时间，b 要到 350
    await waiting;
    expect(breaker.ready('a')).toBe('due');
    expect(breaker.ready('b')).toBe('wait');
  });

  it('换备用的模型记在状态里；reset 清掉；状态变化通知监听方', () => {
    const breaker = createBreaker();
    const changes: string[] = [];
    const off = breaker.onChange((p) => changes.push(p));
    breaker.failure('a', '余额不足');
    breaker.noteFallback('a', B1);
    breaker.noteFallback('a', B1); // 没变不通知
    expect(breaker.status(['a', 'b'])).toEqual([
      { provider: 'a', breaker: 'open', reason: '余额不足', fallbackTo: B1 },
      { provider: 'b', breaker: 'ok' },
    ]);
    breaker.reset();
    expect(breaker.gate('a')).toBe('ok');
    off();
    breaker.failure('a', 'x');
    expect(changes).toEqual(['a', 'a', 'a']);
  });
});
