// 第四类：作业调参。给一个 Spark 式的批处理作业（读一批日志、按 key 排序聚合、写出结果）调参数，
// 让它在结果不变的前提下跑进目标时间。考的是做实验的方式：每次实验要真等十几秒到一分钟、同时最多跑 4 个；
// 参数之间有交互（单独调哪一个都卡住，要两个一起挪才过得去），有悬崖（缓存装不装得下热数据，差一点就差很多）；
// 最快的那个配置结果是错的（快但不对，测误交付）。一个 agent 一次一个实验、按参数挨个扫，时间不够；
// 看几条路线能不能分头做实验、把量到的记成事实共享、不重复做。
//
// 这里是世界（种子生成，agent 看不到）和纯函数的性能模型，HTTP 在 api.ts，题面和检查在 tasks.ts。
// 性能模型（确定的；每次实验在上面乘一点噪声，见 api.ts）：
// - 时间 = 读 + 排序聚合 + 写 + 开销。CPU 的活按有效并行度分摊：worker 不超过核数时按 worker 数，超过以后争抢、越多越慢；
//   读盘和计算默认是串着的，prefetch 让两者重叠一部分。
// - 读：输入读一遍；作业里有几轮要反复扫同一份热数据。缓存装得下热数据时扫缓存很便宜；装不下时按 LRU 淘汰、顺序扫，
//   每轮都被挤掉，几乎每轮都要从盘上重读、解压、重新解析（悬崖：差一点就差很多）。热数据压不太动。
// - 排序聚合：radix 比 merge 快，但只对非负的 key 排得对；spill 到盘时 shuffle 的数据写一遍读一遍（压缩省盘、费 CPU），
//   放内存省掉读写盘，但占内存。
// - 开销：每批有固定的调度开销（批越小越多），每个 worker 启动要一点时间。
// - 内存峰值 = 基础 + worker 数 × batch_size × 每份的大小 + 缓存 + （spill=memory 时）shuffle 的量 + 预读缓冲；超过上限 OOM。
// - 关键交互（中等和难）：默认配置再把缓存开到装下热数据，内存就超；得同时把 batch_size 或 workers 降下来。
//   从默认出发每次只动一个参数（坐标下降）会先把 workers 加到内存装满，然后卡在目标之上。
//
// 生成时在参数网格上算出结果对的最优，目标 T = 最优 ×（1 + 余量），余量 15%–25%（简单档：最优只在 workers、cache_mb 里找）。
// 不合格的世界重抽（照 constraints/world.ts）：所有档都要默认配置和最好的单参数改动到不了 T；中等和难的还要坐标下降（细网格、
// 直接做法用的粗网格、每步挑最好的单参数改动）到不了 T、不开缓存到不了 T、用 radix 的最快配置比 T 快得多、「全开到最大」跑不了。

import { createHash } from 'node:crypto';
import { Rng } from '../kit/rng.ts';

