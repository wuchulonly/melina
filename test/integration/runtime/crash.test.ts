// 崩溃恢复：子进程用真的 RunStore（SQLite 文件）和真的 DirCopy workspace 跑一个任务，
// 跑到求解分支第二个 episode 中途（写了 b.txt、记了一条 shell 意图）时 kill -9；父进程打开同一份数据跑恢复：
// 接管子进程留下的锁，workspace 回到 lastSnapshot（a.txt 在、b.txt 没了），收件箱里有「重启过」和「这条命令不知道生效没有」，
// 分支接着跑，提交候选，交付的 patch 里有 a.txt、c.txt，没有 b.txt。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../../src/api/data-lock.ts';
import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig } from '../../../src/core/config.ts';
import type { Branch, Run } from '../../../src/core/types.ts';
import { createKernel } from '../../../src/runtime/runtime.ts';
import { createScheduler } from '../../../src/runtime/scheduler.ts';
import { RECOVERED_NOTICE } from '../../../src/runtime/templates.ts';
import { openRunStore } from '../../../src/storage/state.ts';
import { createWorkspaceProviders } from '../../../src/workspace/provider.ts';
import {
  closes,
  FakeEnv,
  FakeExplorer,
  FakeGateway,
  FakeScoper,
  fakeAssembler,
  registry,
  waitFor,
} from '../../unit/runtime/kit.ts';

const CHILD = new URL('./crash-child.ts', import.meta.url).pathname;
const ACT_ID = '01J0000000000000000000ACT9';

let dir: string;
let child: ChildProcess | undefined;
afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 等子进程打印 READY <runId> <branchId> */
function ready(proc: ChildProcess, ms: number): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程 ${ms} 毫秒内没打印 READY`)), ms);
    const lines = createInterface({ input: proc.stdout as NodeJS.ReadableStream });
    lines.on('line', (line) => {
      const m = /^READY (\S+) (\S+)$/.exec(line.trim());
      if (m) {
        clearTimeout(timer);
        resolve([m[1] as string, m[2] as string]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程提前退出了（${code}）`));
    });
  });
}

describe('崩溃恢复', () => {
  it('子进程跑到一半 kill -9，再打开同一份数据恢复，任务接着跑完', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-crash-'));
    mkdirSync(join(dir, 'project'));
    writeFileSync(join(dir, 'project', 'seed.txt'), '起点就有的文件\n');

    child = spawn(process.execPath, [CHILD, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    const [runId, branchId] = await ready(child, 60_000);
    const pid = child.pid;
    const exited = new Promise((r) => child?.once('exit', r));
    child.kill('SIGKILL');
    await exited;

    // 子进程留下的：锁文件里是它的 pid；RunStore 里分支还在第 2 个 episode，workspace 里有没收尾的 b.txt
    const lockPid = () =>
      readFileSync(join(dir, 'data', 'melina.lock'), 'utf8')
        .trim()
        .split(' ')[0];
    expect(lockPid()).toBe(String(pid));
    // 和 Melina 一样先拿锁再打开库：拿锁的进程已经不在了，接管
    const lock = acquireLock(join(dir, 'data', 'melina.lock'));
    expect(lockPid()).toBe(String(process.pid));
    const store = openRunStore({ db: join(dir, 'melina.db'), artifacts: join(dir, 'artifacts') });
    const artifacts = store.artifacts as NonNullable<typeof store.artifacts>;
    const before = store.queries.getBranch(branchId) as Branch;
    expect(before).toMatchObject({ state: 'running', episode: 2 });
    const wsPath = before.workspace?.path as string;
    expect(existsSync(join(wsPath, 'b.txt'))).toBe(true);

    const explorer = new FakeExplorer(store);
    let seen: { episode: number; a: boolean; b: boolean; inbox: string[] } | undefined;
    explorer.on('主干直解路线', (ctx) => {
      const ws = ctx.input.branch.workspace?.path as string;
      seen = {
        episode: ctx.input.branch.episode,
        a: existsSync(join(ws, 'a.txt')),
        b: existsSync(join(ws, 'b.txt')),
        inbox: store.queries.inbox(branchId, 0).map((i) => i.text),
      };
      writeFileSync(join(ws, 'c.txt'), '做完了\n');
      ctx.observe('写了 c.txt，查过部署没生效，重新部署，返回 200');
      return ctx.done(closes.submit());
    });
    const global: GlobalConfig = { ...DEFAULT_GLOBAL_CONFIG, limits: { modelCalls: {}, toolExec: 2, diskFreeMin: 0 } };
    const scheduler = createScheduler({ limits: () => global.limits, cpus: () => 2 });
    const env = new FakeEnv();
    const runtime = createKernel({
      writer: store.writer,
      queries: store.queries,
      bus: store.bus,
      artifacts,
      workspaces: createWorkspaceProviders({ dataDir: join(dir, 'data'), artifacts }),
      gateway: new FakeGateway(),
      assembler: fakeAssembler(store),
      explorer,
      scoper: new FakeScoper(),
      registry,
      config: { global: () => global, credentials: () => [] },
      scheduler,
      dataDir: join(dir, 'data'),
      env,
    });
    try {
      const report = await runtime.recovery.run();
      expect(report).toEqual({ runs: [runId], branches: [branchId], unknownCommands: [ACT_ID], rescoped: [] });
      expect(env.ops('stop', branchId)).toBe(1);
      // workspace 已经回到上次收尾时：a.txt 在，b.txt 没了
      expect(existsSync(join(wsPath, 'a.txt'))).toBe(true);
      expect(existsSync(join(wsPath, 'b.txt'))).toBe(false);

      await runtime.start();
      await waitFor(() => (store.queries.getRun(runId) as Run).status === 'done', '任务交付', 30_000);
      expect(seen).toEqual({
        episode: 2,
        a: true,
        b: false,
        inbox: [RECOVERED_NOTICE, expect.stringContaining('curl -X POST https://deploy.example.com/release')],
      });
      const run = store.queries.getRun(runId) as Run;
      const patch = Buffer.from(await artifacts.read(runId, run.result?.patch as never)).toString();
      expect(patch).toContain('a.txt');
      expect(patch).toContain('c.txt');
      expect(patch).not.toContain('b.txt');
      expect(patch).not.toContain('seed.txt');
    } finally {
      await runtime.stop();
      store.close();
      lock.release();
    }
  });
});
