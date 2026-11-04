// 作业调参的标准解：只用 runner.md 写的接口、GET / 的说明和目标里的数，照有经验的人的做法一轮轮做实验，
// 每轮同时交 4 个作业（并发上限），等这一轮跑完再定下一轮：
// 1. 基线：默认配置（耗时、校验和）；radix（校验和对不上就不用，顺带开 prefetch 量预读缓冲占多少内存）；
//    worker 和 batch 压小、不开缓存的探针（量 worker 的内存怎么涨，也是后面找缓存悬崖的参照）；
//    一个肯定装不下的配置（OOM 时报的峰值就是内存上限，而且死得快）。
// 2. 找缓存的悬崖：探针不变，缓存从小到内存放得下的最大值分四档试，耗时比参照掉一大截的就是装下了热数据；
//    再在最后一段里细分，直到差一档（256 MB）。
// 3. 缓存定在刚好装下，剩下的内存在 worker 和 batch 之间分：挑几个 worker 数，batch 取放得下的最大值，
//    再在最好的附近细找。内存是确定的（没有噪声），跑成了的配置就一定放得下，所以比模型算出的上限多试一两个 worker。
// 4. 在最好的配置上试压缩和 prefetch（要腾内存就少开 worker），再把好的组合起来。
// 5. 量到的里面挑最快、校验和对的；比目标快出噪声就交，差一点的多跑两次取平均再定。
// 每一步做完，量到的最快的已经比目标快出噪声（不到目标的 95%）就不再往下试，直接交。
//
// 它知道生成器的几个前提（像 machine/solve.ts 那样写明）：内存峰值是线性的（基础 + 每份 × worker × batch + 缓存
// + 每级预读 × worker × prefetch）；缓存只有装下热数据才有大用（悬崖）；worker 超过核数以后不会更快；输出只有排序算法可能变。
// 具体的数全靠试。不 import world.ts 和 api.ts。

import { http, httpOk, writeJson } from '../client.ts';
import type { SolveContext } from '../task.ts';

export interface JobConfig {
  workers: number;
  batch_size: number;
  cache_mb: number;
  compression: string;
  sort: string;
  spill: string;
  prefetch: number;
}

export interface JobView {
  id: string;
  status: string;
  config: JobConfig;
  runtime_s?: number;
  peak_mem_gb?: number;
  output_checksum?: string;
}

interface Info {
  default: JobConfig;
  params: {
    workers: { max: number };
    batch_size: { values: number[] };
    cache_mb: { max: number; step: number };
    compression: { values: string[] };
  };
}

const DONE = new Set(['ok', 'oom', 'timeout', 'cancelled']);
const POLL_MS = 2000;
/** 按模型挑配置时内存留的余量（峰值只报到 0.1 GB） */
const SAFE_GB = 0.1;
/** 耗时比不开缓存的参照短这么多才算装下了热数据（噪声 ±3%，缓存差一点时也有一点点命中） */
const CLIFF = 0.86;

/** 目标里写的「要调到 312 秒以内」 */
export function targetOf(statement: string): number {
  const m = /要调到\s*(\d+)\s*秒以内/.exec(statement);
  if (!m) throw new Error('目标里没写要调到多少秒');
  return Number(m[1]);
}

export function key(c: JobConfig): string {
  return `${c.workers}/${c.batch_size}/${c.cache_mb}/${c.compression}/${c.sort}/${c.spill}/${c.prefetch}`;
}

/** 交作业、等结果 */
export class Lab {
  readonly ctx: SolveContext;
  readonly done: JobView[] = [];

  constructor(ctx: SolveContext) {
    this.ctx = ctx;
  }

  async submit(config: JobConfig): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const res = await http(`${this.ctx.url}/jobs`, { method: 'POST', body: config });
      if (res.status === 201) return (res.body as { id: string }).id;
      if (res.status !== 429) throw new Error(`交作业返回 ${res.status}：${res.text}`);
      await this.ctx.sleep(Number(res.headers.get('retry-after') ?? '5') * 1000);
    }
    throw new Error('一直交不上作业');
  }

  /** 一批配置一起交，等全部结束，按顺序返回 */
  async run(configs: JobConfig[]): Promise<JobView[]> {
    const ids: string[] = [];
    for (const c of configs) ids.push(await this.submit(c));
    for (;;) {
      const { jobs } = await httpOk<{ jobs: JobView[] }>(`${this.ctx.url}/jobs`);
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const views = ids.map((id) => byId.get(id));
      if (views.every((v) => v !== undefined && DONE.has(v.status))) {
        this.done.push(...(views as JobView[]));
        return views as JobView[];
      }
      await this.ctx.sleep(POLL_MS);
    }
  }
}

/** 内存模型：峰值 = base + slot × worker × batch + 缓存 + pf × worker × prefetch（spill 一直落盘）。每轮用全部观测重新拟合 */
class Memory {
  coef = [0, 0, 0]; // base、slot、pf
  limit = Number.POSITIVE_INFINITY;
  readonly rows: number[][] = [];
  readonly ys: number[] = [];

