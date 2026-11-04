// 跑分脚本（plan 、17、19， 评估设计）：每个被测方（Melina 的配置变体、单 agent 基线、同时开 k 个单 agent 的基线）
// 在每个任务上各跑 N 次，按时间截断记成败（U01：难任务比速度；token 只当上限防跑飞），出报告（summary.md、成功率随时间的曲线
// curve-time.svg、随 token 的 curve.svg、随费用的 curve-cost.svg，数据在同名的 .csv）。
// 同一个世界（任务、第几次）的几个被测方同一时刻开跑（量时间要两边同时跑同一个世界，U01）；--parallel 是同时跑几个世界。
//
// A/B：Melina 完整版对单 agent 基线。基线要和 Melina 用同一个模型、同样的容器；这台开发机起不了 Podman，Melina 用 test/dev/serve.ts 起，
// 两边都用 proot，--net-allow 给一样的端口（仿真环境的），agent 就只连得到仿真环境：
//
//   node test/dev/serve.ts --port 8701 --data ~/.melina-dev-eval --net-allow 18701
//   node test/eval/score.ts --melina http://127.0.0.1:8701 --variants melina --baseline deepseek/deepseek-flash --baseline-k 3 \
//     --tasks scenarios --n 2 --runtime proot --sim-port 18701 --sim-bind 127.0.0.1 --sim-host 127.0.0.1
//
// 装了 Podman 的机器上 Melina 用 `melina serve` 起，--runtime podman（默认），仿真环境 --sim-bind 0.0.0.0（容器里连 host.containers.internal）。
// 主干直解路线只开一份加 --bet0-model 供应商/模型。
// 靠环境变量改了整台 Melina 行为的实验补丁：起几台 Melina，--melina-at 变体名=地址 把那个变体指到对应的 Melina，别的照常用 --melina。
//
// 不接 Melina、不调模型，只检查跑分脚本和题目本身（这台机器上也能跑）：
//
//   node test/eval/score.ts --contender reference --contender naive --tasks all --n 2
//
// 存档在 --out（默认系统临时目录下的 melina-eval/<时间>）：results.jsonl、summary.md、summary.json、curve(-cost).svg、curve(-cost).csv、
// trials/<任务>/<被测方>/<第几次>/（世界的要点、起点 workspace、附件、Melina 的事件和摘要、基线的工具日志、交付、环境的请求日志）。
// 加 --transcript 时，单 agent 基线每次尝试的回复原文（思考、文字、工具调用和结果）另写一份 baseline-transcript.jsonl；
// Melina 那边的在起它的 serve.ts 上加 --transcript，两份同一个格式，比每步想了多少用 test/dev/transcript.ts。
// 同一个 --out 再跑会跳过已经有结果的试验，--fresh 从头来。Ctrl-C 取消在跑的 Run、写出已有结果的汇总；再按一次直接退出。
// 只按已有的结果重出报告：node test/eval/score.ts --report-only --out <存档目录>

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ModelRef } from '../../src/core/model-ref.ts';
import { DEFAULT_MASTER_SEED } from '../sim/kit/rng.ts';
import { SimServer } from '../sim/server.ts';
import type { SimTask } from '../sim/task.ts';
import { verifyWorld } from '../sim/verify.ts';
import { baselineContender, parallelBaselineContender } from './baseline.ts';
import { loadTaskFile } from './catalog.ts';
import { type Contender, melinaContender, solutionContender } from './contenders.ts';
import { keyValues, readKeyFile } from './keys.ts';
import { HttpMelina } from './melina.ts';
import { verifyRealWorld } from './real/verify.ts';
import {
  type ContenderRole,
  costCurveCsv,
  costCurveSvg,
  curveCsv,
  curveSvg,
  markdownReport,
  type ReportMeta,
  rolesOf,
  summarize,
  timeCurveCsv,
  timeCurveSvg,
} from './report.ts';
import { appendResult, completeWorlds, latest, readResults, worldKey } from './results.ts';
import { evalRuntime, type RuntimeKind, secretRedactor } from './runtimes.ts';
import { containerSandbox, hostSandbox } from './sandbox.ts';
import { type EvalTask, type Sandbox, suiteOf } from './task.ts';
import { DEFAULT_TASKS, selectEvalTasks } from './tasks.ts';
import { formatDuration, formatTokens, parseCutoffs, parseDurations, parseTokens } from './tokens.ts';
import { runTrial, type TrialResult } from './trial.ts';
import { loadVariants, pickVariants, singleBet0 } from './variants.ts';

