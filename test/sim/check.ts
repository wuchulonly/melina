// 在 Run 外面检查一份交付的 workspace：
//   node test/sim/check.ts service-hard --seed demo --dir /path/to/delivered
// 过了退出码 0，没过 1。

import { parseArgs } from 'node:util';
import { taskById } from './tasks.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { seed: { type: 'string' }, dir: { type: 'string' } },
});
const id = positionals[0];
if (!id || !values.seed || !values.dir) {
  console.error('用法：node test/sim/check.ts <任务 id> --seed <种子> --dir <交付的目录>');
  process.exit(2);
}
const result = taskById(id).create(values.seed).check(values.dir);
console.log(`${result.pass ? '过了' : '没过'}：${result.summary}`);
process.exit(result.pass ? 0 : 1);
