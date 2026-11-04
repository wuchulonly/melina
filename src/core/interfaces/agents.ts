// 角色会话与无工具生成函数的入口。

// 分支循环、snapshot 和状态变化由 runtime 管理。

import type { EpisodeFailure, UsageTotals } from '../events.ts';
import type { Id } from '../ids.ts';
import type { ModelRef } from '../model-ref.ts';
import type { CloseOutcome, ClosingToolName, ToolSpec } from '../tools.ts';
import type { Bet, Branch, Run, ScoperOutput, WatchNote } from '../types.ts';
import type { Layout, PickRequest, WatchRequest } from './context.ts';
import type { ToolCall, ToolOutcome, ToolSession } from './gateway.ts';
import type { ModelCallMeta } from './models.ts';

// ── 通用的一次角色调用（agents/episode.ts） ───────────────────────────────

export type Transcript = readonly unknown[];

/**
 * 一次角色调用：新建一个 Harness agent，串行执行工具，sessionId 取 meta.sessionId。
 * 初始上下文来自 Layout，后续历史与可选自动压缩由 Harness 管理；调用结束释放内存会话。
 */
export interface RoleCallRequest {
  meta: ModelCallMeta;
  layout: Layout;
  session: ToolSession;
  /**
   * 上下文用到模型窗口的 ratio，或到了 tokens 个 token（给了的话，两者先到的算；episode.contextHint、contextTokens）时，
   * 用 steer 追加一次 text；给了 onReached 就改为调用它（传当时的上下文 token 数），由调用方自己追加（Explorer 的收尾线）
   */
  contextHint?: { ratio: number; text: string; tokens?: number; onReached?: (tokens: number) => void };
  /** 模型停下却没调用收尾工具时追加的话（closing.check）；默认提醒一次，再不收尾就是 no_close */
  closeReminder: string;
  /** 长会话持续执行、纠错，直到合法收尾、取消、超时或模型错误，不按通用失败次数退出。 */
  continueUntilClosed?: boolean;
  /** 角色特有的参数处理；failures 是 runner 统一累计的提交失败数（schema 与语义错误共用）。 */
  prepareArguments?: (spec: ToolSpec, raw: unknown, failures: number) => unknown;
  /** 每次工具调用完成后调用；Explorer 用它数工具调用、到点追加提示 */
  onToolResult?: (call: ToolCall, outcome: ToolOutcome) => void;

  keepTranscript?: boolean;
  /** 每次请求前读取最新系统提示；领域和完成标准确定后可更新，保留当前对话。 */
  systemPrompt?: () => string;
  /**
   * 每次请求前现读的参考材料（巡检器地图），以独立 user 消息放在 system 之后，JSON 字段为 referenceContext。
   * 只用于当前正常求解请求，不写入系统提示、对话历史或压缩摘要。没有就是 undefined。
   */
  referenceContext?: () => string | undefined;
  /**
   * Harness 自动压缩：按窗口比例和模型输出预留决定触发点，保留最近 keep 比例的可用输入预算。
   * 原始历史保留在会话日志，后续请求读取摘要与最近消息；确认超窗时压缩并重试。
   * 首次失败调 onFailed 并停止主动压缩，仍保留超窗恢复。
   */
  compact?: CompactOptions;
}

/** RoleCallRequest.compact */
export interface CompactOptions {
  /** 上下文到模型窗口的这个比例时压缩 */
  ratio: number;
  /** 最近消息原样保留的比例，基数是模型窗口减去输出预留 */
  keep: number;
  /** 压完一次：压之前、之后估的上下文 token 数，压进摘要的消息条数 */
  onCompacted?: (info: { before: number; after: number; messages: number }) => void;
  onFailed?: (error: unknown) => void;
}

export type RoleCallOutcome =
  | { kind: 'closed'; tool: ClosingToolName; args: unknown } // 收尾或提交工具被接受
  | { kind: 'no_close' } // 模型停下，提醒一次仍不收尾
  | { kind: 'context_overflow' } // 上下文撑爆了模型窗口
  | { kind: 'model_error'; message: string } // 模型的回复用不了：修一次仍不合 schema、请求被拒的其他 4xx
  | { kind: 'aborted'; reason: string }; // kill、Run 取消

export interface RoleCallResult {
  outcome: RoleCallOutcome;
  toolCalls: number;
  turns: number;
  usage: UsageTotals;
  /** 调用结束时的整段对话；keepTranscript 时才给 */
  transcript?: Transcript;
}

