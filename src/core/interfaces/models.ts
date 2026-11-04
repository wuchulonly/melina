// 模型层的公共契约，供应商传输类型由 models/protocol.ts 定义。

import type { ProviderStatus } from '../events.ts';
import type { Id } from '../ids.ts';
import type { ModelChoice, ModelRef, Tier } from '../model-ref.ts';
import type { Role } from '../types.ts';
import type { JobKind } from './scheduler.ts';

export type ModelFailureKind = 'provider' | 'model' | 'context' | 'queue' | 'unknown';

/** 一次角色调用里，每次模型调用都带的信息：向 Scheduler 要槽位、记账、选缓存路由 */
export interface ModelCallMeta {
  runId: Id;
  branchId?: Id;
  role: Role;
  job: JobKind;

  sessionId: string;
  model: ModelRef;
  signal?: AbortSignal;
  /** 供后台角色按明确原因退避；成功清空，不以熔断状态推断本次请求是否正常。 */
  onFailure?: (kind: ModelFailureKind | undefined) => void;
}

/**
 * models/stream.ts 的 melinaStream：先向 Scheduler 申请槽位和令牌桶，返回后按 usage 记账；
 * 供应商那边的错（限流、过载、5xx、断开、model.idleTimeoutMs 没动静）退避重试 retries.model 次再熔断、换备用模型，不算分支失败；
 * 401、403、额度用完不重试：这家配了几个 key 就先换下一个 key，都用不了才熔断。供应商 SDK 自带的重试关掉（maxRetries: 0）。
 */
export type MelinaStreamFactory<StreamFn = unknown> = (meta: ModelCallMeta) => StreamFn;

/** 模型配置、分档和备用顺序（models/registry.ts）；模型信息取 DeepSeek 目录 */
export interface ModelRegistry {
  /** 档位换成那一档的首选模型；具体的模型原样返回 */
  resolve(choice: ModelChoice): ModelRef;
  /** 一档里的模型，按顺序：第一个是首选，后面是熔断时的备用 */
  tier(tier: Tier): ModelRef[];

  allowed(): ModelRef[];
  isAllowed(ref: Pick<ModelRef, 'provider' | 'model'>): boolean;
  /** models.fallback：同档位的下一个模型；没有就是 undefined */
  fallback(ref: ModelRef): ModelRef | undefined;
  /** 上下文窗口（token），episode.contextHint 用 */
  contextWindow(ref: Pick<ModelRef, 'provider' | 'model'>): number | undefined;
  providers(): string[];
  /** 各供应商的熔断状态和每个 API key 的状况，GET /status 和 system.updated 用 */
  breakers(): Pick<ProviderStatus, 'provider' | 'breaker' | 'reason' | 'fallbackTo' | 'keys'>[];
}

/** 无工具的一次生成；共用调度、重试、取消和记账，不创建角色会话。 */
export type TextGenerator = (input: { meta: ModelCallMeta; system: string; prompt: string }) => Promise<string>;