export const CODECS = ['none', 'lz4', 'zstd'] as const;
export type Codec = (typeof CODECS)[number];
export const SORTS = ['merge', 'radix'] as const;
export type SortAlgo = (typeof SORTS)[number];
export const SPILLS = ['memory', 'disk'] as const;
export type Spill = (typeof SPILLS)[number];
export const BATCH_SIZES = [64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;

export const WORKERS_MAX = 32;
export const CACHE_MAX_MB = 16384;
export const CACHE_STEP_MB = 256;
export const PREFETCH_MAX = 8;
/** 一个作业最多跑多久（换算后的秒），超过记 timeout */
export const MAX_RUNTIME_S = 1800;

export interface JobConfig {
  workers: number;
  batch_size: number; // 每批多少条记录，单位千条
  cache_mb: number;
  compression: Codec;
  sort: SortAlgo;
  spill: Spill;
  prefetch: number;
}

export const CONFIG_KEYS = ['workers', 'batch_size', 'cache_mb', 'compression', 'sort', 'spill', 'prefetch'] as const;

export const DEFAULT_CONFIG: JobConfig = {
  workers: 4,
  batch_size: 512,
  cache_mb: 1024,
  compression: 'none',
  sort: 'merge',
  spill: 'disk',
  prefetch: 0,
};

/** 每个参数的取值规则：报错时说的就是这句 */
const RULES: Record<
  keyof JobConfig,
  { values: readonly unknown[]; text: string } | { ok: (n: number) => boolean; text: string }
> = {
  workers: { ok: (n) => n >= 1 && n <= WORKERS_MAX, text: ` 1 到 ${WORKERS_MAX} 的整数` },
  batch_size: { values: BATCH_SIZES, text: ` ${BATCH_SIZES.join('、')} 之一` },
  cache_mb: {
    ok: (n) => n >= 0 && n <= CACHE_MAX_MB && n % CACHE_STEP_MB === 0,
    text: ` 0 到 ${CACHE_MAX_MB} 之间 ${CACHE_STEP_MB} 的倍数`,
  },
  compression: { values: CODECS, text: ` ${CODECS.join('、')} 之一` },
  sort: { values: SORTS, text: ` ${SORTS.join('、')} 之一` },
  spill: { values: SPILLS, text: ` ${SPILLS.join('、')} 之一` },
  prefetch: { ok: (n) => n >= 0 && n <= PREFETCH_MAX, text: ` 0 到 ${PREFETCH_MAX} 的整数` },
};

/** 参数校验：合格返回完整的配置（没写的用默认值），不合格返回说清哪一个不对的一句话。接口和检查共用 */
export function parseConfig(raw: unknown): JobConfig | string {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG };
  if (typeof raw !== 'object' || Array.isArray(raw)) return '配置要是一个 JSON 对象，例如 {"workers": 8}';
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      return `不认识的参数：${key}（可调的参数：${CONFIG_KEYS.join('、')}）`;
    }
  }
  const out: Record<string, number | string> = { ...DEFAULT_CONFIG };
  for (const key of CONFIG_KEYS) {
    if (!(key in v)) continue;
    const rule = RULES[key];
    const value = v[key];
    const ok =
      'values' in rule
        ? (rule.values as readonly unknown[]).includes(value)
        : typeof value === 'number' && Number.isInteger(value) && rule.ok(value);
    if (!ok) return `${key} 要是${rule.text}，收到的是 ${JSON.stringify(value)}`;
    out[key] = value as number | string;
  }
  return out as unknown as JobConfig;
}

// ── 世界 ──────────────────────────────────────────────────────────────────

type Range = readonly [number, number];

export interface TuningParams {
  cores: readonly number[]; // 机器核数，从里面抽
  contention: Range; // 超过核数以后的争抢系数；[0, 0] 是超过核数不变慢也不变快
  memory: 'ample' | 'tight'; // tight：默认配置再把缓存开到装下热数据就 OOM
  negativeKeys: boolean; // 数据里有没有负数的 key（有的话 radix 排错）
  stages: boolean; // 作业结果里给不给分阶段的耗时
  passes: Range; // 热数据反复扫几轮（整数）
  hotGb: Range;
  inputGb: Range;
  diskMBps: Range;
  parseCpu: Range; // 每 GB 数据解析要的 CPU 秒
  mergeCpu: Range; // 每百万条 merge 排序要的 CPU 秒
  radixCpu: Range;
  shuffleGb: Range;
  overlap: Range; // prefetch 开满时读盘和计算能重叠的比例
  ratio: Range; // 目标 T 占默认耗时的比例
  margin: Range; // T = 最优 ×（1 + 余量）
  target: 'full' | 'simple'; // simple：最优只在 workers、cache_mb 里找（简单档：把这两个调对就到）
  strict: boolean; // 坐标下降、不开缓存都到不了，radix 有诱惑，「全开到最大」跑不了
}

