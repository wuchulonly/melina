// 巡检器每轮使用 observation_context / observation_submit：冻结输入、查询证据、提交并持久化。
// 沿用 Melina 的模型选择和一轮超时；校验失败留在同一窗口继续纠正，主代理读取最新发布的地图。

import { MelinaError } from '../core/errors.ts';
import { ROOT } from '../core/ids.ts';
import type { RoleCallRunner, WatcherAgent } from '../core/interfaces/agents.ts';
import type { ContextAssembler } from '../core/interfaces/context.ts';
import type { ToolGateway } from '../core/interfaces/gateway.ts';
import type { ModelRegistry } from '../core/interfaces/models.ts';
import { type ModelRef, sameModel } from '../core/model-ref.ts';
import { TOOL } from '../core/tools.ts';
import type { Run } from '../core/types.ts';
import { WatchFailure, type WatchFailureReason } from '../core/watch-budget.ts';

/** 选模型要看的：各档的模型、熔断状态；有 apiKey 就也看 key（models/registry.ts 的 MelinaModelRegistry 有） */
export type WatcherRegistry = Pick<ModelRegistry, 'tier' | 'allowed' | 'breakers'> & {
  apiKey?(provider: string): string | undefined;
};

/**
 * 和作者不同家的模型：先在 strong 档里找别家的，别家的只在别的档里也用（减少共同盲区更要紧）；
 * 只配了一家时退而用同家的另一个模型，再不行就是作者那个，sameProvider 标出来。
 * 没配 key、正在熔断的供应商往后排：选了它，melinaStream 会熔断后换到同档的备用模型（可能正是作者那一家），记的却是它。
 */
export function differentProviderModel(
  registry: WatcherRegistry,
  author: ModelRef,
): { model: ModelRef; sameProvider: boolean } {
  const strong = registry.tier('strong');
  const all = registry.allowed();
  const down = new Set(
    registry
      .breakers()
      .filter((b) => b.breaker !== 'ok')
      .map((b) => b.provider),
  );
  const usable = (m: ModelRef) =>
    !down.has(m.provider) && (registry.apiKey ? Boolean(registry.apiKey(m.provider)) : true);
  const otherProvider = (m: ModelRef) => m.provider !== author.provider;
  const otherModel = (m: ModelRef) => !sameModel(m, author);
  const anyModel = () => true;
  // 按偏好排好的几组候选：先挑能用的，都不能用再按原来的顺序挑
  const groups: [ModelRef[], (m: ModelRef) => boolean][] = [
    [strong, otherProvider],
    [all, otherProvider],
    [strong, otherModel],
    [all, otherModel],
    [strong, anyModel],
    [all, anyModel],
  ];
  const pick = (ok: (m: ModelRef) => boolean) => {
    for (const [list, wanted] of groups) {
      const found = list.find((m) => wanted(m) && ok(m));
      if (found) return found;
    }
    return undefined;
  };
  const model = pick(usable) ?? pick(anyModel) ?? author;
  return { model, sameProvider: model.provider === author.provider };
}

export const WATCHER_CLOSE_REMINDER =
  '你停下了，但还没提交。看完以后调用 observation_submit 交这一版的看法：方向只写这一轮有变化的，每项写全、写原来的编号，实测结果附上支持本轮结论的证据短码。observation_submit 要单独调用。';

export const WATCHER_CONTEXT_HINT =
  '上下文已经用得很多了：根据已有摘要调用 observation_submit 提交判断，只补查影响结论的细节。';

export const WATCHER_DEADLINE_HINT =
  '本轮已进入软截止：立即单独调用 observation_submit，提交已有判断和方向变化。宿主保存进度与历史，未展示材料留给下一轮。硬截止仍会取消本轮。';

export interface WatcherDeps {
  runner: RoleCallRunner;
  gateway: ToolGateway;
  assembler: Pick<ContextAssembler, 'forWatcher'>;
  registry: WatcherRegistry;
  /** 交的看法被整份退回时记一行系统日志：退回不进 RunStore，不记就数不出来 */
  onNotice?: (text: string) => void;
}

