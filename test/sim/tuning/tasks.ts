// 作业调参的三档任务：
// - 简单（门槛 1）：内存宽裕、没有超核争抢、数据里没有负数 key（radix 也对）；把 workers 开到核数附近、缓存开到装下热数据就到，
//   只动一个参数不够。T 大约是默认耗时的 60%–70%。
// - 中等（门槛 2）：内存交互和缓存悬崖有了（缓存要装下热数据就得同时把 batch_size 或 workers 降下来），radix 陷阱有了；
//   T 大约是默认的 40%；作业结果里给分阶段的耗时，好推理。
// - 难（门槛 3）：再加超核争抢、压缩取舍、spill 和 prefetch；T 大约是默认的 25%–30%；结果里只有总时间、内存峰值、校验和、状态。
// 交付工作目录里的 config.json，检查直接用 world.ts 的无噪声模型算（不经过 HTTP）：跑得完、耗时不超过 T、校验和和默认配置一样。

import type { CompletionSpec } from '../../../src/core/types.ts';
import type { SimClock } from '../kit/clock.ts';
import {
  type CheckResult,
  type Difficulty,
  type Gate,
  parseJson,
  readDeliverable,
  type SimTask,
  type SimWorld,
} from '../task.ts';
import { MAX_QUEUED, MAX_RUNNING, TIME_SCALE, tuningHandler } from './api.ts';
import { naiveTuning } from './naive.ts';
import { solveTuning } from './solve.ts';
import {
  BATCH_SIZES,
  CACHE_MAX_MB,
  CACHE_STEP_MB,
  CODECS,
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  generateTuning,
  MAX_RUNTIME_S,
  PREFETCH_MAX,
  parseConfig,
  SORTS,
  SPILLS,
  simulate,
  type TuningParams,
  type TuningWorld,
  WORKERS_MAX,
} from './world.ts';

export const TUNING_PRESETS: Record<Difficulty, TuningParams> = {
  easy: {
    cores: [8],
    contention: [0, 0],
    memory: 'ample',
    negativeKeys: false,
    stages: false,
    passes: [4, 6],
    hotGb: [4, 7],
    inputGb: [10, 20],
    diskMBps: [120, 200],
    parseCpu: [6, 10],
    mergeCpu: [3, 4],
    radixCpu: [2.2, 2.8],
    shuffleGb: [2, 4],
    overlap: [0, 0],
    ratio: [0.58, 0.7],
    margin: [0.15, 0.4],
    target: 'simple',
    strict: false,
  },
  medium: {
    cores: [12, 16],
    contention: [0, 0],
    memory: 'tight',
    negativeKeys: true,
    stages: true,
    passes: [6, 9],
    hotGb: [4, 8],
    inputGb: [10, 20],
    diskMBps: [150, 500],
    parseCpu: [15, 25],
    mergeCpu: [5, 7],
    radixCpu: [1.5, 2.5],
    shuffleGb: [4, 8],
    overlap: [0.2, 0.4],
    ratio: [0.36, 0.45],
    margin: [0.15, 0.25],
    target: 'full',
    strict: true,
  },
  hard: {
    cores: [16, 20, 24],
    contention: [0.3, 0.8],
    memory: 'tight',
    negativeKeys: true,
    stages: false,
    passes: [7, 11],
    hotGb: [5, 9],
    inputGb: [8, 16],
    diskMBps: [150, 500],
    parseCpu: [15, 25],
    mergeCpu: [5, 7],
    radixCpu: [1.5, 2.5],
    shuffleGb: [8, 14],
    overlap: [0.6, 0.9],
    ratio: [0.25, 0.31],
    margin: [0.15, 0.25],
    target: 'full',
    strict: true,
  },
};

const GATE: Record<Difficulty, Gate> = { easy: 1, medium: 2, hard: 3 };
const LABEL: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '难' };

export function tuningTask(difficulty: Difficulty, params: TuningParams = TUNING_PRESETS[difficulty]): SimTask {
  return {
    id: `tuning-${difficulty}`,
    env: 'tuning',
    difficulty,
    gate: GATE[difficulty],
    title: `作业调参（${LABEL[difficulty]}）`,
    domain: 'general',
    create: (seed) => tuningWorld(generateTuning(params, seed)),
    solve: solveTuning,
    naive: naiveTuning,
  };
}

export function tuningTasks(): SimTask[] {
  return (['easy', 'medium', 'hard'] as const).map((d) => tuningTask(d));
}

const FORMAT = JSON.stringify(DEFAULT_CONFIG).replaceAll(',', ', ').replaceAll(':', ': ');

