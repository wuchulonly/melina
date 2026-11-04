// 检查环境的毛病不算交付没过：沙箱没把命令跑起来、沙箱里没有 python3 时抛错，跑分记成出错；
// 超时、被杀、一个测试都没跑起来的标上 suspect，跑分拿标准解在同一个沙箱里复跑：标准解也没过就记出错，标准解过了才算交付没过。
// 对照样例的结果都是已知的：标准解该过、直接的做法该挂，沙箱是好是坏由测试定。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerRuntime } from '../../../src/core/interfaces/container.ts';
import { solutionContender } from '../../eval/contenders.ts';
import { codeTask, HIDDEN_DIR, parseUnittest, runHiddenTests, testsSummary } from '../../eval/real/kit.ts';
import { containerSandbox } from '../../eval/sandbox.ts';
import type { Sandbox } from '../../eval/task.ts';
import { runTrial, type TrialOptions } from '../../eval/trial.ts';
import { writeFiles } from '../../eval/workspace.ts';
import { SimServer } from '../../sim/server.ts';

const PASSED = 'test_a (m.T.test_a) ... ok\n\nRan 1 test in 0.001s\n\nOK\n';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'melina-check-env-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('隐藏测试的结果', () => {
  it('命令里的 timeout 先到点（124）算超时；超时、被杀、一个都没跑起来的标 suspect，测试挂了的不标', () => {
    expect(parseUnittest('test_a (m.T.test_a) ... ', 124, false)).toMatchObject({ timedOut: true, ok: false });
    expect(testsSummary(parseUnittest('', 124, false))).toMatchObject({ pass: false, suspect: '检查超时' });
    expect(testsSummary(parseUnittest('test_a (m.T.test_a) ... ok\nKilled\n', 137, false))).toMatchObject({
      pass: false,
      suspect: '检查被杀',
    });
    expect(testsSummary(parseUnittest('ImportError: x\n', 1, false))).toMatchObject({
      pass: false,
      suspect: '一个测试都没跑起来',
    });
    const failed = testsSummary(
      parseUnittest('test_a (m.T.test_a) ... FAIL\n\nRan 1 test in 0.1s\n\nFAILED (failures=1)\n', 1, false),
    );
    expect(failed.pass).toBe(false);
    expect(failed.suspect).toBeUndefined();
    expect(testsSummary(parseUnittest(PASSED, 0, false))).toEqual({ pass: true, summary: '隐藏测试 1 个全过' });
  });

  it('沙箱里没有 python3：抛错（检查没跑成），不当成交付没过', async () => {
    // 照原样跑跑分给的那条命令，只是 PATH 里什么都没有：bash 的内建命令照常能用，python3 找不到
    const empty = mkdtempSync(join(tmpdir(), 'melina-empty-path-'));
    const noPython: Sandbox = async (dir, cmd) => {
      const r = spawnSync('/bin/bash', ['-c', cmd], { cwd: dir, env: { PATH: empty }, encoding: 'utf8' });
      return { exitCode: r.status, output: `${r.stdout}${r.stderr}`, timedOut: false };
    };
    try {
      await expect(runHiddenTests(scratch, { 'test_x.py': '' }, noPython)).rejects.toThrow(/没有 python3/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('检查用的容器沙箱', () => {
  const runtime = (output: string, exitCode: number | null) => {
    const cmds: string[] = [];
    const rt: Pick<ContainerRuntime, 'start' | 'exec' | 'remove'> = {
      start: async () => ({ id: 'check' }) as never,
      exec: async (_ref, req) => {
        cmds.push(req.cmd);
        return { exitCode, output, timedOut: false } as never;
      },
      remove: async () => {},
    };
    return { rt, cmds };
  };

  it('命令开头先打一行记号：输出里有它，去掉以后原样返回', async () => {
    const { rt, cmds } = runtime(`MELINA_CHECK_STARTED\n${PASSED}`, 0);
    const r = await containerSandbox(rt)(scratch, 'python3 -m unittest', { timeoutMs: 1000, domain: 'code' });
    expect(cmds[0]).toBe('echo MELINA_CHECK_STARTED; python3 -m unittest');
    expect(r).toEqual({ exitCode: 0, output: PASSED, timedOut: false });
  });

  it('输出里没有记号（proot 起不来时返回 127、不抛错）：沙箱没把命令跑起来，抛错', async () => {
    const { rt } = runtime('proot 起不来：spawn /root/.cache/melina/proot EAGAIN\n', 127);
    await expect(containerSandbox(rt)(scratch, 'true', { timeoutMs: 1000, domain: 'code' })).rejects.toThrow(
      /沙箱没把命令跑起来（退出码 127）/,
    );
  });
});

describe('检查没过又分不清是谁的问题：拿标准解在同一个沙箱里复跑', () => {
  let server: SimServer;
  let out: string;
  let options: TrialOptions;
  beforeAll(async () => {
    server = new SimServer();
    await server.start();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'melina-check-env-trial-'));
    options = { server, out, master: 'unit', maxTokens: 1_000_000, signal: new AbortController().signal };
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  /** 一道假的代码题：起点 a.txt 是 start，标准解改成 good，直接的做法改成 bad */
  const task = () => {
    writeFiles(join(scratch, 'task'), {
      'starter/a.txt': 'start\n',
      'solution/a.txt': 'good\n',
      'naive/a.txt': 'bad\n',
      'hidden/test_a.py': '',
    });
    return codeTask({
      id: 'code-fake',
      difficulty: 'easy',
      title: '假代码题',
      dir: join(scratch, 'task'),
      statement: '把 a.txt 改好',
      completion: { interpretation: '把 a.txt 改好', criteria: ['a.txt 是 good'] },
      notes: {},
    });
  };
  /** 交付是 good 的全过；不是 good 的跑到超时（像死循环）：超时本身分不清是交付慢还是环境慢 */
  const slowWhenBad: Sandbox = async (dir) =>
    readFileSync(join(dir, 'a.txt'), 'utf8') === 'good\n' &&
    readFileSync(join(dir, HIDDEN_DIR, 'test_a.py'), 'utf8') === ''
      ? { exitCode: 0, output: PASSED, timedOut: false }
      : { exitCode: 124, output: 'test_a (m.T.test_a) ... ', timedOut: false };
  /** 检查环境坏了：什么都跑到超时 */
  const broken: Sandbox = async () => ({ exitCode: 124, output: '', timedOut: false });

  it('交付慢：同一个沙箱里标准解过了，算交付没过', async () => {
    const r = await runTrial(task(), solutionContender('naive'), 0, { ...options, sandbox: slowWhenBad });
    expect(r).toMatchObject({ status: 'done', checkPass: false });
    expect(r.checkSummary).toBe('隐藏测试跑超时了（同一个沙箱里标准解过了）');
    expect(r.error).toBeUndefined();
  });

  it('检查环境坏了：标准解也没过，记成跑分出错（不进分母），不算交付没过', async () => {
    const r = await runTrial(task(), solutionContender('reference'), 0, { ...options, sandbox: broken });
    expect(r).toMatchObject({ status: 'error', checkPass: false });
    expect(r.error).toMatch(/^检查环境出了问题（检查超时）：同一个沙箱里标准解也没过/);
  });

  it('检查过了就不复跑', async () => {
    let calls = 0;
    const counted: Sandbox = async (dir, cmd, opts) => {
      calls++;
      return slowWhenBad(dir, cmd, opts);
    };
    const r = await runTrial(task(), solutionContender('reference'), 0, { ...options, sandbox: counted });
    expect(r).toMatchObject({ status: 'done', checkPass: true });
    expect(calls).toBe(1);
  });
});
