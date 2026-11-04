import type { ToolOutcome } from '../../core/interfaces/gateway.ts';
import type { DeliverArgs } from '../../core/tools.ts';
import { branchOf, fail, failFrom, ok, type ToolEnv } from '../session.ts';
import { checkArtifactPath } from './close.ts';
export function delivered(): string {
  return '已保存这一版。当前会话继续；全部完成及外部验收通过后再最终交付。';
}
export async function deliverTool(env: ToolEnv, args: DeliverArgs, signal: AbortSignal): Promise<ToolOutcome> {
  if (!env.deps.deliver) return fail('当前没有连接快照交付');
  if (args.artifact) {
    const bad = await checkArtifactPath(env, args.artifact, signal);
    if (bad) return fail(bad);
  }
  if (signal.aborted) return fail('调用已停止');
  const branch = branchOf(env);
  try {
    await env.deps.deliver.deliver({
      runId: env.run.id,
      branchId: branch.id,
      version: {
        episode: env.caller.episode ?? branch.episode,
        claim: env.deps.redactor.redact(args.claim),
        ...(args.artifact ? { artifact: args.artifact } : {}),
      },
    });
    return ok(delivered());
  } catch (error) {
    return failFrom(env, error, '保存阶段成果');
  }
}
