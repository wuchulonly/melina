// 只注册 DeepSeek：请求、思考签名和工具协议均由官方 Harness 适配器处理。

import { randomUUID } from 'node:crypto';
import { LlmError, type ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, type DeepSeekAdapterOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { SessionId } from '@deepseek-ai/dsh-session';
import { fromHarnessBlock, toHarnessMessage } from './messages.ts';
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from './protocol.ts';

const HARNESS_USER_ID = randomUUID();

export function builtinProviders(): Provider[] {
  return [deepseekProvider()];
}
export function deepseekProvider(): Provider {
  const model = (id: string, name: string, input: number, output: number, cacheRead: number): Model => ({
    id,
    name,
    provider: 'deepseek',
    api: 'deepseek-messages',
    baseUrl: 'https://api.deepseek.com/anthropic',
    reasoning: true,
    input: ['text'],
    contextWindow: 1_000_000,
    maxTokens: 256_000,
    cost: { input, output, cacheRead, cacheWrite: 0 },
  });
  const models = [
    model('deepseek-flash', 'DeepSeek V4.1 Flash', 0.3, 1.2, 0.006),
    model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1.32, 3.96, 0.044),
  ];
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: models[0]?.baseUrl,
    getModels: () => models,
    stream: nativeStream,
    streamSimple: nativeStream,
  };
}
function nativeStream(model: Model, context: TranscriptContext, options: SimpleStreamOptions = {}) {
  const out = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  void (async () => {
    try {
      if (!options.apiKey) throw new Error(`No API key for provider ${model.provider}`);
      const connection = resolveAdapterOptions({
        baseURL: model.baseUrl,
        maxTokens: model.maxTokens,
        streamIdleTimeoutMs: options.timeoutMs ?? 900_000,
        models: [{ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
        retryPolicy: { mode: 'normal', maxRetries: 0 },
      });
      const adapter = new DeepSeekAdapter({
        options: () => connection,
        resolveAuth: async () => ({ headers: { 'x-api-key': options.apiKey as string } }),
        resolveUserId: () => HARNESS_USER_ID as ReturnType<DeepSeekAdapterOptions['resolveUserId']>,
        prepareExtensions: async () => ({
          fields: {},
          accept: async () => {
            await options.onResponse?.({ status: 200, headers: {} }, model);
          },
        }),
      });
      const systems = context.messages.filter((m) => m.role === 'system');
      const tools = systems.flatMap((m) => m.toolsAdded ?? []);
      const effort =
        model.id === 'deepseek-v4-pro' && options.reasoning !== 'off' && options.reasoning !== 'max'
          ? 'high'
          : options.reasoning === 'off' || options.reasoning === 'low' || options.reasoning === 'max'
            ? options.reasoning
            : 'high';
      for await (const chunk of adapter.stream({
        provider: model.provider,
        model: model.id,
        messages: context.messages.map(toHarnessMessage),
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters as Record<string, unknown>,
              })),
            }
          : {}),
        purpose: options.purpose,
        signal: options.signal,
        reasoningEffort: effort as ReasoningEffortId,
        sessionId: options.sessionId ? SessionId(options.sessionId) : undefined,
        maxTokens: options.maxTokens ?? model.maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      })) {
        if (chunk.type === 'block-end') message.content.push(...fromHarnessBlock(chunk.block));
        else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')
          out.push({
            type:
              chunk.type === 'text-delta'
                ? 'text_delta'
                : chunk.type === 'reasoning-delta'
                  ? 'thinking_delta'
                  : 'toolcall_delta',
            delta: chunk.type === 'tool-call-delta' ? (chunk.argumentsDelta ?? '') : chunk.text,
            partial: message,
          });
        else if (chunk.type === 'usage') {
          const u = chunk.usage;
          message.usage.input = u.inputTokens ?? 0;
          message.usage.output = u.outputTokens ?? 0;
          message.usage.cacheRead = u.cacheReadTokens ?? 0;
          message.usage.cacheWrite = u.cacheWriteTokens ?? 0;
        } else if (chunk.type === 'finish') {
          message.stopReason =
            chunk.reason.kind === 'tool-calls'
              ? 'toolUse'
              : chunk.reason.kind === 'max-tokens'
                ? 'length'
                : chunk.reason.kind;
          message.replayState = chunk.replayState;
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            message.errorMessage = chunk.reason.failure.message;
            message.failureCode = chunk.reason.failure.code;
          }
        }
      }
    } catch (error) {
      if (error instanceof LlmError && error.failure.status !== undefined)
        await options.onResponse?.(
          {
            status: error.failure.status,
            headers: error.failure.providerRetryAfterMs
              ? { 'retry-after-ms': String(error.failure.providerRetryAfterMs) }
              : {},
          },
          model,
        );
      // rc.2 在发出完整工具块后、usage/finish 前才检查参数 JSON。
      // 只把这一处校验交回工具层，保留原文供修复或 INVALID_ARGS 自纠。
      if (
        !options.signal?.aborted &&
        error instanceof LlmError &&
        error.code === 'MALFORMED_RESPONSE' &&
        error.message === 'DeepSeek Messages stream: tool input is invalid JSON' &&
        message.content.some((block) => block.type === 'toolCall' && block.argumentsError)
      ) {
        message.stopReason = 'toolUse';
      } else {
        message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        if (error instanceof LlmError) message.failureCode = error.code;
        message.errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
    const u = message.usage;
    u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
      u.cost[key] = (u[key] * model.cost[key]) / 1_000_000;
    u.cost.total = u.cost.input + u.cost.output + u.cost.cacheRead + u.cost.cacheWrite;
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      out.push({ type: 'error', reason: message.stopReason, error: message });
    else out.push({ type: 'done', reason: message.stopReason, message });
    out.end(message);
  })();
  return out;
}