const { values } = parseArgs({
  options: {
    melina: { type: 'string' },
    // 某个变体用另一台 Melina：变体名=地址，可以给几次。环境变量影响整台服务时，为各变体分别启动 Melina，
    // 起几台 Melina、各跑各的变体，和别的被测方照样同一个世界同一时刻开跑
    'melina-at': { type: 'string', multiple: true },
    header: { type: 'string', multiple: true },
    tasks: { type: 'string' },
    'tasks-file': { type: 'string' },
    variants: { type: 'string' },
    'variants-file': { type: 'string' },
    'bet0-model': { type: 'string' },
    contender: { type: 'string', multiple: true },
    baseline: { type: 'string', multiple: true },
    'baseline-tier': { type: 'string', default: 'strong' },
    // 另加「同时开 k 个单 agent，谁先交用谁的」的基线（U01）；0 不加
    'baseline-k': { type: 'string', default: '0' },
    // 各道独立跑完，评估结束后离线挑最早做对的；判题结果不反馈给模型。
    'baseline-independent-k': { type: 'string', default: '0' },
    keys: { type: 'string', default: '~/.melina-keys.env' },
    runtime: { type: 'string', default: 'podman' },
    'net-allow': { type: 'string' },
    n: { type: 'string', default: '3' },
    // 时间截断（U01）：最后一个是一次试验最多跑多久，到点没交出算没做成；成功率按这几个点报、按时间画曲线。
    // 不给是 5m,10m,20m,40m,80m；--report-only 时不给就用存档里的
    'time-cutoffs': { type: 'string' },
    // token 截断：只报成功率、画曲线；token-cap 是防跑飞的上限，到了就取消
    cutoffs: { type: 'string', default: '500k,1m,2m,4m,8m,16m' },
    'token-cap': { type: 'string', default: '50m' },
    out: { type: 'string' },
    master: { type: 'string', default: DEFAULT_MASTER_SEED },
    'sim-bind': { type: 'string' },
    'sim-host': { type: 'string' },
    'sim-port': { type: 'string', default: '0' },
    'stall-min': { type: 'string', default: '30' },
    parallel: { type: 'string', default: '1' },
    fresh: { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false },
    // 记单 agent 基线回复的原文：每次尝试一份 baseline-transcript.jsonl，在那次尝试的目录里；
    // Melina 那边用 serve.ts 的 --transcript
    transcript: { type: 'boolean', default: false },
  },
});

const DEFAULT_TIME_CUTOFFS = '5m,10m,20m,40m,80m';
const expand = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : resolve(p));

