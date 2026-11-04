// Scoper：一次 strong 模型调用，把人写的一句目标翻成完成标准、约束和领域，顺带给出 setup 命令，不等人确认。
// 求解分支先开跑，它起草完后由 runtime 补充完成标准、约束等信息。
// 它可以在只读的容器里用 sh 和 read 看一眼工作目录（工具是 ToolGateway 的会话，容器由 runtime 起）。
// 修一次仍不合 schema、模型停下不交、上下文撑爆这类没交出合格结果的情况按  降级：目标原文当唯一的完成条目，
// interpretation 写「按字面理解」，domain 用 general，其余留空，Run 照常开跑。被取消（Run 取消）就抛错，不降级。

import { MelinaError } from '../core/errors.ts';
import type { RoleCallRunner, ScoperAgent, ScoperOutcome } from '../core/interfaces/agents.ts';
import type { ModelRegistry } from '../core/interfaces/models.ts';
import type { ModelRef } from '../core/model-ref.ts';
import type { ScoperOutput } from '../core/types.ts';

export const SCOPER_CLOSE_REMINDER =
  '你停下了，但还没提交。看清楚目标指的是什么、怎么核对以后，调用 submit_completion 一次交齐 completion、constraints、domain（需要时还有 sharedSystems、setup、profile）。';

export const SCOPER_CONTEXT_HINT = '上下文已经用得很多了：不用再看了，按现在知道的调用 submit_completion 提交。';

/**
 * 求解分支独立开跑，但未预设完成标准的任务提交候选时要等 Scoper 起草完成，约束也应尽早补充。
 * 起草超过一分钟时提示一次按已有信息提交，避免反复探测或等待外部接口拖延；不强制结束调用。
 */
export const SCOPER_TIME_HINT_MS = 60_000;
export const SCOPER_TIME_HINT =
  '你已经看了一分钟了：主干直解路线已经在跑，它交候选要等你的完成标准，约束也是越早到越有用。别再接着探、跑长命令，按现在知道的马上调用 submit_completion 提交，没摸清的留给分支去摸。';

export interface ScoperDeps {
  runner: RoleCallRunner;
  registry: Pick<ModelRegistry, 'resolve'>;
  /** 可选的领域（GlobalConfig.domains）；降级时用 general，没有 general 就用第一个 */
  domains: () => readonly string[];
  onNotice?: (text: string) => void;
  /** 多久还没交就提示一次（SCOPER_TIME_HINT），默认 SCOPER_TIME_HINT_MS；测试里改短 */
  timeHintMs?: number;
}

export function createScoperAgent(deps: ScoperDeps): ScoperAgent {
  return {
    async scope({ run, layout, session, signal }): Promise<ScoperOutcome> {
      let model: ModelRef;
      try {
        model = deps.registry.resolve({ tier: 'strong' });
      } catch (error) {
        deps.onNotice?.(
          `Scoper 没有可用的 strong 模型，按字面理解目标：${error instanceof Error ? error.message : error}`,
        );
        return { output: degraded(run.goal.statement, deps.domains()), degraded: true };
      }
      const handle = deps.runner.start({
        meta: { runId: run.id, role: 'scoper', job: 'scoper_call', sessionId: run.id, model, signal },
        layout,
        session,
        contextHint: { ratio: 0.8, text: SCOPER_CONTEXT_HINT },
        closeReminder: SCOPER_CLOSE_REMINDER,
      });
      const timer = setTimeout(() => handle.steer(SCOPER_TIME_HINT), deps.timeHintMs ?? SCOPER_TIME_HINT_MS);
      let result: Awaited<typeof handle.done>;
      try {
        result = await handle.done;
      } finally {
        clearTimeout(timer);
      }
      const o = result.outcome;
      if (o.kind === 'closed' && o.tool === 'submit_completion')
        return { output: o.args as ScoperOutput, degraded: false };
      if (o.kind === 'aborted') throw new MelinaError('conflict', `Scoper 被取消了：${o.reason}`);
      const why = o.kind === 'model_error' ? o.message : o.kind === 'closed' ? `交上来的是 ${o.tool}` : o.kind;
      deps.onNotice?.(`Scoper 没交出合格的完成标准（${why}），按字面理解目标`);
      return { output: degraded(run.goal.statement, deps.domains()), degraded: true };
    },
  };
}

/** ：目标原文当唯一的完成条目，interpretation 写「按字面理解」，domain 用 general，其余留空 */
export function degraded(statement: string, domains: readonly string[]): ScoperOutput {
  const domain = domains.includes('general') ? 'general' : (domains[0] ?? 'general');
  return {
    completion: { interpretation: '按字面理解', criteria: [statement] },
    constraints: [],
    domain,
  };
}
