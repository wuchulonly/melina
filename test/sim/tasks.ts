// 机制回归用的完整仿真清单；主评测场景由 test/eval/tasks.ts 显式选入，不自动包含这里的全部任务。
// 三类环境各三档，按难度对应门槛：简单的给门槛 1，中等的给门槛 2（升级和 fork），
// 难的给门槛 3（共享事实和全隔离比）。难度可调：各环境的 *Task(difficulty, params) 收任意参数，这里只列预设。
// 另有比「难」再加码的一档：参数照评价会话的加码档实验（10-02 exp3、10-03 exp4），
// 任务 id 也一样（machine-extreme……），同一个总种子生成的世界和那两次实验一模一样，结果能接着比。难度标签照旧是 hard（门槛 3）。
//  加了订单服务的配额档（service-quota，几个 agent 抢同一个外部系统）和第四类环境作业调参（tuning-*，三档：做实验的方式）。

import { constraintTask, constraintTasks } from './constraints/tasks.ts';
import { machineTask, machineTasks } from './machine/tasks.ts';
import { serviceTask, serviceTasks } from './service/tasks.ts';
import type { SimTask } from './task.ts';
import { tuningTasks } from './tuning/tasks.ts';

export function allTasks(): SimTask[] {
  return [
    ...machineTasks(),
    ...serviceTasks(),
    ...constraintTasks(),
    ...extremeTasks(),
    ...quotaTasks(),
    ...tuningTasks(),
  ];
}

/**
 * 整个账号共用一份请求配额：订单服务加码档每 10 分钟允许 120 次请求，用完后锁定 10 分钟。
 * 配额写在 api.md 中，各求解分支都能看到，需避免重复请求耗尽共享额度；难度标签为 hard。
 */
export function quotaTasks(): SimTask[] {
  const task = serviceTask('hard', {
    orders: 900,
    archivedShare: 0.2,
    pageSize: 40,
    pagination: 'cursor-header',
    archived: 'v2',
    precision: 'v2-cents',
    v2Overlap: true,
    rateLimit: 3,
    tokenTtl: 20,
    quota: { requests: 120, windowMs: 10 * 60_000, lockMs: 10 * 60_000 },
  });
  return [{ ...task, id: 'service-quota', title: '订单服务（配额）' }];
}

/** 加码的一档：单 agent 也做得出，但慢、而且同一个世界几次之间差好几倍（exp3：3.5–22 分钟），拿来比速度（U01） */
export function extremeTasks(): SimTask[] {
  const tag = (t: SimTask): SimTask => ({
    ...t,
    id: t.id.replace(/-hard$/, '-extreme'),
    title: t.title.replace('（难）', '（加码）'),
  });
  return [
    tag(
      machineTask('hard', {
        buttons: 7,
        modes: ['STANDBY', 'PRIME', 'HEAT', 'CHECK', 'RUN'],
        transitions: [
          { entry: true, guard: false },
          { entry: false, guard: true },
          { entry: true, guard: true },
          { entry: true, guard: true },
        ],
        back: true,
        ops: 'mixed',
        pressure: { max: 3, visible: false },
        depth: [18, 30],
        trap: true,
        bootMs: 1000,
        maxPresses: 300,
      }),
    ),
    tag(
      serviceTask('hard', {
        orders: 900,
        archivedShare: 0.2,
        pageSize: 40,
        pagination: 'cursor-header',
        archived: 'v2',
        precision: 'v2-cents',
        v2Overlap: true,
        rateLimit: 3,
        tokenTtl: 20,
      }),
    ),
    tag(
      constraintTask('hard', {
        services: 18,
        machines: 12,
        zones: 4,
        replicas: [1, 3],
        feedback: 'opaque',
        reserve: [2, 10],
        reservedPorts: true,
        antiPairs: 8,
        zoneSpread: true,
        slack: 0,
      }),
    ),
  ];
}

/**
 * 按名字挑任务：all；gate1、gate2、gate3；easy、medium、hard；machine、service、constraints；
 * 或者任务 id（machine-hard）。逗号分开取并集，顺序照 allTasks()。
 */
export function selectTasks(spec: string): SimTask[] {
  const tasks = allTasks();
  const wanted = spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (wanted.length === 0) throw new Error('没指定任务');
  const picked = new Set<SimTask>();
  for (const w of wanted) {
    const matched = tasks.filter(
      (t) =>
        w === 'all' ||
        t.id === w ||
        t.difficulty === w ||
        t.env === w ||
        (w.startsWith('gate') && `gate${t.gate}` === w),
    );
    if (matched.length === 0)
      throw new Error(
        `没有这样的任务：${w}（可选：all、gate1–3、easy/medium/hard、${tasks.map((t) => t.id).join('、')}）`,
      );
    for (const t of matched) picked.add(t);
  }
  return tasks.filter((t) => picked.has(t));
}

export function taskById(id: string): SimTask {
  const task = allTasks().find((t) => t.id === id);
  if (!task) throw new Error(`没有这个任务：${id}`);
  return task;
}