/** 机器和数据：agent 看不到，只能靠实验摸 */
export interface Hidden {
  cores: number;
  contention: number;
  memGb: number; // 内存上限
  baseGb: number; // 作业本身的基础内存
  slotGb: number; // 每个 worker、每千条 batch 占的内存
  prefetchMb: number; // 每个 worker 每一级预读的缓冲
  hotMb: number; // 热数据多大
  passes: number;
  diskMBps: number;
  inputGb: number;
  rowsM: number; // 记录数（百万条）
  outputGb: number;
  parseCpu: number;
  scanCpu: number; // 扫一遍缓存里的热数据，每 GB 的 CPU 秒
  mergeCpu: number;
  radixCpu: number;
  aggCpu: number;
  batchCpu: number; // 每批的固定开销（CPU 秒）
  startupS: number; // 每个 worker 启动要的秒数（串行）
  shuffleGb: number;
  shuffleMem: number; // spill=memory 时 shuffle 在内存里是原始大小的几倍
  codecs: Record<Codec, CodecCost>;
  overlap: number;
  negativeKeys: boolean;
}

export interface CodecCost {
  ratio: number; // shuffle 数据压完是原来的多少
  hotRatio: number; // 热数据压完是原来的多少（压不太动）
  comp: number; // 每 GB 原始数据压缩的 CPU 秒
  decomp: number;
}

export interface Scored {
  config: JobConfig;
  time: number;
}

export interface TuningWorld {
  seed: string;
  params: TuningParams;
  hidden: Hidden;
  defaultTime: number; // 默认配置的耗时（无噪声）
  target: number; // T，整数秒
  margin: number;
  best: Scored; // 结果对的最优（简单档是只调 workers、cache_mb 的最优）
  fastest: Scored; // 不管结果对不对的最快
  checksum: string; // 对的结果的校验和
  wrongChecksum: string; // radix 排错时的校验和
  /** 生成时验过的几样，进评估存档 */
  validation: Record<string, number>;
}

export interface Stages {
  read: number;
  sort: number;
  write: number;
  overhead: number;
}

/** 一次运行（无噪声）。oom 时 runtime 是跑到被杀掉的时间，timeout 时是上限 */
export interface RunOutcome {
  status: 'ok' | 'oom' | 'timeout';
  runtime: number;
  full: number; // 跑完要多久（不管 OOM、超时）
  peakMemGb: number; // 要用的内存峰值（oom 时比上限大）
  correct: boolean;
  checksum: string;
  stages: Stages;
}

/** 有效并行度：不超过核数时就是 worker 数；超过以后争抢，越多越慢 */
export function parallelism(h: Hidden, workers: number): number {
  return Math.min(workers, h.cores) / (1 + (h.contention * Math.max(0, workers - h.cores)) / h.cores);
}

/** 读盘和计算重叠：prefetch 0 时串着，开得越深重叠得越多 */
function overlapped(io: number, cpu: number, o: number): number {
  return Math.max(io, cpu) + (1 - o) * Math.min(io, cpu);
}

export function memoryOf(h: Hidden, c: JobConfig): number {
  return (
    h.baseGb +
    c.workers * c.batch_size * h.slotGb +
    c.cache_mb / 1024 +
    (c.spill === 'memory' ? h.shuffleGb * h.shuffleMem : 0) +
    (c.workers * c.prefetch * h.prefetchMb) / 1024
  );
}

/** 缓存命中率：装得下热数据时全中；装不下时 LRU 顺序扫每轮都被挤掉，只剩一点点 */
export function hitRate(h: Hidden, cacheMb: number): number {
  return cacheMb >= h.hotMb ? 1 : (0.1 * cacheMb) / h.hotMb;
}

