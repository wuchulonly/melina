// 评测后的预算核对：只在宿主运行标准解，不向被测模型反馈、不改变三组预算或成绩。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { realClock, VirtualClock } from '../../sim/kit/clock.ts';
import { deriveSeed } from '../../sim/kit/rng.ts';
import { SimServer } from '../../sim/server.ts';
import { materialText } from '../task.ts';
import { selectEvalTasks } from '../tasks.ts';
import { writeFiles } from '../workspace.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    real: { type: 'boolean', default: false },
  },
});
if (!values.out) throw new Error('需要 --out');
const out = resolve(values.out);
const server = new SimServer({ host: '127.0.0.1', publicHost: '127.0.0.1' });
await server.start();
try {
  await Promise.all(
    selectEvalTasks('tuning').map(async (task) => {
      const seed = deriveSeed('melina-three-way-2026-10-13', task.id, 0);
      const world = task.create(seed);
      const virtual = new VirtualClock();
      const clock = values.real ? realClock : virtual;
      const mounted = server.mount(world.handler!(clock));
      const dir = join(out, task.id, values.real ? 'real' : 'virtual');
      mkdirSync(dir, { recursive: true });
      writeFiles(dir, world.starter());
      const materials = Object.fromEntries(
        world.materials(mounted.url).map((m) => [m.name, materialText(m.name, m.content)]),
      );
      const t0 = Date.now();
      const begin = clock.now();
      let waitsMs = 0;
      let error: string | undefined;
      try {
        await task.solve({
          url: mounted.url,
          dir,
          statement: world.statement(mounted.url),
          materials,
          sleep: async (ms) => {
            waitsMs += ms;
            if (values.real && Date.now() - t0 + ms > 20 * 60_000) throw new Error('参考解也达到 20 分钟时间上限');
            await clock.sleep(ms);
          },
        });
      } catch (e) {
        error = String(e);
      }
      const check = await world.check(dir, {});
      const result = {
        task: task.id,
        seed,
        clock: values.real ? 'real' : 'virtual',
        startedAt: new Date(t0).toISOString(),
        wallMs: Date.now() - t0,
        simulatedElapsedMs: clock.now() - begin,
        waitsMs,
        requests: mounted.stats.requests,
        check,
        ...(error ? { error } : {}),
      };
      writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result));
      server.unmount(mounted.token);
    }),
  );
} finally {
  await server.close();
}
