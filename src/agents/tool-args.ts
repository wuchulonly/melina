// 工具输入边界：解析 JSON、规范化 schema 允许的可选空值、类型转换、按变体报错。
// 只允许把字段移到唯一已存在的子对象；参数校验保留业务内容。

import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';
import { HANDLE_PATTERN, ID_PATTERN } from '../core/ids.ts';
import type { ToolSpec } from '../core/tools.ts';

/** JSON Schema 里要看的几个字段（typebox 的 TSchema 类型上没有写出来） */
interface Node {
  type?: unknown;
  const?: unknown;
  properties?: Record<string, Node>;
  required?: string[];
  additionalProperties?: unknown;
  items?: Node;
  minItems?: number;
  maxItems?: number;
  anyOf?: Node[];
  oneOf?: Node[];
  pattern?: string;
  minLength?: number;
  description?: string;
}

export interface PreparedArgs {
  args: unknown;
  /** 兜底挪到该在的地方的字段（只有提交类工具会有），给调用方记日志 */
  moved: string[];
}

/** 最多报几处，多的只说个数（和 core/validate.ts 的 formatIssues 一样） */
const MAX_PROBLEMS = 8;

/** 规范化不涉及业务含义；保留未知字段，交给校验明确报错。 */
export function normalizeToolArgs(spec: ToolSpec, raw: unknown, opts: { relocate?: boolean } = {}): PreparedArgs {
  const schema = spec.parameters as Node;
  let args = parsedIfJson(raw);
  args = typeof args === 'object' && args !== null ? structuredClone(args) : args;
  const moved = opts.relocate ? relocateRoot(schema, args) : [];
  args = normalizeOptionals(schema, args);
  return { args: Value.Convert(spec.parameters, args), moved };
}

/** 合格就返回规范化参数；不合格抛中文错误，不修改调用方输入。 */
export function prepareToolArgs(spec: ToolSpec, raw: unknown, opts: { relocate?: boolean } = {}): PreparedArgs {
  const schema = spec.parameters as Node;
  const prepared = normalizeToolArgs(spec, raw, opts);
  const { args } = prepared;
  if (validator(schema).Check(args)) return prepared;
  const problems = explain(schema, args, '');
  if (problems.length === 0) {
    // 走不到这里（上面不合格就一定有问题可说）；万一走到了，退回 typebox 原本的报错
    for (const e of validator(schema).Errors(args)) problems.push({ path: e.instancePath || '', text: e.message });
  }
  throw new Error(formatProblems(spec.name, problems));
}

/**
 * 挪：根上多出来的字段，能确定该放哪就挪过去：它是根上某个已经写了的对象里的字段，只有这一个对象有它，那个对象里还没写，就放进去；
 * 那里已经写了一样的值，根上这份是重复的，去掉。未知字段原样交给校验。
 * 别的都不动：对象没写的不替模型新建（建了 candidate 就成了交候选），两边的值对不上的不替它挑，交给报错让模型自己改
 */
function relocateRoot(schema: Node, args: unknown): string[] {
  if (!isPlainObject(args) || !schema.properties || schema.additionalProperties !== false) return [];
  const props = schema.properties;
  const moved: string[] = [];
  for (const key of Object.keys(args)) {
    if (key in props) continue;
    const value = args[key];
    if (!hasValue(value)) continue;
    const homes = Object.keys(props).filter((k) => isPlainObject(args[k]) && props[k]?.properties?.[key] !== undefined);
    const home = homes.length === 1 ? (args[homes[0] as string] as Record<string, unknown>) : undefined;
    if (!home) continue;
    if (!hasValue(home[key])) {
      home[key] = value;
      delete args[key];
      moved.push(`把根上的 ${key} 挪进 ${homes[0]}`);
    } else if (JSON.stringify(home[key]) === JSON.stringify(value)) {
      delete args[key];
    }
  }
  return moved;
}

// ── ① 整理未填写的可选字段 ─────────────────────────────────────────────

function normalizeOptionals(schema: Node, value: unknown): unknown {
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const picked = pickVariant(variants, value);
    if (picked) return normalizeOptionals(picked, value);
    // 认不出是哪个变体：哪个变体去掉 null 以后合格就用哪个，都不合格就原样（交给报错）
    for (const v of variants) {
      const candidate = normalizeOptionals(v, structuredClone(value));
      if (validator(v).Check(candidate)) return candidate;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (schema.items) for (let i = 0; i < value.length; i++) value[i] = normalizeOptionals(schema.items, value[i]);
    return value;
  }
  if (!isPlainObject(value) || !schema.properties) return value;
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    // 非空文本的可选项写成空串等同未填写；允许空值的 Text、必填字段和空白字符本身保持原义。
    if (
      !required.has(key) &&
      ((value[key] === null && !validator(prop).Check(null)) ||
        (value[key] === '' && prop.type === 'string' && (prop.minLength ?? 0) > 0))
    )
      delete value[key];
    else value[key] = normalizeOptionals(prop, value[key]);
  }
  return value;
}

