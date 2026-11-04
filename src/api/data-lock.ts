// 数据目录的文件锁：Melina 在打开 RunStore 之前拿，关完库再放。
// 拿锁后才能初始化数据库、清理上传文件或写系统状态，避免多个运行时同时操作同一份数据。
// 不接运行时的 Melina（notConnectedRuntime，只读查看）也拿：它一样会写系统状态。
//
// 锁文件 <dataDir>/melina.lock 里写拿锁进程的 pid 和启动时间（Linux 的 /proc/<pid>/stat 第 22 项），pid 被别的进程复用时认得出来。
// 已经有了：写锁的那个进程还活着就拒绝（unavailable），否则（崩溃、kill -9 留下的）接管。单机单进程，
// 不防同一时刻两个进程一起抢的极端情况。同步的：Melina 的构造函数里拿。

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MelinaError } from '../core/errors.ts';

export interface DataDirLock {
  release(): void;
}

/** 拿锁的是谁：pid，加上进程的启动时间，pid 被别的进程复用时认得出来 */
export interface LockHolder {
  pid: number;
  start?: string | undefined;
}

/**
 * 建锁文件（O_EXCL），写进自己的 pid 和启动时间。已经有了：写锁的进程还活着（pid 在、启动时间也对得上）就拒绝，
 * 否则接管。容器里 pid 复用很常见，只看 pid 会把一个无关的进程当成 Melina。
 */
export function acquireLock(path: string, me: LockHolder = self()): DataDirLock {
  // 锁文件里写的是进程，同一个进程再拿会当成「上次自己留下的」接管；同一个进程里开两个 Melina 用同一个数据目录（SDK 的用法）时，
  // 两个运行时会在同一个 RunStore 上一起跑。所以本进程拿着的锁另记一份，后开的直接拒绝
  const key = resolve(path);
  const here = me.pid === process.pid;
  if (here && heldHere.has(key)) throw new MelinaError('unavailable', '数据目录正被本进程里的另一个 Melina 使用');
  mkdirSync(dirname(key), { recursive: true });
  const line = `${me.pid}${me.start ? ` ${me.start}` : ''}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(key, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = parseHolder(readOr(key));
      if (holder && !(holder.pid === me.pid && holder.start === me.start) && alive(holder)) {
        throw new MelinaError('unavailable', `数据目录正被另一个 Melina 进程（pid ${holder.pid}）使用`);
      }
      try {
        unlinkSync(key); // 上次崩溃留下的
      } catch {
        // 刚被别人删了
      }
      continue;
    }
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
    if (here) heldHere.add(key);
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        if (here) heldHere.delete(key);
        if (readOr(key) === line) {
          try {
            unlinkSync(key);
          } catch {
            // 已经没了
          }
        }
      },
    };
  }
  throw new MelinaError('unavailable', '拿不到数据目录的锁');
}

/** 本进程拿着的数据目录锁（绝对路径） */
const heldHere = new Set<string>();

function self(): LockHolder {
  return { pid: process.pid, start: startTime(process.pid) };
}

function readOr(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function parseHolder(text: string): LockHolder | undefined {
  const [pid, start] = text.trim().split(/\s+/);
  const n = Number.parseInt(pid ?? '', 10);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return { pid: n, ...(start ? { start } : {}) };
}

/** /proc/<pid>/stat 的第 22 项（开机以来的时钟滴答数）；不是 Linux、或进程不在了就是 undefined */
export function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // 第 2 项是括号里的命令名，里面可能有空格和括号：从最后一个右括号往后数
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19];
  } catch {
    return undefined;
  }
}

function alive(holder: LockHolder): boolean {
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  // pid 在：能看启动时间就核对，看不了（不是 Linux）就当是它
  if (holder.start === undefined) return true;
  const now = startTime(holder.pid);
  return now === undefined || now === holder.start;
}
