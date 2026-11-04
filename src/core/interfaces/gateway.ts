// ToolGateway。实现在 src/tools/。
//

// session.tools 是可执行的工具，顺序和 ContextAssembler 给模型的工具定义一致；agents/harness.ts 把它们注册成 Harness 工具，
// 执行工具前由 session.check 校验。这里不出现 Harness 的类型。
//
// 一次环境工具调用：角色检查和参数校验→ sh 调用先写 sh.intent → 在调用方的容器里带超时执行 →
// 原文进 Artifact store、放进本分支的 /melina/artifacts 视图 → 超过 toolOutput.inlineMaxTokens 只回摘要和只读路径 →
// 写 Observation，返回 { observationId, summary, path? }。

import type { Id, SnapshotId } from '../ids.ts';
import type { ModelRef } from '../model-ref.ts';
import type { ClosingToolName, ToolSpec } from '../tools.ts';
import type { Role, WatchNote, WorkspaceRef } from '../types.ts';
import type { ContainerRef } from './container.ts';
import type { WatchContext, WatchRequest } from './context.ts';

/** 模型发起的一次工具调用 */
export interface ToolCall {
  id: string; // 供应商给的 tool call id
  name: string;
  args: unknown; // 已经按参数 schema 校验过（Harness 执行层做）
}

/** 工具执行的结果，原样回给模型 */
export interface ToolOutcome {
  /** 给模型看的内容：环境工具是 EnvToolResult 的 JSON，内置工具是 RecordResult 或查询结果的 JSON，出错是一句说明 */
  content: string;
  isError: boolean;
  /** 收尾工具和提交工具被接受时为 true：结束这次角色调用（Harness concludeTurn） */
  terminate?: boolean;
  observationId?: Id;
}

export interface MelinaTool {
  spec: ToolSpec;
  /** 每次模型请求前检查；不可用的工具从该会话声明中暂时移除，执行入口仍须兜底。 */
  available?(): boolean;
  /** 模型声明保持严格；执行前只做可核对的输入整理，须幂等且不得写业务记录。 */
  normalizeArguments?(raw: unknown): unknown;
  run(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
}

/** 这次角色调用是谁、在哪执行 */
export interface CallerContext {
  runId: Id;
  role: Role;
  /** Explorer 的分支；巡检器是它看的那条分支（读的账记在这条分支上） */
  branchId?: Id;
  episode?: number;
  /** 本 episode 的起点 snapshot，写进 Observation.snapshot */
  snapshot: SnapshotId;

  container?: ContainerRef;
  workspace?: WorkspaceRef;
  readOnly: boolean;
}

export interface ToolSessionOptions {
  /** 工具边界的只读通知；宿主可在提交等状态跃迁时启动后台观察。 */
  onToolIntent?: (call: ToolCall) => void;
  /** 观察者的冻结输入；提交工具在落库成功后才结束会话。 */
  observation?: {
    request: WatchRequest;
    input: WatchContext;
    model: ModelRef;
    /** 只进入收尾阶段，不取消正在生成的请求。 */
    closing?: AbortSignal;
    /** 本轮原文补查次数；默认使用宿主预算，批量读取仍算一次。 */
    contextLimit?: number;
  };
  /**
   * 收尾工具、提交工具交上来时的语义检查（参数 schema 已经过了），例如候选未满足外部验收。
   * 返回错误说明就回给模型改了重发；返回 undefined 就接受并结束。
   */
  onClose?: (tool: ClosingToolName, args: unknown) => string | undefined;
}

export interface ToolSession {
  /** 在两次工具执行之间保存现场，期间新调用排在存档之后。 */
  checkpoint?(save: () => Promise<void>): Promise<boolean>;
  readonly caller: CallerContext;
  readonly tools: readonly MelinaTool[];
  /** observation_submit 已经持久化的版本；runtime 不再重复发布。 */
  readonly publishedWatch?: WatchNote;
  /**
   * 工具执行前的检查：turn 是同一轮输出里的全部工具调用。返回拒绝原因，模型会看到；返回 undefined 放行。
   * 拒绝的情况：角色不许用；收尾工具、deliver 和别的工具同一轮出现（提示单独重发，、）。
   */
  check(call: ToolCall, turn: readonly ToolCall[]): string | undefined;
  /** 到现在为止的工具调用数，口径同 Branch.toolCalls：环境工具 */
  readonly toolCalls: number;
  /** 被接受的那次收尾或提交；end_episode 的 args 为 CloseOutcome，还没有就是 undefined */
  closed(): { tool: ClosingToolName; args: unknown } | undefined;
}

export interface ToolGateway {
  open(caller: CallerContext, options?: ToolSessionOptions): ToolSession;
}
