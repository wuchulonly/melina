import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { MelinaContainers } from '../../../src/api/assemble.ts';
import { melinaRuntime, type RuntimeOptions } from '../../../src/api/runtime.ts';
import { Melina, type MelinaInternals } from '../../../src/api/sdk.ts';
import type { MelinaOptions } from '../../../src/core/api.ts';
import type { ModelsConfig } from '../../../src/core/config.ts';
import type { ContainerRef } from '../../../src/core/interfaces/container.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import type { RuntimeKernel } from '../../../src/runtime/runtime.ts';
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type JsonObject,
  type Message,
  type Provider,
  type TranscriptContext,
} from '../../unit/models/protocol.ts';
import { HostRuntime } from '../../unit/tools/host-runtime.ts';

// ── 模型 ──────────────────────────────────────────────────────────────────

export const PROVIDER = 'faux';
export const STRONG: ModelRef = { provider: PROVIDER, model: 'm-strong', tier: 'strong' };
/**
 * strong 档的第二个模型：配进 strong 档时主干直解路线开两份。默认的 MODELS 不配它，faux 的目录里也只有配了它的
 * Melina 才有（模型页的目录照旧，演示和 e2e 不受影响）
 */
export const STRONG2: ModelRef = { provider: PROVIDER, model: 'm-strong-2', tier: 'strong' };
export const FAST: ModelRef = { provider: PROVIDER, model: 'm-fast', tier: 'fast' };

export const MODELS: ModelsConfig = {
  providers: [{ provider: PROVIDER, keys: [{ key: 'faux-key' }] }],
  strong: [STRONG],
  fast: [FAST],
};

export type Role = 'scoper' | 'explorer' | 'selection' | 'watcher' | 'other';
export function roleOf(ctx: TranscriptContext): Role {
  const first = ctx.messages[0];
  const tools = first?.role === 'system' ? (first.toolsAdded ?? []).map((t) => t.name) : [];
  if (tools.includes('submit_completion')) return 'scoper';
  if (tools.includes('observation_submit')) return 'watcher';
  if (tools.includes('end_episode')) return 'explorer';
  const text = typeof first?.content === 'string' ? first.content : '';
  return text.includes('选择') && text.includes('版本') ? 'selection' : 'other';
}

export interface Ask {
  ctx: TranscriptContext;
  role: Role;
  model: string;
  /** 这次请求用的 API key（一家配几个 key 时看换没换） */
  apiKey?: string;
}

export type Brain = (ask: Ask) => AssistantMessage | Promise<AssistantMessage>;

/** faux 供应商：每次请求前往队列里放一步「交给 brain」，并发的请求各自拿自己的上下文 */
export function brainProvider(
  brain: () => Brain,
  id = PROVIDER,
  /** 目录里另加的模型；不给就只有 STRONG、FAST，模型页的目录照旧 */
  extra: readonly string[] = [],
): { provider: Provider; asks: Ask[] } {
  const faux = fauxProvider({
    provider: id,
    api: id,
    models: [
      { id: STRONG.model, contextWindow: 200_000, reasoning: true },
      { id: FAST.model, contextWindow: 200_000 },
      ...extra
        .filter((m) => m !== STRONG.model && m !== FAST.model)
        .map((m) => ({ id: m, contextWindow: 200_000, reasoning: true })),
    ],
  });
  const asks: Ask[] = [];
  const step = () =>
    faux.appendResponses([
      async (ctx, options, _state, model) => {
        // 模拟网络响应让出事件循环；零延迟返修也必须让 I/O、取消和测试超时有机会执行。
        await setImmediate();
        const ask = { ctx, role: roleOf(ctx), model: model.id, ...(options?.apiKey ? { apiKey: options.apiKey } : {}) };
        asks.push(ask);
        return brain()(ask);
      },
    ]);
  const inner = faux.provider;
  const provider: Provider = {
    ...inner,
    stream: (model, context, options) => {
      step();
      return inner.stream(model, context, options);
    },
    streamSimple: (model, context, options) => {
      step();
      return inner.streamSimple(model, context, options);
    },
  };
  return { provider, asks };
}

// ── 回复的写法 ────────────────────────────────────────────────────────────

export const turn = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: 'toolUse' });
export const tool = (name: string, args: JsonObject) => fauxToolCall(name, args);
/** 交候选：只提交 claim 和可选 artifact */
export const candidateCall = (args: JsonObject) => tool('end_episode', { candidate: args });
export const say = (text: string) => fauxAssistantMessage(text);
export const look = (cmd: string) => tool('sh', { cmd });
export const act = (cmd: string, expect: string) => tool('sh', { cmd, expect });

export interface ToolResult {
  name: string;
  text: string;
  isError: boolean;
  /** 环境工具的可显示结果 */
  json?: { summary?: string; path?: string };
}

export function toolResults(messages: readonly Message[]): ToolResult[] {
  const out: ToolResult[] = [];
  for (const m of messages) {
    if (m.role !== 'toolResult') continue;
    const text = m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    let json: ToolResult['json'];
    try {
      json = JSON.parse(text) as ToolResult['json'];
    } catch {
      json = undefined;
    }
    out.push({ name: m.toolName, text, isError: m.isError, ...(json ? { json } : {}) });
  }
  return out;
}