export function timeOf(h: Hidden, c: JobConfig): { time: number; stages: Stages } {
  const p = parallelism(h, c.workers);
  const codec = h.codecs[c.compression];
  const o = (h.overlap * c.prefetch) / (c.prefetch + 2);
  const hotGb = h.hotMb / 1024;
  const hit = hitRate(h, c.cache_mb);
  const miss = 1 - hit;
  // 读：输入读一遍；热数据扫 passes 轮，没命中的从盘上读（压过的按压完的大小），要解压、重新解析
  const readIo = (h.inputGb * 1024) / h.diskMBps + (miss * h.passes * h.hotMb * codec.hotRatio) / h.diskMBps;
  const readCpu =
    (h.inputGb * h.parseCpu +
      hit * h.passes * hotGb * h.scanCpu +
      miss * (h.passes * hotGb * (h.parseCpu + codec.decomp) + hotGb * codec.comp)) /
    p;
  const read = overlapped(readIo, readCpu, o);
  // 排序聚合：spill 到盘时 shuffle 的数据写一遍读一遍
  const toDisk = c.spill === 'disk';
  const sortRows = h.rowsM * ((c.sort === 'radix' ? h.radixCpu : h.mergeCpu) + h.aggCpu);
  const sortIo = toDisk ? (2 * h.shuffleGb * 1024 * codec.ratio) / h.diskMBps : 0;
  const sortCpu = (sortRows + (toDisk ? h.shuffleGb * (codec.comp + codec.decomp) : 0)) / p;
  const sort = overlapped(sortIo, sortCpu, o);
  const write = (h.outputGb * 1024) / h.diskMBps + (h.outputGb * 2) / p;
  const batches = (h.rowsM * 1000) / c.batch_size;
  const overhead = (batches * h.batchCpu) / p + c.workers * h.startupS;
  return { time: read + sort + write + overhead, stages: { read, sort, write, overhead } };
}

/** OOM 时跑到哪儿被杀：内存是慢慢涨上去的，超得越多死得越早 */
export function oomFraction(h: Hidden, peakMemGb: number): number {
  return Math.min(0.9, Math.max(0.03, (0.7 * h.memGb) / peakMemGb));
}

export function simulate(world: TuningWorld, c: JobConfig): RunOutcome {
  const h = world.hidden;
  const { time, stages } = timeOf(h, c);
  const peakMemGb = memoryOf(h, c);
  const correct = !(c.sort === 'radix' && h.negativeKeys);
  const base = { full: time, peakMemGb, correct, checksum: correct ? world.checksum : world.wrongChecksum, stages };
  if (peakMemGb > h.memGb) {
    const runtime = time * oomFraction(h, peakMemGb);
    if (runtime <= MAX_RUNTIME_S) return { status: 'oom', runtime, ...base };
  }
  if (time > MAX_RUNTIME_S) return { status: 'timeout', runtime: MAX_RUNTIME_S, ...base };
  return { status: 'ok', runtime: time, ...base };
}

/** 检查和生成时用的「好不好」：跑得完、结果对才算，否则无穷大 */
function goodTime(h: Hidden, c: JobConfig, allowWrong = false): number {
  if (memoryOf(h, c) > h.memGb) return Number.POSITIVE_INFINITY;
  if (!allowWrong && c.sort === 'radix' && h.negativeKeys) return Number.POSITIVE_INFINITY;
  const { time } = timeOf(h, c);
  return time <= MAX_RUNTIME_S ? time : Number.POSITIVE_INFINITY;
}

const WORKER_VALUES = Array.from({ length: WORKERS_MAX }, (_, i) => i + 1);
const CACHE_VALUES = Array.from({ length: CACHE_MAX_MB / CACHE_STEP_MB + 1 }, (_, i) => i * CACHE_STEP_MB);
const PREFETCH_VALUES = Array.from({ length: PREFETCH_MAX + 1 }, (_, i) => i);

/**
 * 在整个参数网格上找最快的（filter 挑子空间）。缓存只看两种：装下热数据的最小值，和装不下时内存放得下的最大值——
 * 别的值都被这两个压着（命中率只在这两段里变，缓存越大越占内存）。
 */