  learn(views: JobView[]): void {
    for (const v of views) {
      const c = v.config;
      if (v.status === 'oom' && v.peak_mem_gb !== undefined) this.limit = Math.min(this.limit, v.peak_mem_gb);
      if (v.status !== 'ok' || v.peak_mem_gb === undefined || c.spill !== 'disk') continue;
      this.rows.push([1, c.workers * c.batch_size, c.workers * c.prefetch]);
      this.ys.push(v.peak_mem_gb - c.cache_mb / 1024);
    }
    this.coef = leastSquares(this.rows, this.ys) ?? this.coef;
  }

  of(c: JobConfig): number {
    const [base = 0, slot = 0, pf = 0] = this.coef;
    return base + slot * c.workers * c.batch_size + c.cache_mb / 1024 + pf * c.workers * c.prefetch;
  }

  fits(c: JobConfig): boolean {
    return this.of(c) <= this.limit - SAFE_GB;
  }
}

export async function solveTuning(ctx: SolveContext): Promise<void> {
  const target = targetOf(ctx.statement);
  const info = await httpOk<Info>(`${ctx.url}/`);
  const base = info.default;
  const batches = [...info.params.batch_size.values].sort((a, b) => a - b);
  const smallest = batches[0] ?? base.batch_size;
  const step = info.params.cache_mb.step;
  const workersMax = info.params.workers.max;
  const lab = new Lab(ctx);
  const mem = new Memory();
  // 校验和对的配置量到的耗时（同一个配置量了几次就取平均）
  const times = new Map<string, { config: JobConfig; runs: number[] }>();
  let checksum: string | undefined;
  const good = (v: JobView | undefined): v is JobView & { runtime_s: number } =>
    v?.status === 'ok' && v.output_checksum === checksum && v.runtime_s !== undefined;
  const mean = (k: string) => {
    const runs = times.get(k)?.runs ?? [];
    return runs.length === 0 ? Number.POSITIVE_INFINITY : runs.reduce((a, b) => a + b, 0) / runs.length;
  };
  const ranked = () => [...times.keys()].sort((a, b) => mean(a) - mean(b));
  const lead = () => times.get(ranked()[0] ?? '')?.config;
  const run = async (configs: JobConfig[]): Promise<JobView[]> => {
    const views = await lab.run(configs);
    mem.learn(views);
    checksum ??= views[0]?.output_checksum;
    for (const v of views) {
      if (!good(v)) continue;
      const entry = times.get(key(v.config)) ?? { config: v.config, runs: [] };
      entry.runs.push(v.runtime_s);
      times.set(key(v.config), entry);
    }
    return views;
  };
  /** 只交没量过的 */
  const measure = async (configs: (JobConfig | undefined)[]): Promise<void> => {
    const fresh = new Map<string, JobConfig>();
    for (const c of configs) if (c && !times.has(key(c))) fresh.set(key(c), c);
    if (fresh.size > 0) await run([...fresh.values()]);
  };
  /** 最快的那个已经比目标快出噪声，就不用再试了 */
  const reached = () => mean(ranked()[0] ?? '') <= target * 0.95;
  const deliver = (c: JobConfig) => writeJson(ctx.dir, 'config.json', c);

  // 1. 基线
  const probe = (wp: number): JobConfig => ({ ...base, workers: wp, batch_size: smallest, cache_mb: 0 });
  const [b0, bRadix, ref8] = await run([
    base,
    { ...base, sort: 'radix', prefetch: 4 },
    probe(8),
    {
      ...base,
      workers: workersMax,
      batch_size: batches[batches.length - 1] ?? base.batch_size,
      cache_mb: info.params.cache_mb.max,
    },
  ]);
  if (b0?.status !== 'ok' || !b0.output_checksum) throw new Error(`默认配置没跑成：${JSON.stringify(b0)}`);
  const sort = bRadix?.status === 'ok' && bRadix.output_checksum === checksum ? 'radix' : 'merge';

  // 2. 找缓存的悬崖：探针的 worker 和 batch 压小；最大那档也没掉下来，就再少开几个 worker 腾内存
  const findCliff = async (wp: number, known?: JobView): Promise<number | undefined> => {
    const p = probe(wp);
    let ref = known;
    const top = Math.min(
      info.params.cache_mb.max,
      Math.floor(((mem.limit - SAFE_GB - mem.of(p)) * 1024) / step) * step,
    );
    if (top < step) return undefined;
    let lo = 0;
    let hi = top + step; // 先当成「最大的那档也装不下」
    while (hi - lo > step) {
      const n = Math.min(ref ? 4 : 3, (hi - lo) / step - 1);
      const points = [
        ...new Set(Array.from({ length: n }, (_, k) => lo + Math.round(((k + 1) * (hi - lo)) / (n + 1) / step) * step)),
      ].filter((x) => x > lo && x < hi);
      const views = await run([...(ref ? [] : [p]), ...points.map((x) => ({ ...p, cache_mb: x }))]);
      if (!ref) ref = views.shift();
      if (!good(ref)) return undefined;
      const limit = ref.runtime_s * CLIFF;
      const first = points.findIndex((_, i) => good(views[i]) && (views[i]?.runtime_s ?? 0) < limit);
      if (first < 0) lo = points[points.length - 1] as number;
      else {
        hi = points[first] as number;
        lo = first > 0 ? (points[first - 1] as number) : lo;
      }
    }
    return hi <= top ? hi : undefined;
  };
  let cacheMb = 0;
  for (const wp of [8, 4, 2]) {
    const found = await findCliff(wp, wp === 8 ? ref8 : undefined);
    if (found !== undefined) {
      cacheMb = found;
      break;
    }
  }
  if (reached()) return deliver(lead() as JobConfig);

  // 3. 缓存定下来以后，内存在 worker 和 batch 之间分：先粗后细
  const shape: JobConfig = { ...base, sort, cache_mb: cacheMb, prefetch: 0 };
  const sized = (w: number): JobConfig | undefined => {
    if (w < 1 || w > workersMax) return undefined;
    let b = smallest;
    for (const x of batches) if (mem.fits({ ...shape, workers: w, batch_size: x })) b = x;
    return { ...shape, workers: w, batch_size: b };
  };
  let wTop = 1;
  for (let w = 1; w <= workersMax; w++) if (mem.fits({ ...shape, workers: w, batch_size: smallest })) wTop = w;
  await measure([wTop + 1, wTop, Math.round(wTop * 0.75), Math.round(wTop / 2)].map(sized));
  const coarse = lead();
  if (coarse) {
    const w = coarse.workers;
    const span = w > wTop ? 1 : Math.max(1, Math.round(wTop / 8));
    await measure([w - 2 * span, w - span, w + span, w + 2 * span].map(sized));
  }
  if (reached()) return deliver(lead() as JobConfig);

  // 4. 压缩和 prefetch（要腾内存就少开 worker），再组合
  const c = lead();
  if (c) {
    const prefetched = (p: number): JobConfig | undefined => {
      for (let w = c.workers; w >= Math.max(1, c.workers - 4); w--) {
        if (mem.fits({ ...c, workers: w, prefetch: p })) return { ...c, workers: w, prefetch: p };
      }
      return undefined;
    };
    const codecs = info.params.compression.values.filter((x) => x !== c.compression);
    await measure([...codecs.map((x) => ({ ...c, compression: x })), prefetched(1), prefetched(2)]);
    const codec = (lead() ?? c).compression;
    const withPrefetch = ranked()
      .map((k) => times.get(k)?.config)
      .find((x) => x !== undefined && x.prefetch > 0 && mean(key(x)) < mean(key(c)));
    await measure([
      { ...c, compression: codec, workers: c.workers + 1 },
      withPrefetch && { ...withPrefetch, compression: codec },
      withPrefetch && { ...withPrefetch, compression: codec, workers: withPrefetch.workers + 1 },
    ]);
  }

  // 5. 挑一个交：最快的那个比目标快出噪声就交；差一点的前两名再各跑两次，按平均挑
  if (!reached() && mean(ranked()[0] ?? '') > target * 0.97) {
    const top = ranked()
      .slice(0, 2)
      .map((k) => times.get(k)?.config as JobConfig);
    await run([...top, ...top]);
  }
  const chosen = lead();
  if (!chosen) throw new Error('一个能用的配置都没量到');
  deliver(chosen);
}

