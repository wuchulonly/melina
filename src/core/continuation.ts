// 摘要接力保存一份待执行计划、验收高水位和入口检查游标。
import Type, { type Static } from 'typebox';
import { ModelRef } from './model-ref.ts';
import { Arr, Bool, IdS, Nat, Obj, Opt, SnapshotS, Str } from './schema.ts';

export const ContinuationPlan = Obj({
  summary: Str({ maxLength: 2400 }),
  hasAccess: Bool(),
  sourceBranchId: Opt(IdS()),
  directions: Arr(Str({ maxLength: 800 }), { maxItems: 16 }),
});
export type ContinuationPlan = Static<typeof ContinuationPlan>;

export const ContinuationBatch = Obj({
  key: Str(),
  summary: Str({ maxLength: 2400 }),
  task: Opt(Str()),
  baseWatermark: Opt(Nat()),
  sources: Arr(Obj({ branchId: IdS(), snapshot: SnapshotS(), model: ModelRef, direction: Str() }), {
    minItems: 1,
    maxItems: 16,
  }),
});
export type ContinuationBatch = Static<typeof ContinuationBatch>;

export const ContinuationState = Obj({
  version: Type.Literal(1),
  handled: Arr(Str()),
  access: Arr(Obj({ branchId: IdS(), toolCalls: Nat() })),
  acceptance: Arr(
    Obj({
      task: Str(),
      best: Nat(),
      total: Opt(Nat()),
      branches: Opt(Arr(Obj({ branchId: IdS(), watermark: Nat(), toolCallsAtAccept: Nat(), attributed: Opt(Bool()) }))),
    }),
  ),
  pending: Opt(ContinuationBatch),
});
export type ContinuationState = Static<typeof ContinuationState>;
