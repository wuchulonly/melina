// 作业调参的直接做法：先试「workers、batch_size、cache_mb 都开到最大」；不行就从默认配置出发做坐标下降：
// 一次只动一个参数，每个参数在几档里挑最快的（同一个参数的几档一起交），校验和和默认配置对不上的不要，一轮轮扫到不再变快。
// 简单的那档这样能到；中等和难的，workers 先加到把内存占满，缓存就再也开不到装下热数据，卡在目标之上。

import { httpOk, writeJson } from '../client.ts';
import type { SolveContext } from '../task.ts';
import { type JobConfig, key, Lab } from './solve.ts';

const GRID: Record<keyof JobConfig, readonly (number | string)[]> = {
  workers: [1, 2, 4, 8, 16, 32],
  batch_size: [64, 128, 256, 512, 1024, 2048, 4096, 8192],
  cache_mb: [0, 1024, 2048, 4096, 8192, 16384],
  compression: ['none', 'lz4', 'zstd'],
  sort: ['merge', 'radix'],
  spill: ['memory', 'disk'],
  prefetch: [0, 2, 4, 8],
};

export async function naiveTuning(ctx: SolveContext): Promise<void> {
  const lab = new Lab(ctx);
  const info = await httpOk<{ default: JobConfig }>(`${ctx.url}/`);
  const [base, max] = await lab.run([
    info.default,
    { ...info.default, workers: 32, batch_size: 8192, cache_mb: 16384 },
  ]);
  if (base?.status !== 'ok' || base.runtime_s === undefined) throw new Error('默认配置没跑成');
  const checksum = base.output_checksum;
  let config = info.default;
  let time = base.runtime_s;
  if (max?.status === 'ok' && max.output_checksum === checksum && max.runtime_s !== undefined && max.runtime_s < time) {
    config = max.config;
    time = max.runtime_s;
  }
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const name of Object.keys(GRID) as (keyof JobConfig)[]) {
      const options = (GRID[name] as readonly (number | string)[])
        .map((v) => ({ ...config, [name]: v }) as JobConfig)
        .filter((c) => key(c) !== key(config));
      for (const v of await lab.run(options)) {
        if (v.status !== 'ok' || v.output_checksum !== checksum || v.runtime_s === undefined) continue;
        if (v.runtime_s < time) {
          config = v.config;
          time = v.runtime_s;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  writeJson(ctx.dir, 'config.json', config);
}
