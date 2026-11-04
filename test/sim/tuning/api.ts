// 作业调参的 HTTP 接口：交作业、看状态、列全部、取消。一个实例一份可变状态，几条分支共用一个实例，彼此看得到对方的作业
// （真实的作业历史就是这样）。同时最多跑 4 个，其余先进先出排队；作业真要等：真实耗时 = 模拟的 runtime_s ÷ TIME_SCALE。
// 状态按 now 推进：每个请求先把到 now 为止该跑完的跑完、该开跑的开跑（离散事件），不用 setTimeout；
// 单元测试和标准解用虚拟时钟，sleep 就把时间拨过去。规则只在 world.ts 里，这里不透露（OOM 只说超了上限、被杀掉了）。

import type { SimClock } from '../kit/clock.ts';
import { json, noRoute, type SimHandler, type SimRequest, type SimResponse, segments } from '../kit/http.ts';
import {
  BATCH_SIZES,
  CACHE_MAX_MB,
  CACHE_STEP_MB,
  CODECS,
  DEFAULT_CONFIG,
  type JobConfig,
  MAX_RUNTIME_S,
  noiseOf,
  PREFETCH_MAX,
  parseConfig,
  SORTS,
  SPILLS,
  type Stages,
  simulate,
  type TuningWorld,
  WORKERS_MAX,
} from './world.ts';

/** 预发环境用 1/20 的抽样数据跑：返回的耗时换算成全量，真等的时间是它的 1/20 */
export const TIME_SCALE = 20;
export const MAX_RUNNING = 4;
export const MAX_QUEUED = 16;
/** 一个实例最多收多少个作业：agent 失控刷作业时不把内存吃光 */
export const MAX_JOBS = 3000;

export type JobStatus = 'queued' | 'running' | 'ok' | 'oom' | 'timeout' | 'cancelled';

interface Job {
  seq: number;
  id: string;
  config: JobConfig;
  status: JobStatus;
  submittedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 开跑时定下来：跑多久（真实毫秒）、结果 */
  plan?: { ends: number; status: 'ok' | 'oom' | 'timeout'; runtime: number; peakMemGb: number; stages: Stages };
  checksum?: string;
}

