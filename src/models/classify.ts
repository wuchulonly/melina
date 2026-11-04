// DeepSeek 原生请求的失败策略；状态来自 Harness LlmError，未知错误保留为角色失败。
import { type AssistantMessage, isContextOverflow, isRetryableAssistantError } from './protocol.ts';
export type CallFailure =
  | { kind: 'aborted' }
  | { kind: 'overflow'; message: string }
  | { kind: 'model'; message: string; status?: number }
  | { kind: 'auth' | 'billing'; reason: string; status?: number }
  | { kind: 'provider'; reason: string; status?: number; throttle?: { status: number; retryAfterMs?: number } }
  | { kind: 'unknown'; message: string };
export interface CallSeen {
  status?: number;
  retryAfterMs?: number;
  idle?: boolean;
  contextWindow?: number;
}
const EXHAUSTED =
  /insufficient[_ ]balance|insufficient_quota|exceeded_current_quota|余额不足|欠费|out of budget|credit balance|payment required|available balance/i;
export function classify(message: AssistantMessage, seen: CallSeen = {}): CallFailure | undefined {
  if (seen.idle && ['error', 'aborted'].includes(message.stopReason))
    return { kind: 'provider', reason: '长时间没有收到新内容（model.idleTimeoutMs）' };
  if (message.stopReason === 'aborted') return { kind: 'aborted' };
  if (message.stopReason !== 'error') return undefined;
  const text = message.errorMessage ?? '';
  const short = shorten(text);
  const status = seen.status && seen.status >= 400 ? seen.status : statusFromText(text);
  const code = message.failureCode;
  const reason = withStatus(status, short);
  if (code === 'CONTEXT_WINDOW_EXCEEDED' || isContextOverflow(message, seen.contextWindow))
    return { kind: 'overflow', message: short };
  if (
    status === 401 ||
    status === 403 ||
    code === 'AUTH' ||
    (status === undefined &&
      /unauthori[sz]ed|forbidden|invalid.*key|authentication|no api key for provider/i.test(text))
  )
    return { kind: 'auth', reason, status };
  if (status === 402 || code === 'QUOTA' || EXHAUSTED.test(text)) return { kind: 'billing', reason, status };
  if (
    status === 429 ||
    status === 503 ||
    status === 529 ||
    code === 'RATE_LIMIT' ||
    /insufficient_system_resource|overloaded|too many requests/i.test(text)
  ) {
    const throttle = status ?? (code === 'RATE_LIMIT' ? 429 : 503);
    return {
      kind: 'provider',
      reason,
      ...(status ? { status } : {}),
      throttle: { status: throttle, ...(seen.retryAfterMs !== undefined ? { retryAfterMs: seen.retryAfterMs } : {}) },
    };
  }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500))
    return { kind: 'provider', reason, status };
  if (status !== undefined && status >= 400) return { kind: 'model', message: reason, status };
  if (
    (code && ['SERVER', 'TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'EMPTY_RESPONSE'].includes(code)) ||
    isRetryableAssistantError(message)
  )
    return { kind: 'provider', reason: short };
  if (code === 'INVALID_REQUEST' || /content[_ ]filter|refusal|safety|blocked by|policy violation/i.test(text))
    return { kind: 'model', message: short };
  return { kind: 'unknown', message: short || '模型调用出错，没有错误信息' };
}
export function statusFromText(text: string): number | undefined {
  const match =
    /^\s*(\d{3})\b/.exec(text) ??
    /\((\d{3})\)/.exec(text) ??
    /status(?: code)?:? (\d{3})\b/i.exec(text) ??
    /"code"\s*:\s*(\d{3})\b/.exec(text);
  const status = match?.[1] ? Number(match[1]) : undefined;
  return status !== undefined && status >= 400 && status < 600 ? status : undefined;
}
/** Retry-After（秒或 HTTP 日期）和 retry-after-ms，换成毫秒 */
export function retryAfterMs(headers: { get(name: string): string | null }, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms) {
    const value = Number.parseFloat(ms);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const after = headers.get('retry-after');
  if (!after) return undefined;
  const seconds = Number.parseFloat(after);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(after);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function withStatus(status: number | undefined, text: string): string {
  if (status === undefined || text.startsWith(String(status))) return text;
  return `${status}：${text}`;
}

function shorten(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 300 ? `${one.slice(0, 300)}…` : one;
}
