// 一次试验：一个任务、一个被测方、第几次（种子由总种子、任务和次数定，各个被测方同一次用同一个世界，好成对比较）。
// 挂上环境实例（真实任务没有）→ 建起点 workspace、写附件 → 跑（可以重来的被测方，截断内没提交就从头再来）
// → 在 Run 外面检查交付（代码题在沙箱里跑隐藏测试）→ 存档。
// 不抛错：跑分这边出了问题（起点仓库建不起来、世界不合格……）记成 status 为 error 的结果，汇总时不算任务失败。
// 检查没过、又分不清是交付的问题还是检查环境的问题（超时、被杀、一个测试都没跑起来）时，拿标准解在同一个沙箱里复跑一次当对照，
// 标准解也没过就记成出错。
// 截断：主要按墙钟时间——一次试验从第一次开跑算起，到 maxWallMs 还没交出就取消，
// 可以重来的被测方在这段时间里从头再来；token 只当上限防跑飞（maxTokens），成功率另按 token 画一条曲线、费用照报。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type UsageTotals, ZERO_USAGE } from '../../src/core/events.ts';
import { realClock, type SimClock } from '../sim/kit/clock.ts';
import { deriveSeed } from '../sim/kit/rng.ts';
import type { SimServer } from '../sim/server.ts';
import type { CheckResult, Difficulty, Gate } from '../sim/task.ts';
import type { AttemptOutcome, AttemptStatus, Contender } from './contenders.ts';
import { referenceCheck } from './real/verify.ts';
import { type EvalTask, type Sandbox, type Suite, suiteOf } from './task.ts';
import { addUsage } from './tokens.ts';
import { prepareWorkspace, writeFiles } from './workspace.ts';

/** 可以重来的被测方最多来几次（并行基线的每一道也一样）；一次连 token 都没花就结束的不再重来（不然会一直空转） */
export const MAX_ATTEMPTS = 20;
/** 一次试验默认最多跑多久 */
export const DEFAULT_MAX_WALL_MS = 3 * 3600_000;
/** 离时间截断不到这么久就不再重来：重来一次光起容器、读题就要几十秒 */
const MIN_RESTART_MS = 60_000;

export interface TrialResult {
  task: string;
  suite?: Suite; // 不写是 sim
  env: string;
  difficulty: Difficulty;
  gate?: Gate; // 仿真任务对应的门槛；真实任务没有
  contender: string;
  rep: number;
  seed: string;
  status: AttemptStatus; // 最后一次的结局；error 是跑分这边的问题（不算跑过），melina_error 是 Melina 那边的（算失败）
  submitted: boolean;
  delivered: boolean; // 交付取到了、做了检查（提交了但 Run 没收尾完的没有）
  checkPass: boolean;
  checkSummary: string;
  tokens: number; // 几次加起来
  tokensAtSubmit?: number; // 提交那一刻一共用了多少（含前面重来的几次）
  usdAtSubmit?: number; // 提交那一刻一共花了多少钱（美元，含前面重来的几次）； 加这一项之前的结果没有
  usage: UsageTotals;
  wallMs: number;
  /**
   * 从第一次开跑到交出（Melina 交付的那个结果、基线调用 done）用了多久，含前面重来的几次；时间截断按它算。
   * Melina 交过几版的是交付的那一个交出的时刻：收尾交的候选，或者 Run 停下时交付的那一版
   */
  firstCandidateMs?: number;
  /** 从第一次开跑到第一次交出（Melina 交的一版或候选，哪个早算哪个）： 的「首个候选的时间」； 之前的结果没有 */
  firstSubmitMs?: number;
  /** 哪一批跑的（score.ts 每次开跑的时刻）：同一个世界的几方要是同一批的才算同一时刻开跑； 之前的结果没有 */
  batch?: string;
  /** 这次试验最多跑多久（最后一个时间截断）：到点取消时正在收尾的候选可能稍晚落库，晚于它交出的不算做成； 之前的结果没有 */
  maxWallMs?: number;
  routes: number;
  branches: number;
  routesExplored?: number; // 花在被叫停路线上的 token
  byRole?: Record<string, UsageTotals>; // 按角色分的用量（几次加起来）
  attempts: number;
  runIds: string[];
  envRequests: number; // 环境收到了多少请求
  endReason?: string;
  /** 交付的是 Run 停下时交付的那一版 */
  deliveredVersion?: boolean;
  error?: string;
  startedAt: string;
}

