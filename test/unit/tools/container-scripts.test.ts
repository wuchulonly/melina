// 在容器里跑的几段 sh 直接在宿主机上跑（它们只用 sh、setsid、sed、cut、tr、grep、kill）：
// 结束标记和退出码、取消时连 setsid 出去的子孙一起杀、取消落在命令起来之前、长命令、后台进程跨调用存活、数量上限、pid 被复用时不认错。
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BG_SCRIPT,
  displayCommand,
  EXEC_SCRIPT,
  KILL_SCRIPT,
  parseBackgroundOutput,
  WRITE_FILE_SCRIPT,
} from '../../../src/tools/container-scripts.ts';

const run = promisify(execFile);
let root: string;
let state: string;
let logs: string;
const started: number[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'melina-scripts-'));
  state = join(root, 'state');
  logs = join(root, 'logs');
});

afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

/** 结束标记里退出码后面的三个 cgroup 计数随机器而变：比输出时去掉 */
const COUNTERS = /(\nMELINA-EXIT-\S+ \d+) \S+ \S+ \S+\n/;

/** 跑前台脚本（命令从 stdin 传），看到结束标记就返回；要杀的话等杀进程的脚本也跑完。raw 时留着标记里的计数 */
function runExec(
  id: string,
  cwd: string,
  cmd: string,
  killAfterMs?: number,
  opts: { raw?: boolean; cgroot?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('sh', ['-c', EXEC_SCRIPT, 'melina-exec', id, state, cwd, ...(opts.cgroot ? [opts.cgroot] : [])]);
    p.stdin.end(cmd);
    let out = '';
    let killed: Promise<unknown> = Promise.resolve();
    const timer = setTimeout(() => reject(new Error(`超时：${out}`)), 10_000);
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (/\nMELINA-EXIT-\S+ \d+( \S+ \S+ \S+)?\n/.test(out)) {
        clearTimeout(timer);
        void killed.then(() => resolve(opts.raw ? out : out.replace(COUNTERS, '$1\n')));
      }
    });
    if (killAfterMs !== undefined) {
      const due = new Promise((r) => setTimeout(r, killAfterMs));
      killed = due.then(() => run('sh', ['-c', KILL_SCRIPT, 'melina-kill', id, state]));
    }
  });
}

async function pgrep(pattern: string): Promise<string> {
  const { stdout } = await run('sh', ['-c', `ps -eo pid,args | grep -F -- '${pattern}' | grep -v grep || true`]);
  return stdout.trim();
}

