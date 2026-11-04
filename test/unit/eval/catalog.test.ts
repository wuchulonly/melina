import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadTaskFile } from '../../eval/catalog.ts';
import { selectEvalTasks } from '../../eval/tasks.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function taskFile(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'melina-external-tasks-'));
  dirs.push(dir);
  const path = join(dir, 'tasks.mjs');
  writeFileSync(path, source);
  return path;
}

const validTask = `{
  id: 'external-new', env: 'new', suite: 'research', difficulty: 'hard', title: '外部新题', domain: 'general',
  create() {}, async solve() {}, async naive() {}
}`;

it('只从外部目录选题，按难度筛选也不会混进开发题，并存文件内容的哈希', async () => {
  const source = `export const evalTasks = async () => [${validTask}];`;
  const path = taskFile(source);
  const catalog = await loadTaskFile(path);
  expect(catalog.path).toBe(path);
  expect(catalog.sha256).toBe(createHash('sha256').update(source).digest('hex'));
  expect(selectEvalTasks('all', catalog.tasks).map((task) => task.id)).toEqual(['external-new']);
  expect(selectEvalTasks('research:hard', catalog.tasks).map((task) => task.id)).toEqual(['external-new']);
  expect(() => selectEvalTasks('machine-hard', catalog.tasks)).toThrow('没有这样的任务');
});

it.each([
  ['没有导出', 'export const tasks = [];', '必须导出'],
  ['空任务集', 'export const evalTasks = () => [];', '非空数组'],
  ['重复 id', `export const evalTasks = () => [${validTask}, ${validTask}];`, 'id 重复'],
  ['目录穿越', `export const evalTasks = () => [{...${validTask}, id: '../escape'}];`, 'EvalTask'],
  ['缺少标准解', `export const evalTasks = () => [{...${validTask}, solve: null}];`, 'EvalTask'],
])('拒绝%s，让不合格题目在模型调用之前失败', async (_label, source, message) => {
  await expect(loadTaskFile(taskFile(source))).rejects.toThrow(message);
});
