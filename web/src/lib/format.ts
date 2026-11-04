// 数字、时间的写法：给人看的，中文习惯。token 上万用「万」，费用是美元。

import type { UsageTotals } from '../../../src/core/events.ts';

/** 一共处理了多少 token：输入、缓存命中、缓存写入、输出加起来 */
export function totalTokens(u: UsageTotals): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

/**
 * 缓存命中率 = cacheRead /（input + cacheRead + cacheWrite）：和 core/events.ts 的 UsageBreakdown、test/dev/usage.ts 同一个口径。
 * 没有输入时没有
 */
export function cacheHitRate(u: Pick<UsageTotals, 'input' | 'cacheRead' | 'cacheWrite'>): number | undefined {
  const all = u.input + u.cacheRead + u.cacheWrite;
  return all > 0 ? u.cacheRead / all : undefined;
}

/** 94% · 不到 1% · —（没有） */
export function formatPercent(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return '—';
  if (x > 0 && x < 0.01) return '不到 1%';
  return `${Math.round(x * 100)}%`;
}

/** 8,532 · 24.1 万 · 241 万 · 1.24 亿 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 10_000) return Math.round(n).toLocaleString('en-US');
  if (abs < 100_000_000) return `${trim(n / 10_000, abs < 1_000_000 ? 1 : 0)} 万`;
  return `${trim(n / 100_000_000, 2)} 亿`;
}

/** $27.40 · $0.03 · <$0.01 · $1,204 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** 120 GB · 980 MB */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const gb = n / 1024 ** 3;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${trim(gb, 1)} GB`;
  const mb = n / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 读数拆成三段（components/ui.tsx 的 Reading 用）：前面的符号、数字、后面的单位，连着空格原样留下 */
export interface ReadingParts {
  /** $ 、<$ */
  pre: string;
  num: string;
  /** 数字和单位之间原来的空格（「685 万」有，「82%」没有），复制出来和原文一样 */
  gap: string;
  /** 万、ms、GB、% …… */
  unit: string;
}

const READING = /^(<?\$?)(-?\d[\d,]*(?:\.\d+)?)(\s?)(\S(?:.*\S)?)?$/u;

/** $27.40 → $ · 27.40；685 万 → 685 · 万；82% → 82 · %；不是「数字 + 单位」的（—、不到 1 分钟）给 null，照原样写 */
export function splitReading(text: string): ReadingParts | null {
  const m = READING.exec(text);
  if (!m) return null;
  const unit = m[4] ?? '';
  // 单位里又有数字的（「1 小时 9 分」）不是一个读数
  if (/\d/.test(unit)) return null;
  return { pre: m[1] ?? '', num: m[2] ?? '', gap: unit ? (m[3] ?? '') : '', unit };
}

function trim(n: number, digits: number): string {
  return n
    .toFixed(digits)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

const pad = (n: number) => String(n).padStart(2, '0');

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 9月28日 02:10；不是今年的带年份 */
export function formatDateTime(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const n = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, n)) return `今天 ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(d, yesterday)) return `昨天 ${time}`;
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === n.getFullYear() ? `${date} ${time}` : `${d.getFullYear()}年${date} ${time}`;
}

/** 只写哪一天：今天 · 昨天 · 9月28日；不是今年的带年份 */
export function formatDay(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const n = new Date(now);
  if (sameDay(d, n)) return '今天';
  if (sameDay(d, new Date(now - 86_400_000))) return '昨天';
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === n.getFullYear() ? date : `${d.getFullYear()}年${date}`;
}

/** 完整时间，放在 title 里：2026-09-28 02:10:35 */
export function formatFullTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 刚刚 · 3 分钟前 · 2 小时前 · 昨天 14:20 · 9月28日 02:10；将来的时间写「40 秒后」「3 分钟后」 */
export function formatRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = now - t;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60_000) return `${Math.max(1, Math.round(ahead / 1000))} 秒后`;
    if (ahead < 3_600_000) return `${Math.round(ahead / 60_000)} 分钟后`;
    return formatDateTime(iso, now);
  }
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 12 * 3_600_000 && sameDay(new Date(t), new Date(now))) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return formatDateTime(iso, now);
}

/** 不到 1 分钟 · 12 分钟 · 1 小时 12 分 · 2 天 3 小时 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m ? `${hours} 小时 ${m} 分` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days} 天 ${h} 小时` : `${days} 天`;
}

/** 路径的最后一段：/home/me/shop-api → shop-api */
export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

/** 把 home 换成 ~，长路径好读一些 */
export function shortPath(path: string, home?: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}
