// 接收文字交接或交付，最终候选须确认完成标准已就绪并检查交付物后结束当前会话。
import { DEFAULT_GLOBAL_CONFIG } from '../../core/config.ts';
import { isMelinaError } from '../../core/errors.ts';
import type { ToolOutcome, ToolSessionOptions } from '../../core/interfaces/gateway.ts';
import type { CloseOutcome, ClosingToolName, EndEpisodeCall, SubmitCompletionArgs } from '../../core/tools.ts';
import { containerPath, displayPath, shQuote } from '../paths.ts';
import { completionOf, fail, messageOf, redactDeep, type ToolEnv } from '../session.ts';
export const CLOSE_ACCEPTED = '收到了，这次调用到这里结束。';
export async function closeTool(
  env: ToolEnv,
  tool: ClosingToolName,
  args: unknown,
  options: ToolSessionOptions,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  let accepted: unknown = args;
  try {
    if (tool === 'end_episode') {
      const input = args as EndEpisodeCall;
      const handoff = input.handoff?.trim();
      if (Boolean(input.candidate) === Boolean(handoff)) return fail('填写 candidate 或 handoff，每次只填一种。');
      if (input.candidate) {
        if (!(await completionOf(env, signal))) return { content: '完成标准还在准备，继续当前工作。', isError: false };
        if (input.candidate.artifact) {
          const bad = await checkArtifactPath(env, input.candidate.artifact, signal);
          if (bad) return fail(bad);
        }
        accepted = { kind: 'candidate', ...input.candidate } satisfies CloseOutcome;
      } else if (handoff) accepted = { kind: 'continue', handoff } satisfies CloseOutcome;
      else return fail('填写交接摘要。');
    } else if (tool === 'submit_completion') {
      accepted = checkCompletion(env, args as SubmitCompletionArgs);
      if (typeof accepted === 'string') return fail(accepted);
    }
    const rejected = options.onClose?.(tool, accepted);
    if (rejected) return fail(rejected);
    for (const guard of env.deps.submissionGuards ?? []) {
      signal.throwIfAborted();
      const result = await guard(env, { tool, args: accepted }, signal);
      signal.throwIfAborted();
      if (typeof result === 'string') return fail(result);
      if (result) return { content: result.again, isError: false };
    }
    signal.throwIfAborted();
    env.state.closed = { tool, args: redactDeep(accepted, (text) => env.deps.redactor.redact(text)) };
    return { content: CLOSE_ACCEPTED, isError: false, terminate: true };
  } catch (error) {
    if (signal.aborted) return fail('调用已停止，未接受提交');
    if (!isMelinaError(error)) env.deps.onError(error, '检查提交');
    return fail(messageOf(error));
  }
}
export async function checkArtifactPath(
  env: ToolEnv,
  artifact: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const checked = containerPath(artifact, { allowMelina: false, file: true });
  if (!checked.ok) return `artifact：${checked.reason}`;
  const container = env.caller.container;
  if (!container) return 'artifact：当前分支没有可用容器，无法确认交付文件；请先在本分支取得文件后重试';
  try {
    const r = await env.deps.runtime.exec(container, {
      cmd: `if [ -f ${shQuote(checked.path)} ]; then echo MELINA-FILE yes; else echo MELINA-FILE no; fi`,
      timeoutMs: env.deps.fileTimeoutMs,
      signal,
    });
    if (r.timedOut || r.cancelled || r.exitCode !== 0 || r.output.trim() !== 'MELINA-FILE yes')
      return `artifact：无法确认 ${displayPath(checked.path)} 是本分支的文件；请先在本分支取得并检查文件后重试`;
  } catch (error) {
    env.deps.onError(error, '查交付物在不在');
    return 'artifact：交付文件检查失败，请确认本分支文件可读后重试';
  }
  return undefined;
}
function checkCompletion(env: ToolEnv, args: SubmitCompletionArgs): string | SubmitCompletionArgs {
  const domains = env.deps.domains?.() ?? DEFAULT_GLOBAL_CONFIG.domains;
  if (!domains.includes(args.domain)) {
    return `domain 只能是 ${domains.join('、')} 之一；请按「可选的领域」列表的描述，选择最符合目标和所需工具的一项`;
  }
  const out: SubmitCompletionArgs = { ...args };
  if (out.setup !== undefined && out.setup.trim() === '') delete out.setup;
  if (out.sharedSystems !== undefined && out.sharedSystems.length === 0) delete out.sharedSystems;
  return out;
}
