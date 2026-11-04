// Bet 0 的会话由 DeepSeek Harness 驱动；工具仍通过 ToolSession 进入隔离容器。
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, {
  createUserMessage,
  HarnessError,
  type Message,
  ReasoningEffortId,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm';
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { MelinaError } from '../core/errors.ts';
import { ZERO_USAGE } from '../core/events.ts';
import type { RoleCallOutcome, RoleCallRequest, RoleCallRunner } from '../core/interfaces/agents.ts';
import type { ToolCall } from '../core/interfaces/gateway.ts';
import type { ModelRegistry } from '../core/interfaces/models.ts';
import { isClosingTool, isEnvTool } from '../core/tools.ts';
import { check } from '../core/validate.ts';
import { type HarnessAdapterFactory, type HarnessReply, textOf, toModelMessage } from '../models/harness.ts';
import { installCompaction } from './compaction.ts';
import type { RoleCallDeps, TranscriptBody, TranscriptEntry } from './episode.ts';
import { prepareToolArgs } from './tool-args.ts';

export interface HarnessDeps extends Pick<RoleCallDeps, 'onNotice' | 'publicText' | 'transcript' | 'thinking'> {
  adapter: HarnessAdapterFactory;
  registry: Pick<ModelRegistry, 'contextWindow' | 'providers'>;
}

/**
 * 提交工具被拒（参数不合 schema，或收尾内容不合规）满这么多次就按角色降级：「带着错误重试一次，仍失败就降级」。
 * 中间又调成了环境工具的重新数：那是接着做了事以后的一次新提交，不是带着错误重试同一份。
 * 持续会话另由 continueUntilClosed 控制，候选被退回后可以继续推进。
 */
export const CLOSE_ATTEMPTS = 2;

/** 连着这么多轮的工具调用全被 session.check 拦下，就不再等它改，按没有合法收尾结束 */
export const BLOCKED_TURNS = 4;

export function createHarnessRunner(deps: HarnessDeps): RoleCallRunner {
  return { start: (req) => start(deps, req) };
}

function start(deps: HarnessDeps, req: RoleCallRequest) {
  const { meta, layout, session } = req;
  const definition = ({ name, description, parameters }: RoleCallRequest['layout']['tools'][number]) => ({
    name,
    description,
    parameters: JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>,
  });
  if (JSON.stringify(layout.tools.map(definition)) !== JSON.stringify(session.tools.map((t) => definition(t.spec))))
    throw new MelinaError('internal', '工具定义和可执行的工具对不上');

  const ctx = new Context();
  let agent: Agent | undefined;
  let ended = false;
  let turns = 0;
  let last: HarnessReply | undefined;
  let failure: RoleCallOutcome | undefined;
  let closeFailures = 0;
  let lastCloseError = '';
  let blockedTurns = 0;
  let reminded = false;
  let hinted = false;
  let idleTurns = 0;
  let progressed = false;
  let currentSystem = layout.system;
  const promptFailures = new Set<string>();
  const usage = { ...ZERO_USAGE };
  const queued: string[] = [];
  const blocked = new Set<string>();
  let restrictedTools = '';
  let restoreTools: (() => void) | undefined;
  const transcript: Message[] = [];
  let turnCalls: ToolCall[] = [];
  let wake: (() => void) | undefined;

  // 工具集在 pre-step 之前就已装箱，须在执行/参数整理结束时更新下一请求的声明。
  const refreshTools = () => {
    if (!agent) return;
    const unavailable = session.tools
      .filter((tool) => tool.available && !tool.available())
      .map((tool) => tool.spec.name);
    const restriction = unavailable.join(',');
    if (restriction === restrictedTools) return;
    restoreTools?.();
    restoreTools = unavailable.length ? agent.ctx.tools.restrict({ deny: unavailable }) : undefined;
    restrictedTools = restriction;
  };

  const record = (body: TranscriptBody) => {
    try {
      deps.transcript?.({
        ...body,
        at: Date.now(),
        runId: meta.runId,
        branchId: meta.branchId,
        role: meta.role,
        job: meta.job,
        sessionId: meta.sessionId,
      } as TranscriptEntry);
    } catch {
      /* 开发脚本不能中断求解。 */
    }
  };
  const steer = (text: string) => {
    if (ended || session.closed() || meta.signal?.aborted) return;
    if (agent) agent.steer(userMessage(text));
    else queued.push(text);
    idleTurns = 0;
    wake?.();
  };
  const onReply = (reply: HarnessReply) => {
    for (const key of Object.keys(usage) as (keyof typeof usage)[]) {
      const n = reply.usage[key];
      if (Number.isFinite(n) && n > 0) usage[key] += n;
    }
    const toolCalls = callsOf(reply.content);
    record({
      kind: reply.purpose === 'compaction' ? 'compact' : 'reply',
      model: `${reply.provider}/${reply.model}`,
      text: textOf(reply.content),
      thinking: reply.content.flatMap((b) => (b.type === 'reasoning' ? [b.text] : [])).join('\n'),
      toolCalls,
      stopReason: reply.stopReason,
      usage: reply.usage,
      ...(reply.error ? { error: reply.error } : {}),
    });
    if (reply.purpose === 'compaction') return;
    turns++;
    last = reply;
    turnCalls = toolCalls;
    if (toolCalls.length) reminded = false;
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') return;
    const text = textOf(reply.content);
    if (text.trim()) deps.publicText?.(session.caller, text);
    const hint = req.contextHint;
    const window = deps.registry.contextWindow(reply);
    const limit = Math.min(window && hint ? window * hint.ratio : Infinity, hint?.tokens || Infinity);
    const used = Math.max(
      reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite,
      agent ? ctx.tokenMeter.measure(agent.session).totalTokens : 0,
    );
    if (hint && !hinted && used >= limit) {
      hinted = true;
      if (hint.onReached) hint.onReached(used);
      else steer(hint.text);
    }
  };
  const prompt = () => {
    try {
      currentSystem = req.systemPrompt?.() ?? currentSystem;
    } catch (error) {
      promptError('系统提示', error);
    }
    return currentSystem.trimEnd();
  };
  const promptError = (what: string, error: unknown) => {
    if (promptFailures.has(what)) return;
    promptFailures.add(what);
    deps.onNotice?.(`${meta.role}（${meta.branchId ?? meta.runId}）未刷新${what}：${String(error)}`);
  };
  const referenceContext = () => {
    try {
      return req.referenceContext?.();
    } catch (error) {
      promptError('观察地图', error);
      return undefined;
    }
  };
  const adapter = deps.adapter(meta, onReply, req.referenceContext ? referenceContext : undefined);
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        if (wake === finish) wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      wake = finish;
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });

  const done = (async () => {
    const aborted = () => agent?.cancel({ kind: 'user' });
    try {
      meta.signal?.throwIfAborted();
      await ctx.plugin(LlmRuntime);
      await ctx.plugin(SessionStore);
      await ctx.plugin(SessionProjectionRegistry);
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      await ctx.plugin(TokenMeter);
      await ctx.plugin(AgentRegistry);
      await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
      if (req.compact) await installCompaction(ctx, req.compact);
      ctx.llm.registerAdapter([...new Set([meta.model.provider, ...deps.registry.providers()])], adapter);
      ctx.systemPrompt.section({ name: 'melina', order: 0, text: prompt, complete: true, interpolate: false });
      for (const tool of session.tools)
        ctx.tools.register({
          ...definition(tool.spec),
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
          execute: async (raw, exec) => {
            const call = { id: exec.callId, name: tool.spec.name, args: raw };
            // 混调等会话限制先判定，避免参数错误占用收尾重试次数。
            const reason = session.check(call, turnCalls);
            if (reason !== undefined) {
              blocked.add(call.id);
              throw new HarnessError(reason, 'BLOCKED');
            }
            let args: unknown;
            try {
              const normalized = tool.normalizeArguments ? tool.normalizeArguments(raw) : raw;
              if (req.prepareArguments) args = req.prepareArguments(tool.spec, normalized, closeFailures);
              else {
                const prepared = prepareToolArgs(tool.spec, normalized, { relocate: isClosingTool(tool.spec.name) });
                args = prepared.args;
                if (prepared.moved.length)
                  deps.onNotice?.(`${meta.role} 交 ${tool.spec.name} 时整理了参数：${prepared.moved.join('、')}`);
              }
              check(tool.spec.parameters, args, `${tool.spec.name} 参数`);
            } catch (error) {
              throw new HarnessError(String(error), 'INVALID_ARGS');
            } finally {
              refreshTools();
            }
            call.args = args;
            if (isEnvTool(call.name) || tool.spec.environment) closeFailures = 0;
            const outcome = await tool.run(call, exec.signal).finally(refreshTools);
            try {
              req.onToolResult?.(call, outcome);
            } catch {
              /* 宿主通知不影响工具结果。 */
            }
            if (outcome.isError) throw new HarnessError(outcome.content, 'TOOL_ERROR');
            if (!isClosingTool(call.name)) progressed = true;
            if (outcome.terminate || session.closed()) exec.concludeTurn();
            return outcome.content;
          },
        });
      ctx.on('session/event', (_session: Session, event) => {
        // 原始历史只收新增对话；压缩和系统提示替换只改变模型所见的 surface。
        if (event.surfaceOp !== 'append') return;
        if (event.type === 'assistant/message') transcript.push(event.data.message);
        else if (event.type === 'user/message' && event.data.source.kind !== 'compact-checkpoint') {
          transcript.push(event.data);
          if (event.data.source.kind === 'user' && turns > 0)
            record({ kind: 'steer', text: textOf(event.data.content) });
        } else if (event.type === 'tool/result') {
          const message = event.data.message;
          transcript.push(message);
          const name = turnCalls.find((call) => call.id === message.toolCallId)?.name ?? '';
          if (message.isError && isClosingTool(name) && !blocked.has(message.toolCallId)) {
            closeFailures++;
            lastCloseError = textOf(message.content);
          }
          record({
            kind: 'result',
            toolCallId: message.toolCallId,
            tool: name,
            isError: !!message.isError,
            blocked: blocked.has(message.toolCallId),
            text: textOf(message.content).replace(/^Error: /, ''),
          });
        }
      });
      ctx.on('agent/error', ({ error }) => {
        const message = error instanceof Error ? error.message : String(error);
        failure =
          last?.failureCode === 'CONTEXT_WINDOW_EXCEEDED' ||
          /context.{0,60}(?:limit|exceed|overflow)|prompt.{0,30}(?:long|length|exceed)|上下文.*(?:超|满)/i.test(message)
            ? { kind: 'context_overflow' }
            : { kind: 'model_error', message };
      });
      ctx.on('agent/pre-step', async ({ agent: subject, signal }, next) => {
        if (turnCalls.length) blockedTurns = turnCalls.every((call) => blocked.has(call.id)) ? blockedTurns + 1 : 0;
        if (
          session.closed() ||
          (!req.continueUntilClosed && (closeFailures >= CLOSE_ATTEMPTS || blockedTurns >= BLOCKED_TURNS))
        ) {
          if (!session.closed() && closeFailures >= CLOSE_ATTEMPTS)
            failure = { kind: 'model_error', message: `提交工具连续 ${CLOSE_ATTEMPTS} 次不合格：${lastCloseError}` };
          subject.inbox.clear();
          return { kind: 'reject' };
        }
        if (turns > 0) {
          idleTurns = progressed ? 0 : idleTurns + 1;
          progressed = false;
          if (req.continueUntilClosed && idleTurns >= 3)
            await pause(Math.min(30_000, 1_000 * 2 ** Math.min(5, idleTurns - 3)), signal);
        }
        signal.throwIfAborted();
        const hint = req.contextHint;
        const window = deps.registry.contextWindow(last ?? meta.model);
        const used = ctx.tokenMeter.measure(subject.session).totalTokens;
        if (hint && !hinted && used >= Math.min(window ? window * hint.ratio : Infinity, hint.tokens || Infinity)) {
          hinted = true;
          if (hint.onReached) hint.onReached(used);
          else steer(hint.text);
        }
        const decision = await next();
        return decision.kind === 'enter'
          ? {
              ...decision,
              messages: [
                ...decision.messages,
                ...subject.inbox.splice('next-step', 0, subject.inbox.nextStep.length, []),
              ],
            }
          : decision;
      });
      ctx.on('agent/turn-stopping', ({ agent: subject }) => {
        if (session.closed() || meta.signal?.aborted || failure) {
          subject.inbox.clear();
          return;
        }
        if (!req.continueUntilClosed && (reminded || closeFailures >= CLOSE_ATTEMPTS)) return;
        reminded = true;
        subject.steer(
          userMessage(
            req.continueUntilClosed && !turnCalls.length
              ? `上一轮没有调用工具；文字不会执行操作或完成提交。下一步请直接调用工具。\n${req.closeReminder}`
              : req.closeReminder,
          ),
        );
      });
      const handle = await ctx.agents.create({
        sessionId: SessionId(meta.sessionId),
        ...(meta.signal ? { signal: meta.signal } : {}),
        agentOptions: {
          provider: meta.model.provider,
          model: meta.model.model,
          reasoningEffort: ReasoningEffortId(deps.thinking?.(meta) ?? (meta.model.tier === 'strong' ? 'high' : 'low')),
        },
      });
      agent = handle.agent;
      refreshTools();
      meta.signal?.addEventListener('abort', aborted, { once: true });
      meta.signal?.throwIfAborted();
      const opening = [...layout.messages.map((m) => m.text), ...queued.splice(0)];
      for (const text of opening.slice(0, -1)) agent.inject(userMessage(text));
      agent.steer(userMessage(opening.at(-1) ?? '开始。'));
      await agent.whenIdle();
    } catch (error) {
      failure ??= {
        kind: 'model_error',
        message: `DeepSeek Harness：${error instanceof Error ? error.message : error}`,
      };
    } finally {
      ended = true;
      meta.signal?.removeEventListener('abort', aborted);
      wake?.();
      await ctx.fiber.dispose();
    }
    const closed = session.closed();
    const outcome: RoleCallOutcome = closed
      ? { kind: 'closed', ...closed }
      : meta.signal?.aborted || last?.stopReason === 'aborted'
        ? { kind: 'aborted', reason: String(meta.signal?.reason ?? '已取消') }
        : (failure ?? { kind: 'no_close' });
    return {
      outcome,
      toolCalls: session.toolCalls,
      turns,
      usage,
      ...(req.keepTranscript
        ? {
            transcript: [
              { role: 'system', content: layout.system, toolsAdded: layout.tools, timestamp: Date.now() },
              ...transcript.filter((m) => m.role !== 'system').flatMap(toModelMessage),
            ],
          }
        : {}),
    };
  })();
  return { done, steer, handoffMaterial: () => serialize(transcript) };
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

function callsOf(content: HarnessReply['content']): ToolCall[] {
  return content.flatMap((block) => {
    if (block.type !== 'tool-call') return [];
    let args: unknown;
    try {
      args = JSON.parse(block.arguments);
    } catch {
      args = block.arguments;
    }
    return [{ id: block.id, name: block.name, args }];
  });
}

function serialize(messages: readonly RequestMessage[]): string {
  const names = new Map(
    messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool-call' ? [[b.id, b.name] as const] : []))),
  );
  return messages
    .map(
      (message) =>
        `${message.role === 'tool' ? `【${names.get(message.toolCallId) ?? '工具'} 的结果】` : `【${message.role}】\n`}${message.content
          .map((block) => {
            const text =
              block.type === 'text' || block.type === 'reasoning'
                ? block.text
                : block.type === 'tool-call'
                  ? `【它调用 ${block.name}】${block.arguments}`
                  : JSON.stringify(block);
            return text.length > 4000 && (message.role === 'tool' || block.type === 'reasoning')
              ? `${text.slice(0, 4000)}…（后续省略）`
              : text;
          })
          .join('\n')}`,
    )
    .join('\n\n');
}