// 只按已有的结果重出报告（改了报告的格式、或者跑到一半想看看）：不起环境、不跑试验
if (values['report-only']) {
  if (!values.out) throw new Error('--report-only 要给 --out（哪次评估的存档目录）');
  const before = JSON.parse(readFileSync(join(values.out, 'meta.json'), 'utf8')) as Omit<
    ReportMeta,
    'title' | 'notes'
  > & {
    cutoffs: number[];
    timeCutoffs?: number[]; //  之前的存档没有
    report?: Omit<ReportMeta, 'title'>; // 早先的存档没有，用上面几项拼
  };
  const meta = before.report ?? {
    master: before.master,
    reps: before.reps,
    contenders: before.contenders,
    startedAt: before.startedAt,
  };
  // 报告的时间刻度：命令行给了就用给的（换一组刻度重出），没给用存档里的； 之前的存档没有，用默认的 5–80 分钟
  const times = values['time-cutoffs']
    ? parseDurations(values['time-cutoffs'])
    : (before.timeCutoffs ?? parseDurations(DEFAULT_TIME_CUTOFFS));
  // 这次试验最多跑多久按存档跑的时候算（到点取消的口径），早先的结果里没记就补上
  const archiveMax = before.timeCutoffs?.[before.timeCutoffs.length - 1];
  const results = latest(readResults(join(values.out, 'results.jsonl'))).map((r) =>
    r.maxWallMs === undefined && archiveMax !== undefined ? { ...r, maxWallMs: archiveMax } : r,
  );
  writeReport(values.out, results, before.cutoffs, times, meta);
  process.exit(0);
}

const cutoffs = parseCutoffs(values.cutoffs);
const timeCutoffs = parseDurations(values['time-cutoffs'] ?? DEFAULT_TIME_CUTOFFS);
const maxTokens = parseTokens(values['token-cap']);
const reps = Number(values.n);
const externalCatalog = values['tasks-file'] ? await loadTaskFile(expand(values['tasks-file'])) : undefined;
const tasks = selectEvalTasks(values.tasks ?? (externalCatalog ? 'all' : DEFAULT_TASKS), externalCatalog?.tasks);
const maxWallMs = timeCutoffs[timeCutoffs.length - 1] as number;
const k = Number(values['baseline-k']);
const independentK = Number(values['baseline-independent-k']);
if (!Number.isInteger(k) || k < 0 || k === 1)
  throw new Error(`--baseline-k 要是 0（不加）或者不小于 2 的整数：${values['baseline-k']}`);
if (!Number.isInteger(independentK) || independentK < 0 || independentK === 1)
  throw new Error(`--baseline-independent-k 要是 0 或不小于 2 的整数：${values['baseline-independent-k']}`);
if (independentK > 0 && k > 0) throw new Error('先提交赛跑和独立跑完两种并行口径要分开跑');
if (independentK > 0 && !values.baseline?.length) throw new Error('--baseline-independent-k 要和 --baseline 一起给');
const solutions = values.contender ?? [];
for (const kind of solutions) {
  if (kind !== 'reference' && kind !== 'naive') throw new Error(`--contender 只能是 reference 或 naive：${kind}`);
}
const baselines = values.baseline ?? [];
if (!values.melina && baselines.length === 0 && solutions.length === 0) {
  throw new Error(
    '要么 --melina <Melina 的地址>（可以再加 --baseline 供应商/模型），要么 --baseline，要么 --contender reference|naive',
  );
}
if (values.variants && !values.melina) throw new Error('--variants 要和 --melina 一起给');
if (values.runtime !== 'podman' && values.runtime !== 'proot')
  throw new Error(`--runtime 只能是 podman 或 proot：${values.runtime}`);
const runtimeKind = values.runtime as RuntimeKind;
const tier = values['baseline-tier'];
if (tier !== 'strong' && tier !== 'fast') throw new Error(`--baseline-tier 只能是 strong 或 fast：${tier}`);
// 跑模型写的代码（基线干活、检查代码题的交付）要容器；只跑标准解和直接做法时题目代码可信，检查直接在宿主机上跑
const viaModels = Boolean(values.melina) || baselines.length > 0;
const needsRuntime = baselines.length > 0 || (viaModels && tasks.some((t) => suiteOf(t) === 'code'));