export interface TrialOptions {
  server: SimServer;
  out: string; // 这次评估的存档目录
  master: string; // 总种子
  maxTokens: number; // token 上限：超过就取消
  /** 一次试验最多跑多久（墙钟，从第一次开跑算起，含重来的几次）；到点没交出算没做成。默认 3 小时 */
  maxWallMs?: number;
  signal: AbortSignal;
  log?: (line: string) => void;
  clock?: SimClock; // 环境的时钟（限流、开机排队），默认真时钟；单元测试里换成虚拟的
  /** 跑之前查这个世界合不合格（标准解过、没动过的不过）；不合格返回原因，这次试验记成 error 不跑 */
  verify?: (task: EvalTask, seed: string) => Promise<string | undefined>;
  /** 检查交付时要跑代码的（代码题的隐藏测试）在这里跑；不给的话这类检查记成出错 */
  sandbox?: Sandbox;
  /** 这一批的标记，写进结果（TrialResult.batch） */
  batch?: string;
}

export function trialDir(out: string, task: string, contender: string, rep: number): string {
  return join(out, 'trials', task, contender, String(rep));
}

export async function runTrial(
  task: EvalTask,
  contender: Contender,
  rep: number,
  options: TrialOptions,
): Promise<TrialResult> {
  const seed = deriveSeed(options.master, task.id, rep);
  const dir = trialDir(options.out, task.id, contender.name, rep);
  const log = (line: string) => options.log?.(`[${task.id} ${contender.name} #${rep}] ${line}`);
  const base: TrialResult = {
    task: task.id,
    suite: suiteOf(task),
    env: task.env,
    difficulty: task.difficulty,
    ...(task.gate !== undefined ? { gate: task.gate } : {}),
    contender: contender.name,
    rep,
    seed,
    status: 'error',
    submitted: false,
    delivered: false,
    checkPass: false,
    checkSummary: '没有交付',
    tokens: 0,
    usage: ZERO_USAGE,
    wallMs: 0,
    routes: 0,
    branches: 0,
    attempts: 0,
    runIds: [],
    envRequests: 0,
    startedAt: new Date().toISOString(),
    ...(options.batch !== undefined ? { batch: options.batch } : {}),
  };
  let result: TrialResult;
  try {
    // 上次中断留下的半截（起点仓库、交付、事件）不能接着用，从头来
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const invalid = await options.verify?.(task, seed);
    if (invalid !== undefined) {
      result = { ...base, error: `这个世界不合格，没跑：${invalid}` };
    } else {
      result = await attempts(task, contender, seed, dir, base, options, log);
    }
  } catch (e) {
    result = { ...base, error: `跑分出错：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  } catch {}
  log(`检查：${result.checkPass ? '过' : '没过'}，${result.checkSummary}${result.error ? `（${result.error}）` : ''}`);
  return result;
}

async function attempts(
  task: EvalTask,
  contender: Contender,
  seed: string,
  dir: string,
  base: TrialResult,
  options: TrialOptions,
  log: (line: string) => void,
): Promise<TrialResult> {
  const world = task.create(seed);
  writeFileSync(join(dir, 'world.json'), `${JSON.stringify({ task: task.id, seed, ...world.summary() }, null, 2)}\n`);
  // 真实任务没有仿真环境：地址是空的，环境的请求日志也是空的
  const env = world.handler
    ? options.server.mount(world.handler(options.clock ?? realClock))
    : { token: '', url: '', log: [] as unknown[], stats: { requests: 0 } };
  const localUrl = world.handler ? options.server.urlFor(env.token, '127.0.0.1') : '';
  const statement = world.statement(env.url);
  const completion = world.completion(env.url);
  const outcomes: AttemptOutcome[] = [];
  let tokens = 0;
  let usage = ZERO_USAGE;
  let tokensAtSubmit: number | undefined;
  let usdAtSubmit: number | undefined;
  let firstCandidateMs: number | undefined;
  let firstSubmitMs: number | undefined;
  // 计时从第一次开跑算起（验世界、建起点仓库不算），重来的几次算在同一段时间里
  let startedAt: number | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const attemptDir = join(dir, `attempt-${attempt}`);
      const workspace = join(attemptDir, 'workspace');
      prepareWorkspace(workspace, world.starter(), { git: contender.needsGit });
      const materialsDir = join(attemptDir, 'materials');
      const files = world.materials(env.url);
      writeFiles(materialsDir, Object.fromEntries(files.map((m) => [m.name, m.content])));
      log(`第 ${attempt} 次开始，环境 ${env.url}`);
      const attemptStart = Date.now();
      if (startedAt === undefined) {
        startedAt = attemptStart;
        deadline = attemptStart + (options.maxWallMs ?? DEFAULT_MAX_WALL_MS);
      }
      let outcome: AttemptOutcome;
      try {
        outcome = await contender.attempt({
          task,
          world,
          url: env.url,
          localUrl,
          workspace,
          materials: files.map((m) => ({ name: m.name, path: join(materialsDir, m.name) })),
          statement,
          completion,
          domain: task.domain,
          budget: options.maxTokens - tokens,
          deadline,
          dir: attemptDir,
          signal: options.signal,
          log,
        });
      } catch (e) {
        outcome = {
          status: 'error',
          submitted: false,
          tokens: 0,
          usage: ZERO_USAGE,
          wallMs: 0,
          routes: 0,
          branches: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      outcomes.push(outcome);
      if (outcome.submitted && outcome.tokensAtSubmit !== undefined) tokensAtSubmit = tokens + outcome.tokensAtSubmit;
      if (outcome.submitted && outcome.usdAtSubmit !== undefined) usdAtSubmit = usage.usd + outcome.usdAtSubmit;
      if (outcome.submitted && outcome.firstCandidateMs !== undefined) {
        firstCandidateMs = attemptStart - startedAt + outcome.firstCandidateMs;
      }
      // 第一次交出：Melina 报的一版或候选里最早的；只报交付时刻的被测方（基线）就是它
      const firstSubmit = outcome.firstSubmitMs ?? outcome.firstCandidateMs;
      if (outcome.submitted && firstSubmit !== undefined && firstSubmitMs === undefined) {
        firstSubmitMs = attemptStart - startedAt + firstSubmit;
      }
      tokens += outcome.tokens;
      usage = addUsage(usage, outcome.usage);
      log(
        `第 ${attempt} 次结束：${outcome.status}，用了 ${outcome.tokens} token${outcome.error ? `，${outcome.error}` : ''}`,
      );
      const again =
        contender.restartable &&
        !outcome.submitted &&
        outcome.status !== 'error' &&
        outcome.tokens > 0 &&
        tokens < options.maxTokens &&
        Date.now() < deadline - MIN_RESTART_MS &&
        !options.signal.aborted;
      if (!again) break;
    }
  } finally {
    if (world.handler) {
      writeFileSync(join(dir, 'env-log.jsonl'), env.log.map((e) => `${JSON.stringify(e)}\n`).join(''));
      options.server.unmount(env.token);
    }
  }
  const last = outcomes[outcomes.length - 1] as AttemptOutcome;
  const delivered = last.submitted && last.delivered !== undefined;
  let check: CheckResult;
  let checkError: string | undefined;
  if (!delivered) {
    check = { pass: false, summary: last.submitted ? '提交了候选，但 Run 没收尾完，没取到交付' : '没有交付' };
  } else {
    try {
      check = await world.check(last.delivered as string, options.sandbox ? { sandbox: options.sandbox } : {});
      if (!check.pass && check.suspect && options.sandbox && suiteOf(task) !== 'sim') {
        // 分不清是交付的问题还是检查环境的问题：标准解在同一个沙箱里复跑一次当对照
        const control = await referenceCheck(task, seed, options.sandbox);
        if (control.pass) check = { ...check, summary: `${check.summary}（同一个沙箱里标准解过了）` };
        else {
          checkError = `检查环境出了问题（${check.suspect}）：同一个沙箱里标准解也没过（${control.error ?? control.summary}）`;
        }
      }
    } catch (e) {
      // 检查本身跑不起来（没有沙箱、沙箱出错）：跑分这边的问题，不算任务失败
      checkError = `检查没跑成：${e instanceof Error ? e.message : String(e)}`;
      check = { pass: false, summary: checkError };
    }
  }
  const result: TrialResult = {
    ...base,
    status: last.status,
    submitted: last.submitted,
    delivered,
    checkPass: check.pass,
    checkSummary: check.summary,
    tokens,
    usage,
    wallMs: outcomes.reduce((s, o) => s + o.wallMs, 0),
    routes: outcomes.reduce((s, o) => s + o.routes, 0),
    branches: outcomes.reduce((s, o) => s + o.branches, 0),
    attempts: outcomes.length,
    runIds: outcomes.flatMap((o) => (o.runId ? [o.runId] : [])),
    envRequests: env.stats.requests,
  };
  if (tokensAtSubmit !== undefined) result.tokensAtSubmit = tokensAtSubmit;
  if (usdAtSubmit !== undefined) result.usdAtSubmit = usdAtSubmit;
  const reported = <K extends 'routesExplored'>(key: K) =>
    outcomes.some((o) => o[key] !== undefined) ? outcomes.reduce((s, o) => s + (o[key] ?? 0), 0) : undefined;
  const routesExplored = reported('routesExplored');
  if (routesExplored !== undefined) result.routesExplored = routesExplored;
  if (outcomes.some((o) => o.byRole)) {
    const byRole: Record<string, UsageTotals> = {};
    for (const o of outcomes) {
      for (const [role, u] of Object.entries(o.byRole ?? {})) byRole[role] = addUsage(byRole[role] ?? ZERO_USAGE, u);
    }
    result.byRole = byRole;
  }
  if (firstCandidateMs !== undefined) result.firstCandidateMs = firstCandidateMs;
  if (firstSubmitMs !== undefined) result.firstSubmitMs = firstSubmitMs;
  result.maxWallMs = options.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  if (last.endReason) result.endReason = last.endReason;
  if (last.deliveredVersion) result.deliveredVersion = true;
  const error = outcomes.find((o) => o.error)?.error;
  if (error) result.error = error;
  if (checkError) {
    result.status = 'error';
    result.error = checkError;
  }
  return result;
}

/**
 * 做成了：交出了、Run 外面的检查过了（交错了算没做成）。到时间、到 token 上限还没交出的，跑分时已经取消；
 * 取消那一刻正在收尾的 episode 带着候选落了库、交出时间晚于这次的时间上限的，也不算
 */
export function succeeded(r: TrialResult): boolean {
  if (r.status === 'error' || !r.submitted || !r.checkPass) return false;
  return r.maxWallMs === undefined || r.firstCandidateMs === undefined || r.firstCandidateMs <= r.maxWallMs;
}

/** 在 token 截断点 cutoff 上算不算成功：做成了，交出时用的 token 不超过截断 */
export function successAt(r: TrialResult, cutoff: number): boolean {
  return succeeded(r) && r.tokensAtSubmit !== undefined && r.tokensAtSubmit <= cutoff;
}

/** 在时间截断点 ms 上算不算成功：做成了，从开跑到交出不超过 ms（U01：难任务比速度） */
export function successWithin(r: TrialResult, ms: number): boolean {
  return succeeded(r) && r.firstCandidateMs !== undefined && r.firstCandidateMs <= ms;
}

/** 做对用了多久：没做成（没交出、交错了）算无穷大，取中位数时排在最后 */
export function timeToCorrect(r: TrialResult): number {
  return succeeded(r) && r.firstCandidateMs !== undefined ? r.firstCandidateMs : Number.POSITIVE_INFINITY;
}
