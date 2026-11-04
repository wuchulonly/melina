// 场景题清单：移出的题不能再被选中；离线调查的标准解过、没动过的和直接做法不过。
// 一次试验从附件（含二进制的）到 Run 外面的检查走得通，不执行交付程序。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { solutionContender } from '../../eval/contenders.ts';
import { parseUnittest } from '../../eval/real/kit.ts';
import { realTasks } from '../../eval/real/tasks.ts';
import { verifyRealWorld } from '../../eval/real/verify.ts';
import { hostSandbox } from '../../eval/sandbox.ts';
import { suiteOf } from '../../eval/task.ts';
import { BATCHES, DEFAULT_TASKS, evalTasks, selectEvalTasks } from '../../eval/tasks.ts';
import { runTrial, type TrialOptions } from '../../eval/trial.ts';
import { SimServer } from '../../sim/server.ts';

describe('挑题', () => {
  it('主清单只含场景探索题，按任务集、环境、难度、批次和 id 筛选', () => {
    const ids = (spec: string) => selectEvalTasks(spec).map((t) => t.id);
    expect(ids('all')).toEqual(BATCHES.scenarios);
    expect(ids('scenarios')).toEqual(ids('all'));
    expect(ids('real')).toEqual(['research-incident', 'research-telemetry']);
    expect(ids('research')).toEqual(ids('real'));
    expect(ids('real:hard')).toEqual(ids('real'));
    expect(ids('harness')).toEqual(['service-quota', 'tuning-medium', 'tuning-hard']);
    expect(ids('harness:hard')).toEqual(['service-quota', 'tuning-hard']);
    expect(ids('sim:medium')).toEqual(['service-medium', 'constraints-medium', 'tuning-medium']);
    expect(ids(DEFAULT_TASKS)).toEqual(ids('sim:medium'));
    expect(ids('gate2')).toEqual(ids('sim:medium'));
    expect(ids('research-incident,service-hard')).toEqual(['service-hard', 'research-incident']);
    expect(selectEvalTasks('all')).toHaveLength(20);
    expect(selectEvalTasks('all').filter((t) => suiteOf(t) === 'sim')).toHaveLength(18);
    expect(selectEvalTasks('business')).toHaveLength(9);
    expect(selectEvalTasks('web')).toHaveLength(4);
    expect(selectEvalTasks('workflow')).toHaveLength(5);
    expect(evalTasks().some((t) => suiteOf(t) === 'code' || t.domain === 'code')).toBe(false);
    expect(() => selectEvalTasks('constructor')).toThrow(/没有这样的任务/);
    expect(ids('sim:hard')).toEqual([
      'service-hard',
      'constraints-hard',
      'service-extreme',
      'constraints-extreme',
      'service-quota',
      'tuning-hard',
      'web-export-snapshot',
      'web-batch-dependencies',
      'workflow-resume',
      'web-cache-consistency',
      'web-resource-alias',
      'workflow-version-restore',
      'workflow-refund-retry',
      'workflow-settlement-events',
      'workflow-inventory-release',
    ]);
    expect(() => selectEvalTasks('nope')).toThrow(/没有这样的任务/);
  });

  it('每个内置批次都指向当前题目，清理不会留下失效的默认选题或批次', () => {
    const ids = new Set(evalTasks().map((task) => task.id));
    for (const [batch, members] of Object.entries(BATCHES)) {
      expect(members.length, batch).toBeGreaterThan(0);
      for (const id of members) expect(ids.has(id), `${batch}: ${id}`).toBe(true);
    }
    expect(selectEvalTasks(DEFAULT_TASKS)).toHaveLength(3);
  });

  it.each([
    'code',
    'code-ledger',
    'code-cron',
    'code-ignore',
    'code-semver',
    'code-csv',
    'code-pages',
    'code-flaky',
    'code-statements',
    'code-bre',
    'research-abtest',
    'research-refunds',
    'research-5xx',
    'machine-easy',
    'machine-medium',
    'machine-hard',
    'machine-extreme',
    'service-easy',
    'constraints-easy',
    'tuning-easy',
    'gate1',
    'harness:easy',
  ])('主清单拒绝已移出的选题 %s', (spec) => {
    expect(() => selectEvalTasks(spec)).toThrow('没有这样的任务');
  });
});

describe('每道题都合格', () => {
  for (const task of realTasks()) {
    it(`${task.id}：标准解过，没动过的、直接的做法都不过`, async () => {
      const r = await verifyRealWorld(task, 'unit-seed', hostSandbox);
      expect(r.reference, r.reference.summary).toMatchObject({ pass: true });
      expect(r.reference.error).toBeUndefined();
      expect(r.untouched.pass).toBe(false);
      expect(r.naive.pass).toBe(false);
      expect(r.ok).toBe(true);
    }, 60_000);
  }
});

describe('研究题的数据按种子生成', () => {
  it('同一个种子同一份数据，换个种子就不一样', () => {
    for (const task of realTasks().filter((t) => suiteOf(t) === 'research')) {
      const a = task.create('s1').materials('');
      const b = task.create('s1').materials('');
      const c = task.create('s2').materials('');
      const text = (ms: typeof a) => ms.map((m) => Buffer.from(m.content).toString('base64')).join('|');
      expect(text(a)).toBe(text(b));
      expect(text(a)).not.toBe(text(c));
    }
  }, 60_000); // 两道调查题各生成三份数据，机器忙时超过默认的 5 秒
});

describe('unittest 的输出', () => {
  it('全过、有挂的、一个都没跑起来', () => {
    const ok = 'test_a (m.T.test_a) ... ok\n\nRan 1 test in 0.001s\n\nOK\n';
    expect(parseUnittest(ok, 0, false)).toMatchObject({ ran: 1, ok: true, failed: [] });
    const bad =
      'test_a (m.T.test_a) ... FAIL\ntest_b (m.T.test_b) ... ERROR\n\nRan 2 tests in 0.1s\n\nFAILED (failures=1, errors=1)\n';
    expect(parseUnittest(bad, 1, false)).toMatchObject({ ran: 2, ok: false, failed: ['test_a', 'test_b'] });
    expect(parseUnittest('ImportError: x\n', 1, false)).toMatchObject({ ran: 0, ok: false });
  });
});

describe('一次试验', () => {
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
    out = mkdtempSync(join(tmpdir(), 'melina-eval-real-'));
    options = { server, out, master: 'unit', maxTokens: 1_000_000, signal: new AbortController().signal };
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });
  const task = (id: string) =>
    realTasks().find((t) => t.id === id) as NonNullable<ReturnType<typeof realTasks>[number]>;

  it('研究题：二进制附件原样写进附件目录、读回来不丢字节，标准解交的 answer.json 过检查', async () => {
    const r = await runTrial(task('research-telemetry'), solutionContender('reference'), 0, options);
    expect(r).toMatchObject({ suite: 'research', status: 'done', checkPass: true });
    expect(r.gate).toBeUndefined();
    expect(r.envRequests).toBe(0);
  });

  it('故障调查按事实核对答案，不需要执行交付代码；标准解过，未经调查的猜测不过', async () => {
    const t = task('research-incident');
    const good = await runTrial(t, solutionContender('reference'), 0, options);
    expect(good).toMatchObject({ suite: 'research', status: 'done', checkPass: true, envRequests: 0 });
    const bad = await runTrial(t, solutionContender('naive'), 0, options);
    expect(bad).toMatchObject({ suite: 'research', status: 'done', checkPass: false });
  });
});
