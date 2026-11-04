// 模型层和 episode 测试共用的假实现：假 Scheduler、假账本、模型页配置、fauxProvider 供应商、假 ToolSession。
// 假 ToolSession 按 的约定写：收尾工具要单独调用；收尾内容的语义检查走 onClose；环境工具算工具调用数。

import { type GlobalConfig, type ModelsConfig, resolveGlobalConfig } from '../../../src/core/config.ts';
import type { ResolvedProviderKey } from '../../../src/core/interfaces/config-store.ts';
import type { Layout } from '../../../src/core/interfaces/context.ts';
import type { MelinaTool, ToolCall, ToolOutcome, ToolSession } from '../../../src/core/interfaces/gateway.ts';
import type { ModelUsageEntry } from '../../../src/core/interfaces/ledger.ts';
import type { ModelCallMeta } from '../../../src/core/interfaces/models.ts';
import type { JobKind } from '../../../src/core/interfaces/scheduler.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import { type ClosingToolName, isClosingTool, isEnvTool, type ToolSpec } from '../../../src/core/tools.ts';
import { type Breaker, createBreaker } from '../../../src/models/breaker.ts';
import { createKeyPool, type KeyPool } from '../../../src/models/keys.ts';
import { createModelRegistry, type MelinaModelRegistry } from '../../../src/models/registry.ts';
import { createMelinaStream, type MelinaStreamDeps } from '../../../src/models/stream.ts';
import {
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from './protocol.ts';

export const RUN = '01JAAAAAAAAAAAAAAAAAAAAAAA';
export const BRANCH = '01JBBBBBBBBBBBBBBBBBBBBBBB';

export const A1: ModelRef = { provider: 'faux-a', model: 'a-1', tier: 'strong' };
export const A2: ModelRef = { provider: 'faux-a', model: 'a-2', tier: 'strong' };
export const B1: ModelRef = { provider: 'faux-b', model: 'b-1', tier: 'strong' };
export const F1: ModelRef = { provider: 'faux-b', model: 'b-1', tier: 'fast' };

/** 假 Scheduler：名额随要随给，记下每次要名额、限流信号和用掉的 token；hold 设了就卡住下一次要名额（测取消用） */
export function fakeScheduler() {
  const s = {
    slots: [] as { runId: string; provider: string; job: JobKind; branchId?: string; estTokens?: number }[],
    throttled: [] as { provider: string; status: number; retryAfterMs?: number }[],
    consumed: [] as { provider: string; tokens: number }[],
    inFlight: 0,
    maxInFlight: 0,
    hold: undefined as Promise<void> | undefined,
  };
  const scheduler: MelinaStreamDeps['scheduler'] = {
    async modelSlot(req, signal) {
      signal?.throwIfAborted();
      if (s.hold) {
        const hold = s.hold;
        await new Promise<void>((resolve, reject) => {
          void hold.then(resolve);
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      s.slots.push(req);
      s.inFlight++;
      s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
      return {
        release() {
          s.inFlight--;
        },
      };
    },
    throttled(provider, signal) {
      s.throttled.push({ provider, ...signal });
    },
    consumed(provider, tokens) {
      s.consumed.push({ provider, tokens });
    },
  };
  return { state: s, scheduler };
}

export function fakeLedger() {
  const entries: ModelUsageEntry[] = [];
  return { entries, ledger: { model: (e: ModelUsageEntry) => entries.push(e) } };
}

export interface Setup {
  a: FauxProviderHandle;
  b: FauxProviderHandle;
  registry: MelinaModelRegistry;
  breaker: Breaker;
  keyPool: KeyPool;
  scheduler: ReturnType<typeof fakeScheduler>;
  ledger: ReturnType<typeof fakeLedger>;
  models: ModelsConfig;
  /** 每家一个 key；要配几个的用 keyLists */
  keys: Record<string, string | undefined>;
  /** 每家按顺序的几个 key，有就盖过 keys */
  keyLists: Record<string, ResolvedProviderKey[]>;
  global: GlobalConfig;
  notices: string[];
  stream: ReturnType<typeof createMelinaStream>;
}

/**
 * 两家 faux 供应商：faux-a（a-1、a-2，窗口 a-1 2 万）和 faux-b（b-1）。strong 档 a-1、b-1，fast 档 b-1。
 * 重试、没动静、试探都调得很短，测试用真计时器。
 */
export function setup(
  opts: {
    strong?: ModelRef[];
    fast?: ModelRef[];
    keys?: Record<string, string | undefined>;
    keyLists?: Record<string, ResolvedProviderKey[]>;
    global?: Parameters<typeof resolveGlobalConfig>[0];
    probeIntervalMs?: number;
    /** 用不了的 key 第一次多久后试，不给就和熔断的试探一样（probeIntervalMs） */
    keyProbeIntervalMs?: number;
    /** 熔断和 key 试探共用的时钟；真实请求和退避仍用原来的定时器 */
    now?: () => number;
    contextWindow?: number;
    /** 换掉 faux-a 的 Provider（比如模拟真实适配层没有 key 时同步抛错） */
    wrapA?: (provider: Provider) => Provider;
    /** 后台的角色在熔断时最多等多久 */
    backgroundWaitMs?: number;
  } = {},
): Setup {
  const a = fauxProvider({
    provider: 'faux-a',
    api: 'faux-a',
    models: [
      { id: 'a-1', contextWindow: opts.contextWindow ?? 20_000, reasoning: true },
      { id: 'a-2', contextWindow: 50_000 },
    ],
  });
  const b = fauxProvider({ provider: 'faux-b', api: 'faux-b', models: [{ id: 'b-1', contextWindow: 30_000 }] });
  const keys: Record<string, string | undefined> = opts.keys ?? { 'faux-a': 'key-a', 'faux-b': 'key-b' };
  const keyLists: Record<string, ResolvedProviderKey[]> = opts.keyLists ?? {};
  const apiKeys = (provider: string): ResolvedProviderKey[] => {
    const list = keyLists[provider];
    if (list) return list;
    const key = keys[provider];
    return key ? [{ id: `key-${provider}`, key }] : [];
  };
  const models: ModelsConfig = {
    // 模型页上的 key 跟着 keys、keyLists 走（GET /models 的样子：只回 id、名字和 hasKey）
    get providers() {
      return ['faux-a', 'faux-b'].map((provider) => ({
        provider,
        keys: apiKeys(provider).map((k) => ({ id: k.id, ...(k.name ? { name: k.name } : {}), hasKey: true })),
      }));
    },
    strong: opts.strong ?? [A1, B1],
    fast: opts.fast ?? [F1],
  };
  const global = resolveGlobalConfig({
    retries: { model: 2 },
    model: { idleTimeoutMs: 2000 },
    ...(opts.global ?? {}),
  });
  const breaker = createBreaker({ probeIntervalMs: opts.probeIntervalMs ?? 40, now: opts.now });
  const keyPool = createKeyPool({
    probeIntervalMs: opts.keyProbeIntervalMs ?? opts.probeIntervalMs ?? 40,
    now: opts.now,
  });
  const registry = createModelRegistry({
    source: { getModels: () => models, apiKeys, global: () => global },
    providers: [opts.wrapA ? opts.wrapA(a.provider) : a.provider, b.provider],
    breaker,
    keys: keyPool,
  });
  const scheduler = fakeScheduler();
  const ledger = fakeLedger();
  const notices: string[] = [];
  const stream = createMelinaStream({
    registry,
    scheduler: scheduler.scheduler,
    ledger: ledger.ledger,
    backoff: { baseMs: 5, maxMs: 20 },
    onNotice: (t) => notices.push(t),
    ...(opts.backgroundWaitMs !== undefined ? { backgroundWaitMs: opts.backgroundWaitMs } : {}),
  });
  return { a, b, registry, breaker, keyPool, scheduler, ledger, models, keys, keyLists, global, notices, stream };
}

export function meta(model: ModelRef = A1, extra: Partial<ModelCallMeta> = {}): ModelCallMeta {
  return {
    runId: RUN,
    branchId: BRANCH,
    role: 'explorer',
    job: 'explorer_episode',
    sessionId: BRANCH,
    model,
    ...extra,
  };
}

/** 直接用 melinaStream 发一次（不经过 Agent） */
export async function callOnce(
  s: Setup,
  m: ModelCallMeta = meta(),
  options: SimpleStreamOptions = {},
  context: TranscriptContext = { messages: [{ role: 'user', content: '你好', timestamp: 1 }] } as TranscriptContext,
): Promise<{ message: AssistantMessage; events: string[] }> {
  const fn = s.stream(m);
  const out = await fn(s.registry.model(m.model), context, options);
  const events: string[] = [];
  for await (const e of out) events.push(e.type);
  return { message: await out.result(), events };
}

/** 一条出错的回复，顺带用 onResponse 报一个状态码（真实的 SDK 由 stream.ts 的自定义 fetch 拿到） */
export function httpError(status: number, text: string, headers: Record<string, string> = {}): FauxResponseStep {
  return async (_ctx, options, _state, model) => {
    await options?.onResponse?.({ status, headers }, model);
    return fauxAssistantMessage([], { stopReason: 'error', errorMessage: text });
  };
}

/** 一直不回，直到被取消（测没动静超时和取消） */
export function hang(): FauxResponseStep {
  return (_ctx, options) =>
    new Promise<AssistantMessage>((resolve) => {
      const done = () =>
        resolve(fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'Request was aborted' }));
      if (options?.signal?.aborted) done();
      else options?.signal?.addEventListener('abort', done, { once: true });
    });
}

// ── 假 ToolSession ───────────────────────

export interface FakeSessionOptions {
  /** 收尾内容的语义检查：返回错误说明就拒绝 */
  onClose?: (tool: ClosingToolName, args: unknown) => string | undefined;
  /** 某个工具的执行；默认返回一个 Observation id */
  impl?: Record<string, (call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome> | ToolOutcome>;
}

export interface FakeSession extends ToolSession {
  log: string[];
  calls: ToolCall[];
}

export function fakeSession(specs: ToolSpec[], opts: FakeSessionOptions = {}): FakeSession {
  let toolCalls = 0;
  let closed: { tool: ClosingToolName; args: unknown } | undefined;
  const log: string[] = [];
  const calls: ToolCall[] = [];
  let obs = 0;
  const tools: MelinaTool[] = specs.map((spec) => ({
    spec,
    async run(call, signal) {
      calls.push(call);
      log.push(`start ${call.name}`);
      try {
        if (isClosingTool(call.name)) {
          const reason = opts.onClose?.(call.name, call.args);
          if (reason) return { content: reason, isError: true };
          closed = { tool: call.name, args: call.args };
          return { content: '收尾已接受', isError: false, terminate: true };
        }
        const custom = opts.impl?.[call.name];
        const outcome = custom ? await custom(call, signal) : { content: `观测 ${++obs}`, isError: false };
        if (isEnvTool(call.name)) toolCalls++;
        return outcome;
      } finally {
        log.push(`end ${call.name}`);
      }
    },
  }));
  return {
    caller: { runId: RUN, role: 'explorer', branchId: BRANCH, episode: 1, snapshot: 'root', readOnly: false },
    tools,
    log,
    calls,
    check(call, turn) {
      if (isClosingTool(call.name) && turn.length > 1) return `${call.name} 必须单独调用：请把它单独放在一轮里重发`;
      return undefined;
    },
    get toolCalls() {
      return toolCalls;
    },
    closed: () => closed,
  };
}

export function layoutFor(session: ToolSession, text = '开始这个 episode'): Layout {
  return {
    role: 'explorer',
    system: '你是 Melina 的 Explorer。',
    tools: session.tools.map((t) => t.spec),
    messages: [{ role: 'user', text }],
    basedOnSeq: 1,
  };
}
