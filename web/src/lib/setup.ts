// 第一次用的开工清单：按 GET /models 和系统状态的提示（SystemStatus.notices）列出还差哪几步。纯函数。

import type { ModelsConfig } from '../../../src/core/config.ts';
import type { SystemNotice, SystemStatus } from '../../../src/core/events.ts';

export interface SetupStep {
  key: 'key' | 'tiers' | 'sandbox' | 'images' | 'goal';
  done: boolean;
  title: string;
  detail: string;
  /** 去哪儿做这一步 */
  to?: string;
  /**
   * 没做完时 Melina 拒建任务（src/api/runtime.ts：没有容器引擎、不是 rootless、冻不住容器、某一档的模型都没有 key）。
   * 镜像没建不拒：任务照建，用到那个领域的路线起不来容器
   */
  blocks: boolean;
}

/** 这一家有没有存着、解得开的 key */
function hasKey(models: ModelsConfig, provider: string): boolean {
  return models.providers.some((p) => p.provider === provider && (p.keys ?? []).some((k) => k.hasKey));
}

/**
 * 容器引擎那一步叫什么：系统状态里 sandbox 的 error 不只「没装」——还有不是 rootless、冻不住容器、
 * 引擎现在用不了（含按分支容器的参数起不来、没装 slirp4netns）。以前一律叫「装好容器引擎」，引擎明明装好了。
 * 按 Melina 那句话（src/api/status.ts containerNotices）的说法认，test/unit/web/setup.test.ts 拿后端的原话核对；认不出的叫「处理容器引擎的问题」
 */
export function sandboxTitle(text: string): string {
  if (text.startsWith('没找到容器引擎')) return '装好容器引擎';
  if (text.includes('不是 rootless')) return '把容器引擎配成 rootless 的';
  if (text.includes('冻不住容器')) return '让容器引擎冻得住容器';
  if (text.includes('容器引擎现在用不了')) return '修好容器引擎';
  return '处理容器引擎的问题';
}

/**
 * 还差哪几步；全做完（模型配好、容器引擎和镜像没报错）返回 null，开工清单就不出现。
 * models 还没拉回来时返回 null：别闪一下清单。
 */
export function setupSteps(
  models: ModelsConfig | undefined,
  status: SystemStatus | undefined,
  runCount: number | undefined,
): SetupStep[] | null {
  if (!models) return null;
  const anyKey = models.providers.some((p) => (p.keys ?? []).some((k) => k.hasKey));
  const tierReady = (list: ModelsConfig['strong']) => list.some((m) => hasKey(models, m.provider));
  const tiers = tierReady(models.strong) && tierReady(models.fast);
  const errors = (kind: SystemNotice['kind']) =>
    (status?.notices ?? []).filter((n) => n.kind === kind && n.level === 'error');
  const sandbox = errors('sandbox')[0];
  const images = errors('images')[0];
  if (anyKey && tiers && !sandbox && !images) return null;
  const steps: SetupStep[] = [
    {
      key: 'key',
      done: anyKey,
      title: '填一家模型供应商的 API key',
      detail: 'Melina 用各家的官方接口；key 只能写进去，存好以后不再显示。',
      to: '/models',
      blocks: true,
    },
    {
      key: 'tiers',
      done: tiers,
      title: '给 strong、fast 两档各选一个模型',
      detail: 'strong 用于求解、起草标准和挑选版本，fast 可用于轻量调用；同一个模型可以两档都放。',
      to: '/models',
      blocks: true,
    },
  ];
  if (sandbox)
    steps.push({ key: 'sandbox', done: false, title: sandboxTitle(sandbox.text), detail: sandbox.text, blocks: true });
  if (images) steps.push({ key: 'images', done: false, title: '建好领域镜像', detail: images.text, blocks: false });
  steps.push({
    key: 'goal',
    done: (runCount ?? 0) > 0,
    title: '写下第一个目标',
    detail: '说清楚要做成什么就行，完成标准 Melina 自己起草。',
    to: '/runs?new',
    blocks: false,
  });
  return steps;
}

/** 还没做、会让 Melina 拒建任务的那几步 */
export function blockingSteps(steps: readonly SetupStep[] | null): SetupStep[] {
  return (steps ?? []).filter((s) => !s.done && s.blocks);
}
