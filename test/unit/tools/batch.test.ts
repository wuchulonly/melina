// 在宿主机执行与容器相同的 runner：验证落盘与真实子进程，不请求外部服务。
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withBatchCommand } from '../../../src/tools/batch.ts';

const script = fileURLToPath(new URL('../../../src/tools/batch.py', import.meta.url));
let root: string;
let jobs: string;
let state: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'melina-batch-'));
  jobs = join(root, 'items.json');
  state = join(root, 'state');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function manifest(items: { id: string; code: string }[]) {
  writeFileSync(jobs, JSON.stringify(items.map(({ id, code }) => ({ id, argv: ['python3', '-u', '-c', code] }))));
}

function saved() {
  return JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
}

function call(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'python3',
      [script, ...args, '--state', state],
      { env: { ...process.env, MELINA_SH_DEADLINE_MS: '', ...env }, timeout: 8000 },
      (error, stdout, stderr) => resolve({ code: Number(error?.code ?? 0), stdout, stderr }),
    );
  });
}

function run(more: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return call(['run', jobs, '--budget', '4', '--reserve', '0.15', '--item-timeout', '0.8', ...more], env);
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (true) {
    try {
      if (predicate()) return;
    } catch {}
    if (Date.now() >= deadline) throw new Error('等待批次状态超时');
    await delay(20);
  }
}

