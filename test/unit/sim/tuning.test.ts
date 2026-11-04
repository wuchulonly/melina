// 作业调参：性能模型的几条性质（悬崖、超核变慢、OOM、radix 在有负数 key 时校验和不同、噪声）、世界合不合格、
// 接口（参数校验、并发上限和排队、状态随时钟推进、取消、列表、不存在的作业 404）、检查；
// 三档各几个种子上标准解过、没动过的不过、中等和难的直接做法不过。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualClock } from '../../sim/kit/clock.ts';
import { makeRequest, type SimResponse } from '../../sim/kit/http.ts';
import { SimServer } from '../../sim/server.ts';
import { MAX_QUEUED, MAX_RUNNING, TIME_SCALE, tuningHandler } from '../../sim/tuning/api.ts';
import { checkTuning, TUNING_PRESETS, tuningTask } from '../../sim/tuning/tasks.ts';
import {
  ALL_MAX,
  bestConfig,
  bestSingleMove,
  CACHE_STEP_MB,
  coordinateDescent,
  DEFAULT_CONFIG,
  generateTuning,
  greedyDescent,
  type JobConfig,
  MAX_RUNTIME_S,
  memoryOf,
  NOISE,
  noiseOf,
  simulate,
  type TuningWorld,
  timeOf,
} from '../../sim/tuning/world.ts';
import { verifyWorld } from '../../sim/verify.ts';

const TIERS = ['easy', 'medium', 'hard'] as const;
const worlds = Object.fromEntries(TIERS.map((d) => [d, generateTuning(TUNING_PRESETS[d], `unit-${d}`)])) as Record<
  (typeof TIERS)[number],
  TuningWorld
>;

interface JobBody {
  id: string;
  status: string;
  config: JobConfig;
  queue_position?: number;
  submitted_at: string;
  started_at?: string;
  finished_at?: string;
  elapsed_s?: number;
  runtime_s?: number;
  peak_mem_gb?: number;
  output_checksum?: string;
  stages?: Record<string, number>;
  error?: string;
}

function client(world: TuningWorld) {
  const clock = new VirtualClock();
  const api = tuningHandler(world, clock);
  const call = async (method: string, path: string, body?: unknown): Promise<SimResponse> =>
    api.handle(makeRequest(method, path, body === undefined ? {} : { body }));
  const submit = async (config: Partial<JobConfig> = {}) => (await call('POST', '/jobs', config)).body as JobBody;
  const job = async (id: string) => (await call('GET', `/jobs/${id}`)).body as JobBody;
  return { clock, api, call, submit, job };
}

const hotCeil = (w: TuningWorld) => Math.ceil(w.hidden.hotMb / CACHE_STEP_MB) * CACHE_STEP_MB;