export function createWatcherAgent(deps: WatcherDeps): WatcherAgent {
  return {
    async watch({ run, request, author, signal, closing }) {
      try {
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) {
          if (signal.reason instanceof WatchFailure) throw signal.reason;
          throw new MelinaError('conflict', '巡检器这一轮被停下了');
        }
        throw error;
      }
      const model = watcherModel(deps.registry, run, author);
      const layout = deps.assembler.forWatcher(run.id, request);
      if (!layout.watch) throw new MelinaError('invalid', '巡检器布局缺少冻结材料与展示信息');
      const session = deps.gateway.open(
        {
          runId: run.id,
          role: 'watcher',
          branchId: request.branchId,
          snapshot: ROOT,
          readOnly: true,
        },
        {
          observation: {
            request,
            input: layout.watch,
            model,
            closing,
          },
        },
      );
      let failure: WatchFailureReason | undefined;
      const handle = deps.runner.start({
        meta: {
          runId: run.id,
          branchId: request.branchId,
          role: 'watcher',
          job: 'watcher_call',
          // 同一条路线的各轮共用系统提示（目标简述），缓存路由按路线和角色分，不和那条路线自己的对话混
          sessionId: `${request.branchId}-watcher`,
          model,
          signal,
          onFailure: (kind) => {
            failure = kind === 'queue' ? 'provider' : kind;
          },
        },
        // 开场已提供判断所需骨架，原文按需展开。
        layout: {
          ...layout,
          // 声明与可执行 schema 共用同一份，包含已加载的领域扩展。
          tools: session.tools.map((tool) => tool.spec),
        },
        session,
        continueUntilClosed: true,
        contextHint: { ratio: 0.8, text: WATCHER_CONTEXT_HINT },
        closeReminder: WATCHER_CLOSE_REMINDER,
        onToolResult: (call, outcome) => {
          if (call.name === TOOL.submitWatch && outcome.isError) {
            failure = 'validation';
            try {
              if (JSON.parse(outcome.content).failure === 'storage') failure = 'storage';
            } catch {
              /* schema 校验可能只返回文字 */
            }
            deps.onNotice?.(`任务 ${run.id} 的巡检器提交被退回：${outcome.content.slice(0, 300)}`);
          }
        },
      });
      const prioritize = () => {
        handle.steer(WATCHER_DEADLINE_HINT);
        deps.onNotice?.(`任务 ${run.id} 的巡检器进入软截止；提醒将在当前模型回合结束后生效，仍保留硬截止`);
      };
      closing?.addEventListener('abort', prioritize, { once: true });
      if (closing?.aborted) prioritize();
      let result: Awaited<typeof handle.done>;
      try {
        result = await handle.done;
      } catch (error) {
        if (signal.aborted && signal.reason instanceof WatchFailure) throw signal.reason;
        throw error;
      } finally {
        closing?.removeEventListener('abort', prioritize);
      }
      const o = result.outcome;
      if (signal.aborted && signal.reason instanceof WatchFailure && !session.publishedWatch) throw signal.reason;
      if (session.publishedWatch) {
        return { published: session.publishedWatch, windowUntilSeq: request.untilSeq };
      }
      if (o.kind === 'aborted') {
        if (signal.reason instanceof WatchFailure) throw signal.reason;
        throw new MelinaError('conflict', `巡检器这一轮被停下了：${o.reason}`);
      }
      const why =
        o.kind === 'model_error'
          ? o.message
          : o.kind === 'closed'
            ? `交上来的是 ${o.tool}`
            : o.kind === 'context_overflow'
              ? '上下文撑爆了模型窗口'
              : '停下了，没提交';
      throw new WatchFailure(
        o.kind === 'context_overflow' ? 'context' : (failure ?? (o.kind === 'model_error' ? 'model' : 'no_close')),
        `巡检器这一轮没交出看法：${why}`,
      );
    },
  };
}

/**
 * 巡检器用哪个模型：watch.model 写了用它（建任务时档位已经换成具体的模型）；没写用它看的那条路线自己的模型（author）。
 * 挑出来的那家这时没配 key、正在熔断，换和它不同家的（后台角色碰上熔断要干等几分钟才交回出错，
 * models/stream.ts 的 BACKGROUND_WAIT_MS，这一轮就白等了）
 */
export function watcherModel(registry: WatcherRegistry, run: Run, author: ModelRef): ModelRef {
  const chosen = run.config.watch?.model;
  const model = chosen && 'provider' in chosen ? chosen : chosen ? registry.tier(chosen.tier)[0] : author;
  if (model && usable(registry, model)) return model;
  return differentProviderModel(registry, author).model;
}

function usable(registry: WatcherRegistry, model: ModelRef): boolean {
  if (registry.breakers().some((b) => b.provider === model.provider && b.breaker !== 'ok')) return false;
  return registry.apiKey ? Boolean(registry.apiKey(model.provider)) : true;
}
