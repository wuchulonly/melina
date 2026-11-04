// plan  的「做完的标准」：标准解都过检查，没动过的环境都不过；门槛 1 的简单任务和门槛 3 的难题都备好。
// 另外查：中等和难的直接做法过不了；同一个种子生成同样的目标和附件；附件和目标里不透露藏起来的规则。
// 每个任务用跑分脚本的种子规则取前 3 个世界；更多种子用 node test/sim/sweep.ts 扫。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MASTER_SEED, deriveSeed } from '../../sim/kit/rng.ts';
import { SimServer } from '../../sim/server.ts';
import { allTasks, selectTasks } from '../../sim/tasks.ts';
import { verifyWorld } from '../../sim/verify.ts';

let server: SimServer;

beforeAll(async () => {
  server = new SimServer();
  await server.start();
});

afterAll(async () => {
  await server.close();
});

describe('任务清单', () => {
  it('四类环境各三档，按难度对应门槛 1、2、3；另有加码的一档（难度照旧是难）、订单服务的配额档', () => {
    const tasks = allTasks();
    expect(tasks.map((t) => t.id)).toEqual([
      'machine-easy',
      'machine-medium',
      'machine-hard',
      'service-easy',
      'service-medium',
      'service-hard',
      'constraints-easy',
      'constraints-medium',
      'constraints-hard',
      'machine-extreme',
      'service-extreme',
      'constraints-extreme',
      'service-quota',
      'tuning-easy',
      'tuning-medium',
      'tuning-hard',
    ]);
    for (const t of tasks) expect(t.gate).toBe({ easy: 1, medium: 2, hard: 3 }[t.difficulty]);
    expect(selectTasks('gate1').map((t) => t.difficulty)).toEqual(['easy', 'easy', 'easy', 'easy']);
    expect(selectTasks('gate3,service-easy').map((t) => t.id)).toEqual([
      'machine-hard',
      'service-easy',
      'service-hard',
      'constraints-hard',
      'machine-extreme',
      'service-extreme',
      'constraints-extreme',
      'service-quota',
      'tuning-hard',
    ]);
    expect(selectTasks('service-extreme').map((t) => t.title)).toEqual(['订单服务（加码）']);
    expect(() => selectTasks('nope')).toThrow('没有这样的任务');
  });
});

for (const task of allTasks()) {
  describe(task.id, () => {
    for (let rep = 0; rep < 3; rep++) {
      const seed = deriveSeed(DEFAULT_MASTER_SEED, task.id, rep);
      it(`第 ${rep} 个世界：标准解过、没动过的不过${task.difficulty === 'easy' ? '' : '、直接做法不过'}`, async () => {
        const r = await verifyWorld(task, seed, server);
        expect(r.reference.error).toBeUndefined();
        expect(r.reference, r.reference.summary).toMatchObject({ pass: true });
        expect(r.untouched.pass).toBe(false);
        if (task.difficulty !== 'easy') expect(r.naive.pass, r.naive.summary).toBe(false);
        expect(r.ok).toBe(true);
      }, 60_000); // 难档一个世界一两秒，pnpm check 时机器忙会更慢
    }

    it('同一个种子同样的目标、完成标准、附件和起点；评估用的完成标准每条都能自己核对', () => {
      const url = 'http://host.containers.internal:9100/t0k3n';
      const a = task.create('same');
      const b = task.create('same');
      expect(b.statement(url)).toBe(a.statement(url));
      expect(b.completion(url)).toEqual(a.completion(url));
      expect(b.materials(url)).toEqual(a.materials(url));
      expect(b.starter()).toEqual(a.starter());
      expect(b.summary()).toEqual(a.summary());
      expect(a.statement(url)).toContain(url);
      expect(a.completion(url).criteria.length).toBeGreaterThanOrEqual(2);
      expect(task.domain).toBe('general');
    });

    it('目标、完成标准、附件和起点里不透露藏起来的规则', () => {
      const url = 'http://sim.local/t';
      const w = task.create('leak');
      const c = w.completion(url);
      // 完成标准里「同一个订单只算一次」「精确到分」这类是在定义什么算对，有意留着；这里查的是藏起来的接口和规则本身
      const visible = [
        w.statement(url),
        c.interpretation,
        ...c.criteria,
        ...w.materials(url).map((m) => m.content),
        ...Object.values(w.starter()),
      ].join('\n');
      const hidden: Record<string, RegExp> = {
        machine: /PRIME|HEAT|泄压|压力|联锁条件|偶数|奇数/,
        service: /cursor|游标|include_archived|archived|v2|Link|amount_cents|过期|限流/,
        constraints: /预留|保留|同一台机器上的服务|可用区要分开|anti|E_MEM|rejected/,
        tuning: /负数|非负|悬崖|热数据|LRU|争抢|核数|内存上限是/,
      };
      expect(visible).not.toMatch(hidden[task.env] as RegExp);
    }, 30_000); // 生成难一点的世界单独跑要 3 秒多，整套单测并行时偶尔超过 5 秒的默认上限
  });
}