describe('性能模型', () => {
  it('缓存装下热数据时耗时掉一大截，差一档就几乎没用（悬崖）', () => {
    for (const w of Object.values(worlds)) {
      const at = (cache_mb: number) => timeOf(w.hidden, { ...w.best.config, cache_mb }).time;
      const fit = at(hotCeil(w));
      const short = at(hotCeil(w) - CACHE_STEP_MB);
      expect(short / fit).toBeGreaterThan(1.15);
      // 从 0 加到差一档，省下的不到悬崖那一下的四分之一
      expect(at(0) - short).toBeLessThan((short - fit) / 4);
      expect(at(16384)).toBeCloseTo(fit, 6);
    }
  });

  it('核数以内 worker 越多越快；超过核数难档越多越慢，简单和中等的不再变快', () => {
    for (const [tier, w] of Object.entries(worlds)) {
      const h = w.hidden;
      const at = (workers: number) => timeOf(h, { ...DEFAULT_CONFIG, workers }).time;
      expect(at(Math.floor(h.cores / 2))).toBeGreaterThan(at(h.cores));
      const over = Math.min(32, h.cores * 2);
      if (tier === 'hard') {
        expect(at(h.cores + 4)).toBeGreaterThan(at(h.cores));
        expect(at(over)).toBeGreaterThan(at(h.cores + 4));
      } else expect(at(over)).toBeGreaterThanOrEqual(at(h.cores));
    }
  });

  it('内存超过上限就 OOM，跑到一部分时失败；中等和难的默认配置再把缓存开到装下热数据就超', () => {
    for (const [tier, w] of Object.entries(worlds)) {
      const r = simulate(w, ALL_MAX);
      expect(r.status).toBe('oom');
      expect(r.peakMemGb).toBeGreaterThan(w.hidden.memGb);
      expect(r.runtime).toBeLessThan(r.full);
      expect(simulate(w, DEFAULT_CONFIG).status).toBe('ok');
      const cached = { ...DEFAULT_CONFIG, cache_mb: hotCeil(w) };
      expect(simulate(w, cached).status).toBe(tier === 'easy' ? 'ok' : 'oom');
      // 腾出内存（batch 降下来）缓存就放得下：要两个参数一起挪
      if (tier !== 'easy') expect(simulate(w, { ...cached, batch_size: 64 }).status).toBe('ok');
    }
  });

  it('radix 比 merge 快；数据里有负数 key 时校验和不同，没有时一样', () => {
    for (const [tier, w] of Object.entries(worlds)) {
      const merge = simulate(w, DEFAULT_CONFIG);
      const radix = simulate(w, { ...DEFAULT_CONFIG, sort: 'radix' });
      expect(radix.runtime).toBeLessThan(merge.runtime);
      expect(merge.checksum).toBe(w.checksum);
      if (tier === 'easy') expect(radix.checksum).toBe(w.checksum);
      else expect(radix.checksum).not.toBe(w.checksum);
      // 别的参数不改结果
      expect(simulate(w, { ...w.best.config, compression: 'zstd', spill: 'disk', prefetch: 3 }).checksum).toBe(
        w.checksum,
      );
    }
  });

  it('噪声在 ±3% 以内，由种子和作业序号定', () => {
    const w = worlds.medium;
    const xs = Array.from({ length: 300 }, (_, i) => noiseOf(w, i + 1));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(1 - NOISE);
      expect(x).toBeLessThanOrEqual(1 + NOISE);
    }
    expect(new Set(xs).size).toBe(xs.length);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(NOISE);
    expect(noiseOf(w, 7)).toBe(noiseOf(generateTuning(TUNING_PRESETS.medium, 'unit-medium'), 7));
    expect(noiseOf(w, 7)).not.toBe(noiseOf(worlds.hard, 7));
  });
});

describe('generateTuning', () => {
  it('同一个种子同一个世界，不同种子不同', () => {
    expect(generateTuning(TUNING_PRESETS.hard, 'unit-hard')).toEqual(worlds.hard);
    expect(generateTuning(TUNING_PRESETS.hard, 'other').hidden).not.toEqual(worlds.hard.hidden);
  });

  for (const tier of TIERS) {
    it(`${tier}：T 在默认耗时的目标比例里，最优到得了；只动一个参数到不了${tier === 'easy' ? '' : '；坐标下降、不开缓存都到不了，radix 的最快配置比 T 快得多，全开到最大会 OOM'}`, () => {
      const params = TUNING_PRESETS[tier];
      for (const seed of ['a', 'b', 'c']) {
        const w = generateTuning(params, seed);
        const h = w.hidden;
        expect(w.target / w.defaultTime).toBeGreaterThanOrEqual(params.ratio[0]);
        expect(w.target / w.defaultTime).toBeLessThanOrEqual(params.ratio[1]);
        expect(w.best.time).toBeLessThanOrEqual(w.target / (1 + params.margin[0]) + 1);
        expect(simulate(w, w.best.config)).toMatchObject({ status: 'ok', correct: true });
        expect(bestSingleMove(h).time).toBeGreaterThan(w.target * 1.08);
        if (tier === 'easy') continue;
        for (const d of [coordinateDescent(h), coordinateDescent(h, true), greedyDescent(h)]) {
          expect(d.time).toBeGreaterThan(w.target * 1.1);
        }
        expect(bestConfig(h, { cached: false }).time).toBeGreaterThan(w.target * 1.1);
        expect(w.best.config.cache_mb).toBeGreaterThanOrEqual(h.hotMb);
        expect(w.fastest.config.sort).toBe('radix');
        expect(w.fastest.time).toBeLessThan(w.target * 0.9);
        expect(memoryOf(h, ALL_MAX)).toBeGreaterThan(h.memGb);
      }
    });
  }
});