function tuningWorld(world: TuningWorld): SimWorld {
  const D = Math.round(world.defaultTime);
  const T = world.target;
  return {
    seed: world.seed,
    statement: (url) =>
      `把 ${url} 上这个批处理作业调快：现在用默认配置跑一次大约 ${D} 秒（作业结果里的 runtime_s），要调到 ${T} 秒以内，` +
      '而且输出要和默认配置的一样（output_checksum 相同）。调好的配置写进工作目录里的 config.json，' +
      `格式和默认配置一样，七个参数都写上：${FORMAT}；参数说明和接口见附件 runner.md。`,
    completion: (): CompletionSpec => ({
      interpretation:
        '耗时按作业结果里的 runtime_s 算（已经换算成全量数据）；同一个配置每次跑会差几个百分点，按这个配置的平均耗时算；' +
        '输出要和默认配置的一样，作业不能 OOM、不能超时',
      criteria: [
        // 只有这七个键：检查和作业接口用同一份校验（world.ts 的 parseConfig，「和环境同一份规则」），
        // 多写一个说明键接口就回 400；原来这一条没写，完成标准比检查松
        `工作目录根下有 config.json，是一个 JSON 对象，只有 ${CONFIG_KEYS.join('、')} 这七个参数（不多写别的键，原样当请求体交给作业接口收得下），取值都在 runner.md 写的范围里`,
        `用 config.json 的配置跑，作业能跑完（状态 ok），平均耗时不超过 ${T} 秒`,
        '这个配置跑出来的 output_checksum 和默认配置跑出来的一样',
      ],
      metric: { name: '作业耗时', unit: '秒', better: 'lower', target: T },
    }),
    materials: (url) => [{ name: 'runner.md', content: runnerDoc(world, url) }],
    starter: () => ({ 'README.md': '# 作业调参\n\n这次任务的交付物 config.json 放在这个目录。\n' }),
    handler: (clock: SimClock) => tuningHandler(world, clock),
    deliverables: () => ['config.json'],
    check: (dir) => checkTuning(world, dir),
    summary: () => {
      const h = world.hidden;
      return {
        target: T,
        defaultTime: D,
        margin: Number(world.margin.toFixed(3)),
        best: { ...world.best, time: Math.round(world.best.time) },
        fastest: { ...world.fastest, time: Math.round(world.fastest.time) },
        validation: Object.fromEntries(Object.entries(world.validation).map(([k, v]) => [k, Number(v.toFixed(3))])),
        machine: { cores: h.cores, memGb: h.memGb, hotMb: h.hotMb, passes: h.passes, diskMBps: h.diskMBps },
        negativeKeys: h.negativeKeys,
        params: world.params,
      };
    },
  };
}

export function checkTuning(world: TuningWorld, dir: string): CheckResult {
  const file = readDeliverable(dir, 'config.json');
  if ('error' in file) return { pass: false, summary: file.error };
  const parsed = parseJson(file.text, 'config.json');
  if ('error' in parsed) return { pass: false, summary: parsed.error };
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { pass: false, summary: 'config.json 要是一个 JSON 对象' };
  }
  const missing = CONFIG_KEYS.filter((k) => !(k in value));
  if (missing.length > 0) return { pass: false, summary: `config.json 少了参数：${missing.join('、')}` };
  const config = parseConfig(value);
  if (typeof config === 'string') return { pass: false, summary: `config.json 不合规：${config}` };
  const r = simulate(world, config);
  const T = world.target;
  if (r.status === 'oom') {
    return {
      pass: false,
      summary: `这个配置会 OOM：要 ${r.peakMemGb.toFixed(1)} GB，上限 ${world.hidden.memGb} GB`,
    };
  }
  if (r.status === 'timeout') return { pass: false, summary: `这个配置跑 ${MAX_RUNTIME_S} 秒都跑不完` };
  if (!r.correct) return { pass: false, summary: '输出和默认配置的不一样（数据里有负数 key，radix 排错了）' };
  if (r.runtime > T) {
    return {
      pass: false,
      summary: `这个配置平均要 ${r.runtime.toFixed(0)} 秒，目标 ${T} 秒以内（最优约 ${Math.round(world.best.time)} 秒）`,
    };
  }
  return {
    pass: true,
    summary: `平均 ${r.runtime.toFixed(0)} 秒（目标 ${T} 秒，默认 ${Math.round(world.defaultTime)} 秒），输出和默认配置一样`,
  };
}

