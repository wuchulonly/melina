// 宿主实例租约的进程边界：完整 Melina，模型换成 faux、容器换成宿主 bash，使用临时工作区。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { accessPolicy } from '../../../src/api/access.ts';
import {
  act,
  type Brain,
  type DevMelina,
  devMelina,
  HELLO_COMPLETION,
  removeDir,
  say,
  tempDir,
  tool,
  toolResults,
  turn,
  waitFor,
} from './kit.ts';

let dir: string | undefined;
let dk: DevMelina | undefined;
afterEach(async () => {
  await dk?.close();
  dk = undefined;
  if (dir) removeDir(dir);
  dir = undefined;
});

it('宿主立即暂停杀掉前台和后台进程；重启后任务日志、原 Run 和去重通知仍在，沿原工作区恢复', async () => {
  dir = tempDir();
  const workspace = join(dir, 'plain');
  mkdirSync(workspace);
  let resumed = false;
  const brain: Brain = ({ ctx, role }) => {
    if (role === 'scoper')
      return turn(tool('submit_completion', { completion: HELLO_COMPLETION, constraints: [], domain: 'general' }));
    if (role !== 'explorer') return say(`没想到会有 ${role} 的调用`);
    const results = toolResults(ctx.messages);
    if (resumed) {
      if (results.length === 0)
        return turn(act("cat activity.log; printf 'continued\\n' > resumed.txt", '读取已保存的任务日志并继续原工作区'));
      return turn(tool('end_episode', { handoff: '沿原图的缺口继续' }));
    }
    if (results.length === 0)
      return turn(act("printf 'recorded progress\\n' > activity.log", '任务日志持久化在宿主工作区'));
    if (results.length === 1)
      return turn(
        tool('sh', {
          cmd: "while true; do printf 'tick\\n' >> background.log; sleep 0.05; done",
          expect: '后台任务持续运行',
          background: true,
        }),
      );
    return turn(act("printf '%s\\n' $$ > busy.pid; sleep 60", '前台工具保持忙碌直到宿主中断'));
  };
  dk = await devMelina({ dir, brain });
  const original = await dk.melina.createRun({
    goal: { statement: '同一道题继续解', completion: HELLO_COMPLETION, domain: 'general' },
    workspace: { root: workspace },
    config: { continuation: { enabled: false } },
  });
  const branchOf = () => original.summary().branches[0]?.branch;
  await waitFor('前台和后台任务都在运行', () => {
    const path = branchOf()?.workspace?.path;
    return (
      path &&
      existsSync(join(path, 'busy.pid')) &&
      Number(readFileSync(join(path, 'busy.pid'), 'utf8').trim()) > 0 &&
      [...(dk?.containers.containers.values() ?? [])].some((c) => c.background.length > 0)
    );
  });
  const before = branchOf();
  const path = before?.workspace?.path as string;
  const foreground = Number(readFileSync(join(path, 'busy.pid'), 'utf8').trim());
  const background = [...dk.containers.containers.values()].flatMap((c) => c.background.map((p) => p.pid));
  const host = '127.0.0.1:7474';
  const request = (route: string, body?: unknown) =>
    dk?.melina
      .app({ port: 7474, access: accessPolicy(7474) })
      .request(`http://${host}/api/runs/${original.id}/${route}`, {
        method: 'POST',
        headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }) as Promise<Response>;
  const stopped = await request('interrupt');
  expect(stopped.status).toBe(200);
  expect(((await stopped.json()) as { run: unknown }).run).toMatchObject({ id: original.id, status: 'paused' });
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  await waitFor('前台和后台进程都退出', () => [foreground, ...background].every(gone));
  expect(branchOf()?.failures).toBe(before?.failures);
  expect(branchOf()?.lastSnapshot).not.toBe(before?.lastSnapshot);
  const notice = {
    kind: 'hint',
    broadcast: true,
    key: 'instance:replacement-test',
    text: '宿主实测事实：实例已更换，需要重新检查环境；方法和已验证事实保留。',
  };
  const first = await request('input', notice);
  expect(first.status).toBe(200);
  const firstInput = ((await first.json()) as { input: { id: string } }).input;
  await dk.close();
  dk = await devMelina({ dir, brain });
  const restored = dk.melina.run(original.id);
  expect(restored.summary().run.status).toBe('paused');
  const restoredPath = restored.summary().branches[0]?.branch.workspace?.path as string;
  expect(readFileSync(join(restoredPath, 'activity.log'), 'utf8')).toBe('recorded progress\n');
  const retry = await request('input', notice);
  expect(retry.status).toBe(200);
  expect(((await retry.json()) as { input: { id: string } }).input.id).toBe(firstInput.id);
  resumed = true;
  expect((await request('resume')).status).toBe(200);
  await waitFor('原工作区继续出活', () => existsSync(join(restoredPath, 'resumed.txt')));
  expect(restored.id).toBe(original.id);
  expect(readFileSync(join(restoredPath, 'activity.log'), 'utf8')).toBe('recorded progress\n');
  await restored.cancel();
});