describe('tuningHandler', () => {
  it('GET / 给数据规模、参数范围、默认配置和并发上限，不给机器和热数据的细节', async () => {
    const c = client(worlds.hard);
    const res = await c.call('GET', '/');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toMatchObject({
      default: DEFAULT_CONFIG,
      limits: { running: MAX_RUNNING, queued: MAX_QUEUED, max_runtime_s: MAX_RUNTIME_S },
      data: { records: worlds.hard.hidden.rowsM * 1_000_000, size_gb: worlds.hard.hidden.inputGb },
    });
    expect(Object.keys(body).sort()).toEqual(
      ['data', 'default', 'description', 'docs', 'job', 'limits', 'params', 'time_scale'].sort(),
    );
    expect(Object.keys(body.data as object).sort()).toEqual(['records', 'size_gb']);
    expect(JSON.stringify(body)).not.toMatch(/核|热数据|负数|上限是/);
    expect((await c.call('POST', '/')).status).toBe(405);
  });

  it('参数校验：不认识的参数、越界、类型不对都 400 并说清是哪一个；没写的用默认值；请求体不是 JSON 也 400', async () => {
    const c = client(worlds.medium);
    const bad: [Record<string, unknown>, string][] = [
      [{ workers: 0 }, 'workers'],
      [{ workers: 33 }, 'workers'],
      [{ workers: 2.5 }, 'workers'],
      [{ batch_size: 100 }, 'batch_size'],
      [{ cache_mb: 300 }, 'cache_mb'],
      [{ cache_mb: 20000 }, 'cache_mb'],
      [{ compression: 'gzip' }, 'compression'],
      [{ sort: 'quick' }, 'sort'],
      [{ spill: 'ssd' }, 'spill'],
      [{ prefetch: 9 }, 'prefetch'],
      [{ prefetch: '2' }, 'prefetch'],
      [{ threads: 4 }, '不认识的参数：threads'],
    ];
    for (const [config, word] of bad) {
      const res = await c.call('POST', '/jobs', config);
      expect(res.status, JSON.stringify(config)).toBe(400);
      expect((res.body as { error: string }).error).toContain(word);
    }
    const notJson = await c.api.handle({ ...makeRequest('POST', '/jobs'), text: 'workers=8' });
    expect(notJson.status).toBe(400);
    expect((await c.call('POST', '/jobs', [1, 2])).status).toBe(400);
    const res = await c.call('POST', '/jobs', { workers: 8, compression: 'lz4' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'job-0001',
      status: 'running',
      config: { ...DEFAULT_CONFIG, workers: 8, compression: 'lz4' },
    });
    const empty = await c.call('POST', '/jobs');
    expect(empty.status).toBe(201);
    expect((empty.body as JobBody).config).toEqual(DEFAULT_CONFIG);
  });

  it('同时最多跑 4 个，其余按提交顺序排队；空出位子的那一刻排队的开跑', async () => {
    const c = client(worlds.hard);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await c.submit({ workers: 4 + i })).id);
    const first = await Promise.all(ids.map((id) => c.job(id)));
    expect(first.map((j) => j.status)).toEqual(['running', 'running', 'running', 'running', 'queued', 'queued']);
    expect(first.slice(4).map((j) => j.queue_position)).toEqual([1, 2]);
    await c.clock.sleep(10 * 60_000);
    const done = await Promise.all(ids.map((id) => c.job(id)));
    for (const j of done) {
      expect(j.status).toBe('ok');
      const ms = Date.parse(j.finished_at as string) - Date.parse(j.started_at as string);
      expect(Math.abs(ms - ((j.runtime_s as number) * 1000) / TIME_SCALE)).toBeLessThan(10);
    }
    const ends = done
      .slice(0, 4)
      .map((j) => j.finished_at as string)
      .sort();
    expect(done[4]?.started_at).toBe(ends[0]);
    expect(done[5]?.started_at).toBe(ends[1]);
  });

  it('状态随时钟推进：running 带已跑的秒数，跑完是 ok，带耗时、内存峰值、校验和；中等的带分阶段耗时', async () => {
    for (const tier of ['medium', 'hard'] as const) {
      const w = worlds[tier];
      const c = client(w);
      const { id } = await c.submit();
      const real = (w.defaultTime * 1000) / TIME_SCALE;
      await c.clock.sleep(real / 2);
      const half = await c.job(id);
      expect(half.status).toBe('running');
      expect(half.elapsed_s).toBeCloseTo(w.defaultTime / 2, -1);
      expect(half.runtime_s).toBeUndefined();
      await c.clock.sleep(real);
      const done = await c.job(id);
      expect(done.status).toBe('ok');
      expect(Math.abs((done.runtime_s as number) / w.defaultTime - 1)).toBeLessThanOrEqual(NOISE + 0.001);
      expect(done.peak_mem_gb).toBeCloseTo(memoryOf(w.hidden, DEFAULT_CONFIG), 1);
      expect(done.output_checksum).toBe(w.checksum);
      if (tier === 'medium') {
        const stages = done.stages as Record<string, number>;
        expect(Object.keys(stages)).toEqual(['read', 'sort', 'write', 'overhead']);
        const sum = Object.values(stages).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(done.runtime_s as number, 0);
      } else {
        expect(done.stages).toBeUndefined();
      }
    }
  });

  it('OOM 的作业跑到一部分就停，峰值报的是上限；跑不完的到上限时间停，记 timeout', async () => {
    const w = worlds.hard;
    const c = client(w);
    const oom = await c.submit(ALL_MAX);
    const slow: JobConfig = { ...DEFAULT_CONFIG, workers: 1, batch_size: 64, cache_mb: 0 };
    expect(simulate(w, slow).status).toBe('timeout');
    const timeout = await c.submit(slow);
    await c.clock.sleep(((MAX_RUNTIME_S - 1) * 1000) / TIME_SCALE);
    const o = await c.job(oom.id);
    expect(o).toMatchObject({ status: 'oom', peak_mem_gb: w.hidden.memGb, error: '内存超过上限，作业被杀掉了' });
    expect(o.runtime_s).toBeLessThan(simulate(w, ALL_MAX).full);
    expect(o.output_checksum).toBeUndefined();
    expect((await c.job(timeout.id)).status).toBe('running');
    await c.clock.sleep(2000);
    expect(await c.job(timeout.id)).toMatchObject({ status: 'timeout', runtime_s: MAX_RUNTIME_S });
  });

  it('排队满了 429，带 Retry-After', async () => {
    const c = client(worlds.easy);
    for (let i = 0; i < MAX_RUNNING + MAX_QUEUED; i++) expect((await c.call('POST', '/jobs', {})).status).toBe(201);
    const full = await c.call('POST', '/jobs', {});
    expect(full.status).toBe(429);
    expect(Number(full.headers?.['retry-after'])).toBeGreaterThan(0);
    await c.clock.sleep(Number(full.headers?.['retry-after']) * 1000);
    expect((await c.call('POST', '/jobs', {})).status).toBe(201);
  });

  it('取消：排队的直接取消；在跑的取消后空出位子，排队的马上开跑；结束了的 409；没有的 404', async () => {
    const c = client(worlds.medium);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await c.submit()).id);
    const [a, b, , , e, f] = ids as [string, string, string, string, string, string];
    const cancelQueued = await c.call('DELETE', `/jobs/${e}`);
    expect(cancelQueued.status).toBe(200);
    expect(cancelQueued.body).toMatchObject({ status: 'cancelled' });
    expect((await c.job(e)).started_at).toBeUndefined();
    expect((await c.job(f)).queue_position).toBe(1);
    await c.clock.sleep(5000);
    const cancelRunning = await c.call('DELETE', `/jobs/${a}`);
    expect(cancelRunning.body).toMatchObject({ status: 'cancelled', runtime_s: (5 * TIME_SCALE) as number });
    const started = await c.job(f);
    expect(started.status).toBe('running');
    expect(started.started_at).toBe(new Date(c.clock.now()).toISOString());
    await c.clock.sleep(10 * 60_000);
    expect((await c.job(b)).status).toBe('ok');
    const again = await c.call('DELETE', `/jobs/${b}`);
    expect(again.status).toBe(409);
    expect((await c.call('DELETE', '/jobs/job-9999')).status).toBe(404);
    expect((await c.call('GET', '/jobs/job-9999')).status).toBe(404);
  });

  it('列表：GET /jobs 列出这个实例里全部作业（几条分支共用），可以按状态筛；路径和方法不对的报错', async () => {
    const c = client(worlds.easy);
    for (let i = 0; i < 5; i++) await c.submit({ workers: i + 1 });
    const all = (await c.call('GET', '/jobs')).body as { jobs: JobBody[]; running: number; queued: number };
    expect(all.jobs.map((j) => j.id)).toEqual(['job-0001', 'job-0002', 'job-0003', 'job-0004', 'job-0005']);
    expect(all).toMatchObject({ running: 4, queued: 1 });
    const queued = (await c.call('GET', '/jobs?status=queued')).body as { jobs: JobBody[] };
    expect(queued.jobs.map((j) => j.id)).toEqual(['job-0005']);
    expect((await c.call('GET', '/nope')).status).toBe(404);
    expect((await c.call('GET', '/jobs/job-0001/logs')).status).toBe(404);
    expect((await c.call('PUT', '/jobs')).status).toBe(405);
    expect((await c.call('POST', '/jobs/job-0001')).status).toBe(405);
  });
});

