// 工具并发的内存、进程余量：用实际格式的 /proc 和 cgroup 文件核对读数、父组约束和命名空间回退。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localResourcePressure } from '../../../src/runtime/resource-pressure.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'melina-resource-pressure-'));
  file('proc/meminfo', 'MemTotal: 1000000 kB\nMemAvailable: 500000 kB\nMemFree: 1 kB\n');
  file('proc/self/cgroup', '0::/parent/melina\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function file(path: string, content: string): void {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const read = () => localResourcePressure({ proc: join(dir, 'proc'), cgroup: join(dir, 'cgroup') });
describe('内存和进程余量', () => {
  it('页缓存仍可回收：按 MemAvailable 算，即使 MemFree 很小也允许放宽；控制器缺项不挡住', () => {
    expect(read()).toBe(false);
  });
  it('宿主机可用内存只有少量时收紧，阈值中间保持，内存恢复后允许放宽', () => {
    file('proc/meminfo', 'MemTotal: 1000000 kB\nMemAvailable: 40000 kB\n');
    expect(read()).toBe(true);
    file('proc/meminfo', 'MemTotal: 1000000 kB\nMemAvailable: 60000 kB\n');
    expect(read()).toBeUndefined();
    file('proc/meminfo', 'MemTotal: 1000000 kB\nMemAvailable: 200000 kB\n');
    expect(read()).toBe(false);
  });
  it('剩余字节不少但内存分配在等待时收紧；等待回落才允许放宽', () => {
    file('proc/pressure/memory', 'some avg10=20.00 avg60=0.00 avg300=0.00 total=20\n');
    expect(read()).toBe(true);
    file('proc/pressure/memory', 'some avg10=5.00 avg60=0.00 avg300=0.00 total=20\n');
    expect(read()).toBeUndefined();
    file('proc/pressure/memory', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=20\n');
    expect(read()).toBe(false);
  });
  it('机器有内存，Melina 的 cgroup 接近自己的内存上限：仍然收紧', () => {
    file('cgroup/parent/melina/memory.max', '1024\n');
    file('cgroup/parent/melina/memory.current', '1000\n');
    expect(read()).toBe(true);
    file('cgroup/parent/melina/memory.stat', 'anon 400\ninactive_file 600\n');
    expect(read()).toBe(false); // 不把可回收的文件缓存当成工作内存
  });
  it('当前组没有有限上限，但父组的内存名额吃紧：不能忽略父组', () => {
    file('cgroup/parent/melina/memory.max', 'max\n');
    file('cgroup/parent/memory.max', '1024\n');
    file('cgroup/parent/memory.current', '1000\n');
    expect(read()).toBe(true);
  });
  it('当前组的进程名额吃紧时收紧，留有中间余量时保持，恢复后放宽', () => {
    file('cgroup/parent/melina/pids.max', '100\n');
    file('cgroup/parent/melina/pids.current', '95\n');
    expect(read()).toBe(true);
    file('cgroup/parent/melina/pids.current', '85\n');
    expect(read()).toBeUndefined();
    file('cgroup/parent/melina/pids.current', '70\n');
    expect(read()).toBe(false);
  });
  it('自己还有进程名额、父组已经快满：按父组收紧', () => {
    file('cgroup/parent/melina/pids.max', '100\n');
    file('cgroup/parent/melina/pids.current', '10\n');
    file('cgroup/parent/pids.max', '100\n');
    file('cgroup/parent/pids.current', '95\n');
    expect(read()).toBe(true);
  });
  it('cgroup 的内存压力也参与决定，即使宿主机读数平稳', () => {
    file('cgroup/parent/melina/memory.pressure', 'some avg10=20.00 avg60=0.00 avg300=0.00 total=20\n');
    expect(read()).toBe(true);
  });
  it('没有有限上限、损坏或缺失的读数跳过，不能凭空判定资源不足', () => {
    file('cgroup/parent/melina/pids.max', 'max\n');
    file('cgroup/parent/melina/pids.current', '999999\n');
    file('cgroup/parent/melina/memory.max', 'invalid\n');
    file('cgroup/parent/melina/memory.current', '999999\n');
    file('proc/pressure/memory', 'some avg10=NaN\n');
    expect(read()).toBe(false);
  });
  it('cgroup 命名空间里的成员路径在挂载根外：读挂载根，不能沿路径读出根外的计数', () => {
    file('proc/self/cgroup', '0::/../outside\n');
    file('outside/pids.max', '100\n');
    file('outside/pids.current', '95\n');
    expect(read()).toBe(false);
    file('cgroup/pids.max', '100\n');
    file('cgroup/pids.current', '95\n');
    expect(read()).toBe(true);
  });
});
