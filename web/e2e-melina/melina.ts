// 前端接真后端的端到端测试用的 Melina：演示模式（test/dev/demo.ts）—— 存储、运行时、会话、HTTP、SSE 都是真的，
// 模型按剧本走、命令在这台机器上用 bash 跑（只碰 workspace 里的 demo/）。每个 worker 起一个，数据放临时目录，跑完删掉。
// 页面只通过 HTTP 和它说话；这里起进程、等它就绪、停掉或 kill -9 它。

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));

export interface DemoMelina {
  url: string;
  port: number;
  data: string;
  /** Melina 的输出（出错时看） */
  log(): string;
  /** 正常停下（SIGTERM） */
  stop(): Promise<void>;
  /** kill -9 */
  kill(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function exited(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((r) => proc.once('exit', () => r()));
}

/** 起一个演示模式的 Melina。pace 是模型每一步「想」多久（毫秒）；data、port 给了就用（重启测试用同一个） */
export async function startDemoMelina(
  options: { pace?: number; data?: string; port?: number } = {},
): Promise<DemoMelina> {
  const port = options.port ?? (await freePort());
  const data = options.data ?? mkdtempSync(join(tmpdir(), 'melina-e2e-'));
  const proc = spawn(
    process.execPath,
    [
      join(REPO, 'test/dev/demo.ts'),
      '--port',
      String(port),
      '--pace',
      String(options.pace ?? 200),
      '--data',
      data,
      '--web',
      join(REPO, 'web/dist'),
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  proc.stderr?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000; // 机器忙的时候 Node 起来、编译 TS 要好几秒
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`演示模式的 Melina 没起来：\n${out}`);
    try {
      if ((await fetch(`${url}/api/status`)).ok) break;
    } catch {
      // 还没开始听
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`演示模式的 Melina 60 秒没起来：\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    data,
    log: () => out,
    stop: async () => {
      proc.kill('SIGTERM');
      await exited(proc);
    },
    kill: async () => {
      proc.kill('SIGKILL');
      await exited(proc);
    },
  };
}

/** 测试里建的临时目录（git 仓库、普通目录）：每个测试跑完删掉 */
const scratchDirs: string[] = [];

/** 一个临时目录，测试跑完删掉 */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

export const test = base.extend<{ melinaLog: undefined }, { melina: DemoMelina }>({
  melina: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright 的 fixture 要这样写
    async ({}, use) => {
      const melina = await startDemoMelina();
      await use(melina);
      await melina.stop();
      rmSync(melina.data, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ melina }, use) => {
    await use(melina.url);
  },
  // 测试没过时把 Melina 的输出附上（还有没有在跑、报了什么错）；删掉这个测试建的临时目录
  melinaLog: [
    async ({ melina }, use, testInfo) => {
      await use(undefined);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('melina.log', { body: melina.log(), contentType: 'text/plain' });
        console.error(`Melina 的输出（最后 3000 字）：\n${melina.log().slice(-3000)}`);
      }
      for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
    { auto: true },
  ],
});

export { expect };

/** 等页面连上全局事件流 */
export async function waitLive(page: Page): Promise<void> {
  await expect(page.getByText('已连上 Melina，实时更新')).toBeVisible();
}

/** 在任务页点「新建任务」，弹窗里写目标、（可选）选工作目录，开始，等进到这个任务；返回 Run 的 id */
export async function createTask(page: Page, statement: string, workspace?: string): Promise<string> {
  await page.goto('/runs');
  await page.getByRole('link', { name: '新建任务' }).first().click();
  await page.getByLabel('要做成什么？').fill(statement);
  if (workspace) {
    await page.getByRole('button', { name: /工作目录/ }).click();
    await page.getByRole('combobox').fill(workspace);
    await page.getByRole('combobox').press('Escape');
  }
  await page.getByRole('button', { name: '开始' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9A-Z]{26}$/);
  return page.url().split('/').pop() as string;
}

/** 一个 git 仓库：files 写进去、提交一次（交付成分支的测试用） */
export function gitRepo(files: Record<string, string>): string {
  const dir = join(scratchDir('melina-e2e-repo-'), 'repo');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', '起点');
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tester',
      GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'Tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
    },
  }).trim();
}
