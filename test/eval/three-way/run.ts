// 冻结三组机制后跑完整非编程场景清单；判题和参考解只在评测进程使用。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { melinaRuntime } from '../../../src/api/runtime.ts';
import { startServer } from '../../../src/cli.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import { CliEngine, PodmanRuntime } from '../../../src/tools/container.ts';
import { DomainImages } from '../../../src/tools/container-images.ts';
import { SimServer } from '../../sim/server.ts';
import type { SimTask } from '../../sim/task.ts';
import { verifyWorld } from '../../sim/verify.ts';
import { baselineContender } from '../baseline.ts';
import { melinaContender } from '../contenders.ts';
import { keyValues, readKeyFile } from '../keys.ts';
import { HttpMelina } from '../melina.ts';
import { verifyRealWorld } from '../real/verify.ts';
import {
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
} from '../report.ts';
import { appendResult, completeWorlds, latest, readResults, worldKey } from '../results.ts';
import { secretRedactor } from '../runtimes.ts';
import { containerSandbox } from '../sandbox.ts';
import { type EvalTask, suiteOf } from '../task.ts';
import { selectEvalTasks } from '../tasks.ts';
import { runTrial } from '../trial.ts';
import { heimdallObserver } from './observer.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    keys: { type: 'string' },
    tasks: { type: 'string', default: 'scenarios' },
    master: { type: 'string', default: 'melina-three-way-2026-10-13' },
    'max-minutes': { type: 'string', default: '20' },
    'token-cap': { type: 'string', default: '4000000' },
    'verify-only': { type: 'boolean', default: false },
    'melina-port': { type: 'string', default: '18831' },
    'sim-port': { type: 'string', default: '18832' },
  },
});
if (!values.out || !values.keys) throw new Error('请提供 --out 与 --keys；只读取文件，不打印 key。');
const out = resolve(values.out);
const keyFile = resolve(values.keys);
const keys = readKeyFile(keyFile);
const keyList = keys.deepseek;
if (!keyList?.length) throw new Error('没有提供 DeepSeek key。');
mkdirSync(out, { recursive: true });
const redactor = secretRedactor(keyValues(keys));
const log = (text: string) => console.log(redactor.redact(text));
const maxWallMs = Number(values['max-minutes']) * 60_000;
const maxTokens = Number(values['token-cap']);
const master = values.master;
const model: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' };
const containers = new PodmanRuntime({
  engine: new CliEngine('podman'),
  images: new DomainImages(),
  redactor,
  memoryMax: 2 * 1024 ** 3,
  pidsMax: 256,
  onWarn: (text) => log(`[容器] ${text}`),
});
const sandbox = containerSandbox(containers);
const tasks = selectEvalTasks(values.tasks);
const verifyServer = new SimServer({ host: '127.0.0.1', publicHost: '127.0.0.1' });
await verifyServer.start();
const verified = new Map<string, Promise<string | undefined>>();
const verify = (task: EvalTask, seed: string) => {
  const key = `${task.id}/${seed}`;
  let pending = verified.get(key);
  if (!pending) {
    pending = (async () => {
      const r =
        suiteOf(task) === 'sim'
          ? await verifyWorld(task as SimTask, seed, verifyServer)
          : await verifyRealWorld(task, seed, sandbox);
      // 只把合格标记与对照结果写到宿主评测档案，不传给任一 agent。
      writeFileSync(join(out, `qualification-${task.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
      if (r.ok) return undefined;
      return `标准解/空交付/直接做法对照未满足要求：${JSON.stringify(r)}`;
    })();
    verified.set(key, pending);
  }
  return pending;
};
if (values['verify-only']) {
  const { deriveSeed } = await import('../../sim/kit/rng.ts');
  let invalid = 0;
  for (const task of tasks) {
    const reason = await verify(task, deriveSeed(master, task.id, 0));
    if (reason) {
      invalid++;
      log(`${task.id}: ${reason}`);
    } else log(`${task.id}: 标准解通过，空交付和直接做法不通过`);
  }
  await verifyServer.close();
  process.exit(invalid ? 1 : 0);
}

const server = new SimServer({
  host: '0.0.0.0',
  port: Number(values['sim-port']),
  publicHost: 'host.containers.internal',
});
await server.start();
const home = join(resolve(keyFile, '..'), 'melina-three-way');
const api = await startServer(
  { port: Number(values['melina-port']), home },
  {
    models: {
      providers: [{ provider: 'deepseek', keys: keyList.map((k) => ({ name: k.name, key: k.key })) }],
      strong: [model],
      fast: [{ ...model, tier: 'fast' }],
    },
    internals: {
      containers,
      runtime: melinaRuntime({
        extensions: [],
      }),
      log: {
        warn: (text) => log(`[Melina] ${text}`),
        error: (text, error) => log(`[Melina] ${text}: ${String(error)}`),
      },
    },
  },
);
// 此组只比较求解分支的持续会话和 Watcher；关闭摘要接力以固定求解分支数。

const settings = api.melina.settings();
api.melina.setSettings({
  ...settings,
  config: {
    ...(settings.config ?? {}),
    domains: ['general', 'research'],
    limits: { ...(settings.config?.limits ?? {}), toolExec: 3, modelCalls: { deepseek: 8 } },
    sandbox: { memoryMax: 2 * 1024 ** 3, pidsMax: 256 },
  },
});
const native = melinaContender(
  new HttpMelina({ baseUrl: `http://127.0.0.1:${values['melina-port']}` }),
  {
    name: 'melina-bet0-watch',
    title: 'Melina Bet 0＋Watcher（持续会话）',
    config: {
      bet0: { models: [model] },
      continuation: { enabled: false },
      watch: { enabled: true, model },
    },
  },
  { maxWallMs, stallMs: maxWallMs, graceMs: 60_000, cancelTimeoutMs: 60_000 },
);
const baselineOptions = { model, keys: keyList, containers, redactor, maxWallMs };
const continuous = baselineContender({ ...baselineOptions, name: 'pi-heimdall-adapted', observer: heimdallObserver });
continuous.title = 'Heimdall 式双环适配（持续 Pi＋判断图＋请求前替换摘要）';
const single = baselineContender({ ...baselineOptions, name: 'pi-single' });
// 三组均只有一次主尝试；没有按隐藏判题结果重试或挑选答案。
continuous.restartable = false;
single.restartable = false;
const contenders = [native, continuous, single];
const startedAt = new Date().toISOString();
const times = [2, 5, 10, 15, Number(values['max-minutes'])].map((m) => m * 60_000).filter((ms) => ms <= maxWallMs);
const cuts = [100000, 250000, 500000, 1000000, 2000000, maxTokens].filter((n, i, a) => a.indexOf(n) === i);
const meta: Omit<ReportMeta, 'title'> = {
  master,
  reps: 1,
  startedAt,
  contenders: contenders.map((c, i) => ({
    name: c.name,
    title: c.title,
    role: i === 0 ? 'melina' : i === 1 ? 'variant' : 'baseline',
  })),
  notes: [
    `${tasks.length} 道非编程开发集场景：相同种子、附件、完成标准；同一世界三组同时开始，一次只跑一个世界。`,
    '均用 deepseek-flash；主 agent high，观察者 low；每题 20 分钟、4M 输入含缓存与输出 token 上限。',
    'Melina 使用生产 direct 会话与 Watcher；关闭摘要接力以固定分支数。',
    'Heimdall 为通用题适配：保留原版结构化判断 schema 与增量合并，持续 pi-agent-core Agent，发请求时替换 system 摘要。',
    '两组观察者统一每 10 次环境工具触发、4 分钟、6 次只读查询；原版 Heimdall 的 60/300 秒定时与 CTF 专用工具不参与。',
    '持续 Pi 两组均无 pi-coding-agent SDK 自动压缩；Melina 使用生产长会话与自动压缩；无题目解法 skills。',
    '只有宿主评测进程读参考解与真值。任一模型都收不到判题反馈，提交一次结束。费用取 SDK 用量估算，非账单。',
    '相同 rootless Podman 领域镜像、2 GiB 内存、256 进程；容器只挂自身工作区、附件和只读工具原文。',
    '主解题提示有框架本身的差异；此实验不能单独归因到巡检器、上下文或提示词某一个因素。',
  ],
};
const hashes = Object.fromEntries(
  [
    'test/eval/tasks.ts',
    'test/eval/baseline.ts',
    'test/eval/three-way/observer.ts',
    'src/api/runtime.ts',
    'test/eval/three-way/vendor/heimdall-contract.ts',
    'test/eval/three-way/vendor/heimdall-state.ts',
  ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
writeFileSync(
  join(out, 'meta.json'),
  `${JSON.stringify(
    {
      // 跑的是哪一版 Melina： 那批冻在 45469c4（原来写死在这里）；合进 main 以后照实取跑的时候的提交
      sourceCommit: execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim(),
      heimdallCommit: 'd9368848a5b0dbd5b87cfa476fee0ce9cb5a48ea',
      tasks: tasks.map((t) => t.id),
      maxWallMs,
      tokenCap: maxTokens,
      timeCutoffs: times,
      cutoffs: cuts,
      master,
      reps: 1,
      startedAt,
      contenders: meta.contenders,
      report: meta,
      hashes,
      images: Object.fromEntries(
        ['general', 'research'].map((domain) => [domain, new DomainImages().imageFor(domain)]),
      ),
    },
    null,
    2,
  )}\n`,
);
const resultsFile = join(out, 'results.jsonl');
const stop = new AbortController();
process.on('SIGINT', () => stop.abort('用户中断评测'));
process.on('SIGTERM', () => stop.abort('评测进程停止'));
const report = () => {
  const results = latest(readResults(resultsFile));
  const summary = summarize(results, cuts, { timeCutoffs: times, ...rolesOf(meta.contenders) });
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(out, 'summary.md'), markdownReport(summary, { title: '三组本地场景评测', ...meta }));
  writeFileSync(join(out, 'curve-time.svg'), timeCurveSvg(results, times, meta.contenders));
  writeFileSync(join(out, 'curve-time.csv'), timeCurveCsv(results, times));
  writeFileSync(join(out, 'curve.svg'), curveSvg(results, cuts, meta.contenders));
  writeFileSync(join(out, 'curve.csv'), curveCsv(results, cuts));
  writeFileSync(join(out, 'curve-cost.svg'), costCurveSvg(results, cuts, meta.contenders));
  writeFileSync(join(out, 'curve-cost.csv'), costCurveCsv(results, cuts));
};
const complete = completeWorlds(
  readResults(resultsFile),
  contenders.map((c) => c.name),
);
try {
  log(
    `开始完整三组评测：${tasks.length} 道题，每组 ${values['max-minutes']} 分钟、${maxTokens} token；主模型 deepseek-flash。`,
  );
  for (const task of tasks) {
    if (stop.signal.aborted) break;
    if (complete.has(worldKey({ task: task.id, rep: 0 }))) {
      log(`${task.id}: 已有完整同批结果，跳过`);
      continue;
    }
    const batch = new Date().toISOString();
    await Promise.all(
      contenders.map(async (contender) => {
        const result = await runTrial(task, contender, 0, {
          server,
          out,
          master,
          maxTokens,
          maxWallMs,
          signal: stop.signal,
          verify,
          sandbox,
          batch,
          log,
        });
        if (!stop.signal.aborted) {
          appendResult(resultsFile, result);
          log(
            `完成 ${result.task} ${result.contender}: ${result.checkPass ? '通过' : '未通过'}；${result.status}；${Math.round(result.wallMs / 1000)} 秒；${result.tokens} token；估算 $${result.usage.usd.toFixed(4)}`,
          );
          if (result.error) log(`原因：${result.error}`);
          report();
        }
      }),
    );
  }
} finally {
  report();
  await api.stop();
  await server.close();
  await verifyServer.close();
}
log(`报告：${join(out, 'summary.md')}`);
