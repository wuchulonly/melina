// 事件信封统一为 { seq, runId, type, at, data }，seq 全局递增。
// 存储写入发布记录事件；用量与系统状态发布汇总事件，大字段通过句柄读取。
// 消费方按事件类型处理；历史事件中的未知类型应跳过，持久化历史保持原样。

import Type, { type Static, type TSchema } from 'typebox';
import type { Id } from './ids.ts';
import { ModelRef } from './model-ref.ts';
import { Arr, Bool, Enum, IdS, Ids, Nat, Num, Obj, Opt, Seq, Str, Time } from './schema.ts';
import { Bet, Branch, Candidate, HumanInput, InboxItem, Observation, Role, Run, Snapshot, WatchNote } from './types.ts';

/** sh 调用执行前写下意图；id 就是之后那条 Observation 的 id */
export const ShIntent = Obj({
  id: IdS(),
  branchId: IdS(),
  episode: Nat(),
  cmd: Str(),
  expect: Opt(Str()),
});
export type ShIntent = Static<typeof ShIntent>;

/** episode 怎么结束的：三个收尾工具对应 ended / submitted / stuck、done；没有合法收尾是 failed */
export const EpisodeOutcomeKind = Enum(['ended', 'submitted', 'failed']);
export type EpisodeOutcomeKind = Static<typeof EpisodeOutcomeKind>;

/**
 * 失败的 episode 有三种，上下文撑爆也算没有合法收尾：
 * model_error 模型的回复用不了；no_close 模型停下、提醒一次仍不收尾；context_overflow 上下文撑爆了模型窗口；
 */
export const EpisodeFailure = Enum(['model_error', 'no_close', 'context_overflow']);
export type EpisodeFailure = Static<typeof EpisodeFailure>;

/** 一次角色调用结束的分支、轮次与结果；与本次状态写入在同一事务中提交。 */
export const EpisodeClosed = Obj({
  branchId: IdS(),
  episode: Nat({ minimum: 1 }),
  outcome: EpisodeOutcomeKind,
  failure: Opt(EpisodeFailure), // exit(stuck) 的 note
});
export type EpisodeClosed = Static<typeof EpisodeClosed>;

export const UsageTotals = Obj({
  input: Nat(),
  cacheRead: Nat(),
  cacheWrite: Nat(),
  output: Nat(),
  usd: Num({ minimum: 0 }),
});
export type UsageTotals = Static<typeof UsageTotals>;

export const ZERO_USAGE: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 };

/**
 * 一个 Run 的用量按角色、按分支分。账本里每行本来就记了角色和分支。
 * 缓存命中率 = cacheRead /（input + cacheRead + cacheWrite），和 test/dev/usage.ts 同一个口径
 */
export const UsageBreakdown = Obj({
  byRole: Arr(Obj({ role: Role, ...UsageTotals.properties })), // 只列用过的角色
  // 分支用量包含执行该分支的 Explorer 和旁观该分支的巡检器。

  byBranch: Arr(Obj({ branchId: IdS(), ...UsageTotals.properties })),
});
export type UsageBreakdown = Static<typeof UsageBreakdown>;

/** 记账后按秒合并：这一秒的增量，和这个 Run 到现在的总数 */
export const UsageUpdated = Obj({ delta: UsageTotals, total: UsageTotals });
export type UsageUpdated = Static<typeof UsageUpdated>;

/** 一家供应商的一个 API key 的状况 */
export const ProviderKeyStatus = Obj({
  id: IdS(),
  name: Opt(Str()),
  // active：在用；standby：能用的备用；down：用不了（额度用完、key 失效），过一阵拿一次真实调用去试：第一次一分钟后，
  // 又失败就隔得翻倍，最长一小时
  state: Enum(['active', 'standby', 'down']),
  reason: Opt(Str()), // down 的原因，例如「402：余额不足」
});
export type ProviderKeyStatus = Static<typeof ProviderKeyStatus>;

/** 一个供应商的运行状况 */
export const ProviderStatus = Obj({
  provider: Str(),
  breaker: Enum(['ok', 'open', 'probing']), // open：熔断中，没有备用模型的作业在排队，每分钟试一次；probing：正在试
  reason: Opt(Str()), // 熔断原因，例如「401：API key 无效」「连续 3 次超时」
  limit: Type.Union([Nat({ minimum: 1 }), Type.Null()]), // 现在能同时在途几个调用；null 是不限
  inFlight: Nat(),
  queued: Nat(),
  episodes: Obj({ running: Nat(), queued: Nat() }), // 用这家模型的 episode（准入层）
  retryAt: Opt(Time()), // 响应带 Retry-After 时，新调用等到这个时间
  fallbackTo: Opt(ModelRef), // 熔断期间换到的备用模型
  keys: Opt(Arr(ProviderKeyStatus)), // 这家配的 API key，按模型页的顺序；没配 key 的供应商没有
});
export type ProviderStatus = Static<typeof ProviderStatus>;

