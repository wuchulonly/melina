import { describe, expect, it } from 'vitest';
import { classify, retryAfterMs, statusFromText } from '../../../src/models/classify.ts';
import { fauxAssistantMessage } from './protocol.ts';

const error = (text: string, failureCode?: string) =>
  fauxAssistantMessage([], { stopReason: 'error', errorMessage: text, failureCode });
describe('DeepSeek 失败分类', () => {
  it.each([
    [401, 'Invalid API Key', 'auth'],
    [403, 'denied', 'auth'],
    [402, 'Insufficient Balance', 'billing'],
    [429, 'rate limit; see billing details', 'provider'],
    [429, 'insufficient_quota', 'billing'],
    [500, 'internal error', 'provider'],
    [503, 'busy', 'provider'],
    [408, 'timeout', 'provider'],
    [400, 'invalid tool arguments', 'model'],
    [400, 'prompt is too long', 'overflow'],
  ])('HTTP %s %s -> %s', (status, text, expected) => {
    expect(classify(error(String(text)), { status: Number(status) })?.kind).toBe(expected);
  });
  it('使用 Harness 稳定错误码，保留 Retry-After', () => {
    expect(classify(error('rate limited', 'RATE_LIMIT'), { retryAfterMs: 300 })).toMatchObject({
      kind: 'provider',
      throttle: { status: 429, retryAfterMs: 300 },
    });
    expect(classify(error('not enough credits', 'QUOTA'))?.kind).toBe('billing');
    expect(classify(error('too large', 'CONTEXT_WINDOW_EXCEEDED'))?.kind).toBe('overflow');
    for (const code of ['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'SERVER'])
      expect(classify(error('stream interrupted', code))?.kind).toBe('provider');
  });
  it('取消不重试；空闲超时重试；未知错误交给角色', () => {
    const aborted = fauxAssistantMessage([], { stopReason: 'aborted' });
    expect(classify(aborted)?.kind).toBe('aborted');
    expect(classify(aborted, { idle: true })?.kind).toBe('provider');
    expect(classify(error('new unsupported failure'))?.kind).toBe('unknown');
    expect(classify(fauxAssistantMessage('OK'))).toBeUndefined();
  });
  it('HTTP 与网关文本状态、秒数与日期的 Retry-After', () => {
    expect(statusFromText('503 Service unavailable')).toBe(503);
    expect(statusFromText('HTTP (401)')).toBe(401);
    expect(statusFromText('status code: 429')).toBe(429);
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '50' }))).toBe(50);
    expect(retryAfterMs(new Headers({ 'retry-after': '.5' }))).toBe(500);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs(new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:02 GMT' }), now)).toBe(2000);
    expect(retryAfterMs(new Headers({ 'retry-after': 'invalid' }))).toBeUndefined();
  });
});