const bind = values['sim-bind'] ?? (viaModels ? '0.0.0.0' : '127.0.0.1');
const publicHost = values['sim-host'] ?? (bind === '0.0.0.0' ? 'host.containers.internal' : bind);
const out = values.out ?? join(tmpdir(), 'melina-eval', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });
const resultsFile = join(out, 'results.jsonl');
const metaFile = join(out, 'meta.json');
if (values.fresh) {
  writeFileSync(resultsFile, '');
  rmSync(join(out, 'trials'), { recursive: true, force: true });
} else if (existsSync(metaFile)) {
  // 接着跑：总种子不一样就是另一套世界，时间截断、token 上限不一样「到点取消」的口径就不一样，混在一张表里不对
  const before = JSON.parse(readFileSync(metaFile, 'utf8')) as {
    master?: string;
    timeCutoffs?: number[];
    tokenCap?: number;
    tasksFile?: string;
    tasksFileSha256?: string;
    baselineIndependentK?: number;
  };
  const beforeMax = before.timeCutoffs?.[before.timeCutoffs.length - 1];
  if (before.master !== values.master || beforeMax !== maxWallMs || before.tokenCap !== maxTokens) {
    console.error(
      `${out} 是用总种子 ${before.master}、最长 ${formatDuration(beforeMax ?? 0)}、token 上限 ${formatTokens(before.tokenCap ?? 0)} 跑的，` +
        `这次是 ${values.master}、${formatDuration(maxWallMs)}、${formatTokens(maxTokens)}：换一个 --out，或者加 --fresh 从头来`,
    );
    process.exit(2);
  }
  if (
    before.tasksFile !== externalCatalog?.path ||
    before.tasksFileSha256 !== externalCatalog?.sha256 ||
    (before.baselineIndependentK ?? 0) !== independentK
  ) {
    throw new Error(`${out} 的外部任务文件或独立并行口径和这次不同，换一个 --out`);
  }
}

const server = new SimServer({ host: bind, port: Number(values['sim-port']), publicHost });
await server.start();
// 每次试验前先验一下这个世界（标准解过、没动过的不过、中等和难的直接做法不过）：仿真的 sweep 只扫过前 60 个种子，
// 真实任务的数据也按种子生成。各个被测方同一次用同一个世界，验一次就够。
// 代码题在检查交付的同一个沙箱里验：只在宿主机上验的话，容器里缺 python3、proot 起不来这类毛病验不出来，
// 交付会被记成没做对
const verifyServer = new SimServer();
await verifyServer.start();
const verified = new Map<string, Promise<string | undefined>>();
const verify = (task: EvalTask, seed: string): Promise<string | undefined> => {
  const key = `${task.id}|${seed}`;
  let p = verified.get(key);
  if (!p) {
    p = verifyOne(task, seed);
    verified.set(key, p);
  }
  return p;
};
async function verifyOne(task: EvalTask, seed: string): Promise<string | undefined> {
  const report =
    suiteOf(task) === 'sim'
      ? await verifyWorld(task as SimTask, seed, verifyServer)
      : await verifyRealWorld(task, seed, sandbox ?? hostSandbox);
  if (report.ok) return undefined;
  const ref = report.reference as { pass: boolean; summary: string; error?: string };
  return `标准解${ref.pass ? '过' : '没过'}（${ref.error ?? ref.summary}），没动过的${report.untouched.pass ? '过了' : '不过'}，直接做法${report.naive.pass ? '过了' : '不过'}`;
}

// 容器：基线在里面干活，代码题的交付在里面跑隐藏测试；proot 下只许连仿真环境的端口（和 Melina 那边的 --net-allow 一样）
const keysFile = expand(values.keys);
const keys = readKeyFile(keysFile);
const secrets = keyValues(keys);
const extraPorts = (values['net-allow'] ?? '')
  .split(',')
  .map((p) => Number(p.trim()))
  .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
const netAllow = runtimeKind === 'proot' ? [server.port, ...extraPorts] : undefined;
const runtime = needsRuntime
  ? evalRuntime(runtimeKind, {
      root: join(out, 'containers'),
      secrets,
      ...(netAllow ? { netAllow } : {}),
      log: (t) => console.warn(`[容器] ${t}`),
    })
  : undefined;
