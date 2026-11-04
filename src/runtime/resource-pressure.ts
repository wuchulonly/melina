// 工具层的资源余量：CPU 在 Scheduler 里量；这里看整台机器的可用内存，
// 再看 Melina 所在 cgroup 及父组的内存、进程名额。容器里挂载的是自己的 cgroup 时从挂载根开始。
// 读不到的项跳过；处于高低阈值之间时不放宽，避免在边界来回跳。

import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** true 收紧，false 可以放宽，undefined 保持 */
type Pressure = boolean | undefined;

export interface ResourcePaths {
  proc?: string;
  cgroup?: string;
}

export function localResourcePressure(paths: ResourcePaths = {}): Pressure {
  const proc = paths.proc ?? '/proc';
  const cgroup = resolve(paths.cgroup ?? '/sys/fs/cgroup');
  const readings: Pressure[] = [];
  const info = read(join(proc, 'meminfo'));
  const total = memoryValue(info, 'MemTotal') ?? totalmem();
  // MemAvailable 包括可回收的缓存；MemFree 会把仍能使用的页缓存当成内存吃紧。
  const available = memoryValue(info, 'MemAvailable') ?? freemem();
  if (total > 0) readings.push(headroom(available, total, 0.05, 0.1));
  memoryPressure(join(proc, 'pressure', 'memory'), readings);
  for (const dir of cgroupDirs(proc, cgroup)) {
    memoryPressure(join(dir, 'memory.pressure'), readings);
    const memoryMax = counter(join(dir, 'memory.max'));
    const memoryUsed = counter(join(dir, 'memory.current'));
    if (memoryMax !== undefined && memoryMax > 0 && memoryUsed !== undefined) {
      // inactive_file 是可回收的页缓存，不该因为它接近 memory.max 就一直排队。
      const stat = read(join(dir, 'memory.stat'));
      const inactive = Number(/^inactive_file (\d+)$/m.exec(stat ?? '')?.[1] ?? 0);
      const working = Math.max(0, memoryUsed - inactive);
      readings.push(headroom(memoryMax - working, memoryMax, 0.05, 0.1));
    }
    const pidsMax = counter(join(dir, 'pids.max'));
    const pidsUsed = counter(join(dir, 'pids.current'));
    if (pidsMax !== undefined && pidsMax > 0 && pidsUsed !== undefined) {
      readings.push(headroom(pidsMax - pidsUsed, pidsMax, 0.1, 0.2));
    }
  }
  if (readings.includes(true)) return true;
  if (readings.length === 0 || readings.includes(undefined)) return undefined;
  return false;
}

/** 整台机器和父组的上限也会挡住起进程，不能只看最里面一组。 */
function cgroupDirs(proc: string, root: string): string[] {
  const membership = read(join(proc, 'self', 'cgroup'));
  const relative = /^0::\/(.*)$/m.exec(membership ?? '')?.[1];
  const current = relative === undefined ? root : resolve(root, relative);
  // cgroup 命名空间可能让 /proc 里的路径指向挂载根外面；此时读挂载根。
  if (current !== root && !current.startsWith(root + sep)) return [root];
  const dirs: string[] = [];
  for (let dir = current; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === root) return dirs;
  }
}

function headroom(free: number, total: number, high: number, low: number): Pressure {
  const ratio = free / total;
  return ratio <= high ? true : ratio >= low ? false : undefined;
}

/** 至少 10% 的时间有任务在等内存时收紧，不超过 1% 时才允许放宽。 */
function memoryPressure(path: string, readings: Pressure[]): void {
  const value = Number(/^some avg10=([\d.]+)/m.exec(read(path) ?? '')?.[1]);
  if (!Number.isFinite(value) || value < 0 || value > 100) return;
  readings.push(value >= 10 ? true : value <= 1 ? false : undefined);
}

function memoryValue(info: string | undefined, key: string): number | undefined {
  const value = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(info ?? '')?.[1];
  return value === undefined ? undefined : Number(value) * 1024;
}

/** max 表示没有有限上限；未启用控制器、没有权限或不是 Linux 时也不给。 */
function counter(path: string): number | undefined {
  const value = read(path)?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
