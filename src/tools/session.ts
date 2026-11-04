// ToolGateway 一次会话（一次角色调用）里各个工具共用的东西：依赖、调用方、会话状态、结果的写法。

import type { TSchema } from 'typebox';
import { isMelinaError } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { ContainerRuntime, Redactor } from '../core/interfaces/container.ts';
import type { CallerContext, ToolCall, ToolOutcome } from '../core/interfaces/gateway.ts';
import type { UsageLedger } from '../core/interfaces/ledger.ts';
import type { Scheduler, Slot } from '../core/interfaces/scheduler.ts';
import type { EventBus, RunStoreQueries, RunStoreWriter } from '../core/interfaces/store.ts';
import type { ClosingToolName, ToolSpec } from '../core/tools.ts';
import type { Bet, Branch, Candidate, CompletionSpec, Role, Run, WatchNote } from '../core/types.ts';
import type { RunningCommands } from './running.ts';
import type { ArtifactViews } from './views.ts';

export interface GatewayDeps {
  writer: Pick<RunStoreWriter, 'appendObservation' | 'appendShIntent' | 'recordWatch'>;
  queries: RunStoreQueries;
  /**
   * 求解分支可先开跑；交候选时若完成标准仍在起草，提交工具通过事件总线等待 completion.drafted。
   * 不给就不等，按没有完成标准查（只跑 RunStore 的测试）
   */
  bus?: Pick<EventBus, 'subscribe'>;
  artifacts: Pick<ArtifactStore, 'put' | 'readLines' | 'path' | 'has'>;
  runtime: Pick<ContainerRuntime, 'exec'>;
  /** 工具层的名额：在容器里执行环境工具前要一个，执行完就还；不给就不排队（测试） */
  toolSlots?: Pick<Scheduler, 'toolSlot'>;
  /** 落盘和返回之前把凭证值换掉 */
  redactor: Pick<Redactor, 'redact'>;
  views: ArtifactViews;
  ledger?: Pick<UsageLedger, 'tool'>;
  /** 可选的领域（GlobalConfig.domains）：submit_completion 只能从里面选 */
  domains?: () => readonly string[];
  /** 由进程入口显式加载的工具扩展；默认没有。 */
  extensions?: readonly ToolExtension[];
  /** 可选提交检查，按注册顺序执行；不改变普通工具的执行。 */
  submissionGuards?: readonly SubmissionGuard[];
  /** 无副作用的同步策略，预检与实际执行前都会重新检查。 */
  toolChecks?: readonly ToolCheck[];
  /** 参数通过后、工具执行前的异步准备；返回原因则不执行工具。 */
  beforeTools?: readonly BeforeTool[];
  /** deliver 的执行：打 snapshot、写成一版（runtime 的 BranchRunners.deliver）；不给就告诉模型现在用不了 */
  deliver?: VersionDesk;
  newId?: () => Id;
  /** 不影响工具结果的问题（记账、放视图出错）记到系统日志，不进模型上下文 */
  onError?: (error: unknown, what: string) => void;
  /** 可舍弃的记账问题，只进系统日志 */
  onNotice?: (text: string) => void;
  /** read、edit、write 在容器里执行的超时，默认 60 秒 */
  fileTimeoutMs?: number;
  /** 正在跑的 sh 命令：撞了资源上限时记下同时在跑命令的别的路线；不给就不记（测试） */
  running?: RunningCommands;
}

export type SubmissionGuard = (
  env: ToolEnv,
  submission: { readonly tool: ClosingToolName; readonly args: unknown },
  signal: AbortSignal,
) => Promise<string | { again: string } | undefined>;

export type ToolCheck = (env: ToolEnv, call: Pick<ToolCall, 'name' | 'args'>) => string | undefined;
export type BeforeTool = (env: ToolEnv, call: ToolCall, signal: AbortSignal) => Promise<string | undefined>;

export function checkTool(env: ToolEnv, call: Pick<ToolCall, 'name' | 'args'>): string | undefined {
  for (const check of env.deps.toolChecks ?? []) {
    const reason = check(env, call);
    if (reason !== undefined) return reason;
  }
  return undefined;
}
export interface VersionDesk {
  deliver(req: {
    runId: Id;
    branchId: Id;
    version: { episode: number; claim: string; artifact?: string | undefined };
  }): Promise<{ candidate: Candidate }>;
}

export interface SessionState {
  publishedWatch?: WatchNote;
  toolCalls: number;
  closed?: { tool: ClosingToolName; args: unknown };
}