export function tuningHandler(world: TuningWorld, clock: SimClock): SimHandler {
  const jobs: Job[] = [];
  const byId = new Map<string, Job>();
  const queue: Job[] = [];
  const running: Job[] = [];

  function start(job: Job, at: number): void {
    const r = simulate(world, job.config);
    const k = noiseOf(world, job.seq);
    let status = r.status;
    let runtime = r.runtime * k;
    if (status === 'timeout' || runtime > MAX_RUNTIME_S) {
      status = 'timeout';
      runtime = MAX_RUNTIME_S;
    }
    // OOM 时看到的峰值就是上限（内存涨到上限那一刻被杀）；超时停下时也还没超过上限
    const peakMemGb = status === 'ok' ? r.peakMemGb : Math.min(r.peakMemGb, world.hidden.memGb);
    const stages: Stages = {
      read: r.stages.read * k,
      sort: r.stages.sort * k,
      write: r.stages.write * k,
      overhead: r.stages.overhead * k,
    };
    job.status = 'running';
    job.startedAt = at;
    job.plan = { ends: at + (runtime * 1000) / TIME_SCALE, status, runtime, peakMemGb, stages };
    if (status === 'ok') job.checksum = r.checksum;
    running.push(job);
  }

  /** 把到 now 为止该跑完的跑完，空出来的位子按排队顺序在空出来的那一刻开跑 */
  function settle(now: number): void {
    for (;;) {
      let next: Job | undefined;
      for (const j of running) {
        const ends = (j.plan as NonNullable<Job['plan']>).ends;
        if (!next || ends < (next.plan as NonNullable<Job['plan']>).ends) next = j;
      }
      if (!next) return;
      const plan = next.plan as NonNullable<Job['plan']>;
      if (plan.ends > now) return;
      next.status = plan.status;
      next.finishedAt = plan.ends;
      running.splice(running.indexOf(next), 1);
      while (running.length < MAX_RUNNING && queue.length > 0) start(queue.shift() as Job, plan.ends);
    }
  }

  function view(job: Job, now: number): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: job.id,
      status: job.status,
      config: job.config,
      submitted_at: iso(job.submittedAt),
    };
    if (job.status === 'queued') out.queue_position = queue.indexOf(job) + 1;
    if (job.startedAt !== undefined) out.started_at = iso(job.startedAt);
    if (job.status === 'running') {
      out.elapsed_s = round1(((now - (job.startedAt as number)) * TIME_SCALE) / 1000);
      return out;
    }
    if (job.finishedAt !== undefined) out.finished_at = iso(job.finishedAt);
    const plan = job.plan;
    if (job.status === 'cancelled') {
      if (job.startedAt !== undefined) {
        out.runtime_s = round1((((job.finishedAt as number) - job.startedAt) * TIME_SCALE) / 1000);
      }
      return out;
    }
    if (!plan) return out;
    out.runtime_s = round1(plan.runtime);
    out.peak_mem_gb = round1(plan.peakMemGb);
    if (job.status === 'ok') {
      out.output_checksum = job.checksum;
      if (world.params.stages) {
        out.stages = {
          read: round1(plan.stages.read),
          sort: round1(plan.stages.sort),
          write: round1(plan.stages.write),
          overhead: round1(plan.stages.overhead),
        };
      }
    } else if (job.status === 'oom') {
      out.error = '内存超过上限，作业被杀掉了';
    } else if (job.status === 'timeout') {
      out.error = `跑了 ${MAX_RUNTIME_S} 秒还没跑完，被停掉了`;
    }
    return out;
  }

  function submit(req: SimRequest, now: number): SimResponse {
    if (req.body === undefined && req.text.trim() !== '') {
      return json(400, { error: '请求体要是 JSON，例如 {"workers": 8, "cache_mb": 2048}' });
    }
    const config = parseConfig(req.body);
    if (typeof config === 'string') return json(400, { error: config });
    if (jobs.length >= MAX_JOBS) return json(429, { error: `这个环境里的作业太多了（最多 ${MAX_JOBS} 个）` });
    if (running.length >= MAX_RUNNING && queue.length >= MAX_QUEUED) {
      const soonest = Math.min(...running.map((j) => (j.plan as NonNullable<Job['plan']>).ends));
      return json(
        429,
        { error: `排队的作业太多了（最多 ${MAX_QUEUED} 个），等前面的跑完再交` },
        { 'retry-after': String(Math.max(1, Math.ceil((soonest - now) / 1000))) },
      );
    }
    const seq = jobs.length + 1;
    const job: Job = { seq, id: `job-${String(seq).padStart(4, '0')}`, config, status: 'queued', submittedAt: now };
    jobs.push(job);
    byId.set(job.id, job);
    if (running.length < MAX_RUNNING) start(job, now);
    else queue.push(job);
    return json(201, view(job, now));
  }

  function cancel(job: Job, now: number): SimResponse {
    if (job.status === 'queued') {
      queue.splice(queue.indexOf(job), 1);
    } else if (job.status === 'running') {
      running.splice(running.indexOf(job), 1);
      job.plan = undefined;
      while (running.length < MAX_RUNNING && queue.length > 0) start(queue.shift() as Job, now);
    } else {
      return json(409, { error: `作业已经结束了（${job.status}），不用取消`, id: job.id, status: job.status });
    }
    job.status = 'cancelled';
    job.finishedAt = now;
    return json(200, view(job, now));
  }

  return {
    handle(req) {
      const now = clock.now();
      settle(now);
      const parts = segments(req.path);
      if (parts.length === 0) {
        if (req.method !== 'GET') return json(405, { error: '这里只能 GET' });
        return json(200, info(world));
      }
      if (parts[0] !== 'jobs' || parts.length > 2) return noRoute();
      if (parts.length === 1) {
        if (req.method === 'POST') return submit(req, now);
        if (req.method !== 'GET') return json(405, { error: '交作业用 POST /jobs，列作业用 GET /jobs' });
        const status = req.query.get('status');
        const list = status ? jobs.filter((j) => j.status === status) : jobs;
        return json(200, { jobs: list.map((j) => view(j, now)), running: running.length, queued: queue.length });
      }
      const job = byId.get(parts[1] as string);
      if (!job) return json(404, { error: '没有这个作业' });
      if (req.method === 'GET') return json(200, view(job, now));
      if (req.method === 'DELETE') return cancel(job, now);
      return json(405, { error: '看作业用 GET，取消用 DELETE' });
    },
  };
}

/** GET /：作业的说明。数据多大、参数范围、并发上限、默认配置；不给机器和数据的细节 */
export function info(world: TuningWorld): Record<string, unknown> {
  const h = world.hidden;
  return {
    job: 'nightly-aggregate',
    description: '读一批事件日志，按 key 排序、聚合，写出汇总结果',
    data: { records: h.rowsM * 1_000_000, size_gb: h.inputGb },
    params: {
      workers: { min: 1, max: WORKERS_MAX },
      batch_size: { values: BATCH_SIZES, unit: '千条' },
      cache_mb: { min: 0, max: CACHE_MAX_MB, step: CACHE_STEP_MB },
      compression: { values: CODECS },
      sort: { values: SORTS },
      spill: { values: SPILLS },
      prefetch: { min: 0, max: PREFETCH_MAX },
    },
    default: DEFAULT_CONFIG,
    limits: { running: MAX_RUNNING, queued: MAX_QUEUED, max_runtime_s: MAX_RUNTIME_S },
    time_scale: `预发环境用 1/${TIME_SCALE} 的抽样数据跑：runtime_s 和 peak_mem_gb 都换算成了全量数据的值，实际要等大约 runtime_s ÷ ${TIME_SCALE} 秒`,
    docs: '参数说明和接口见附件 runner.md',
  };
}

function iso(ms: number): string {
  return new Date(Math.round(ms)).toISOString();
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
