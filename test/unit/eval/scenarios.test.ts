// 业务场景资格与证据验收：标准解只经 HTTP，判题每次从新状态重放。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceStep } from '../../eval/scenarios/client.ts';
import { businessTasks } from '../../eval/scenarios/tasks.ts';
import { type EvalTask, materialText } from '../../eval/task.ts';
import { DEFAULT_MASTER_SEED, deriveSeed } from '../../sim/kit/rng.ts';
import { SimServer } from '../../sim/server.ts';

const tasks = businessTasks();
const dirs: string[] = [];
let server: SimServer;

beforeAll(async () => {
  server = new SimServer();
  await server.start();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await server.close();
});

async function attempt(task: EvalTask, seed: string, kind: 'reference' | 'naive' | 'empty') {
  const world = task.create(seed);
  if (!world.handler) throw new Error('业务题必须有仿真环境');
  const env = server.mount(world.handler({ now: () => 0, sleep: async () => {} }));
  const dir = mkdtempSync(join(tmpdir(), 'melina-business-test-'));
  dirs.push(dir);
  try {
    for (const [name, content] of Object.entries(world.starter())) writeFileSync(join(dir, name), content);
    const ctx = {
      dir,
      url: env.url,
      statement: world.statement(env.url),
      sleep: async () => {},
      materials: Object.fromEntries(
        world.materials(env.url).map((file) => [file.name, materialText(file.name, file.content)]),
      ),
    };
    if (kind === 'reference') await task.solve(ctx);
    if (kind === 'naive') await task.naive(ctx);
    return { world, dir, check: await world.check(dir, {}) };
  } finally {
    server.unmount(env.token);
  }
}

function stepsIn(dir: string): EvidenceStep[] {
  return JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')).steps;
}

function rewriteEvidence(dir: string, steps: EvidenceStep[]) {
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ steps }));
  const positive = steps.findLastIndex((step) => step.response.status >= 200 && step.response.status < 300);
  const negative = steps.findIndex((step) => step.response.status >= 400);
  writeFileSync(
    join(dir, 'report.md'),
    '交付需要由观测核对中间状态，成功结果必须与失败对照一起说明因果关系；完整请求及响应保留在证据中，能够从全新状态重新执行并比较每一步。' +
      `\n[结果](evidence.json#step-${positive}) [对照](evidence.json#step-${negative})\n`,
  );
}

describe('业务场景资格', () => {
  for (const task of tasks) {
    for (let rep = 0; rep < 3; rep++) {
      it(`${task.id} 第 ${rep} 个世界：标准解过，直接做法与空交付不过`, async () => {
        const seed = deriveSeed(DEFAULT_MASTER_SEED, task.id, rep);
        const reference = await attempt(task, seed, 'reference');
        expect(reference.check, reference.check.summary).toMatchObject({ pass: true });
        expect(await reference.world.check(reference.dir, {})).toEqual(reference.check);
        const steps = stepsIn(reference.dir);
        expect(steps.length).toBeLessThanOrEqual(160);
        expect(steps.some((step) => step.response.status >= 400)).toBe(true);
        expect((await attempt(task, seed, 'naive')).check.pass).toBe(false);
        expect((await attempt(task, seed, 'empty')).check.pass).toBe(false);
      }, 30_000);
    }
  }

  it('同种子的公开材料、起点和隐藏规则一致，换种子会产生不同世界', () => {
    const url = 'http://sim.local/test-instance';
    for (const task of tasks) {
      const a = task.create('same');
      const b = task.create('same');
      const c = task.create('different');
      expect(b.statement(url)).toBe(a.statement(url));
      expect(b.completion(url)).toEqual(a.completion(url));
      expect(b.materials(url)).toEqual(a.materials(url));
      expect(b.starter()).toEqual(a.starter());
      expect(b.summary()).toEqual(a.summary());
      expect(c.summary()).not.toEqual(a.summary());
      const visible = [
        a.statement(url),
        JSON.stringify(a.completion(url)),
        JSON.stringify(a.materials(url)),
        JSON.stringify(a.starter()),
      ].join('\n');
      expect(visible).not.toContain(a.summary().mechanism);
      expect(task).toMatchObject({ suite: 'sim', difficulty: 'hard', gate: 3, domain: 'general' });
    }
  });
});

