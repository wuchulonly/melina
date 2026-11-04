// 角色调用统一由 DeepSeek Harness 驱动；此处保留项目调用入口与诊断格式。
import type { UsageTotals } from '../core/events.ts';
import type { RoleCallRunner } from '../core/interfaces/agents.ts';
import type { ToolSession } from '../core/interfaces/gateway.ts';
import type { MelinaStreamFactory, ModelCallMeta } from '../core/interfaces/models.ts';
import { createHarnessAdapterFactory } from '../models/harness.ts';
import type { StreamFn } from '../models/protocol.ts';
import type { MelinaModelRegistry } from '../models/registry.ts';
import { createHarnessRunner } from './harness.ts';
export interface RoleCallDeps {
  stream: MelinaStreamFactory<StreamFn>;
  registry: Pick<MelinaModelRegistry, 'model' | 'contextWindow' | 'providers'>;
  /** 思考级别：默认见 defaultThinking；由 DeepSeek 适配器匹配模型能力 */
  thinking?: (meta: ModelCallMeta) => string;
  /** 只进系统日志的事：提交工具的参数挪了位置、去掉了什么（agents/tool-args.ts） */
  onNotice?: (text: string) => void;
  /** 仅正常回复中的可见文字；不含 thinking、压缩摘要或工具参数。 */
  publicText?: (caller: ToolSession['caller'], text: string) => void;
  /**
   * 记回复原文，只给开发脚本用：每次回复、
   * 每个工具结果、追加给模型的话各一条，量改提示词、改收尾以后每步想了多少、被退回几次。它抛的错不影响这次调用
   */
  transcript?: (entry: TranscriptEntry) => void;
}

/**
 * 回复原文的一条（RoleCallDeps.transcript）。reply 是一次回复，compact 是长会话压缩那次的回复；result 是一个工具结果
 * （blocked：被 session.check 拦下、没有执行）；steer 是开头那条以后追加给模型的话（提醒收尾、收件箱新到的内容这类）
 */
export type TranscriptEntry = TranscriptHead & TranscriptBody;

interface TranscriptHead {
  /** 毫秒时间戳 */
  at: number;
  runId: string;
  branchId?: string;
  role: ModelCallMeta['role'];
  job: ModelCallMeta['job'];
  sessionId: string;
}

export type TranscriptBody =
  | {
      kind: 'reply' | 'compact';
      /** 实际回答的模型（熔断时可能换成了备用）：供应商/模型 */
      model: string;
      thinking: string;
      text: string;
      toolCalls: { id: string; name: string; args: unknown }[];
      stopReason: string;
      error?: string;
      usage: UsageTotals;
    }
  | { kind: 'result'; toolCallId: string; tool: string; isError: boolean; blocked: boolean; text: string }
  | { kind: 'steer'; text: string };

export function defaultThinking(meta: ModelCallMeta): string {
  if (meta.role === 'watcher') return 'low';
  return meta.model.tier === 'strong' ? 'high' : 'low';
}

export function createRoleCallRunner(deps: RoleCallDeps): RoleCallRunner {
  return createHarnessRunner({
    ...deps,
    thinking: deps.thinking ?? defaultThinking,
    adapter: createHarnessAdapterFactory(deps),
  });
}
