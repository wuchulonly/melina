// 起一个仿真环境给人手动试，或者手工建一个 Run 来跑（联调时用）：
//   node test/sim/serve.ts machine-hard --seed demo --host 0.0.0.0 --public-host host.containers.internal --out /tmp/sim-demo
// 打出环境地址、一句目标和完成标准，附件和起点 workspace 写进 --out；Ctrl-C 退出时把请求日志写进 --out/env-log.jsonl。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SimServer } from './server.ts';
import { taskById } from './tasks.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seed: { type: 'string', default: 'demo' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '0' },
    'public-host': { type: 'string' },
    out: { type: 'string' },
  },
});
const id = positionals[0];
if (!id) {
  console.error(
    '用法：node test/sim/serve.ts <任务 id> [--seed s] [--host 0.0.0.0] [--port 9100] [--public-host 主机名] [--out 目录]',
  );
  process.exit(2);
}
const task = taskById(id);
const world = task.create(values.seed);
const server = new SimServer({ host: values.host, port: Number(values.port), publicHost: values['public-host'] });
await server.start();
const env = server.mount(
  world.handler({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
);
const out = values.out ?? mkdtempSync(join(tmpdir(), `melina-sim-${task.id}-`));
mkdirSync(join(out, 'materials'), { recursive: true });
mkdirSync(join(out, 'workspace'), { recursive: true });
for (const m of world.materials(env.url)) writeFileSync(join(out, 'materials', m.name), m.content);
for (const [name, content] of Object.entries(world.starter())) writeFileSync(join(out, 'workspace', name), content);

console.log(`任务：${task.title}（${task.id}，种子 ${world.seed}，门槛 ${task.gate}）`);
console.log(`环境：${env.url}`);
console.log(`目标：${world.statement(env.url)}`);
console.log(`领域：${task.domain}`);
console.log('完成标准：');
for (const [i, c] of world.completion(env.url).criteria.entries()) console.log(`  ${i + 1}. ${c}`);
console.log(`附件在 ${join(out, 'materials')}，起点 workspace 在 ${join(out, 'workspace')}`);
console.log(`检查：node test/sim/check.ts ${task.id} --seed ${world.seed} --dir <交付的目录>`);
console.log('Ctrl-C 退出');

process.on('SIGINT', () => {
  writeFileSync(
    join(out, 'env-log.jsonl'),
    env.log.map((e) => JSON.stringify(e)).join('\n') + (env.log.length ? '\n' : ''),
  );
  console.log(`\n共 ${env.stats.requests} 个请求，日志在 ${join(out, 'env-log.jsonl')}`);
  void server.close().then(() => process.exit(0));
});
