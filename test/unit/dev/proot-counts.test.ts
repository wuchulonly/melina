// 开发机的 proot 运行时在 Melina 这边读跑命令的 cgroup 计数：按 /proc/self/cgroup 找位置，读三项，算增量。
// 读的是假的挂载点和假的 /proc/self/cgroup，不要 proot。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cgroupCounts, countsDelta } from '../../dev/proot-runtime.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'melina-cgroup-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function cgroup(path: string, files: Record<string, string>): { mount: string; self: string } {
  const mount = join(root, 'cg');
  const dir = join(mount, path);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const self = join(root, 'self-cgroup');
  writeFileSync(self, `0::${path}\n`);
  return { mount, self };
}

describe('cgroupCounts', () => {
  it('按 0:: 那行找到 cgroup，读进程数撞上限的次数、OOM 杀掉的进程数、等 CPU 的微秒数', () => {
    const { mount, self } = cgroup('/user.slice/melina.service', {
      'pids.events': 'max 3\n',
      'memory.events': 'low 0\nhigh 0\nmax 12\noom 2\noom_kill 1\noom_group_kill 0\n',
      'cpu.pressure':
        'some avg10=74.63 avg60=63.46 avg300=45.82 total=6805921708\nfull avg10=42.75 avg60=37.02 avg300=26.50 total=4045828734\n',
    });
    expect(cgroupCounts(mount, self)).toEqual({ pidsMax: 3, oomKills: 1, cpuUs: 6805921708 });
  });

  it('在 cgroup namespace 的根上（0::/）也认；读不到的那项没有', () => {
    const { mount, self } = cgroup('/', { 'cpu.pressure': 'some avg10=0 avg60=0 avg300=0 total=50\n' });
    expect(cgroupCounts(mount, self)).toEqual({ cpuUs: 50 });
    expect(cgroupCounts(mount, join(root, 'no-such-file'))).toEqual({});
  });
});

describe('countsDelta', () => {
  it('两次都读到、没变小的才算增量', () => {
    expect(countsDelta({ pidsMax: 3, oomKills: 1, cpuUs: 100 }, { pidsMax: 40, oomKills: 1, cpuUs: 90 })).toEqual({
      pidsMax: 37,
      oomKills: 0,
    });
    expect(countsDelta({}, { pidsMax: 1 })).toEqual({});
  });
});
