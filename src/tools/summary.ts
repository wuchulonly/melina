// 大输出只给摘要：超过 toolOutput.inlineMaxTokens 的输出，
// 上下文里只放头尾片段、大小、结构概要（JSON 的键名、数组长度）和原文在沙箱里的只读路径，原文让 Explorer 用 sed、grep、jq 按需查看。

import { estimateTokens } from '../storage/tokens.ts';

/** 头尾片段各占上限的多少 */
const HEAD_SHARE = 0.35;
const TAIL_SHARE = 0.35;
/** 结构概要最多几行 */
const OUTLINE_LINES = 40;
/** 一个对象最多列几个键 */
const OUTLINE_KEYS = 20;

export interface Summarized {
  /** 原文整个放得下 */
  inline: boolean;
  text: string;
}

/**
 * 原文放得下就原样返回；放不下就给大小、结构概要、开头和结尾。
 * path 是原文在沙箱里的只读路径；没有（原文没能存档）就不提。
 */
export function summarize(raw: string, opts: { maxTokens: number; path?: string; what?: string }): Summarized {
  if (estimateTokens(raw) <= opts.maxTokens) return { inline: true, text: raw };
  const lines = splitLines(raw);
  const bytes = Buffer.byteLength(raw);
  const parts: string[] = [];
  const where = opts.path ? `；原文在 ${opts.path}（只读），用 sed、grep、jq 按需查看。` : '。';
  parts.push(`${opts.what ?? '输出'}共 ${lines.length} 行、${formatBytes(bytes)}，太长了，下面只有开头和结尾${where}`);
  const outline = structureOutline(raw);
  if (outline) parts.push(outline);
  const head = takeHead(lines, Math.floor(opts.maxTokens * HEAD_SHARE));
  const tail = takeTail(lines.slice(head.count), Math.floor(opts.maxTokens * TAIL_SHARE));
  parts.push(`--- 开头 ---\n${head.text}`);
  const skipped = lines.length - head.count - tail.count;
  if (skipped > 0) parts.push(`……（中间 ${skipped} 行没有显示）……`);
  if (tail.count > 0) parts.push(`--- 结尾 ---\n${tail.text}`);
  return { inline: false, text: parts.join('\n') };
}

/** 结构概要：整段是 JSON，或者每行都是 JSON（JSON Lines）时给出键名和数组长度；不是 JSON 就是 undefined */
export function structureOutline(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || !'{["'.includes(trimmed[0] as string)) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null) return undefined;
    return `JSON 结构：\n${outline(value, '', 0).slice(0, OUTLINE_LINES).join('\n')}`;
  } catch {
    // 不是一整个 JSON，试 JSON Lines
  }
  const rows = trimmed.split('\n').filter((l) => l.trim() !== '');
  if (rows.length < 2) return undefined;
  const parsed: unknown[] = [];
  for (const row of rows) {
    try {
      parsed.push(JSON.parse(row));
    } catch {
      return undefined;
    }
  }
  const first = parsed[0];
  const shape = typeof first === 'object' && first !== null ? outline(first, '', 1) : [`  ${typeName(first)}`];
  return [`JSON Lines：${rows.length} 行，第一行：`, ...shape].slice(0, OUTLINE_LINES).join('\n');
}

function outline(value: unknown, path: string, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const label = path === '' ? '整体' : path;
  if (Array.isArray(value)) {
    const out = [`${indent}${label}：数组，长度 ${value.length}${elementNote(value)}`];
    const firstObject = value.find((v) => typeof v === 'object' && v !== null && !Array.isArray(v));
    if (firstObject && depth < 2)
      out.push(...childLines(firstObject as Record<string, unknown>, `${path}[]`, depth + 1));
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    const out = [`${indent}${label}：对象，${keys.length} 个键`];
    if (depth < 3) out.push(...childLines(value as Record<string, unknown>, path, depth + 1));
    return out;
  }
  return [`${indent}${label}：${typeName(value)}`];
}

function childLines(obj: Record<string, unknown>, path: string, depth: number): string[] {
  const keys = Object.keys(obj);
  const out: string[] = [];
  for (const key of keys.slice(0, OUTLINE_KEYS)) {
    const child = obj[key];
    const childPath = `${path}.${key}`;
    if (typeof child === 'object' && child !== null && depth < 3) out.push(...outline(child, childPath, depth));
    else out.push(`${'  '.repeat(depth)}${childPath}：${shortType(child)}`);
  }
  if (keys.length > OUTLINE_KEYS) out.push(`${'  '.repeat(depth)}……还有 ${keys.length - OUTLINE_KEYS} 个键`);
  return out;
}

function elementNote(list: unknown[]): string {
  if (list.length === 0) return '';
  const kinds = new Set(list.slice(0, 50).map(typeName));
  return `，元素是${[...kinds].join('或')}`;
}

function shortType(value: unknown): string {
  if (Array.isArray(value)) return `数组，长度 ${value.length}`;
  if (typeof value === 'object' && value !== null) return `对象，${Object.keys(value).length} 个键`;
  return typeName(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  switch (typeof value) {
    case 'string':
      return '字符串';
    case 'number':
      return '数字';
    case 'boolean':
      return '布尔值';
    case 'object':
      return '对象';
    default:
      return typeof value;
  }
}

/** 按行切；最后一个换行后面没有内容时不算一行 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function takeHead(lines: readonly string[], budget: number): { text: string; count: number } {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) {
      if (out.length === 0) out.push(cutLine(line, budget));
      break;
    }
    out.push(line);
    used += cost;
  }
  return { text: out.join('\n'), count: out.length };
}

function takeTail(lines: readonly string[], budget: number): { text: string; count: number } {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) {
      if (out.length === 0) out.unshift(cutLineEnd(line, budget));
      break;
    }
    out.unshift(line);
    used += cost;
  }
  return { text: out.join('\n'), count: out.length };
}

/** 一行就超了预算（压缩过的 JSON、很长的日志行）：按字符截开头 */
function cutLine(line: string, budget: number): string {
  const chars = [...line];
  let used = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    used += estimateTokens(chars[i] as string);
    if (used > budget) break;
  }
  return i < chars.length ? `${chars.slice(0, i).join('')}…（这一行还有 ${chars.length - i} 个字符）` : line;
}

function cutLineEnd(line: string, budget: number): string {
  const chars = [...line];
  let used = 0;
  let i = chars.length;
  for (; i > 0; i--) {
    used += estimateTokens(chars[i - 1] as string);
    if (used > budget) break;
  }
  return i > 0 ? `…（这一行前面还有 ${i} 个字符）${chars.slice(i).join('')}` : line;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 太长的字符串字段只留开头（Observation.args 里 write 的 content、edit 的 old、new），免得事件和表里塞进整个文件 */
export function preview(text: string, maxChars = 2000): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…（共 ${chars.length} 个字符）`;
}
