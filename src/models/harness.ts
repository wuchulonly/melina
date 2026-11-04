// Harness 的模型适配器：复用 Melina 的供应商路由、重试、取消和记账；会话由 dsh-agent-loop 驱动。
import {
  type ContentBlock,
  type GenerateOptions,
  LlmAdapter,
  type LlmResolvedModelInfo,
  ReasoningEffortId,
  type ReplayEnvelope,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { UsageTotals } from '../core/events.ts';
import type { MelinaStreamFactory, ModelCallMeta } from '../core/interfaces/models.ts';
import { fromHarnessBlock, toHarnessBlock } from './messages.ts';
import type { StreamFn } from './protocol.ts';
import { type Message, normalizeContext } from './protocol.ts';
import type { MelinaModelRegistry } from './registry.ts';

export interface HarnessReply {
  provider: string;
  model: string;
  content: ContentBlock[];
  usage: UsageTotals;
  stopReason: string;
  error?: string;
  failureCode?: string;
  purpose?: GenerateOptions['purpose'];
}

export type HarnessAdapterFactory = (
  meta: ModelCallMeta,
  reply: (reply: HarnessReply) => void,
  referenceContext?: () => string | undefined,
) => LlmAdapter;

export function createHarnessAdapterFactory(deps: {
  stream: MelinaStreamFactory<StreamFn>;
  registry: Pick<MelinaModelRegistry, 'model'>;
  reasoning?: (meta: ModelCallMeta) => string;
}): HarnessAdapterFactory {
  return (meta, reply, referenceContext) => new MelinaHarnessAdapter(deps, meta, reply, referenceContext);
}

class MelinaHarnessAdapter extends LlmAdapter {
  private readonly deps: Parameters<typeof createHarnessAdapterFactory>[0];
  private readonly meta: ModelCallMeta;
  private readonly reply: (reply: HarnessReply) => void;
  private readonly referenceContext?: () => string | undefined;
  constructor(
    deps: Parameters<typeof createHarnessAdapterFactory>[0],
    meta: ModelCallMeta,
    reply: (reply: HarnessReply) => void,
    referenceContext?: () => string | undefined,
  ) {
    super();
    this.deps = deps;
    this.meta = meta;
    this.reply = reply;
    this.referenceContext = referenceContext;
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = this.deps.registry.model({ provider, model });
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: info.contextWindow },
      defaultMaxTokens: info.maxTokens,
      // Melina's transport resolves each provider's supported reasoning levels.
      reasoning: { efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id: ReasoningEffortId(id), name: id })) },
    });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages.flatMap(toModelMessage);
    const names = new Map(
      messages.flatMap((m) =>
        m.role === 'assistant'
          ? m.content.flatMap((b) => (b.type === 'toolCall' ? [[b.id, b.name] as const] : []))
          : [],
      ),
    );
    for (const m of messages) if (m.role === 'toolResult') m.toolName = names.get(m.toolCallId) ?? '';
    const head = messages[0];
    const tools = options.tools?.map((tool) => ({ ...tool }));
    if (head?.role === 'system') head.toolsAdded = tools;
    else if (tools?.length || options.system)
      messages.unshift({ role: 'system', content: options.system ?? '', toolsAdded: tools, timestamp: Date.now() });
    // 派生判断只作为本次请求的参考材料，不进入系统提示、会话历史或压缩摘要。
    const referenceContext = options.purpose ? undefined : this.referenceContext?.();
    if (referenceContext)
      messages.splice(messages[0]?.role === 'system' ? 1 : 0, 0, {
        role: 'user',
        content: JSON.stringify({ referenceContext }),
        timestamp: Date.now(),
      });
    const model = this.deps.registry.model({ provider: options.provider, model: options.model });
    const response = await this.deps.stream(this.meta)(model, normalizeContext({ messages }), {
      signal: options.signal,
      purpose: options.purpose,
      reasoning:
        options.reasoningEffort ??
        (options.purpose === 'compaction' ? 'low' : (this.deps.reasoning?.(this.meta) ?? 'high')),
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    });
    const message = await response.result();
    const content = message.content.map(toHarnessBlock);
    const usage: UsageTotals = {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      usd: message.usage.cost.total,
    };
    this.reply({
      provider: message.provider,
      model: message.model,
      content,
      usage,
      stopReason: message.stopReason,
      ...(message.failureCode ? { failureCode: message.failureCode } : {}),
      ...(message.errorMessage ? { error: message.errorMessage } : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
    });
    for (const [index, block] of content.entries()) {
      yield { type: 'block-start', index, blockType: block.type };
      yield { type: 'block-end', index, block };
    }
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
      },
    };
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      yield {
        type: 'finish',
        reason: {
          kind: message.stopReason,
          failure: { code: message.failureCode ?? 'MODEL_ERROR', message: message.errorMessage ?? message.stopReason },
        },
      };
    } else {
      yield {
        type: 'finish',
        reason: {
          kind:
            message.stopReason === 'toolUse' ? 'tool-calls' : message.stopReason === 'length' ? 'max-tokens' : 'stop',
        },
        ...(message.replayState ? { replayState: message.replayState as ReplayEnvelope } : {}),
      };
    }
  }
}

export function toModelMessage(message: RequestMessage): Message[] {
  const timestamp = Date.now();
  if (message.role === 'developer') return [{ role: 'user', content: textOf(message.content), timestamp }];
  if (message.role === 'system') return [{ role: 'system', content: textOf(message.content), timestamp }];
  if (message.role === 'user') return [{ role: 'user', content: textOf(message.content), timestamp }];
  if (message.role === 'tool')
    return [
      {
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: '',
        content: [{ type: 'text', text: textOf(message.content) }],
        isError: !!message.isError,
        timestamp,
      },
    ];
  return [
    {
      role: 'assistant',
      provider: message.source.provider,
      model: message.source.model,
      api: 'deepseek-messages',
      content: message.content.flatMap(fromHarnessBlock),
      ...(message.source.replayState ? { replayState: message.source.replayState } : {}),
      stopReason: message.content.some((block) => block.type === 'tool-call') ? 'toolUse' : 'stop',
      timestamp,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ];
}

export function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}
