// 环境工具调用的后半段：原文脱敏后进 Artifact store、放进本分支的 /melina/artifacts 视图；
// 超过 toolOutput.inlineMaxTokens 只回摘要和只读路径；写 Observation（带 expect、本 episode 的起点 snapshot，摘要里带退出码）；
// 记一行工具账；返回 { ref, observationId, summary, path? }。

import type { Handle, Id } from '../core/ids.ts';
import type { ToolOutcome } from '../core/interfaces/gateway.ts';

import type { EnvToolName, EnvToolResult } from '../core/tools.ts';
import type { Contention } from '../core/types.ts';
import { artifactPath } from './paths.ts';
import { fail, failFrom, messageOf, redactDeep, type ToolEnv } from './session.ts';
import { type Summarized, summarize } from './summary.ts';

export interface ObservationInput {
  /** sh 调用的 id 在写 sh.intent 前分配；其余的也预先分配 */
  id: Id;
  tool: EnvToolName;
  /** 记进 Observation.args 的参数（大字段已经截短）；落盘前脱敏 */
  args: Record<string, unknown>;
  expect?: string;
  /** 原文：进 Artifact store */
  raw: string;
  /** 摘要的第一行：退出码、文件名、出了什么事 */
  head: string;
  /** 原文放得下时给模型看的样子（read 加行号）；默认就是原文 */
  render?: (raw: string) => string;
  /** 原文太长时摘要里怎么称呼它，默认「输出」 */
  what?: string;
  /** 摘要里不放原文（write 不把写进去的内容再回一遍） */
  echo?: boolean;
  exitCode?: number;
  /** 没跑起来、超时、被取消，或者动作没做成：模型看到的是错误 */
  error?: string;
  /** 跑的时候撞到的资源上限 */
  contention?: Contention;
  startedAt: number;
}

export async function observe(env: ToolEnv, input: ObservationInput): Promise<ToolOutcome> {
  const { deps, caller, run } = env;
  const redact = (text: string) => deps.redactor.redact(text);
  const raw = redact(input.raw);

  // 原文进 Artifact store。存不进去（磁盘满这类）时命令已经执行过了：照样把输出给模型、记一条原文为空的 Observation，
  // 不能让模型以为没跑而重跑，act 的意图也要有个结果
  let handle: Handle | undefined;
  let lost: string | undefined;
  try {
    handle = await deps.artifacts.put(run.id, raw);
  } catch (error) {
    lost = messageOf(error);
    deps.onError(error, '保存工具输出');
    try {
      handle = await deps.artifacts.put(run.id, '');
    } catch {
      handle = undefined;
    }
  }
  if (handle && lost === undefined) await placeInView(env, handle);

  // 末尾的换行只是输出的结束，摘要里不留（不用正则：一长串换行后面跟着文字时正则是平方复杂度，会卡住整个进程）
  const rendered = trimTrailingNewlines(input.render ? input.render(raw) : raw);
  const maxTokens = run.config.toolOutput.inlineMaxTokens;
  const body: Summarized =
    input.echo === false || rendered === ''
      ? { inline: true, text: '' }
      : summarize(rendered, {
          maxTokens,
          ...(handle && lost === undefined ? { path: artifactPath(handle) } : {}),
          ...(input.what ? { what: input.what } : {}),
        });
  const lostNote = lost !== undefined ? `（原文没能存档：${lost}；能给的都在下面）` : '';
  const summary = [redact(input.head), redact(lostNote), body.text].filter((part) => part !== '').join('\n');
  if (!handle) {
    // 连一条空的原文都存不进去，Observation 记不了；命令已经执行了，把结果告诉模型
    return fail(
      `${summary}\n（这次调用已经执行过了，不要重跑；但没能记录下来，没有 observationId，不能当证据：${redact(lost ?? '')}）`,
    );
  }
  const expect = input.expect !== undefined ? redact(input.expect) : undefined;
  const error = lost !== undefined ? `原文没能存档：${lost}${input.error ? `；${input.error}` : ''}` : input.error;

  let observationId: Id;
  try {
    const obs = deps.writer.appendObservation(
      {
        id: input.id,
        runId: run.id,
        ...(caller.branchId ? { branchId: caller.branchId } : {}),
        ...(caller.episode !== undefined ? { episode: caller.episode } : {}),
        role: caller.role,
        tool: input.tool,
        args: redactDeep(input.args, redact),
        ...(expect ? { expect } : {}),
        summary,
        output: handle,
        snapshot: caller.snapshot,
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(error ? { error: redact(error) } : {}),
        ...(input.contention ? { contention: input.contention } : {}),
      },
      { countsAsToolCall: countsAsToolCall(env) },
    );
    observationId = obs.id;
  } catch (e) {
    return failFrom(env, e, '记录这次工具调用');
  }
  // 这次会话的工具调用数（检查点使用）；分支的 toolCalls 在 Observation 落库的事务里加
  env.state.toolCalls++;

  try {
    deps.ledger?.tool({
      runId: run.id,
      ...(caller.branchId ? { branchId: caller.branchId } : {}),
      role: caller.role,
      tool: input.tool === 'sh' ? redact(firstWord(String(input.args.cmd ?? ''))) : input.tool,
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      bytes: Buffer.byteLength(raw),
      handle,
      ms: Math.max(0, Date.now() - input.startedAt),
    });
  } catch (e) {
    deps.onError(e, '记工具账');
  }

  const result: EnvToolResult = {
    summary,
    ...(body.inline || lost !== undefined ? {} : { path: artifactPath(handle) }),
  };
  const content = result;
  return { content: JSON.stringify(content), isError: input.error !== undefined, observationId };
}

/**
 * 算不算进分支的工具调用数：本分支 Explorer 的环境工具。
 * 记在这条分支上的别的角色的调用不算；Scoper 不属于任何分支。
 */
function countsAsToolCall(env: ToolEnv): boolean {
  const { caller } = env;
  return caller.branchId !== undefined && caller.role === 'explorer';
}

/** 本分支的输出写入时就放进它的视图；Scoper 的放进它自己的。出错只记日志 */
async function placeInView(env: ToolEnv, handle: Handle): Promise<void> {
  const { deps, caller, run } = env;
  try {
    const dir = caller.branchId ? deps.views.branchDir(run.id, caller.branchId) : deps.views.scoperDir(run.id);
    await deps.views.add(run.id, dir, handle);
  } catch (error) {
    deps.onError(error, '把输出放进 /melina/artifacts');
  }
}

export function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  return end === text.length ? text : text.slice(0, end);
}

/**
 * sh 记命令的第一个词：跳过开头的环境变量赋值（`FOO=bar cmd`，值可以带引号），在原命令上切，调用方再脱敏
 * （先脱敏再切的话，占位符里的空格会把它切成两半，前半截被当成赋值跳过、后半截记成命令）。
 */
export function firstWord(cmd: string): string {
  const s = cmd.slice(0, 4096);
  let i = 0;
  for (;;) {
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    const start = i;
    let quote = 0;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        quote = c; // 引号里的空白不算分隔
      } else if (isSpace(c)) {
        break;
      }
    }
    const word = s.slice(start, i);
    if (word === '') return 'sh';
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return word.slice(0, 200);
  }
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}
