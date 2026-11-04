// typebox 的小工具和几个基础 schema。core 里所有类型都由 schema 推出来（Static），
// 工具参数、写库校验和 HTTP 接口共用同一份。
//
// 约定：工具参数里的字段都写 description（中文，给模型看）；记录类型只在也当工具参数用时写，其余用行尾注释。

import Type, {
  type TArrayOptions,
  type TEnum,
  type TNumberOptions,
  type TObjectOptions,
  type TProperties,
  type TSchema,
  type TSchemaOptions,
  type TStringOptions,
} from 'typebox';
import { HANDLE_PATTERN, type Handle, ID_PATTERN, type Id, type SnapshotId } from './ids.ts';

/** 封闭对象：不许多余字段。记录、工具参数、请求体都用它 */
export function Obj<P extends TProperties>(properties: P, options: TObjectOptions = {}) {
  return Type.Object(properties, { additionalProperties: false, ...options });
}

/** 开放对象：允许实现加自己的字段（比如 WorkspaceRef） */
export function OpenObj<P extends TProperties>(properties: P, options: TObjectOptions = {}) {
  return Type.Object(properties, { additionalProperties: true, ...options });
}

/** 字符串枚举，JSON schema 里是 { type: 'string', enum }（有的供应商的严格模式要求 enum 带 type），类型是字面量联合 */
export function Enum<const T extends string[]>(values: readonly [...T], options: TSchemaOptions = {}): TEnum<T> {
  return Type.Enum(values, { type: 'string', ...options });
}

export function Opt<T extends TSchema>(schema: T) {
  return Type.Optional(schema);
}

export function Arr<T extends TSchema>(items: T, options: TArrayOptions = {}) {
  return Type.Array(items, options);
}

/** 非空字符串 */
export function Str(options: TStringOptions = {}) {
  return Type.String({ minLength: 1, ...options });
}

/** 可以为空的字符串 */
export function Text(options: TStringOptions = {}) {
  return Type.String(options);
}

/** 非负整数 */
export function Nat(options: TNumberOptions = {}) {
  return Type.Integer({ minimum: 0, ...options });
}

export function Num(options: TNumberOptions = {}) {
  return Type.Number(options);
}

export function Bool(options: TSchemaOptions = {}) {
  return Type.Boolean(options);
}

export function IdS(options: TStringOptions = {}) {
  return Type.Unsafe<Id>(Type.String({ pattern: ID_PATTERN, ...options }));
}

export function HandleS(options: TStringOptions = {}) {
  return Type.Unsafe<Handle>(Type.String({ pattern: HANDLE_PATTERN, ...options }));
}

/** snapshot id，或 'root'（本 Run 的根 snapshot） */
export function SnapshotS(options: TStringOptions = {}) {
  return Type.Unsafe<SnapshotId>(Type.String({ minLength: 1, maxLength: 200, ...options }));
}

/** ISO 8601 时间，UTC，例如 2026-10-01T09:00:00.000Z */
export function Time(options: TStringOptions = {}) {
  return Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$', ...options });
}

/** 事件序号：全局递增，从 1 开始 */
export function Seq(options: TNumberOptions = {}) {
  return Type.Integer({ minimum: 1, ...options });
}

export function Ids(options: TArrayOptions = {}) {
  return Arr(IdS(), options);
}

/**
 * 每条 RunStore 记录都带的两个字段：runId，和创建它的那条事件的 seq。
 * 可变的记录（Bet、Branch）的 seq 也是创建时的那条；Run 自己只带 seq。
 */
export const RecordMeta = {
  runId: IdS(),
  seq: Seq(),
};
