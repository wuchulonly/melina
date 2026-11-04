// 测试用模型脚本；与生产传输解耦。
import { randomUUID } from 'node:crypto';
import {
  type AssistantContent,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type ToolCall,
  type TranscriptContext,
} from '../../../src/models/protocol.ts';

export * from '../../../src/models/protocol.ts';
export const fauxText = (text: string): AssistantContent => ({ type: 'text', text });
export const fauxThinking = (thinking: string): AssistantContent => ({ type: 'thinking', thinking });
export function fauxToolCall(name: string, args: Record<string, unknown>, options: Partial<ToolCall> = {}): ToolCall {
  return { type: 'toolCall', name, arguments: args, id: randomUUID(), ...options };
}
export function fauxAssistantMessage(
  content: string | AssistantContent[],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'faux',
    provider: 'faux',
    model: 'faux',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    timestamp: Date.now(),
    stopReason: 'stop',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}
interface FauxState {
  callCount: number;
}
export type FauxResponseStep =
  | AssistantMessage
  | ((
      context: TranscriptContext,
      options: SimpleStreamOptions | undefined,
      state: FauxState,
      model: Model,
    ) => AssistantMessage | Promise<AssistantMessage>);
export interface FauxProviderHandle {
  provider: Provider;
  state: FauxState;
  getModel(id?: string): Model;
  setResponses(steps: FauxResponseStep[]): void;
  appendResponses(steps: FauxResponseStep[]): void;
}
export function fauxProvider(input: {
  provider: string;
  api?: string;
  models: (Partial<Model> & { id: string })[];
  responses?: FauxResponseStep[];
}): FauxProviderHandle {
  const models: Model[] = input.models.map((m) => ({
    name: m.id,
    provider: input.provider,
    api: input.api ?? 'faux',
    baseUrl: 'https://faux.invalid',
    contextWindow: 20_000,
    maxTokens: 16_384,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...m,
  }));
  const state: FauxState = { callCount: 0 };
  let steps = input.responses ?? [];
  let index = 0;
  const stream: Provider['streamSimple'] = (model, context, options) => {
    const out = createAssistantMessageEventStream();
    state.callCount++;
    const step = steps[index++];
    void Promise.resolve()
      .then(async () => {
        if (!step) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: '400 Faux script exhausted' });
        return typeof step === 'function' ? step(context, options, state, model) : structuredClone(step);
      })
      .catch((error: unknown) =>
        fauxAssistantMessage([], {
          stopReason: options?.signal?.aborted ? 'aborted' : 'error',
          errorMessage: String(error),
        }),
      )
      .then((reply) => {
        const settled: AssistantMessage = options?.signal?.aborted
          ? { ...reply, stopReason: 'aborted', errorMessage: String(options.signal.reason ?? 'aborted') }
          : reply;
        const message = { ...settled, provider: model.provider, model: model.id, api: model.api };
        if (message.stopReason === 'error' || message.stopReason === 'aborted')
          out.push({ type: 'error', reason: message.stopReason, error: message });
        else out.push({ type: 'done', reason: message.stopReason, message });
        out.end(message);
      });
    return out;
  };
  return {
    provider: { id: input.provider, getModels: () => models, streamSimple: stream, stream },
    state,
    getModel: (id) => models.find((m) => !id || m.id === id) as Model,
    appendResponses(value) {
      steps.push(...value);
    },
    setResponses(value) {
      steps = value;
      index = 0;
    },
  };
}
