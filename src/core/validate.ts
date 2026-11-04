// 按 schema 校验。写库前（RunStoreWriter）、工具参数（ToolGateway）、HTTP 请求体（api）都用这里，错误信息格式一致。

import type { Static, TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { invalid } from './errors.ts';
import { EVENT_DATA, EventEnvelope, type MelinaEvent } from './events.ts';

export interface SchemaIssue {
  path: string; // JSON Pointer，例如 /checks/0/evidence
  message: string;
}

type Validator = ReturnType<typeof Compile>;
const cache = new WeakMap<TSchema, Validator>();

function validator(schema: TSchema): Validator {
  let v = cache.get(schema);
  if (!v) {
    v = Compile(schema);
    cache.set(schema, v);
  }
  return v;
}

/** 列出不合 schema 的地方；合就返回空数组 */
export function issues(schema: TSchema, value: unknown): SchemaIssue[] {
  const v = validator(schema);
  if (v.Check(value)) return [];
  return [...v.Errors(value)].map((e) => ({ path: e.instancePath || '/', message: e.message }));
}

export function isValid<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return validator(schema).Check(value);
}

/** 合就原样返回（带上类型），不合抛 MelinaError('invalid')，details 是问题列表 */
export function check<T extends TSchema>(schema: T, value: unknown, what = '数据'): Static<T> {
  const found = issues(schema, value);
  if (found.length > 0) throw invalid(`${what}不合格式：${formatIssues(found)}`, found);
  return value as Static<T>;
}

/** 给模型看的错误：一行一个问题，最多 8 个 */
export function formatIssues(found: readonly SchemaIssue[]): string {
  const shown = found.slice(0, 8).map((i) => `${i.path} ${i.message}`);
  if (found.length > 8) shown.push(`……还有 ${found.length - 8} 处`);
  return shown.join('；');
}

/** 校验一条事件：外壳，再按 type 校验 data；system.updated 的 runId 必须是 null，其余必须有 */
export function eventIssues(value: unknown): SchemaIssue[] {
  const envelope = issues(EventEnvelope, value);
  if (envelope.length > 0) return envelope;
  const e = value as { type: keyof typeof EVENT_DATA; runId: string | null; data: unknown };
  const found = issues(EVENT_DATA[e.type], e.data).map((i) => ({
    path: `/data${i.path === '/' ? '' : i.path}`,
    message: i.message,
  }));
  if (e.type === 'system.updated' ? e.runId !== null : e.runId === null) {
    found.push({
      path: '/runId',
      message: e.type === 'system.updated' ? 'system.updated 的 runId 必须是 null' : 'runId 不能是 null',
    });
  }
  return found;
}

export function checkEvent(value: unknown): MelinaEvent {
  const found = eventIssues(value);
  if (found.length > 0) throw invalid(`事件不合格式：${formatIssues(found)}`, found);
  return value as MelinaEvent;
}