describe('EXEC_SCRIPT', () => {
  it('stdout 和 stderr 按顺序合在一起，最后打结束标记和退出码', async () => {
    const out = await runExec('e1', root, 'echo one; echo two >&2; pwd; exit 3');
    expect(out).toBe(`one\ntwo\n${root}\n\nMELINA-EXIT-e1 3\n`);
  });

  it('包装脚本自己也以命令的退出码退出（结束标记丢了也不会报成 0）', () => {
    const r = spawnSync('sh', ['-c', EXEC_SCRIPT, 'melina-exec', 'e1b', state, root], { input: 'exit 5' });
    expect(r.status).toBe(5);
  });

  it.each([
    ["sh -c 'printf probe-failed; exit 7' 2>&1 | tail -n 1", 7, 'probe-failed'],
    ['printf probe-ok | tail -n 1', 0, 'probe-ok'],
    ['false; printf continued', 0, 'continued'],
    ['set +o pipefail; yes probe | head -n 1', 0, 'probe'],
  ])('管道失败透传，保留顺序命令和显式处理语义：%s', (cmd, code, output) => {
    const r = spawnSync('sh', ['-c', EXEC_SCRIPT, 'melina-exec', 'pipeline', state, root], { input: cmd });
    expect(r.status).toBe(code);
    expect(r.stdout.toString()).toContain(output);
    expect(r.stdout.toString()).toMatch(new RegExp(`\\nMELINA-EXIT-pipeline ${code} `));
  });

  it('工作目录不在：说清楚，退出码 2', async () => {
    const out = await runExec('e2', join(root, 'nope'), 'echo hi');
    expect(out).toBe(`工作目录不存在：${join(root, 'nope')}\n\nMELINA-EXIT-e2 2\n`);
  });

  it('命令留下的后台子进程占着输出管道，结束标记照样马上出来', async () => {
    const t0 = Date.now();
    const out = await runExec('e3', root, 'sleep 30 & echo started');
    expect(out).toBe('started\n\nMELINA-EXIT-e3 0\n');
    expect(Date.now() - t0).toBeLessThan(5000);
    await run('sh', ['-c', KILL_SCRIPT, 'melina-kill', 'e3', state]);
  });

  it('stdin 是空的，等输入的命令不会卡住', async () => {
    const out = await runExec('e4', root, 'cat; echo after');
    expect(out).toBe('after\n\nMELINA-EXIT-e4 0\n');
  });

  it('超过 128 KiB 的命令也行，多行命令照常', async () => {
    const big = 'y'.repeat(300 * 1024);
    expect(await runExec('e5', root, `printf %s '${big}' | wc -c`)).toBe(`${300 * 1024}\n\nMELINA-EXIT-e5 0\n`);
    expect(await runExec('e6', root, 'a=1\nb=2\necho $((a + b))')).toBe('3\n\nMELINA-EXIT-e6 0\n');
  });

  it('命令文件跑完就删', async () => {
    await runExec('e7', root, 'true');
    expect(existsSync(join(state, 'exec', 'e7.sh'))).toBe(false);
    expect(existsSync(join(state, 'exec', 'e7'))).toBe(false);
  });

  describe('结束标记带上命令前后 cgroup 计数的增量', () => {
    // 假的 cgroup 挂载点：路径照这个进程的 /proc/self/cgroup（子进程在同一个 cgroup 里），命令自己改计数，模拟它跑的时候撞了上限
    const fake = () => {
      const line = readFileSync('/proc/self/cgroup', 'utf8')
        .split('\n')
        .find((l) => l.startsWith('0::'));
      const mount = join(root, `cg-${Math.random().toString(36).slice(2)}`);
      const dir = join(mount, (line ?? '0::/').slice(3));
      mkdirSync(dir, { recursive: true });
      return { mount, dir };
    };

    it('进程数、OOM、等 CPU 的增量按顺序跟在退出码后面', async () => {
      const { mount, dir } = fake();
      writeFileSync(join(dir, 'pids.events'), 'max 5\n');
      writeFileSync(join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 9\noom 1\noom_kill 1\noom_group_kill 0\n');
      writeFileSync(
        join(dir, 'cpu.pressure'),
        'some avg10=0.00 avg60=0.00 avg300=0.00 total=1000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=10\n',
      );
      const cmd = [
        `printf 'max 7\\n' >'${join(dir, 'pids.events')}'`,
        `printf 'oom 2\\noom_kill 3\\n' >'${join(dir, 'memory.events')}'`,
        `printf 'some avg10=1.00 avg60=1.00 avg300=1.00 total=4000\\nfull avg10=0 avg60=0 avg300=0 total=20\\n' >'${join(dir, 'cpu.pressure')}'`,
        'echo done',
        'exit 4',
      ].join('\n');
      expect(await runExec('c1', root, cmd, undefined, { raw: true, cgroot: mount })).toBe(
        'done\n\nMELINA-EXIT-c1 4 2 2 3000\n',
      );
    });

    it('读不到的计数写 -（没有 cgroup v2、控制器没委派）', async () => {
      const { mount } = fake();
      expect(await runExec('c2', root, 'true', undefined, { raw: true, cgroot: mount })).toBe(
        '\nMELINA-EXIT-c2 0 - - -\n',
      );
    });

    it('命令没起来时只有退出码', async () => {
      const out = await runExec('c3', join(root, 'nope'), 'true', undefined, { raw: true });
      expect(out).toMatch(/\nMELINA-EXIT-c3 2\n$/);
    });
  });
});

describe('KILL_SCRIPT', () => {
  it('杀掉整个进程组，连自己 setsid 出去的子孙一起', async () => {
    // 带一个这次才有的小数做记号：开发机上别的会话也会跑 sleep 20…，按「sleep 20」找会把它们算进来（10-03 撞上过）
    const mark = `${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`;
    const out = await runExec('k1', root, `sleep 201.${mark} & setsid sleep 202.${mark} & sleep 203.${mark}`, 300);
    expect(out).toMatch(/\nMELINA-EXIT-k1 137\n$/);
    expect(await pgrep(`.${mark}`)).toBe('');
  });

  it('取消落在命令起来之前：留下的标记让它不再起来', async () => {
    await run('sh', ['-c', KILL_SCRIPT, 'melina-kill', 'k2', state]);
    const marker = join(root, 'should-not-exist');
    const out = await runExec('k2', root, `touch ${marker}`);
    expect(out).toBe('\nMELINA-EXIT-k2 137\n');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(state, 'exec', 'k2.cancel'))).toBe(false);
  });

  it('没有这次的记录也不报错', async () => {
    const { stdout, stderr } = await run('sh', ['-c', KILL_SCRIPT, 'melina-kill', 'nothing', state]);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });
});