const sandbox: Sandbox | undefined = runtime ? containerSandbox(runtime) : viaModels ? undefined : hostSandbox;

const contenders: Contender[] = [];
// 每个被测方在报告里是什么：照这里登记的认，不按名字猜（：两个 --baseline 里有叫 k3 的模型时，
// 单 agent 基线叫 baseline-k3，按名字会被当成同时开 k 个的那个）
const roles = new Map<string, ContenderRole>();
const add = (c: Contender, role: ContenderRole) => {
  contenders.push(c);
  roles.set(c.name, role);
};
for (const kind of solutions) add(solutionContender(kind as 'reference' | 'naive'), 'solution');
if (values.melina) {
  const headers: Record<string, string> = {};
  for (const h of values.header ?? []) {
    const i = h.indexOf(':');
    if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const melina = new HttpMelina({ baseUrl: values.melina, headers });
  const melinaAt = new Map<string, HttpMelina>();
  for (const spec of values['melina-at'] ?? []) {
    const i = spec.indexOf('=');
    if (i <= 0 || i === spec.length - 1) throw new Error(`--melina-at 要写成 变体名=Melina 的地址：${spec}`);
    melinaAt.set(spec.slice(0, i).trim(), new HttpMelina({ baseUrl: spec.slice(i + 1).trim(), headers }));
  }
  const extra = values['variants-file'] ? loadVariants(values['variants-file']) : [];
  if (values['bet0-model']) extra.push(singleBet0(modelRef(values['bet0-model'], 'strong')));
  const picked = pickVariants(values.variants ?? 'melina', extra);
  for (const name of melinaAt.keys()) {
    if (!picked.some((v) => v.name === name)) throw new Error(`--melina-at 的 ${name} 不在 --variants 里`);
  }
  for (const v of picked) {
    add(
      melinaContender(melinaAt.get(v.name) ?? melina, v, { stallMs: Number(values['stall-min']) * 60_000, maxWallMs }),
      v.name === 'melina' ? 'melina' : 'variant',
    );
  }
}
for (const spec of baselines) {
  const model = modelRef(spec, tier);
  const list = keys[model.provider];
  if (!list?.length)
    throw new Error(
      `${keysFile} 里没有 ${model.provider} 的 key（变量名 ${model.provider.toUpperCase().replace(/-/g, '_')}_API_KEY）`,
    );
  const suffix = baselines.length > 1 ? `-${model.model.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : '';
  const opts = {
    model,
    keys: list,
    containers: runtime as NonNullable<typeof runtime>,
    redactor: secretRedactor(secrets),
    maxWallMs,
    transcript: values.transcript,
  };
  add(baselineContender({ ...opts, ...(suffix ? { name: `baseline${suffix}` } : {}) }), 'baseline');
  if (k >= 2) add(parallelBaselineContender({ ...opts, k, name: `baseline-k${k}${suffix}` }), 'parallel');
  for (let lane = 1; lane <= independentK; lane++) {
    add(baselineContender({ ...opts, name: `independent-${independentK}-lane-${lane}${suffix}` }), 'independent');
  }
}
const names = contenders.map((c) => c.name);
if (new Set(names).size !== names.length) throw new Error(`被测方重名了：${names.join('、')}`);

function modelRef(spec: string, t: 'strong' | 'fast'): ModelRef {
  const i = spec.indexOf('/');
  if (i <= 0 || i === spec.length - 1) throw new Error(`模型要写成 供应商/模型：${spec}`);
  return { provider: spec.slice(0, i), model: spec.slice(i + 1), tier: t };
}

// 几方都跑完了的世界接着跑时跳过：跑分这边出错的、几方不是同一批跑的，都整组重跑（results.ts 的 completeWorlds）
const complete = completeWorlds(
  readResults(resultsFile),
  contenders.map((c) => c.name),
);
// 这一批的标记写进每次试验的结果：同一个世界的几方要是同一批的，才算同一时刻开跑
const startedAt = new Date().toISOString();
const reportMeta: Omit<ReportMeta, 'title'> = {
  master: values.master,
  reps,
  contenders: contenders.map((c) => ({ name: c.name, title: c.title, role: roles.get(c.name) })),
  startedAt,
  notes: [
    `任务：${tasks.map((t) => t.title).join('、')}。`,
    `时间截断：${timeCutoffs.map(formatDuration).join('、')}（一次试验从开跑算起最多 ${formatDuration(maxWallMs)}，到点没交出算没做成）；` +
      `token 只报、不截断（上限 ${formatTokens(maxTokens)} 防跑飞）；${values['stall-min']} 分钟没有动静算卡住。`,
    '同一个世界的几个被测方同一时刻开跑。',
    ...(externalCatalog ? [`外部任务文件：${externalCatalog.path}，SHA-256 ${externalCatalog.sha256}。`] : []),
    ...(baselines.length > 0
      ? [
          `单 agent 基线：${baselines.join('、')}（${tier} 档的思考级别），截断内没交出可以从头重来。` +
            (k >= 2 ? `并行基线：同时开 ${k} 个，谁先交用谁的，交错了算没做成；没交就停下的那一道从头再来。` : ''),
        ]
      : []),
    ...(runtime ? [`容器：${runtimeKind}${netAllow ? `，只许连端口 ${netAllow.join('、')}` : ''}。`] : []),
    ...(independentK > 0
      ? [
          `独立并行基线：${independentK} 道各自跑完；离线选最早正确交付，只代表并行能力的上限。费用为全部道的实际总费，判题不反馈给模型。`,
        ]
      : []),
  ],
};
writeFileSync(
  metaFile,
  `${JSON.stringify(
    {
      startedAt,
      melina: values.melina,
      melinaAt: values['melina-at'] ?? [],
      tasks: tasks.map((t) => t.id),
      contenders: contenders.map((c) => ({ name: c.name, title: c.title, role: roles.get(c.name) })),
      baselines,
      baselineTier: tier,
      reps,
      cutoffs,
      timeCutoffs,
      tokenCap: maxTokens,
      baselineK: k,
      baselineIndependentK: independentK,
      ...(externalCatalog ? { tasksFile: externalCatalog.path, tasksFileSha256: externalCatalog.sha256 } : {}),
      master: values.master,
      runtime: needsRuntime ? runtimeKind : undefined,
      netAllow,
      keyProviders: Object.keys(keys),
      sim: { bind, publicHost, port: server.port },
      report: reportMeta,
    },
    null,
    2,
  )}\n`,
);

const stop = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts++;
  if (interrupts > 1) process.exit(130);
  console.log('\n收到 Ctrl-C：取消在跑的试验，写汇总；再按一次直接退出');
  stop.abort();
});

console.log(`存档：${out}`);
console.log(`仿真环境听在 ${bind}:${server.port}，给 agent 的地址是 http://${publicHost}:${server.port}/…`);
if (runtime) {
  console.log(
    `基线和代码题的检查用 ${runtimeKind}${netAllow ? `，只许连端口 ${netAllow.join('、')}（Melina 那边的 --net-allow 要给一样的）` : ''}`,
  );
}
console.log(
  `任务 ${tasks.map((t) => t.id).join('、')}；被测方 ${contenders.map((c) => c.name).join('、')}；每个 ${reps} 次；` +
    `时间截断 ${timeCutoffs.map(formatDuration).join('、')}；token 上限 ${formatTokens(maxTokens)}`,
);

// 一个世界（任务、第几次）的几个被测方是一组，同一时刻开跑（U01：量时间要两边同时跑同一个世界，供应商那边、本机的忙闲对各方一样）。
// 接着跑时只要组里有一方缺结果（上次被打断、跑分这边出错），或者几方不是同一批跑的，整组重跑：只补缺的那几方就不是同一时刻跑的了，
// 成对比较会拿不同时段的两次在比。重跑的结果追加在后面，latest() 取最后一次
const groups: { task: EvalTask; rep: number; contenders: Contender[] }[] = [];
let skipped = 0;
for (let rep = 0; rep < reps; rep++) {
  for (const task of tasks) {
    if (complete.has(worldKey({ task: task.id, rep }))) skipped++;
    else groups.push({ task, rep, contenders: [...contenders] });
  }
}
const total = groups.reduce((s, g) => s + g.contenders.length, 0);
console.log(
  `要跑 ${total} 次试验、${groups.length} 个世界（各方都有同一批结果的 ${skipped} 个世界跳过；缺了哪一方、不是同一批的世界整组重跑）`,
);

const runOne = async (task: EvalTask, contender: Contender, rep: number) => {
  const result = await runTrial(task, contender, rep, {
    server,
    out,
    master: values.master,
    maxTokens,
    maxWallMs,
    signal: stop.signal,
    log: (line) => console.log(line),
    verify,
    batch: startedAt,
    ...(sandbox ? { sandbox } : {}),
  });
  if (stop.signal.aborted) {
    // 人按 Ctrl-C 打断的不记：下次接着跑时这次重来
    console.log(`${result.task} ${result.contender} #${result.rep} 被打断了，不记结果`);
    return;
  }
  appendResult(resultsFile, result);
  console.log(
    `完成 ${result.task} ${result.contender} #${result.rep}：${result.checkPass ? '过' : '没过'}（${result.status}，` +
      `${result.firstCandidateMs !== undefined ? `${formatDuration(result.firstCandidateMs)} 交出，` : ''}` +
      `${formatTokens(result.tokens)} token${result.tokensAtSubmit !== undefined ? `，交出时 ${formatTokens(result.tokensAtSubmit)}` : ''}）`,
  );
};
const workers = Array.from({ length: Math.max(1, Number(values.parallel)) }, async () => {
  for (;;) {
    const next = groups.shift();
    if (!next || stop.signal.aborted) return;
    await Promise.all(next.contenders.map((c) => runOne(next.task, c, next.rep)));
  }
});
await Promise.all(workers);
await server.close();
await verifyServer.close();

writeReport(out, latest(readResults(resultsFile)), cutoffs, timeCutoffs, reportMeta);

function writeReport(
  dir: string,
  all: TrialResult[],
  cuts: number[],
  times: number[],
  meta: Omit<ReportMeta, 'title'>,
): void {
  const summary = summarize(all, cuts, { timeCutoffs: times, ...rolesOf(meta.contenders) });
  const report = markdownReport(summary, { title: '跑分报告', ...meta });
  writeFileSync(join(dir, 'summary.md'), report);
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(dir, 'curve-time.csv'), timeCurveCsv(all, times));
  writeFileSync(join(dir, 'curve-time.svg'), timeCurveSvg(all, times, meta.contenders));
  writeFileSync(join(dir, 'curve.csv'), curveCsv(all, cuts));
  writeFileSync(join(dir, 'curve.svg'), curveSvg(all, cuts, meta.contenders));
  writeFileSync(join(dir, 'curve-cost.csv'), costCurveCsv(all, cuts));
  writeFileSync(join(dir, 'curve-cost.svg'), costCurveSvg(all, cuts, meta.contenders));
  console.log(`\n${report}`);
  console.log(
    `汇总写在 ${join(dir, 'summary.md')}，成功率曲线在 ${join(dir, 'curve-time.svg')}（随时间）、${join(dir, 'curve.svg')}（随 token）、` +
      `${join(dir, 'curve-cost.svg')}（随费用），数据在同名的 .csv`,
  );
}
