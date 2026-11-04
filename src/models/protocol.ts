// Melina 的内部消息与用量格式。供应商传输由 DeepSeek Harness 实现。
import { estimateTokens } from '../storage/tokens.ts';

export type Api = string;
export type JsonObject = Record<string, unknown>;
export interface Model<A = Api> {
  id: string;
  name: string;
  provider: string;
  api: A;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface TextContent {
  type: 'text';
  text: string;
}
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}
export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: JsonObject;
  argumentsError?: string;
}
export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export interface Tool {
  name: string;
  description: string;
  parameters: object;
}
export interface SystemMessage {
  role: 'system';
  content: string | TextContent[];
  toolsAdded?: Tool[];
  toolsRemoved?: string[];
  timestamp: number;
}
export interface UserMessage {
  role: 'user';
  content: string | TextContent[];
  timestamp: number;
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface AssistantMessage {
  role: 'assistant';
  content: AssistantContent[];
  api: Api;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  errorMessage?: string;
  timestamp: number;
  replayState?: unknown;
  failureCode?: string;
}
export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
  timestamp: number;
}
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
export interface TranscriptContext {
  messages: Message[];
}
export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
}
export interface SimpleStreamOptions {
  purpose?: 'compaction' | 'session-title';
  signal?: AbortSignal;
  apiKey?: string;
  sessionId?: string;
  reasoning?: string;
  maxTokens?: number;
  maxRetries?: number;
  timeoutMs?: number;
  temperature?: number;
  onResponse?: (response: ProviderResponse, model: Model) => void | Promise<void>;
}
export type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta'; delta: string; partial: AssistantMessage }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: AssistantMessage }
  | { type: 'error'; reason: 'error' | 'aborted'; error: AssistantMessage };
export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void;
  end(message?: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
}
export type StreamFn = (
  model: Model,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
export interface Provider {
  id: string;
  name?: string;
  baseUrl?: string;
  getModels(): readonly Model[];
  streamSimple: StreamFn;
  stream: StreamFn;
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  const queue: AssistantMessageEvent[] = [];
  let finished = false;
  let wake: (() => void) | undefined;
  let resolve!: (message: AssistantMessage) => void;
  const result = new Promise<AssistantMessage>((done) => {
    resolve = done;
  });
  return {
    push(event) {
      queue.push(event);
      if (event.type === 'done') resolve(event.message);
      if (event.type === 'error') resolve(event.error);
      wake?.();
    },
    end(message) {
      if (message) resolve(message);
      finished = true;
      wake?.();
    },
    result: () => result,
    async *[Symbol.asyncIterator]() {
      while (!finished || queue.length) {
        if (queue.length) {
          yield queue.shift() as AssistantMessageEvent;
          continue;
        }
        await new Promise<void>((done) => {
          wake = done;
        });
      }
    },
  };
}
export function normalizeContext(
  context: TranscriptContext & { systemPrompt?: string; tools?: Tool[] },
): TranscriptContext {
  return context.systemPrompt !== undefined || context.tools?.length
    ? {
        messages: [
          { role: 'system', content: context.systemPrompt ?? '', toolsAdded: context.tools, timestamp: Date.now() },
          ...context.messages,
        ],
      }
    : context;
}
export function estimateMessageTokens(message: Message): number {
  return 4 + estimateTokens(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
}
export function estimateContextTokens(context: TranscriptContext): number {
  return context.messages.reduce(
    (n, m) =>
      n + estimateMessageTokens(m) + (m.role === 'system' ? estimateTokens(JSON.stringify(m.toolsAdded ?? [])) : 0),
    0,
  );
}
export function isContextOverflow(message: AssistantMessage, window?: number): boolean {
  return (
    /context.{0,60}(?:exceed|limit|long|overflow|window)|(?:maximum|max) context|prompt.{0,30}(?:long|length|exceed)|上下文.*(?:超|满)/i.test(
      message.errorMessage ?? '',
    ) ||
    (message.stopReason === 'error' && !!window && message.usage.input + message.usage.cacheRead > window)
  );
}
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  return /fetch failed|network|socket|connection|timeout|timed out|ECONN|service unavailable|internal server|stream ended|stream closed|terminated|server.{0,25}busy|at capacity|server error|upstream.{0,25}(?:error|stream)|temporarily unavailable|ERR_HTTP2|\b50[0234]\b/i.test(
    message.errorMessage ?? '',
  );
}
export function retryDelayMs(attempt: number, options: { baseMs: number; maxMs: number }): number {
  return Math.min(options.maxMs, options.baseMs * 2 ** (attempt - 1));
}