/** 外部工具只在声明的角色和分支种类中注册，执行仍通过同一个网关。 */
export interface ToolExtension {
  /** 观察者扩展折入 observation_submit 的可选字段，不再暴露第三个工具。 */
  observation?: {
    field: string;
    parameters: TSchema;
    arguments: (value: unknown) => unknown;
    /** 无写入的预检，与登记共用校验；在任何扩展产生副作用前聚合全部问题。 */
    validate?: (env: ToolEnv, value: unknown, signal: AbortSignal) => Promise<string[]>;
  };
  spec: ToolSpec;
  roles: readonly Role[];
  run(env: ToolEnv, args: unknown, signal: AbortSignal): Promise<ToolOutcome>;
  inspect?: (env: ToolEnv) => OutputInspector | undefined;
}

/** 原始输出落盘前的可选检查；存档之后再提交与 Observation 绑定的元数据。 */
export interface OutputInspector {
  inspect(output: string): string;
  finish(outcome: ToolOutcome): Promise<ToolOutcome>;
}

/** 一次会话的环境：每个工具执行时都拿到它 */
export interface ToolEnv {
  /** 观察者扩展引用证据时必须遵守本轮截止点。 */
  observationUntilSeq?: number;
  /** 已提供的独立状态证据；仅这些 id 可以越过历史覆盖水位。 */
  observationStateRefs?: ReadonlySet<Id>;
  deps: Required<Pick<GatewayDeps, 'newId' | 'onError' | 'fileTimeoutMs'>> & GatewayDeps;
  caller: CallerContext;
  /**
   * 开会话时的 Run。config 开跑后不变；完成标准、约束等可能在会话开始后才由 Scoper 补齐。
   * 需要最新任务信息时用 currentRun。
   */
  run: Run;
  /** Explorer 或带分支的巡检会话：开始时的分支（toolCalls 是此时的累计数，检查点从这里算）。 */
  branch?: Branch;
  bet?: Bet;
  state: SessionState;
  /** 视图补齐以后才执行环境工具：episode 开头把看得到的原文放进 /melina/artifacts */
  ready: Promise<void>;
}

export function ok(value: unknown, extra: Partial<ToolOutcome> = {}): ToolOutcome {
  return { content: typeof value === 'string' ? value : JSON.stringify(value), isError: false, ...extra };
}

export function fail(message: string, extra: Partial<ToolOutcome> = {}): ToolOutcome {
  return { content: message, isError: true, ...extra };
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 工具执行出错：MelinaError 的信息本来就是写给模型看的，原样回去；其余的记日志，回一句 */
export function failFrom(env: ToolEnv, error: unknown, what: string): ToolOutcome {
  if (isMelinaError(error) && error.code !== 'internal') return fail(error.message);
  env.deps.onError(error, what);
  return fail(`${what}出错了：${messageOf(error)}`);
}

/**
 * 在容器里执行一条环境工具命令之前要工具层的名额；等的时候被取消返回 undefined。
 * 没接 Scheduler 时马上给一个空的
 */
export async function toolSlot(env: ToolEnv, signal: AbortSignal): Promise<Slot | undefined> {
  const slots = env.deps.toolSlots;
  if (!slots) return { release: () => {} };
  try {
    return await slots.toolSlot(
      { runId: env.run.id, ...(env.caller.branchId !== undefined ? { branchId: env.caller.branchId } : {}) },
      signal,
    );
  } catch (error) {
    if (signal.aborted) return undefined;
    throw error;
  }
}

/** 本分支的 viewer；没有分支的角色看不到分支私有的东西 */
export function branchOf(env: ToolEnv): Branch {
  if (!env.branch) throw new Error('这个调用不属于任何分支');
  return env.branch;
}

/** 这一刻的 Run：完成标准、约束是 Scoper 起草完才有的，可能在开会话以后；取不到就用开会话时的 */
export function currentRun(env: ToolEnv): Run {
  return env.deps.queries.getRun(env.run.id) ?? env.run;
}

/**
 * 等这个 Run 的完成标准定好（completion.drafted）再返回它；已有标准就马上返回。Scoper 与求解分支并行运行；
 * 任务结束、分支被叫停（signal）就不等了，返回 undefined。没接事件总线时不等，返回现在的（可能没有）
 */
export function completionOf(env: ToolEnv, signal: AbortSignal): Promise<CompletionSpec | undefined> {
  const now = () => currentRun(env).goal.completion;
  const bus = env.deps.bus;
  if (!bus || now() || signal.aborted) return Promise.resolve(signal.aborted ? undefined : now());
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const done = () => {
      unsubscribe();
      signal.removeEventListener('abort', done);
      resolve(signal.aborted ? undefined : now());
    };
    unsubscribe = bus.subscribe(done, { runId: env.run.id, types: ['completion.drafted'] });
    signal.addEventListener('abort', done, { once: true });
    if (now()) done(); // 查和订阅之间刚好落了库
  });
}

export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out as T;
  }
  return value;
}
export function emptyState(): SessionState {
  return { toolCalls: 0 };
}
