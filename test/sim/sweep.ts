// 扫一遍评估要用的世界：每个任务按跑分脚本的种子规则（deriveSeed(总种子, 任务, 第几次)）生成 reps 个世界，逐个 verifyWorld。
// 改了生成规则或难度参数以后跑一下：
//   node test/sim/sweep.ts --tasks all --reps 20 --master melina-eval-v1
// 有不合格的世界就打出来，退出码 1。

import { parseArgs } from 'node:util';
import { DEFAULT_MASTER_SEED, deriveSeed } from './kit/rng.ts';
import { SimServer } from './server.ts';
import { selectTasks } from './tasks.ts';
import { verifyWorld } from './verify.ts';

const { values } = parseArgs({
  options: {
    tasks: { type: 'string', default: 'all' },
    reps: { type: 'string', default: '10' },
    master: { type: 'string', default: DEFAULT_MASTER_SEED },
  },
});

const server = new SimServer();
await server.start();
let bad = 0;
for (const task of selectTasks(values.tasks)) {
  const stats = { worlds: 0, refRequests: 0, refMs: 0, genMs: 0, naivePass: 0 };
  for (let rep = 0; rep < Number(values.reps); rep++) {
    const seed = deriveSeed(values.master, task.id, rep);
    const r = await verifyWorld(task, seed, server);
    stats.worlds++;
    stats.refRequests += r.reference.requests;
    stats.refMs += r.reference.ms;
    stats.genMs += r.generateMs;
    if (r.naive.pass) stats.naivePass++;
    if (!r.ok) {
      bad++;
      console.log(`不合格 ${task.id} 第 ${rep} 次（种子 ${seed}）`);
      console.log(
        `  标准解：${r.reference.pass ? '过' : '没过'}，${r.reference.summary}${r.reference.error ? `；出错：${r.reference.error}` : ''}`,
      );
      console.log(`  直接做法：${r.naive.pass ? '过' : '没过'}，${r.naive.summary}`);
      console.log(`  没动过：${r.untouched.pass ? '过' : '没过'}，${r.untouched.summary}`);
    }
  }
  const n = stats.worlds;
  console.log(
    `${task.id}：${n} 个世界；标准解平均 ${Math.round(stats.refRequests / n)} 个请求、${Math.round(stats.refMs / n)} ms；` +
      `生成平均 ${Math.round(stats.genMs / n)} ms；直接做法过了 ${stats.naivePass} 个`,
  );
}
await server.close();
if (bad > 0) {
  console.log(`共 ${bad} 个世界不合格`);
  process.exit(1);
}
console.log('全部合格');
