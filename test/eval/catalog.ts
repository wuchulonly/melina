// 留出题从仓库外加载：只接评估任务，不改生产提示或运行时。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type EvalTask, SUITES } from './task.ts';

export interface ExternalCatalog {
  path: string;
  sha256: string;
  tasks: EvalTask[];
}

/** 任务文件须导出 evalTasks()；题目、判题器和标准解都由该文件所在的外部目录管理。 */
export async function loadTaskFile(file: string): Promise<ExternalCatalog> {
  const path = resolve(file);
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const module = await import(pathToFileURL(path).href);
  if (typeof module.evalTasks !== 'function') throw new Error(`${path} 必须导出 evalTasks()`);
  const tasks: unknown = await module.evalTasks();
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`${path} 的任务集必须是非空数组`);
  const ids = new Set<string>();
  for (const task of tasks) {
    if (
      !task ||
      typeof task !== 'object' ||
      typeof task.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.id) ||
      typeof task.title !== 'string' ||
      typeof task.env !== 'string' ||
      typeof task.domain !== 'string' ||
      !['easy', 'medium', 'hard'].includes(task.difficulty) ||
      (task.suite !== undefined && !SUITES.includes(task.suite)) ||
      !['create', 'solve', 'naive'].every((name) => typeof task[name] === 'function')
    ) {
      throw new Error(`${path} 含不符合 EvalTask 接口的任务`);
    }
    if (ids.has(task.id)) throw new Error(`${path} 的任务 id 重复：${task.id}`);
    ids.add(task.id);
  }
  return { path, sha256, tasks: tasks as EvalTask[] };
}