describe('交付必须能够复核', () => {
  const task = tasks[0]!;

  it('仅有正确答案，不能替代实际请求与报告', async () => {
    const reference = await attempt(task, 'evidence', 'reference');
    const empty = await attempt(task, 'evidence', 'empty');
    writeFileSync(join(empty.dir, 'answer.json'), readFileSync(join(reference.dir, 'answer.json')));
    expect((await empty.world.check(empty.dir, {})).pass).toBe(false);
  });

  it('响应内容经过修改，重放会明确失败', async () => {
    const reference = await attempt(task, 'evidence', 'reference');
    const steps = stepsIn(reference.dir);
    steps[0]!.response.body = { fabricated: true };
    rewriteEvidence(reference.dir, steps);
    expect(await reference.world.check(reference.dir, {})).toMatchObject({
      pass: false,
      summary: expect.stringContaining('响应与重放结果不符'),
    });
  });

  it('删掉状态变更，后续成功响应不能原样重放', async () => {
    const reference = await attempt(task, 'evidence', 'reference');
    const steps = stepsIn(reference.dir).filter((step) => !step.request.path.endsWith('/corrections'));
    rewriteEvidence(reference.dir, steps);
    expect(await reference.world.check(reference.dir, {})).toMatchObject({
      pass: false,
      summary: expect.stringContaining('响应与重放结果不符'),
    });
  });

  it('删掉不影响结果的正常读取，仍会因缺少指定对照而失败', async () => {
    const reference = await attempt(task, 'evidence', 'reference');
    const steps = stepsIn(reference.dir).filter(
      (step) =>
        !(
          step.request.method === 'GET' &&
          /^\/api\/reports\/[^/]+$/.test(step.request.path) &&
          (step.response.body as { revision?: number }).revision === 1
        ),
    );
    rewriteEvidence(reference.dir, steps);
    expect(await reference.world.check(reference.dir, {})).toMatchObject({
      pass: false,
      summary: expect.stringContaining('缺少普通读取'),
    });
  });

  it('报告需要引用实际失败对照，完整证据不能替代报告依据', async () => {
    const reference = await attempt(task, 'evidence', 'reference');
    const steps = stepsIn(reference.dir);
    const positive = steps.findLastIndex((step) => step.response.status === 200);
    writeFileSync(
      join(reference.dir, 'report.md'),
      '这份报告声称已经调查全部中间行为，并且给出了正确结果，但引用只指向成功响应，没有指出失败对照如何排除其他解释，因此不足以支持完整结论。' +
        `\n[结果](evidence.json#step-${positive}) [重复结果](evidence.json#step-${positive})\n`,
    );
    expect(await reference.world.check(reference.dir, {})).toMatchObject({
      pass: false,
      summary: expect.stringContaining('失败对照'),
    });
  });

  it('完整证据不能掩盖错误金额，也不能复用于另一个世界', async () => {
    const reference = await attempt(task, 'evidence', 'reference');
    const answer = JSON.parse(readFileSync(join(reference.dir, 'answer.json'), 'utf8'));
    writeFileSync(
      join(reference.dir, 'answer.json'),
      JSON.stringify({ ...answer, amount_cents: answer.amount_cents + 1 }),
    );
    expect((await reference.world.check(reference.dir, {})).pass).toBe(false);
    writeFileSync(join(reference.dir, 'answer.json'), JSON.stringify(answer));
    expect((await task.create('different-world').check(reference.dir, {})).pass).toBe(false);
  });
});