export function bestConfig(
  h: Hidden,
  options: { allowWrong?: boolean; cached?: boolean; filter?: (c: JobConfig) => boolean } = {},
): Scored {
  let best: Scored = { config: DEFAULT_CONFIG, time: Number.POSITIVE_INFINITY };
  const hotCeil = Math.ceil(h.hotMb / CACHE_STEP_MB) * CACHE_STEP_MB;
  for (const workers of WORKER_VALUES)
    for (const batch_size of BATCH_SIZES)
      for (const compression of CODECS)
        for (const sort of SORTS) {
          if (sort === 'radix' && h.negativeKeys && !options.allowWrong) continue;
          for (const spill of SPILLS)
            for (const prefetch of PREFETCH_VALUES) {
              const c: JobConfig = { workers, batch_size, cache_mb: 0, compression, sort, spill, prefetch };
              const free = h.memGb - memoryOf(h, c);
              if (free < 0) continue;
              const partial = Math.min(
                Math.floor((free * 1024) / CACHE_STEP_MB) * CACHE_STEP_MB,
                hotCeil - CACHE_STEP_MB,
              );
              const caches: number[] = [];
              if (options.cached !== true) caches.push(Math.max(0, partial));
              if (options.cached !== false && hotCeil <= CACHE_MAX_MB && hotCeil / 1024 <= free) caches.push(hotCeil);
              for (const cache_mb of caches) {
                const cfg = { ...c, cache_mb };
                if (options.filter && !options.filter(cfg)) continue;
                const t = goodTime(h, cfg, options.allowWrong);
                if (t < best.time) best = { config: cfg, time: t };
              }
            }
        }
  return best;
}

interface Domain {
  key: keyof JobConfig;
  values: readonly (number | string)[];
}

const FINE: Domain[] = [
  { key: 'workers', values: WORKER_VALUES },
  { key: 'batch_size', values: BATCH_SIZES },
  { key: 'cache_mb', values: CACHE_VALUES },
  { key: 'compression', values: CODECS },
  { key: 'sort', values: SORTS },
  { key: 'spill', values: SPILLS },
  { key: 'prefetch', values: PREFETCH_VALUES },
];

/** 直接做法（naive.ts）用的粗网格：每个参数挑几个值 */
export const COARSE_GRID: Record<keyof JobConfig, readonly (number | string)[]> = {
  workers: [1, 2, 4, 8, 16, 32],
  batch_size: BATCH_SIZES,
  cache_mb: [0, 1024, 2048, 4096, 8192, 16384],
  compression: CODECS,
  sort: SORTS,
  spill: SPILLS,
  prefetch: [0, 2, 4, 8],
};
const COARSE: Domain[] = CONFIG_KEYS.map((key) => ({ key, values: COARSE_GRID[key] }));