export interface RoleCallHandle {
  /** 从当前对话生成简短文字交接，不改变正在执行的会话。 */
  /** 供宿主生成交接的当前对话材料；读取本身不调用模型。 */
  handoffMaterial?(): string;
  readonly done: Promise<RoleCallResult>;
  /** 追加到消息末尾（agent.steer）：收尾提示、检查点提示、收件箱新内容、暂停提示、人发的指令 */
  steer(text: string): void;
}

export interface RoleCallRunner {
  start(req: RoleCallRequest): RoleCallHandle;
}

// ── Explorer（agents/explorer.ts）：只跑一个 episode ─────────────────────

export interface EpisodeInput {
  run: Run;
  branch: Branch;
  bet: Bet;
  layout: Layout;
  session: ToolSession;
  signal: AbortSignal;
  /** 同 RoleCallRequest.systemPrompt，Explorer 原样转交，供运行时同步任务规则。 */
  systemPrompt?: () => string;
  /** 同 RoleCallRequest.referenceContext，Explorer 原样转给 RoleCallRunner（主干直解路线的巡检器地图） */
  referenceContext?: () => string | undefined;
}

/**
 * 被中止（kill、Run 取消、收尾、退出 Melina）时既没有 close 也没有 failure：runtime 以自己的 AbortSignal 为准，整个丢掉、不收尾。
 * 没被中止却两样都没有，按 no_close 算。已经交上来 close 的（比如提交了候选），后到的 kill、取消要等它落库再执行
 */
export interface EpisodeOutcome {
  /** 合法的收尾；没有就是失败的 episode */
  close?: CloseOutcome;
  failure?: EpisodeFailure;
  /**
   * 失败的原因，一句人话（model_error 时是模型层的出错原因，截短、遮掉像密钥的串）。runtime 写进下一个 episode 的失败提示，
   * 好让它避开同样的错；分支因连续失败转 failed 时写进 stateNote，人看得懂为什么停
   */
  failureDetail?: string;
  /** 本 episode 的工具调用数（口径同 Branch.toolCalls） */
  toolCalls: number;
  /** 分支消息看到了哪个 seq：Layout.seenSeq，或 episode 中途追加的内容里最大的 seq */
  seenSeq: number;
  usage: UsageTotals;
}

export interface EpisodeHandle {
  handoffMaterial?(): string;
  readonly done: Promise<EpisodeOutcome>;
  /** runtime 追加内容；seenSeq 是这段分支消息里最大的 seq，提示类的不给 */
  steer(text: string, seenSeq?: number): void;
}

export interface ExplorerAgent {
  /** 跑一个持续会话，处理动态追加的分支消息和观察地图。 */
  startEpisode(input: EpisodeInput): EpisodeHandle;
}

// ── Scoper（agents/scoper.ts） ───────────────────────────────────────────

export interface ScoperOutcome {
  output: ScoperOutput;
  /** 修一次仍不合 schema 时降级：目标原文当唯一的完成条目，interpretation 写「按字面理解」，domain 用 general */
  degraded: boolean;
}

export interface ScoperAgent {
  scope(input: { run: Run; layout: Layout; session: ToolSession; signal: AbortSignal }): Promise<ScoperOutcome>;
}

// ── 终局选择（agents/select-version.ts） ─────────────────────────────────────

/** 挑中的那一版和理由（理由给人看） */
export interface PickResult {
  candidateId: Id;
  why: string;
  /** 上下文是 RunStore 的哪一刻拼的（Layout.basedOnSeq）：写进 version.picked，停下时据此判挑完以后有没有新记录 */
  basedOnSeq: number;
}

// ── 巡检器（agents/watcher.ts） ──────────────────────────────────

/** 巡检器一轮的已发布版本及固定窗口截止点。 */
export interface WatchResult {
  published: WatchNote;
  /** 实际冻结的窗口终点，用于部分提交后的追赶。 */
  windowUntilSeq: number;
}

export interface WatcherAgent {
  /**
   * 一轮：看主干直解路线在上一版之后、request.untilSeq 以前做了什么，交回已发布的这一版看法。模型由它挑：watch.model 写了用它，
   * 没写用这条路线自己的模型（author），那家没 key、在熔断时换和它不同家的。没交出来（模型的回复用不了、停下没交、
   * 上下文撑爆）抛 unavailable，被取消抛 conflict。提交工具在成功返回前完成合并和持久化；调度器不再发布草稿。
   */
  watch(input: {
    run: Run;
    request: WatchRequest;
    author: ModelRef;
    signal: AbortSignal;
    closing?: AbortSignal;
  }): Promise<WatchResult>;
}

/** 终局选择函数：输入冻结的各版内容，输出选择；不持有角色会话。 */
export type SelectVersion = (input: {
  run: Run;
  request: PickRequest;
  model: ModelRef;
  signal: AbortSignal;
}) => Promise<PickResult>;