// ── ②③ 按变体说清楚哪里不对 ──────────────────────────────────────────

interface Problem {
  path: string; // 例如 candidate.artifact；根上是空串
  text: string;
}

function explain(schema: Node, value: unknown, path: string): Problem[] {
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return explainUnion(variants, value, path);
  if (schema.type === 'object') {
    if (!isPlainObject(value)) return [{ path, text: `要是一个对象，收到 ${show(value)}` }];
    return explainObject(schema, value, path);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [{ path, text: `要是一个数组，收到 ${show(value)}` }];
    const out: Problem[] = [];
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push({
        path,
        text: `至少要 ${schema.minItems} 个，收到${value.length === 0 ? '空数组' : ` ${value.length} 个`}`,
      });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      out.push({ path, text: `最多 ${schema.maxItems} 个，收到 ${value.length} 个` });
    }
    const items = schema.items;
    if (items) {
      for (const [i, v] of value.entries()) out.push(...explain(items, v, `${path}[${i}]`));
    }
    return out;
  }
  return explainLeaf(schema, value, path);
}

function explainObject(schema: Node, value: Record<string, unknown>, path: string): Problem[] {
  const props = schema.properties ?? {};
  const out: Problem[] = [];
  const missing = (schema.required ?? []).filter((k) => !(k in value));
  // 带上字段的说明：只写「缺 expect」时模型改了一次还是漏
  if (missing.length > 0) out.push({ path, text: `缺 ${missing.map((k) => withDescription(k, props[k])).join('、')}` });
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).filter((k) => !(k in props));
    if (extra.length > 0) {
      // 根上的写错了位置最常见：说清它可能该放哪，模型改一次就对
      const hints = path === '' ? whereTheyGo(props, value, extra).map((h) => `；${h}`) : [];
      out.push({
        path,
        text: `多出来的字段 ${extra.join('、')}（这里只收 ${Object.keys(props).join('、')}）${hints.join('')}`,
      });
    }
  }
  for (const [key, v] of Object.entries(value)) {
    const prop = props[key];
    if (prop) out.push(...explain(prop, v, path === '' ? key : `${path}.${key}`));
  }
  return out;
}

/** 未知根字段的可能归属，仅为校验错误提供提示。 */
function whereTheyGo(props: Record<string, Node>, args: Record<string, unknown>, keys: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const where = whereItGoes(props, args, key);
    if (where) groups.set(where, [...(groups.get(where) ?? []), key]);
  }
  return [...groups].map(([where, ks]) => `${ks.join('、')} ${where}`);
}

function whereItGoes(props: Record<string, Node>, args: Record<string, unknown>, key: string): string | undefined {
  const objects = Object.keys(props).filter((k) => props[k]?.properties?.[key] !== undefined);
  if (objects.length === 1) {
    const home = objects[0] as string;
    const there = args[home];
    // 那个对象里已经写了、值不一样（一样的 relocateRoot 已经去掉了）：两份留一份
    if (isPlainObject(there) && hasValue(there[key])) return `在 ${home} 里也写了、两处不一样：只留 ${home} 里那份`;
    return `是 ${home} 里的字段，写进 ${home} 里`;
  }
  if (objects.length > 1) return `是 ${objects.join(' 或 ')} 里的字段，写进对应的那个里`;
  const arrays = Object.keys(props).filter((k) => props[k]?.items?.properties?.[key] !== undefined);
  if (arrays.length > 0) return `是 ${arrays.join(' 或 ')} 里每一项的字段，写进那一项里`;
  return undefined;
}

function explainUnion(variants: Node[], value: unknown, path: string): Problem[] {
  if (variants.some((v) => validator(v).Check(value))) return [];
  const key = discriminator(variants);
  if (key !== undefined && isPlainObject(value)) {
    const allowed = variants.map((v) => v.properties?.[key]?.const);
    const got = value[key];
    const at = path === '' ? key : `${path}.${key}`;
    const list = allowed.map(String).join('、');
    if (got === undefined) return [{ path, text: `缺 ${key}，只能是 ${list} 之一` }];
    const index = allowed.indexOf(got);
    if (index < 0) return [{ path: at, text: `只能是 ${list} 之一，收到 ${show(got)}` }];
    return explain(variants[index] as Node, value, `${path}（${String(got)}）`);
  }
  if (variants.every(constObject)) {
    return [{ path, text: `只能是下面几种之一：${variants.map(describeConstObject).join('；')}，收到 ${show(value)}` }];
  }
  // 别的联合：按问题最少的那个变体说
  let best: Problem[] | undefined;
  for (const v of variants) {
    const found = explain(v, value, path);
    if (found.length > 0 && (best === undefined || found.length < best.length)) best = found;
  }
  return best ?? [];
}

function explainLeaf(schema: Node, value: unknown, path: string): Problem[] {
  const out: Problem[] = [];
  for (const e of validator(schema).Errors(value)) {
    const at = e.instancePath ? `${path}${e.instancePath.replaceAll('/', '.')}` : path;
    out.push({ path: at, text: leafText(schema, e.keyword, e.params as Record<string, unknown>, value, e.message) });
  }
  return out;
}

