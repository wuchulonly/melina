import type { Static } from 'typebox';
import { Arr, HandleS, IdS, Nat, Obj, Opt, Str, Text } from './schema.ts';

/** 宿主回执关联到触发它的观测；来源可以属于前一轮 Run，不伪装成本轮证据。 */
export const FeedbackSource = Obj({
  runId: IdS(),
  branchId: IdS(),
  observationId: IdS(),
  output: Opt(HandleS()),
  tool: Opt(Str()),
  command: Opt(Str({ maxLength: 500 })),
});
export type FeedbackSource = Static<typeof FeedbackSource>;

/** 由宿主采集的观察者材料，仍以 Observation 存档，工具调用计数不增加。 */
export const WATCH_INPUT = {
  speech: 'assistant_text',
  platform: 'platform_status',
  receipt: 'platform_receipt',
  http: 'http_traffic',
  extension: 'extension_status',
} as const;

export const WatchPlatform = Obj({
  task: Str(),
  total: Nat(),
  remaining: Nat(),
  hintStatus: Str(),
  hint: Text(),
  accepted: Arr(Obj({ id: Str(), label: Str(), receipt: Opt(IdS()), source: Opt(FeedbackSource) })),
  rejectedCount: Nat(),
  filteredCount: Opt(Nat()),
});
export type WatchPlatform = Static<typeof WatchPlatform>;