describe('melina-batch', () => {
  it('第三项命中后停止剩余 96 项中的未开始项；省略停止参数续跑也不会重放', async () => {
    const counter = JSON.stringify(join(root, 'count'));
    manifest(
      Array.from({ length: 96 }, (_, i) => ({
        id: `case-${i}`,
        code: `open(${counter}, "a").write("${i}\\n"); raise SystemExit(${i === 2 ? 0 : 4})`,
      })),
    );
    expect((await run(['--stop-on-exit', '0'])).code).toBe(0);
    expect(saved()).toMatchObject({ status: 'matched', stop: { kind: 'exit', itemId: 'case-2' } });
    expect(
      saved()
        .items.slice(3)
        .every((item: { status: string; attempts: number }) => item.status === 'skipped' && item.attempts === 0),
    ).toBe(true);
    expect((await run()).code).toBe(0);
    expect(readFileSync(join(root, 'count'), 'utf8')).toBe('0\n1\n2\n');
    expect((await run(['--retry', 'case-0'])).stderr).toContain('already stopped');
  });

  it('输出判据独立于进程退出码，正常退出但未命中时继续', async () => {
    manifest([
      { id: 'miss', code: 'print("request completed, result absent")' },
      { id: 'hit', code: 'print("RESULT: found")' },
      { id: 'unused', code: 'print("must not execute")' },
    ]);
    expect((await run(['--stop-on-match', '^RESULT: found$'])).code).toBe(0);
    expect(saved()).toMatchObject({ status: 'matched', stop: { kind: 'match', itemId: 'hit' } });
    expect(saved().items[2]).toMatchObject({ status: 'skipped', attempts: 0 });
  });

  it('另一分支发布停止文件时终止 961 项的后续派发，文件消失也不会自动重开', async () => {
    const marker = join(root, 'shared-result');
    manifest(
      Array.from({ length: 961 }, (_, i) => ({
        id: `case-${i}`,
        code: 'import time; time.sleep(0.12); raise SystemExit(4)',
      })),
    );
    const child = spawn('python3', [
      script,
      'run',
      jobs,
      '--state',
      state,
      '--budget',
      '5',
      '--reserve',
      '0.1',
      '--item-timeout',
      '0.5',
      '--stop-on-file',
      marker,
    ]);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.resume();
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    try {
      await until(() => saved().items[0].status === 'running');
      writeFileSync(marker, 'private shared value must not be printed');
      expect(await closed).toBe(0);
      expect(saved()).toMatchObject({ status: 'stopped', stop: { kind: 'file', path: marker } });
      const attempted = saved().items.filter((item: { attempts: number }) => item.attempts > 0).length;
      expect(attempted).toBeLessThanOrEqual(2);
      expect(output).not.toContain('private shared value');
      rmSync(marker);
      expect((await run()).code).toBe(0);
      expect(saved().items.filter((item: { attempts: number }) => item.attempts > 0)).toHaveLength(attempted);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  });

  it('并发命中先停发、保留已在途结果，不再补满并发空位', async () => {
    manifest([
      { id: 'hit', code: 'import time; time.sleep(0.08); print("found")' },
      { id: 'inflight', code: 'import time; time.sleep(0.25); print("finished")' },
      { id: 'unused', code: 'print("unused")' },
    ]);
    expect((await run(['--concurrency', '2', '--stop-on-match', '^found$'])).code).toBe(0);
    expect(saved().items.map((item: { status: string }) => item.status)).toEqual(['completed', 'completed', 'skipped']);
    expect(readFileSync(saved().items[1].log, 'utf8')).toContain('finished');
  });

  it('超时的半截命中输出不熔断，非法或变更的判据也不能复用旧状态', async () => {
    manifest([
      { id: 'slow', code: 'import time; print("found"); time.sleep(2)' },
      { id: 'last', code: 'print("absent")' },
    ]);
    expect((await run(['--stop-on-match', '['])).code).toBe(2);
    expect((await run(['--stop-on-match', '^found$', '--item-timeout', '0.2'])).code).toBe(3);
    expect(saved().stop).toBeUndefined();
    expect(saved().items.map((item: { status: string }) => item.status)).toEqual(['timed_out', 'completed']);
    expect((await run(['--stop-on-exit', '0'])).stderr).toContain('stop conditions changed');
  });

  it('单项落盘后中断仍从原结果恢复命中，不重新执行 pending', async () => {
    manifest([
      { id: 'hit', code: 'print("found")' },
      { id: 'unused', code: 'print("unused")' },
    ]);
    await run(['--stop-on-match', '^found$']);
    const interrupted = saved();
    delete interrupted.stop;
    interrupted.status = 'running';
    interrupted.items[1].status = 'pending';
    writeFileSync(join(state, 'state.json'), JSON.stringify(interrupted));
    expect((await run()).code).toBe(0);
    expect(saved()).toMatchObject({ status: 'matched', stop: { itemId: 'hit' } });
    expect(saved().items[1]).toMatchObject({ status: 'skipped', attempts: 0 });
  });

  it('逐项保存日志；同一清单续跑不会重放已完成项', async () => {
    const counter = JSON.stringify(join(root, 'count'));
    manifest([
      { id: 'one', code: `open(${counter}, "a").write("one\\n"); print("first")` },
      { id: 'two', code: `open(${counter}, "a").write("two\\n"); print("second")` },
    ]);
    expect((await run()).code).toBe(0);
    const initial = saved();
    expect(initial.status).toBe('completed');
    expect(initial.items.map((i: { status: string }) => i.status)).toEqual(['completed', 'completed']);
    expect(readFileSync(initial.items[0].log, 'utf8')).toBe('first\n');
    expect((await run()).code).toBe(0);
    expect(readFileSync(join(root, 'count'), 'utf8')).toBe('one\ntwo\n');
    expect(saved().items.map((i: { attempts: number }) => i.attempts)).toEqual([1, 1]);
  });

  it('到总预算前停止派发，续跑保留已完成项', async () => {
    manifest([
      { id: 'one', code: 'import time; time.sleep(0.4)' },
      { id: 'two', code: 'print(2)' },
    ]);
    const first = await run(['--budget', '1.05']);
    expect(first.code).toBe(3);
    expect(saved().status).toBe('paused');
    expect(saved().items.map((i: { status: string }) => i.status)).toEqual(['completed', 'pending']);
    expect((await run()).code).toBe(0);
    expect(saved().items.map((i: { attempts: number }) => i.attempts)).toEqual([1, 1]);
  });

  it('采用外层绝对截止时间，显式大预算不能绕过它', async () => {
    manifest([{ id: 'one', code: 'print(1)' }]);
    const result = await run(['--budget', '900'], { MELINA_SH_DEADLINE_MS: String(Date.now() + 100) });
    expect(result.code).toBe(3);
    expect(saved().items[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(saved().budgetSeconds).toBeLessThan(0.11);
  });

  it('后台没有外层期限时必须显式给总预算', async () => {
    manifest([{ id: 'one', code: 'print(1)' }]);
    const result = await call(['run', jobs]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('requires --budget');
  });

  it('单项超时保留中间日志，不自动重试失败或超时项', async () => {
    manifest([
      { id: 'slow', code: 'import time; print("partial"); time.sleep(4)' },
      { id: 'bad', code: 'raise SystemExit(9)' },
      { id: 'good', code: 'print("done")' },
    ]);
    expect((await run(['--item-timeout', '0.4'])).code).toBe(3);
    expect(saved().items.map((i: { status: string }) => i.status)).toEqual(['timed_out', 'failed', 'completed']);
    expect(readFileSync(saved().items[0].log, 'utf8')).toContain('partial');
    expect((await run()).code).toBe(3);
    expect(saved().items.map((i: { attempts: number }) => i.attempts)).toEqual([1, 1, 1]);
    expect((await run(['--retry', 'bad'])).code).toBe(3);
    expect(saved().items[1].attempts).toBe(2);
    expect(saved().items[1].log).toMatch(/bad\.2\.log$/);
  });

  it('清单变更或重复标识会拒绝，不能误用旧结果', async () => {
    manifest([{ id: 'one', code: 'print(1)' }]);
    expect((await run()).code).toBe(0);
    manifest([{ id: 'one', code: 'print(2)' }]);
    expect((await run()).stderr).toContain('manifest changed');
    manifest([
      { id: 'one', code: 'print(1)' },
      { id: 'one', code: 'print(2)' },
    ]);
    expect((await run()).stderr).toContain('duplicate');
  });

  it('上次运行中断的项标成 unknown，续跑不自动重放它', async () => {
    manifest([{ id: 'one', code: 'print(1)' }]);
    await run();
    const interrupted = saved();
    interrupted.status = 'running';
    interrupted.items[0].status = 'running';
    writeFileSync(join(state, 'state.json'), JSON.stringify(interrupted));
    const status = JSON.parse((await call(['status'])).stdout);
    expect(status).toMatchObject({ status: 'interrupted', active: false, counts: { unknown: 1 } });
    expect((await run()).code).toBe(3);
    expect(saved().items[0]).toMatchObject({ status: 'unknown', attempts: 1 });
    expect((await run(['--retry', 'one'])).code).toBe(0);
    expect(saved().items[0].attempts).toBe(2);
  });

  it('runner 被强杀但任务仍在运行时继续持锁，退出后标记 unknown', async () => {
    const marker = JSON.stringify(join(root, 'started'));
    manifest([{ id: 'one', code: `import time; open(${marker}, "w").write("started"); time.sleep(1.5)` }]);
    const child = spawn('python3', [script, 'run', jobs, '--state', state, '--budget', '8', '--item-timeout', '4']);
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.stdout.resume();
    child.stderr.resume();
    try {
      await until(() => readFileSync(join(root, 'started'), 'utf8') === 'started');
      child.kill('SIGKILL');
      await closed;
      expect((await run()).stderr).toContain('already running');
      const result = JSON.parse((await call(['wait', '--seconds', '5'])).stdout);
      expect(result).toMatchObject({ status: 'interrupted', active: false, counts: { unknown: 1 } });
      expect((await run()).code).toBe(3);
      expect(saved().items[0]).toMatchObject({ status: 'unknown', attempts: 1 });
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }, 10000);

  it('wait 可以在后台进程刚启动、状态文件尚未出现时等到完成', async () => {
    manifest([{ id: 'one', code: 'print(1)' }]);
    const waiting = call(['wait', '--seconds', '4']);
    await delay(100);
    expect((await run()).code).toBe(0);
    expect(JSON.parse((await waiting).stdout)).toMatchObject({ active: false, status: 'completed' });
  });

  it('单 runner 互斥；短等待有上限，完成后不等满', async () => {
    manifest([{ id: 'one', code: 'import time; time.sleep(1.5)' }]);
    const child = spawn('python3', [script, 'run', jobs, '--state', state, '--budget', '6', '--item-timeout', '3']);
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.stdout.resume();
    child.stderr.resume();
    try {
      await until(() => saved().items[0].status === 'running');
      expect((await run()).stderr).toContain('already running');
      const short = JSON.parse((await call(['wait', '--seconds', '0.1'])).stdout);
      expect(short.active).toBe(true);
      const before = Date.now();
      const done = JSON.parse((await call(['wait', '--seconds', '10'])).stdout);
      expect(done).toMatchObject({ active: false, status: 'completed' });
      expect(Date.now() - before).toBeLessThan(4000);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }, 10000);

  it('并发数量受限，各项之间仍遵守启动间隔', async () => {
    manifest(['one', 'two', 'three'].map((id) => ({ id, code: 'import time; print(time.time()); time.sleep(0.3)' })));
    expect((await run(['--concurrency', '2', '--delay', '0.2'])).code).toBe(0);
    const starts = saved().items.map((item: { log: string }) => Number(readFileSync(item.log, 'utf8')));
    expect(starts[1] - starts[0]).toBeGreaterThan(0.15);
    expect(starts[2] - starts[1]).toBeGreaterThan(0.15);
  });

  it('实际同时运行的项不超过并发上限', async () => {
    manifest(
      ['one', 'two', 'three', 'four'].map((id) => ({
        id,
        code: 'import time; print(time.time()); time.sleep(0.4); print(time.time())',
      })),
    );
    expect((await run(['--concurrency', '2'])).code).toBe(0);
    const events = saved()
      .items.flatMap((item: { log: string }) => {
        const [start, end] = readFileSync(item.log, 'utf8').trim().split('\n').map(Number);
        return [
          { time: start!, change: 1 },
          { time: end!, change: -1 },
        ];
      })
      .sort((a: { time: number }, b: { time: number }) => a.time - b.time);
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.change;
      peak = Math.max(peak, active);
    }
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('取消后落盘 cancelled 且终止普通子进程，后续项保持 pending', async () => {
    const childPid = JSON.stringify(join(root, 'child.pid'));
    manifest([
      {
        id: 'one',
        code: `import subprocess, time; p=subprocess.Popen(["sleep", "30"]); open(${childPid}, "w").write(str(p.pid)); time.sleep(30)`,
      },
      { id: 'two', code: 'print(2)' },
    ]);
    const child = spawn('python3', [script, 'run', jobs, '--state', state, '--budget', '60', '--item-timeout', '40']);
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.stdout.resume();
    child.stderr.resume();
    try {
      await until(() => readFileSync(join(root, 'child.pid'), 'utf8').length > 0);
      child.kill('SIGTERM');
      await closed;
      expect(saved().status).toBe('cancelled');
      expect(saved().items.map((item: { status: string }) => item.status)).toEqual(['cancelled', 'pending']);
      const pid = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
      await until(() => {
        try {
          return readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
        } catch {
          return true;
        }
      });
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }, 10000);

  it('wait 受外层剩余时限约束，无需等满 seconds', async () => {
    manifest([{ id: 'one', code: 'import time; time.sleep(3)' }]);
    const child = spawn('python3', [script, 'run', jobs, '--state', state, '--budget', '8', '--item-timeout', '5']);
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.stdout.resume();
    child.stderr.resume();
    try {
      await until(() => saved().items[0].status === 'running');
      const before = Date.now();
      const result = await call(['wait', '--seconds', '600'], { MELINA_SH_DEADLINE_MS: String(Date.now() + 1100) });
      expect(JSON.parse(result.stdout).active).toBe(true);
      expect(Date.now() - before).toBeLessThan(1500);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }, 10000);

  it('shell 辅助函数保留原命令的退出码', async () => {
    const result = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile('bash', ['-c', withBatchCommand('melina-batch --help; exit 7')], (error, stdout) => {
        resolve({ stdout, code: Number(error?.code ?? 0) });
      });
    });
    expect(result.code).toBe(7);
    expect(result.stdout).toContain('Bounded batches');
  });
});