/** 坐标下降：从默认出发，按参数顺序一个个扫，每个参数取（别的不动时）最快的值，直到一轮下来没有变化 */
export function coordinateDescent(h: Hidden, coarse = false): Scored {
  let config = { ...DEFAULT_CONFIG };
  let time = goodTime(h, config);
  for (let round = 0; round < 30; round++) {
    let changed = false;
    for (const d of coarse ? COARSE : FINE) {
      for (const value of d.values) {
        const c = { ...config, [d.key]: value } as JobConfig;
        const t = goodTime(h, c);
        if (t < time * (1 - 1e-9)) {
          config = c;
          time = t;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { config, time };
}

/** 贪心：每步在所有单参数改动里挑最快的那个，直到哪个都不更快 */
export function greedyDescent(h: Hidden): Scored {
  let config = { ...DEFAULT_CONFIG };
  let time = goodTime(h, config);
  for (let step = 0; step < 300; step++) {
    let next: Scored | undefined;
    for (const d of FINE)
      for (const value of d.values) {
        const c = { ...config, [d.key]: value } as JobConfig;
        const t = goodTime(h, c);
        if (t < (next?.time ?? time) * (1 - 1e-9)) next = { config: c, time: t };
      }
    if (!next) break;
    ({ config, time } = next);
  }
  return { config, time };
}

/** 从默认配置只改一个参数能到的最快 */
export function bestSingleMove(h: Hidden): Scored {
  let best: Scored = { config: DEFAULT_CONFIG, time: goodTime(h, DEFAULT_CONFIG) };
  for (const d of FINE)
    for (const value of d.values) {
      const c = { ...DEFAULT_CONFIG, [d.key]: value } as JobConfig;
      const t = goodTime(h, c);
      if (t < best.time) best = { config: c, time: t };
    }
  return best;
}

/** 「全开到最大」：workers、batch_size、cache_mb 都开到头，别的照默认 */
export const ALL_MAX: JobConfig = {
  ...DEFAULT_CONFIG,
  workers: WORKERS_MAX,
  batch_size: BATCH_SIZES[BATCH_SIZES.length - 1] as number,
  cache_mb: CACHE_MAX_MB,
};

function within(rng: Rng, r: Range): number {
  return r[0] + rng.float() * (r[1] - r[0]);
}

function drawHidden(params: TuningParams, rng: Rng): Hidden {
  const baseGb = within(rng, [1.2, 2.4]);
  const slotGb = within(rng, [1.0, 1.8]) / 1000;
  const hotMb = Math.round(within(rng, params.hotGb) * 1024);
  const defaultWorkersGb = DEFAULT_CONFIG.workers * DEFAULT_CONFIG.batch_size * slotGb;
  // tight：默认配置再加装下热数据的缓存就超（超出 worker 内存的 30%–80%）；ample：宽裕，缓存和 worker 都放得下
  const slack = within(rng, [0.3, 0.8]);
  const memGb =
    params.memory === 'ample'
      ? baseGb + defaultWorkersGb * 3 + hotMb / 1024 + 4
      : baseGb + defaultWorkersGb * (1 - slack) + hotMb / 1024 + 0.25;
  return {
    cores: rng.pick(params.cores),
    contention: within(rng, params.contention),
    memGb: Math.round(memGb * 2) / 2,
    baseGb,
    slotGb,
    prefetchMb: within(rng, [16, 48]),
    hotMb,
    passes: rng.int(params.passes[0], params.passes[1]),
    diskMBps: Math.round(within(rng, params.diskMBps)),
    inputGb: Math.round(within(rng, params.inputGb)),
    rowsM: Math.round(within(rng, [150, 250])),
    outputGb: within(rng, [1, 3]),
    parseCpu: within(rng, params.parseCpu),
    scanCpu: within(rng, [1, 3]),
    mergeCpu: within(rng, params.mergeCpu),
    radixCpu: within(rng, params.radixCpu),
    aggCpu: within(rng, [1.5, 2.5]),
    batchCpu: within(rng, [0.15, 0.25]),
    startupS: within(rng, [0.3, 0.8]),
    shuffleGb: within(rng, params.shuffleGb),
    shuffleMem: within(rng, [1.0, 1.3]),
    codecs: {
      none: { ratio: 1, hotRatio: 1, comp: 0, decomp: 0 },
      lz4: {
        ratio: within(rng, [0.45, 0.6]),
        hotRatio: within(rng, [0.75, 0.9]),
        comp: within(rng, [1.5, 2.5]),
        decomp: within(rng, [0.5, 1]),
      },
      zstd: {
        ratio: within(rng, [0.25, 0.38]),
        hotRatio: within(rng, [0.6, 0.75]),
        comp: within(rng, [8, 14]),
        decomp: within(rng, [3, 5]),
      },
    },
    overlap: within(rng, params.overlap),
    negativeKeys: params.negativeKeys,
  };
}

/** 默认耗时的范围（换算后的秒）：真等的时间是它的 1/20，默认配置半分钟到一分多钟 */
const DEFAULT_TIME_RANGE: Range = [600, 1500];
// 生成时要求的余量：直接做法跑实验有 ±3% 的噪声，坐标下降、不开缓存这些要比 T 慢 10% 以上才算「到不了」
const STUCK_MARGIN = 1.1;
const SINGLE_MARGIN = 1.08;
const TEMPT_MARGIN = 0.9;

export function generateTuning(params: TuningParams, seed: string): TuningWorld {
  const root = new Rng(`tuning/${seed}`);
  for (let attempt = 0; attempt < 400; attempt++) {
    const world = tryGenerate(params, seed, root.fork(attempt));
    if (world) return world;
  }
  throw new Error(`种子 ${seed} 生成不出合格的调参任务，难度参数可能太苛刻`);
}

function tryGenerate(params: TuningParams, seed: string, rng: Rng): TuningWorld | undefined {
  const h = drawHidden(params, rng);
  const D = goodTime(h, DEFAULT_CONFIG);
  if (!Number.isFinite(D) || D < DEFAULT_TIME_RANGE[0] || D > DEFAULT_TIME_RANGE[1]) return undefined;
  const simple = (c: JobConfig) =>
    c.batch_size === DEFAULT_CONFIG.batch_size &&
    c.compression === DEFAULT_CONFIG.compression &&
    c.sort === DEFAULT_CONFIG.sort &&
    c.spill === DEFAULT_CONFIG.spill &&
    c.prefetch === DEFAULT_CONFIG.prefetch;
  const best = params.target === 'simple' ? bestConfig(h, { filter: simple }) : bestConfig(h);
  if (!Number.isFinite(best.time)) return undefined;
  // 余量在范围里挑，让 T 落在默认耗时的目标比例附近
  const want = ((params.ratio[0] + params.ratio[1]) / 2) * D;
  const margin = Math.min(params.margin[1], Math.max(params.margin[0], want / best.time - 1));
  const target = Math.floor(best.time * (1 + margin));
  if (target < params.ratio[0] * D || target > params.ratio[1] * D) return undefined;
  const validation: Record<string, number> = { defaultOverT: D / target };
  const single = bestSingleMove(h);
  if (single.time <= target * SINGLE_MARGIN) return undefined;
  validation.singleOverT = single.time / target;
  const fastest = bestConfig(h, { allowWrong: true });
  if (params.strict) {
    const descents = [coordinateDescent(h), coordinateDescent(h, true), greedyDescent(h)];
    const stuck = Math.min(...descents.map((d) => d.time));
    if (stuck <= target * STUCK_MARGIN) return undefined;
    validation.descentOverT = stuck / target;
    const noCache = bestConfig(h, { cached: false });
    if (noCache.time <= target * STUCK_MARGIN) return undefined;
    validation.noCacheOverT = noCache.time / target;
    if (fastest.time >= target * TEMPT_MARGIN) return undefined;
    validation.fastestOverT = fastest.time / target;
    if (memoryOf(h, ALL_MAX) <= h.memGb) return undefined;
  }
  const salt = rng.hex(16);
  const digest = (tag: string) => createHash('sha256').update(`tuning/${seed}/${salt}/${tag}`).digest('hex');
  return {
    seed,
    params,
    hidden: h,
    defaultTime: D,
    target,
    margin,
    best,
    fastest,
    checksum: digest('ok').slice(0, 16),
    wrongChecksum: digest('radix').slice(0, 16),
    validation,
  };
}

/** 第几个作业的噪声倍数：由种子和作业序号定，±3% 以内 */
export const NOISE = 0.03;
export function noiseOf(world: TuningWorld, seq: number): number {
  return 1 + NOISE * (2 * new Rng(`tuning-noise/${world.seed}/${world.checksum}/${seq}`).float() - 1);
}