/** 最小二乘（正规方程 + 高斯消元）。某一列一直是同一个数（比如从没开过 prefetch）时那一列的系数取 0 */
export function leastSquares(rows: number[][], ys: number[]): number[] | undefined {
  const width = rows[0]?.length ?? 0;
  if (width === 0) return undefined;
  const cols = [...Array(width).keys()].filter((j) => j === 0 || rows.some((r) => r[j] !== rows[0]?.[j]));
  const m = cols.length;
  const at = (r: number[], j: number) => r[cols[j] ?? 0] ?? 0;
  // 增广矩阵 [XᵀX | Xᵀy]
  const a = cols.map((_, p) => [
    ...cols.map((_, q) => rows.reduce((s, r) => s + at(r, p) * at(r, q), 0)),
    rows.reduce((s, r, i) => s + at(r, p) * (ys[i] ?? 0), 0),
  ]);
  for (let p = 0; p < m; p++) {
    let pivot = p;
    for (let q = p + 1; q < m; q++) if (Math.abs(a[q]?.[p] ?? 0) > Math.abs(a[pivot]?.[p] ?? 0)) pivot = q;
    const row = a[pivot] as number[];
    a[pivot] = a[p] as number[];
    a[p] = row;
    const head = row[p] ?? 0;
    if (Math.abs(head) < 1e-12) return undefined;
    for (let q = 0; q < m; q++) {
      const other = a[q] as number[];
      if (q === p) continue;
      const f = (other[p] ?? 0) / head;
      for (let k = p; k <= m; k++) other[k] = (other[k] ?? 0) - f * (row[k] ?? 0);
    }
  }
  const coef = new Array<number>(width).fill(0);
  for (let p = 0; p < m; p++) coef[cols[p] ?? 0] = (a[p]?.[m] ?? 0) / (a[p]?.[p] ?? 1);
  return coef;
}