/**
 * 系统状态里要人知道的一件事：容器引擎用不了、领域镜像没建、某一档没有能用的模型、凭证给不进容器、磁盘不够。
 * 总览常驻显示；建任务时会被拒的那几种也在这里先说（以前总览一切正常，建任务才报错）
 */
export const SystemNotice = Obj({
  kind: Enum(['sandbox', 'images', 'models', 'disk']),
  level: Enum(['warning', 'error']), // error：建任务会被拒，或者分支跑不起来；warning：能跑，但有地方要你看一眼
  text: Str(), // 一句人话，直接显示；要做什么也写在里面（比如「先跑 pnpm images code」）
});
export type SystemNotice = Static<typeof SystemNotice>;

/** 系统状态：熔断、限流、容量、排队、磁盘，和要人知道的事 */
export const SystemStatus = Obj({
  providers: Arr(ProviderStatus),
  toolExec: Obj({ limit: Nat({ minimum: 1 }), running: Nat(), queued: Nat(), auto: Bool() }), // 本机同时执行的命令（工具层），不是路线数
  disk: Obj({ freeBytes: Nat(), minBytes: Nat(), ok: Bool() }), // ok 为 false 时不再启动新分支
  runs: Obj({ running: Nat(), paused: Nat() }),
  notices: Opt(Arr(SystemNotice)), // 没有就是没什么要说的；老的 system.updated 里没有这一项
});
export type SystemStatus = Static<typeof SystemStatus>;

export const RunRecovered = Obj({
  branches: Ids(), // 退回 lastSnapshot 的分支
  unknownCommands: Ids(), // 只有意图、没有结果的 sh 调用（Observation 的 id）
  rescoped: Bool(), // Scoper 没起草完，重新起草
});
export type RunRecovered = Static<typeof RunRecovered>;

export const VersionPicked = Obj({
  candidateId: IdS(), // 挑中的那一版
  versions: Ids({ minItems: 2 }), // 这次比的是哪几版，按交的先后；挑中的在里面
  why: Str(), // 为什么挑它、别的版本差在哪：一两句人话，显示在终点卡上
  model: ModelRef, // 挑的模型
  basedOnSeq: Seq(), // 挑版的上下文是 RunStore 的哪一刻拼的（Layout.basedOnSeq）：这之后记的它没看到
});
export type VersionPicked = Static<typeof VersionPicked>;

// ── 事件类型和 data 的对应 ────────────────────────────────────────────────

export const EVENT_DATA = {
  'run.created': Run,
  'run.updated': Run, // 模式或状态变化，包括暂停和恢复；结束时带 result
  'run.recovered': RunRecovered, // Melina 重启后恢复了这个 Run
  'completion.drafted': Run, // Scoper 起草完：goal 的 completion、constraints、domain、sharedSystems 和 workspace.setup 已填
  'bet.created': Bet,
  'bet.updated': Bet, // Bet 关闭
  'branch.created': Branch,
  'branch.updated': Branch, // 状态、排队、调度权重、待暂停变化
  'episode.closed': EpisodeClosed,
  'snapshot.created': Snapshot,
  'observation.created': Observation,
  'candidate.created': Candidate,
  'inbox.created': InboxItem, // 被回答或作废
  'input.created': HumanInput,
  'sh.intent': ShIntent,
  'version.picked': VersionPicked, // 挑版：只有事件，没有表
  'watch.noted': WatchNote, // 巡检器给主干直解路线的一版看法：只有事件，没有表
  'usage.updated': UsageUpdated,
  'system.updated': SystemStatus, // 只在全局事件流里，runId 为 null
} as const satisfies Record<string, TSchema>;

export type EventType = keyof typeof EVENT_DATA;
export const EVENT_TYPES = Object.keys(EVENT_DATA) as EventType[];
export type EventDataMap = { [K in EventType]: Static<(typeof EVENT_DATA)[K]> };

export type MelinaEventOf<K extends EventType> = {
  seq: number;
  runId: K extends 'system.updated' ? null : Id;
  type: K;
  at: string;
  data: EventDataMap[K];
};
export type MelinaEvent = { [K in EventType]: MelinaEventOf<K> }[EventType];

/** 事件的外壳；data 按 type 在 EVENT_DATA 里查（validate.ts 的 checkEvent） */
export const EventEnvelope = Obj({
  seq: Seq(),
  runId: Type.Union([IdS(), Type.Null()]),
  type: Enum(EVENT_TYPES as [EventType, ...EventType[]]),
  at: Time(),
  data: Type.Unknown(),
});

/** 一次 RunStore 写入对应的记录类型（RunStore 记录都带 id），按 id 查记录时用 */
export const RECORD_EVENT_KIND = {
  'candidate.created': 'candidate',
  'observation.created': 'observation',
  'inbox.created': 'inbox',
  'input.created': 'input',
  'bet.created': 'bet',
  'branch.created': 'branch',
  'snapshot.created': 'snapshot',
  'run.created': 'run',
} as const satisfies Partial<Record<EventType, string>>;
export type RecordKind = (typeof RECORD_EVENT_KIND)[keyof typeof RECORD_EVENT_KIND];