describe('checkTuning', () => {
  it('最优配置过；慢的、OOM 的、结果不对的、格式不对的不过，并说清原因', () => {
    const w = worlds.medium;
    const dir = mkdtempSync(join(tmpdir(), 'melina-sim-tuning-'));
    try {
      const write = (v: unknown) => writeFileSync(join(dir, 'config.json'), JSON.stringify(v));
      expect(checkTuning(w, dir)).toMatchObject({ pass: false, summary: '工作目录里没有 config.json' });
      write(w.best.config);
      expect(checkTuning(w, dir).pass).toBe(true);
      write(DEFAULT_CONFIG);
      expect(checkTuning(w, dir)).toMatchObject({ pass: false, summary: expect.stringContaining(`${w.target} 秒`) });
      write(w.fastest.config);
      expect(checkTuning(w, dir)).toMatchObject({ pass: false, summary: expect.stringContaining('radix') });
      write(ALL_MAX);
      expect(checkTuning(w, dir)).toMatchObject({ pass: false, summary: expect.stringContaining('OOM') });
      write({ ...w.best.config, prefetch: undefined });
      expect(checkTuning(w, dir)).toMatchObject({ pass: false, summary: expect.stringContaining('prefetch') });
      write({ ...w.best.config, workers: 0 });
      expect(checkTuning(w, dir).pass).toBe(false);
      write([w.best.config]);
      expect(checkTuning(w, dir).pass).toBe(false);
      // 多写一个说明键：作业接口原样收不下，检查也不过；完成标准写明了只有这七个参数
      write({ ...w.best.config, note: '缓存开到装下热数据，batch 减半' });
      expect(checkTuning(w, dir)).toMatchObject({
        pass: false,
        summary: expect.stringContaining('不认识的参数：note'),
      });
      const criteria = tuningTask('medium').create('unit-medium').completion('http://sim').criteria;
      expect(criteria[0]).toContain('不多写别的键');
      writeFileSync(join(dir, 'config.json'), '{"workers": 8,');
      expect(checkTuning(w, dir).summary).toContain('不是合法的 JSON');
      // 简单档的 radix 结果是对的
      write(worlds.easy.fastest.config);
      expect(checkTuning(worlds.easy, dir).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('三档各几个种子：标准解过、没动过的不过、中等和难的直接做法不过', () => {
  let server: SimServer;
  beforeAll(async () => {
    server = new SimServer();
    await server.start();
  });
  afterAll(async () => {
    await server.close();
  });
  for (const tier of TIERS) {
    for (const seed of ['unit-1', 'unit-2']) {
      it(`${tier}，种子 ${seed}`, async () => {
        const r = await verifyWorld(tuningTask(tier), seed, server);
        expect(r.reference.error).toBeUndefined();
        expect(r.reference, r.reference.summary).toMatchObject({ pass: true });
        expect(r.untouched.pass).toBe(false);
        if (tier !== 'easy') expect(r.naive.pass, r.naive.summary).toBe(false);
        expect(r.ok).toBe(true);
      }, 120_000);
    }
  }
});
