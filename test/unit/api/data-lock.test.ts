// 数据目录的文件锁：Melina 在打开 RunStore 之前拿。别的 Melina 正开着这份数据，就连库都不打开：
// 迁移、清上传目录、系统状态一样都不做（原来恢复时才拿锁，第二个进程之前写的一条事件就让在跑的 Melina 之后每次写都撞主键）。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, startTime } from '../../../src/api/data-lock.ts';
import { Melina, type MelinaInternals, notConnectedRuntime } from '../../../src/api/sdk.ts';
import { tempDir } from './kit.ts';

let dir: string;
let child: ChildProcess | undefined;
const quiet = { warn: () => {}, error: () => {} };

beforeEach(() => {
  dir = tempDir('melina-lock-');
});

afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function melina(internals: MelinaInternals = {}): Melina {
  return new Melina(
    { db: join(dir, 'melina.db'), artifacts: join(dir, 'artifacts') },
    { runtime: notConnectedRuntime, containers: null, env: {}, log: quiet, ...internals },
  );
}

describe('锁本身', () => {
  it('写锁的进程还活着就拒绝；死了（崩溃、kill -9）就接管；pid 被别的进程复用了（启动时间对不上）也接管', () => {
    const path = join(dir, 'melina.lock');
    const first = acquireLock(path);
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid} ${startTime(process.pid)}\n`);
    expect(() => acquireLock(path, { pid: process.pid + 1 })).toThrow(`pid ${process.pid}`);
    first.release();
    expect(existsSync(path)).toBe(false);
    acquireLock(path, { pid: 4_000_000_000 }).release();
    writeFileSync(path, '4000000001 12345\n'); // 不存在的进程留下的
    acquireLock(path).release();
    writeFileSync(path, `${process.pid} 1\n`); // pid 还在，但启动时间对不上：是别的进程复用了这个 pid
    acquireLock(path, { pid: 4_000_000_002 }).release();
  });

  it('同一个进程里再拿同一个数据目录的锁（两个 Melina 开同一个目录）：拒绝；放掉以后能再拿；放两次不出错', () => {
    const path = join(dir, 'melina.lock');
    const first = acquireLock(path);
    expect(() => acquireLock(join(dir, '.', 'melina.lock'))).toThrow('本进程里的另一个 Melina');
    first.release();
    first.release();
    acquireLock(path).release();
  });
});

describe('Melina 打开数据目录', () => {
  it('同一个进程里第二个 Melina 开同一份数据：构造时就拒绝，第一个照常；关掉以后能再开', async () => {
    const a = melina();
    await a.ready();
    expect(readFileSync(join(dir, 'workspaces', 'melina.lock'), 'utf8')).toContain(String(process.pid));
    expect(() => melina()).toThrow('本进程里的另一个 Melina');
    await a.close();
    expect(existsSync(join(dir, 'workspaces', 'melina.lock'))).toBe(false);
    const b = melina();
    await b.ready();
    await b.close();
  });

  it('别的进程拿着锁：不打开库、不清上传目录，直接说清是谁占着', async () => {
    const lock = join(dir, 'workspaces', 'melina.lock');
    const uploads = join(dir, 'workspaces', '.uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, '在传的附件'), '别删');
    child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { acquireLock } from ${JSON.stringify(new URL('../../../src/api/data-lock.ts', import.meta.url).href)};
         acquireLock(${JSON.stringify(lock)}); console.log('LOCKED'); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child?.stdout as NodeJS.ReadableStream });
      lines.on('line', (line) => {
        if (line.trim() === 'LOCKED') resolve();
      });
      child?.once('exit', (code) => reject(new Error(`拿锁的子进程提前退出了（${code}）`)));
    });
    expect(() => melina()).toThrow(`数据目录正被另一个 Melina 进程（pid ${child.pid}）使用`);
    expect(existsSync(join(dir, 'melina.db'))).toBe(false);
    expect(readFileSync(join(uploads, '在传的附件'), 'utf8')).toBe('别删');
    // 它退出（崩溃）以后就能接管
    const exited = new Promise((r) => child?.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    const k = melina();
    await k.ready();
    expect(readFileSync(lock, 'utf8')).toContain(String(process.pid));
    await k.close();
  });
});