describe('BG_SCRIPT', () => {
  const bg = (id: string, cmd: string, max = 2, cwd = root) =>
    new Promise<string>((resolve) => {
      const p = spawn('sh', ['-c', BG_SCRIPT, 'melina-bg', id, state, logs, cwd, String(max), displayCommand(cmd)]);
      let out = '';
      p.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      p.on('close', () => resolve(out));
      p.stdin.end(cmd);
    });
  /** 状态目录里记着的后台进程（bg/<pid>.rec）：BG_SCRIPT 起进程时写，数的时候把死了的顺手删掉 */
  const records = () => {
    const dir = join(state, 'bg');
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.rec'))
          .map((f) => Number(f.slice(0, -4)))
          .sort((a, b) => a - b)
      : [];
  };

  it('后台命令也能读取被 tail 过滤的失败状态', async () => {
    const result = parseBackgroundOutput(
      await bg('pipeline-bg', "sh -c 'echo probe-failed; exit 7' | tail -n 1; printf 'status=%s\\n' \"$?\""),
    );
    expect(result?.kind).toBe('started');
    await expect.poll(() => readFileSync(result?.log ?? '', 'utf8')).toBe('probe-failed\nstatus=7\n');
  });

  it('起后台进程立即返回 pid 和日志，跨调用活着，满了就拒绝', async () => {
    const first = parseBackgroundOutput(await bg('b1', 'echo from-bg; sleep 301'));
    expect(first?.kind).toBe('started');
    started.push(first?.pid ?? 0);
    expect(first?.log).toBe(join(logs, `bg-${first?.pid}.log`));
    const second = parseBackgroundOutput(await bg('b2', 'sleep 302'));
    started.push(second?.pid ?? 0);
    expect(parseBackgroundOutput(await bg('b3', 'sleep 303'))).toEqual({ kind: 'full', count: 2 });
    expect(existsSync(join(state, 'bg', 'b3.sh'))).toBe(false);

    const pids = [first?.pid ?? 0, second?.pid ?? 0].sort((a, b) => a - b);
    expect(records()).toEqual(pids);
    expect(pids.every((pid) => existsSync(`/proc/${pid}`))).toBe(true);
    await expect.poll(() => readFileSync(first?.log ?? '', 'utf8'), { timeout: 5000 }).toBe('from-bg\n');

    // 死了的不再算：下次起后台进程数到它时，记录和命令文件顺手删掉
    process.kill(first?.pid ?? 0, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    const fourth = parseBackgroundOutput(await bg('b4', 'sleep 304'));
    expect(fourth?.kind).toBe('started');
    started.push(fourth?.pid ?? 0);
    expect(records()).toEqual([second?.pid ?? 0, fourth?.pid ?? 0].sort((a, b) => a - b));
    expect(existsSync(join(state, 'bg', 'b1.sh'))).toBe(false);
  });

  it('pid 被复用了不认错：启动时间对不上就当已经结束', async () => {
    const alive = records().length;
    const pid = process.pid; // 一个活着、但不是我们起的进程
    mkdirSync(join(state, 'bg'), { recursive: true });
    writeFileSync(join(state, 'bg', `${pid}.rec`), `1\n${join(logs, 'x.log')}\nfake\n${join(state, 'bg', 'x.sh')}\n`);
    // 上限正好比真活着的多一个：这条记录要是算进去就满了
    const r = parseBackgroundOutput(await bg('b6', 'sleep 305', alive + 1));
    expect(r?.kind).toBe('started');
    started.push(r?.pid ?? 0);
    expect(records()).not.toContain(pid);
  });

  it('工作目录不在', async () => {
    expect(parseBackgroundOutput(await bg('b5', 'true', 9, join(root, 'nope')))).toEqual({ kind: 'nodir' });
  });
});

describe('WRITE_FILE_SCRIPT', () => {
  it('把 stdin 写进文件，目录不在就建，只有自己能读', async () => {
    const file = join(root, 'secrets', 'deep', 'token');
    const child = spawn('sh', ['-c', WRITE_FILE_SCRIPT, 'melina-write', file]);
    child.stdin.end('line1\nline2\n');
    await new Promise((r) => child.on('close', r));
    expect(readFileSync(file, 'utf8')).toBe('line1\nline2\n');
    const { stdout } = await run('stat', ['-c', '%a', file]);
    expect(stdout.trim()).toBe('600');
  });
});

describe('displayCommand', () => {
  it('只留第一行、去掉制表符、太长截断', () => {
    expect(displayCommand('npm run dev\n# 第二行')).toBe('npm run dev …');
    expect(displayCommand('a\tb')).toBe('a b');
    expect(displayCommand('x'.repeat(300))).toHaveLength(200);
  });
});