/** 对话里 user 消息的文字（收件箱、追加的提示都在里面） */
export function userText(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    )
    .join('\n');
}

/** 这次请求开头那条 system 消息的文字 */
export function systemText(messages: readonly Message[]): string {
  const first = messages[0];
  if (first?.role !== 'system') return '';
  return typeof first.content === 'string' ? first.content : first.content.map((c) => c.text).join('\n');
}

// ── 容器 ──────────────────────────────────────────────────────────────────

/** HostRuntime 加上 Melina 用到的几个方法（forWorkspace、managed、probe、removeEphemeral），当 MelinaContainers 用 */
export class HostContainers extends HostRuntime {
  readonly engine = 'podman' as const;

  forWorkspace(path: string, options: { writable?: boolean } = {}): ContainerRef | undefined {
    for (const c of this.containers.values()) {
      if (c.running && c.spec.workspace.host === path && !(options.writable && c.spec.workspace.readOnly)) return c.ref;
    }
    return undefined;
  }

  async managed() {
    return [...this.containers.values()].map((c) => ({
      ref: c.ref,
      running: c.running,
      paused: false,
      ephemeral: false,
      labels: c.spec.labels ?? {},
    }));
  }

  async probe() {
    return { kind: 'podman' as const, version: 'host', rootless: true, memoryLimit: false, pidsLimit: false };
  }

  async removeEphemeral(): Promise<string[]> {
    return [];
  }
}

// ── Melina ──────────────────────────────────────────────────────────────────

export interface DevMelina {
  dir: string;
  melina: Melina;
  containers: HostContainers;
  runtime: () => RuntimeKernel;
  asks: Ask[];
  logs: string[];
  /** 换 brain（重启以后、或者换一段剧情） */
  setBrain(brain: Brain): void;
  close(): Promise<void>;
}

/**
 * 巡检器的默认回答：主干直解路线开跑 11 分钟后、之后每轮完成 11 分钟后再看（默认开着），各条剧情的
 * brain 不用管它；要看它怎么写的测试给 DevMelinaOptions.watcher
 */
export const watcherReply: Brain = () =>
  turn(
    tool('observation_submit', {
      standing: '还在做，完成标准还没都有观测证明',
      directions: [],
      tension: [],
      advice: '照现在的做下去',
    }),
  );

export interface DevMelinaOptions {
  dir: string;
  brain: Brain;
  /** 巡检器的回答，不给用 watcherReply */
  watcher?: Brain;
  models?: ModelsConfig;
  runtime?: RuntimeOptions;
  internals?: Partial<MelinaInternals>;
  melinaOptions?: Partial<MelinaOptions>;
}

/** 起一个真的 Melina：数据都在 dir 下（melina.db、artifacts/、data/） */
export async function devMelina(options: DevMelinaOptions): Promise<DevMelina> {
  const { dir } = options;
  let brain = options.brain;
  const watcher = options.watcher ?? watcherReply;
  // 模型页配了 faux 自带目录以外的模型：加进 faux 的目录
  const models = options.models ?? MODELS;
  const extra = [...models.strong, ...models.fast].flatMap((m) => (m.provider === PROVIDER ? [m.model] : []));
  const { provider, asks } = brainProvider(
    () => (ask) => (ask.role === 'watcher' ? watcher(ask) : brain(ask)),
    PROVIDER,
    extra,
  );
  const containers = new HostContainers({ root: join(dir, 'host') });
  const logs: string[] = [];
  let runtime: RuntimeKernel | undefined;
  const melina = new Melina(
    {
      db: join(dir, 'melina.db'),
      artifacts: join(dir, 'artifacts'),
      dataDir: join(dir, 'data'),
      models: options.models ?? MODELS,
      ...options.melinaOptions,
    },
    {
      containers: containers as unknown as MelinaContainers,
      modelProviders: [provider],
      env: {},
      log: {
        warn: (m) => logs.push(m),
        error: (m, e) => logs.push(`${m} ${e instanceof Error ? e.message : (e ?? '')}`),
      },
      runtime: melinaRuntime({
        retryDelaysMs: [50, 100, 200],
        backoff: { baseMs: 10, maxMs: 50 },
        ...options.runtime,
        onCreated: (rt) => {
          runtime = rt;
          options.runtime?.onCreated?.(rt);
        },
      }),
      ...options.internals,
    },
  );
  await melina.ready();
  return {
    dir,
    melina,
    containers,
    runtime: () => {
      if (!runtime) throw new Error('运行时没建起来');
      return runtime;
    },
    asks,
    logs,
    setBrain: (b) => {
      brain = b;
    },
    close: async () => {
      await melina.close();
      for (const c of containers.containers.values()) await containers.stop(c.ref);
    },
  };
}

// ── 杂项 ──────────────────────────────────────────────────────────────────

export function tempDir(prefix = 'melina-m0-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 一个 git 仓库：files 写进去、提交一次 */
export function gitRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', '起点');
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tester',
      GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'Tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
    },
  }).trim();
}

export async function waitFor<T>(
  what: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒还没等到：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 一个目录下的文件（相对路径），测交付的东西 */
export function listFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

export function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** 评估时的固定完成标准 */
export const HELLO_COMPLETION = {
  interpretation: '在工作目录根下写一个 hello.txt，内容是 hello',
  criteria: ['工作目录根下有 hello.txt，内容是 hello'],
};