function leafText(schema: Node, keyword: string, params: Record<string, unknown>, value: unknown, fallback: string) {
  const got = `，收到 ${show(value)}`;
  switch (keyword) {
    case 'type':
      return `要是${typeName(params.type)}${got}`;
    case 'const':
      return `只能是 ${show(params.allowedValue)}${got}`;
    case 'enum':
      return `只能是 ${(params.allowedValues as unknown[]).map(String).join('、')} 之一${got}`;
    case 'minimum':
      return `要 ≥ ${String(params.limit)}${got}`;
    case 'maximum':
      return `要 ≤ ${String(params.limit)}${got}`;
    case 'exclusiveMinimum':
      return `要 > ${String(params.limit)}${got}`;
    case 'exclusiveMaximum':
      return `要 < ${String(params.limit)}${got}`;
    case 'minLength':
      return value === '' ? '不能是空的' : `至少 ${String(params.limit)} 个字${got}`;
    case 'maxLength':
      return `最多 ${String(params.limit)} 个字，收到 ${typeof value === 'string' ? value.length : '?'} 个字`;
    case 'pattern':
      if (params.pattern === ID_PATTERN) return `要是一条记录的 id（26 位的 ULID）${got}`;
      if (params.pattern === HANDLE_PATTERN) return `要是一个产物句柄（art:// 开头）${got}`;
      return `格式不对${schema.description ? `（${schema.description}）` : ''}${got}`;
    default:
      return fallback;
  }
}

function formatProblems(tool: string, problems: Problem[]): string {
  const lines = problems.slice(0, MAX_PROBLEMS).map((p) => `- ${p.path === '' ? '参数' : p.path}：${p.text}`);
  if (problems.length > MAX_PROBLEMS) lines.push(`- ……还有 ${problems.length - MAX_PROBLEMS} 处`);
  return `${tool} 的参数不对，没有执行：\n${lines.join('\n')}\n改好以后重新调用 ${tool}（整份重新交）。`;
}

// ── 小工具 ────────────────────────────────────────────────────────────

/** 字段名后面括号里写它的说明（schema 的 description，太长的截掉） */
function withDescription(key: string, schema: Node | undefined): string {
  const text = schema?.description?.trim();
  if (!text) return key;
  return `${key}（${text.length > 40 ? `${text.slice(0, 39)}…` : text}）`;
}

const validators = new WeakMap<Node, ReturnType<typeof Compile>>();

function validator(schema: Node): ReturnType<typeof Compile> {
  let v = validators.get(schema);
  if (!v) {
    v = Compile(schema as TSchema);
    validators.set(schema, v);
  }
  return v;
}

/** 对象联合的判别字段：每个变体都有、都是互不相同的字面量；type、kind 优先 */
function discriminator(variants: Node[]): string | undefined {
  if (variants.length < 2 || !variants.every((v) => v.type === 'object' && v.properties)) return undefined;
  const first = variants[0]?.properties ?? {};
  const keys = Object.keys(first).sort((a, b) => rank(a) - rank(b));
  for (const key of keys) {
    const consts = variants.map((v) => v.properties?.[key]?.const);
    if (consts.some((c) => c === undefined)) continue;
    if (new Set(consts).size === consts.length) return key;
  }
  return undefined;
}

function rank(key: string): number {
  return key === 'type' ? 0 : key === 'kind' ? 1 : 2;
}

/** 认得出是哪个变体就返回它（判别字段的值对上了） */
function pickVariant(variants: Node[], value: unknown): Node | undefined {
  const key = discriminator(variants);
  if (key === undefined || !isPlainObject(value)) return undefined;
  return variants.find((v) => v.properties?.[key]?.const === value[key]);
}

function constObject(v: Node): boolean {
  return v.type === 'object' && Object.values(v.properties ?? {}).every((p) => p.const !== undefined);
}

function describeConstObject(v: Node): string {
  return Object.entries(v.properties ?? {})
    .map(([k, p]) => `${k}=${String(p.const)}`)
    .join(', ');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 真正的 null 表示未填写；字符串 "null" 保留原义。 */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** 有的模型把整份参数当成一个 JSON 字符串交上来 */
function parsedIfJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPlainObject(parsed) ? parsed : raw;
  } catch {
    return raw;
  }
}

const TYPE_NAMES: Record<string, string> = {
  string: '字符串',
  integer: '整数',
  number: '数',
  boolean: ' true 或 false',
  object: '一个对象',
  array: '一个数组',
  null: ' null',
};

function typeName(type: unknown): string {
  return typeof type === 'string' ? (TYPE_NAMES[type] ?? type) : String(type);
}

function show(value: unknown): string {
  if (value === undefined) return '没有';
  if (Array.isArray(value)) return value.length === 0 ? '空数组' : `${value.length} 个元素的数组`;
  if (isPlainObject(value)) return '一个对象';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