function runnerDoc(world: TuningWorld, url: string): string {
  const h = world.hidden;
  const stages = world.params.stages
    ? '\n跑完的作业还带 `stages`：各阶段的耗时（秒），`read` 读数据、`sort` 排序聚合、`write` 写结果、`overhead` 调度和每批的固定开销。\n'
    : '';
  const stagesExample = world.params.stages
    ? ', "stages": {"read": 512.3, "sort": 498.1, "write": 21.4, "overhead": 34.6}'
    : '';
  return `# nightly-aggregate 作业：调参说明

作业读一批事件日志（约 ${(h.rowsM / 100).toFixed(1)} 亿条、${h.inputGb} GB），按 key 排序、聚合，写出汇总结果。
作业里有几轮要反复扫同一部分数据。

## 环境

地址：${url}

- 这是预发环境，用 1/${TIME_SCALE} 的抽样数据跑：作业结果里的 \`runtime_s\`（耗时，秒）和 \`peak_mem_gb\`（内存峰值，GB）都换算成了全量数据的值，
  实际要等的时间大约是 runtime_s ÷ ${TIME_SCALE} 秒（默认配置 ${Math.round(world.defaultTime / TIME_SCALE)} 秒左右）。
- 同时最多跑 ${MAX_RUNNING} 个作业，多的按提交顺序排队；排队的最多 ${MAX_QUEUED} 个，再交返回 429。
- 一个作业跑到 ${MAX_RUNTIME_S} 秒（换算后）还没完就被停掉（timeout）；内存超过机器的上限会被杀掉（oom）。
- 同一个配置每次跑的耗时会差几个百分点。
- 这个环境里大家交的作业都在一起，\`GET /jobs\` 看得到全部。

## 参数

| 参数 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| workers | 1 到 ${WORKERS_MAX} 的整数 | ${DEFAULT_CONFIG.workers} | 并行的 worker 数。每个 worker 同时在手里的数据和 batch_size 成正比，worker 越多占的内存越多 |
| batch_size | ${BATCH_SIZES.join('、')}（单位千条） | ${DEFAULT_CONFIG.batch_size} | 每批处理多少条记录。每批有固定的调度开销，批越小开销越多；批越大，每个 worker 占的内存越多 |
| cache_mb | 0 到 ${CACHE_MAX_MB}，${CACHE_STEP_MB} 的倍数 | ${DEFAULT_CONFIG.cache_mb} | 给反复扫的那部分数据留的内存缓存（MB），算在作业的内存里 |
| compression | ${CODECS.join('、')} | ${DEFAULT_CONFIG.compression} | 落盘的中间数据用什么压缩：省读写盘，费 CPU。lz4 压得少、快，zstd 压得多、慢 |
| sort | ${SORTS.join('、')} | ${DEFAULT_CONFIG.sort} | 排序算法，radix 一般比 merge 快 |
| spill | ${SPILLS.join('、')} | ${DEFAULT_CONFIG.spill} | shuffle 的数据放内存还是落盘。放内存省掉读写盘，但占内存 |
| prefetch | 0 到 ${PREFETCH_MAX} 的整数 | ${DEFAULT_CONFIG.prefetch} | 预读的深度：读盘和计算重叠起来；每一级都要给每个 worker 多留一块缓冲 |

## 接口

- \`GET ${url}/\`：作业说明、参数范围、默认配置
- \`POST ${url}/jobs\`：交一个作业，请求体是配置（JSON，没写的参数用默认值），返回 201 和作业，\`{"id": "job-0001", "status": "running", …}\`
  （前面已经有 ${MAX_RUNNING} 个在跑时是 \`queued\`）；参数不合规返回 400，说清是哪一个
- \`GET ${url}/jobs/<id>\`：一个作业的状态和结果
- \`GET ${url}/jobs\`：这个环境里的全部作业（\`?status=ok\` 只看某个状态的）
- \`DELETE ${url}/jobs/<id>\`：取消排队中或在跑的作业

作业的状态：\`queued\`（排队）、\`running\`、\`ok\`（跑完了）、\`oom\`、\`timeout\`、\`cancelled\`。跑完的作业长这样：

\`\`\`json
{"id": "job-0001", "status": "ok", "config": {…}, "submitted_at": "…", "started_at": "…", "finished_at": "…",
 "runtime_s": 1034.5, "peak_mem_gb": 6.2, "output_checksum": "3f9a…"${stagesExample}}
\`\`\`

\`output_checksum\` 是输出结果的校验和，结果一样校验和就一样。${stages}
例子：

\`\`\`sh
curl -s -X POST ${url}/jobs -H 'content-type: application/json' -d '{"workers": 8, "cache_mb": 2048}'
curl -s ${url}/jobs/job-0001
\`\`\`
`;
}
