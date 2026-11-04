// 场景题主清单（用户 2026-10-12 定）：目标明确，中间的接口行为、约束或根因需要探索。
// test/sim 的完整清单另供机制回归；这里显式选入场景题，避免新回归题自动混进主评测。

import { allTasks as simTasks } from '../sim/tasks.ts';
import { realTasks } from './real/tasks.ts';
import { businessTasks } from './scenarios/tasks.ts';
import { type EvalTask, suiteOf } from './task.ts';

/** 内置默认跑三种中等场景；外部题库仍默认选它自己的 all。 */
export const DEFAULT_TASKS = 'scenarios:medium';

/** 场景题全量与保留下来的 harness 机制题。用「:」和难度取交集，比如 scenarios:hard。 */
export const BATCHES: Readonly<Record<string, readonly string[]>> = {
  scenarios: [
    'service-medium',
    'service-hard',
    'constraints-medium',
    'constraints-hard',
    'service-extreme',
    'constraints-extreme',
    'service-quota',
    'tuning-medium',
    'tuning-hard',
    'research-incident',
    'research-telemetry',
    'web-export-snapshot',
    'web-batch-dependencies',
    'workflow-resume',
    'web-cache-consistency',
    'web-resource-alias',
    'workflow-version-restore',
    'workflow-refund-retry',
    'workflow-settlement-events',
    'workflow-inventory-release',
  ],
  business: [
    'web-export-snapshot',
    'web-batch-dependencies',
    'workflow-resume',
    'web-cache-consistency',
    'web-resource-alias',
    'workflow-version-restore',
    'workflow-refund-retry',
    'workflow-settlement-events',
    'workflow-inventory-release',
  ],
  harness: ['service-quota', 'tuning-medium', 'tuning-hard'],
};

const SCENARIO_TASK_IDS = new Set(BATCHES.scenarios);

export function evalTasks(): EvalTask[] {
  return [...simTasks(), ...realTasks(), ...businessTasks()].filter((task) => SCENARIO_TASK_IDS.has(task.id));
}

/**
 * 按名字挑，逗号分开取并集，顺序照 evalTasks()：
 * - all（主清单全部）、sim（场景仿真）、real（离线调查）、research；
 * - gate2、gate3（保留仿真任务的门槛）；service、constraints、tuning、web、workflow（环境种类）；
 * - medium、hard；任务 id（service-medium、research-incident）；
 * - 批次（BATCHES 里的名字，比如 scenarios、harness）。
 * 可以用「:」取交集，例如 scenarios:medium、real:hard。
 * 传入外部 tasks 时只在该题库中筛选，任务集、环境和难度以外部任务的声明为准。
 */
export function selectEvalTasks(spec: string, tasks: readonly EvalTask[] = evalTasks()): EvalTask[] {
  const wanted = spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (wanted.length === 0) throw new Error('没指定任务');
  const picked = new Set<EvalTask>();
  for (const w of wanted) {
    const parts = w.split(':').filter(Boolean);
    const matched = tasks.filter((t) => parts.every((p) => matches(t, p)));
    if (matched.length === 0) {
      throw new Error(
        `没有这样的任务：${w}（可选 all、任务集/环境/难度、批次 ${Object.keys(BATCHES).join('、')}，用「:」取交集，或任务 id：${tasks.map((t) => t.id).join('、')}）`,
      );
    }
    for (const t of matched) picked.add(t);
  }
  return tasks.filter((t) => picked.has(t));
}

function matches(t: EvalTask, name: string): boolean {
  const suite = suiteOf(t);
  return (
    name === 'all' ||
    t.id === name ||
    t.difficulty === name ||
    t.env === name ||
    suite === name ||
    (name === 'real' && suite !== 'sim') ||
    (name.startsWith('gate') && t.gate !== undefined && `gate${t.gate}` === name) ||
    (Object.hasOwn(BATCHES, name) && (BATCHES[name] as readonly string[]).includes(t.id))
  );
}
