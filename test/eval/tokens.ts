// token 截断的口径。
// 一次 Run 用了多少 token = 输入 + 缓存命中 + 写缓存 + 输出，和 pi-ai 的 totalTokens 一样；费用另记，不进截断。

import type { UsageTotals } from '../../src/core/events.ts';

export function totalTokens(u: UsageTotals): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    usd: a.usd + b.usd,
  };
}

/** '500k'、'1.5m'、'2000000' → 数字 */
export function parseTokens(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(text);
  if (!m) throw new Error(`token 数看不懂：${text}`);
  const unit = (m[2] ?? '').toLowerCase();
  const n = Number(m[1]) * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1);
  return Math.round(n);
}

export function parseCutoffs(text: string): number[] {
  const values = text.split(',').map(parseTokens);
  if (values.length === 0 || values.some((v) => v <= 0)) throw new Error(`截断点要是正数：${text}`);
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 时间截断（U01）：'90s'、'5m'、'1.5h'、不带单位的按分钟 → 毫秒 */
export function parseDuration(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$/i.exec(text);
  if (!m) throw new Error(`时长看不懂：${text}（写成 90s、5m、1.5h）`);
  const unit = (m[2] ?? '').toLowerCase();
  const ms = Number(m[1]) * (unit === 's' ? 1000 : unit === 'h' ? 3600_000 : 60_000);
  return Math.round(ms);
}

export function parseDurations(text: string): number[] {
  const values = text.split(',').map(parseDuration);
  if (values.length === 0 || values.some((v) => v <= 0)) throw new Error(`时间截断要是正数：${text}`);
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 300000 → 5m，5400000 → 90m，10800000 → 3h，45000 → 45s：时间截断的刻度、表头用（3 小时以内按分钟写） */
export function formatDuration(ms: number): string {
  if (ms >= 3 * 3600_000) return `${trim(ms / 3600_000)}h`;
  if (ms >= 60_000) return `${trim(ms / 60_000)}m`;
  return `${trim(ms / 1000)}s`;
}

/** 500000 → 500k，1500000 → 1.5M */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}k`;
  return String(n);
}

function trim(v: number): string {
  return v.toFixed(2).replace(/\.?0+$/, '');
}
