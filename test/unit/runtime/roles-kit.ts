// 角色流程测试：真实工具网关、上下文组装和模型流，使用脚本化提供商。

import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import type { RunConfigOverride } from '../../../src/core/config.ts';
import type { Id } from '../../../src/core/ids.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import type { BetDraft, Branch, Run } from '../../../src/core/types.ts';
import { RunScopes } from '../../../src/runtime/branch-runner.ts';
import { DOMAINS } from '../agents/flow-kit.ts';
import { A1, type Setup, setup } from '../models/fakes.ts';
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxToolCall,
  type JsonObject,
  type Message,
  type TranscriptContext,
} from '../models/protocol.ts';
import { type BranchKit, branch, type Kit, kit } from '../tools/gateway-kit.ts';
export interface RoleKit {
  k: Kit;
  m: Setup;
  assembler: MelinaContextAssembler;
  scopes: RunScopes;
  /** 每次模型请求：哪家、system、工具定义、对话 */
  requests: SeenRequest[];
  cleanup(): void;
}
export interface SeenRequest {
  provider: string;
  model: string;
  system: string;
  tools: string;
  messages: Message[];
}
export function roleKit(opts: { config?: RunConfigOverride; strong?: ModelRef[]; fast?: ModelRef[] } = {}): RoleKit {
  const k = kit({ ...(opts.config ? { config: opts.config } : {}) });
  const m = setup({ ...(opts.strong ? { strong: opts.strong } : {}), ...(opts.fast ? { fast: opts.fast } : {}) });
  const requests: SeenRequest[] = [];
  m.stream = recording(m, requests);
  const assembler = new MelinaContextAssembler({
    queries: k.runStore.queries,
    domains: () => DOMAINS,
    redact: (text) => k.redactor.redact(text),
  });
  const scopes = new RunScopes();
  return {
    k,
    m,
    assembler,
    scopes,
    requests,
    cleanup: () => k.cleanup(),
  };
}
/**
 * melinaStream 外面套一层：记下每次请求的 system、工具定义和对话（缓存前缀的测试要比）。
 * pi 把系统提示和工具定义放在对话最前面的那条 system 消息里（content、toolsAdded）。
 */
function recording(m: Setup, requests: SeenRequest[]): Setup['stream'] {
  const stream = m.stream;
  return (meta) => {
    const fn = stream(meta);
    return (model, context, options) => {
      const sys = context.messages.find((x) => x.role === 'system');
      requests.push({
        provider: model.provider,
        model: model.id,
        system: sys ? textOf(sys.content) : '',
        tools: JSON.stringify(sys?.role === 'system' ? (sys.toolsAdded ?? []) : []),
        messages: context.messages.filter((x) => x.role !== 'system'),
      });
      return fn(model, context, options);
    };
  };
}
function textOf(
  content:
    | string
    | {
        type: string;
        text?: string;
      }[],
): string {
  return typeof content === 'string' ? content : content.map((c) => c.text ?? '').join('');
}
/** 一条在跑的分支：workspace 是临时目录（RunStore 上的 workspace 也指向它），起好它的「容器」 */
export async function liveBranch(rk: RoleKit, over: Partial<BetDraft> = {}): Promise<BranchKit> {
  const b = await branch(rk.k, { model: A1, ...over });
  const updated = rk.k.runStore.writer.updateBranch(b.branch.id, { workspace: { path: b.ws } });
  return { ...b, branch: updated };
}
export function current(rk: RoleKit, id: Id): Branch {
  return rk.k.runStore.queries.getBranch(id) as Branch;
}
export function runOf(rk: RoleKit): Run {
  return rk.k.runStore.queries.getRun(rk.k.run.id) as Run;
}
// ── 模型输出 ──────────────────────────────────────────────────────────────
export const turn = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: 'toolUse' });
export const tool = (name: string, args: JsonObject) => fauxToolCall(name, args);
export const say = (text: string) => fauxAssistantMessage(text);
export const look = (cmd: string) => tool('sh', { cmd });
/** 按上下文里的东西出下一步 */
export const reply =
  (fn: (ctx: TranscriptContext) => AssistantMessage) =>
  (ctx: TranscriptContext): AssistantMessage =>
    fn(ctx);
/** 对话里 user 消息的文字 */
export function userText(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    )
    .join('\n');
}
/** 对话里最后一个工具结果的 observationId */
export function lastObservation(ctx: TranscriptContext): string {
  for (const m of [...ctx.messages].reverse()) {
    if (m.role !== 'toolResult') continue;
    const text = m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    try {
      const id = (
        JSON.parse(text) as {
          observationId?: string;
        }
      ).observationId;
      if (id) return id;
    } catch {
      // 不是环境工具的结果
    }
  }
  throw new Error('对话里还没有 Observation');
}
