// 跑分时被测的那一方：Melina 的一个配置变体；或者不经过 Melina，直接跑标准解、直接的做法
// （拿来检查跑分脚本自己对不对，这台起不了容器的机器上也能跑）。 的单 agent 基线也做成一个 Contender，
// restartable 为 true：截断内没提交就从头重来。

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResultResponse, RunSummary } from '../../src/core/api.ts';
import { type MelinaEvent, type UsageTotals, ZERO_USAGE } from '../../src/core/events.ts';
import { type CompletionSpec, ENDED_RUN_STATUSES, type Run } from '../../src/core/types.ts';
import { realClock, type SimClock } from '../sim/kit/clock.ts';
import { type MelinaClient, MelinaHttpError, type MelinaRun } from './melina.ts';
import { type EvalTask, type EvalWorld, materialText } from './task.ts';
import { addUsage, totalTokens } from './tokens.ts';
import type { Variant } from './variants.ts';
import { extractDelivery, MelinaDeliveryError } from './workspace.ts';

export type AttemptStatus = 'done' | 'cancelled' | 'failed' | 'cut' | 'stalled' | 'timeout' | 'melina_error' | 'error';

export interface AttemptInput {
  task: EvalTask;
  world: EvalWorld;
  url: string; // 容器里看到的环境地址，写进目标和附件；真实任务没有环境，是空的
  localUrl: string; // 跑分脚本自己连环境用的地址；真实任务是空的
  workspace: string; // 起点 workspace
  materials: { name: string; path: string }[];
  statement: string;
  completion: CompletionSpec;
  domain: string;
  budget: number; // 这一次最多还能花多少 token（上限，防跑飞）
  /** 这次试验的时间截断（Date.now() 的毫秒数）：到点还没交出就停下，记成 timeout */
  deadline: number;
  dir: string; // 这一次的存档目录
  signal: AbortSignal; // 评估被人停了
  log: (line: string) => void;
}

export interface AttemptOutcome {
  // cut：到截断还没提交，跑分脚本取消的；stalled：太久没有事件；timeout：跑太久；
  // melina_error：Melina 这边出的问题（连不上、事件流断了、说做完了却取不到结果或交付：分支不在、patch 取不到或打不上），
  // 算失败、进成功率的分母；error 只留给跑分脚本自己的问题（请求写错了、本机读不出交付），不算跑过，接着跑时重跑
  status: AttemptStatus;
  submitted: boolean;
  tokens: number;
  usage: UsageTotals;
  // 交出被交付的那个结果那一刻用了多少（usage.updated 按秒合并，可能差最后一秒的）；交过几版的按交付的那一个取
  tokensAtSubmit?: number;
  usdAtSubmit?: number; // 同一刻花了多少钱（美元），画「成功率随费用」的曲线用
  delivered?: string; // 交付的文件取到了这个目录
  runId?: string;
  wallMs: number;
  // 从这一次开跑（调 createRun 之前）到交出被交付的那个结果；Run 里的那段按 Melina 事件里的时间算。
  // 交过几版的取交付的那一个：收尾交的候选，或者 Run 停下时交付的那一版（只判了它，只能替它报时间）
  firstCandidateMs?: number;
  /** 从这一次开跑到第一次交出（Melina 交的一版或候选，哪个早算哪个）： 的首个候选的时间 */
  firstSubmitMs?: number;
  routes: number; // 开过几条路线（direct 的 Bet）
  branches: number;
  /** 实际探索到的不同路线数：direct 的分支里真跑过工具的（排着队就被取消的不算）；基线不报 */
  routesExplored?: number;
  /** 按角色分的用量（explorer、watcher、scoper）：各角色的花费、缓存命中率 */
  byRole?: Record<string, UsageTotals>;
  endReason?: string;
  /** 交付的是 Run 停下时交付的那一版：到截断、太久没动静被取消，或者 Melina 放弃、出错时交过一版 */
  deliveredVersion?: boolean;
  error?: string;
}

/** 从 Run 的摘要（GET /runs/:id）算  的路线指标和按角色的用量 */
export function routeStats(summary: RunSummary): Pick<AttemptOutcome, 'routesExplored' | 'byRole'> {
  let routesExplored = 0;
  for (const card of summary.branches) {
    const route = card.bet.kind === 'direct';
    if (route && card.branch.toolCalls > 0) routesExplored++;
  }
  const byRole: Record<string, UsageTotals> = {};
  for (const r of summary.usageBy?.byRole ?? []) {
    const { role, ...usage } = r;
    byRole[role] = addUsage(byRole[role] ?? ZERO_USAGE, usage);
  }
  return { routesExplored, byRole };
}

export interface Contender {
  name: string;
  title: string;
  restartable: boolean;
  needsGit: boolean; // 起点要不要是 git 仓库（Melina 要交付成分支）
  attempt(input: AttemptInput): Promise<AttemptOutcome>;
}

export interface MelinaContenderOptions {
  stallMs?: number; // 多久没有任何事件就当卡住、取消，默认 30 分钟（idle 类提问不用等这么久，一出来就取消）
  maxWallMs?: number; // 一个 Run 最多跑多久，默认 3 小时
  /**
   * 取消请求回来以后等它的最后一条事件的时间，默认 5 分钟。POST /cancel 要等 Melina 收尾完（挑版本最多 5 分钟）才回，
   * 所以从请求回来时算
   */
  graceMs?: number;
  /** 取消请求最多等多久，默认 15 分钟：Melina 卡死时不一直等下去 */
  cancelTimeoutMs?: number;
  deliver?: typeof extractDelivery; // 测试里换掉
}

export function melinaContender(
  melina: MelinaClient,
  variant: Variant,
  options: MelinaContenderOptions = {},
): Contender {
  const stallMs = options.stallMs ?? 30 * 60_000;
  const maxWallMs = options.maxWallMs ?? 3 * 3600_000;
  const graceMs = options.graceMs ?? 5 * 60_000;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 15 * 60_000;
  const deliver = options.deliver ?? extractDelivery;
  return {
    name: variant.name,
    title: variant.title,
    restartable: false,
    needsGit: true,
    async attempt(input) {
      const t0 = Date.now();
      // 时间截断：这次试验剩下的时间和单个 Run 的上限取小的
      const maxWall = Math.min(maxWallMs, input.deadline - t0);
      const out: AttemptOutcome = {
        status: 'error',
        submitted: false,
        tokens: 0,
        usage: ZERO_USAGE,
        wallMs: 0,
        routes: 0,
        branches: 0,
      };
      let run: MelinaRun;
      try {
        run = await melina.createRun({
          goal: {
            statement: input.statement,
            materials: input.materials.map((m) => m.path),
            ...(variant.scoper ? {} : { completion: input.completion, domain: input.domain }),
          },
          workspace: { root: input.workspace },
          ...(variant.config ? { config: variant.config } : {}),
        });
      } catch (e) {
        return {
          ...out,
          status: melinaSide(e) ? 'melina_error' : 'error',
          error: errorText(e),
          wallMs: Date.now() - t0,
        };
      }
      out.runId = run.id;
      // 建 Run 那一下的耗时（本机时钟）；Run 里的时间按 Melina 事件里的 at 算，事件流晚到、重连补发都不影响
      const createdLocal = Date.now() - t0;
      input.log(`建了 Run ${run.id}`);
      // 事件流只在这里停：人按 Ctrl-C 时先取消 Run，再接着读到它真结束（最多等 graceMs）
      const stop = new AbortController();
      const interrupted = new Promise<'interrupted'>((resolve) => {
        if (input.signal.aborted) resolve('interrupted');
        input.signal.addEventListener('abort', () => resolve('interrupted'), { once: true });
      });
      const iterator = run
        .events({
          signal: stop.signal,
          onDropped: (raw, problems) => {
            appendFileSync(join(input.dir, 'dropped-events.jsonl'), `${JSON.stringify({ problems, raw })}\n`);
            input.log(`跳过了一条不合契约的事件：${problems}`);
          },
        })
        [Symbol.asyncIterator]();
      let pending: Promise<IteratorResult<MelinaEvent>> | undefined;
      let reason: AttemptStatus | undefined; // 跑分脚本为什么取消的
      let cancelledAt = 0;
      let lastEventAt = Date.now();
      let createdAt: number | undefined;
      // 每个候选、每一版交出那一刻：交付的是哪一个，时间、token、费用、模式就报哪一个的
      const submits = new Map<string, Submit>();
      let formal = false; // 交过正式候选（不是 deliver 交的一版）：Run 在收尾了，token 上限不用再管
      let final: Run | undefined;
      const cancel = async (why: AttemptStatus) => {
        if (reason) return;
        reason = why;
        input.log(`取消 Run：${why}`);
        const answered = await withTimeout(
          run.cancel().catch((e) => input.log(`取消失败：${errorText(e)}`)),
          cancelTimeoutMs,
        );
        if (answered === 'timeout') input.log(`取消请求 ${Math.round(cancelTimeoutMs / 60_000)} 分钟没回`);
        // 宽限期从请求回来时算：POST /cancel 要等 Melina 收尾完才回，最后一条事件这时多半已经在流里了
        cancelledAt = Date.now();
      };
      const onEvent = async (e: MelinaEvent) => {
        lastEventAt = Date.now();
        appendFileSync(join(input.dir, 'events.jsonl'), `${JSON.stringify(e)}\n`);
        switch (e.type) {
          case 'run.created':
            createdAt = Date.parse(e.at);
            break;
          case 'run.updated':
            if ((ENDED_RUN_STATUSES as readonly string[]).includes(e.data.status)) final = e.data;
            break;
          case 'usage.updated':
            out.usage = e.data.total;
            out.tokens = totalTokens(e.data.total);
            break;
          case 'candidate.created': {
            const submit: Submit = {
              tokens: out.tokens,
              usd: out.usage.usd,
              ...(createdAt !== undefined ? { ms: createdLocal + Date.parse(e.at) - createdAt } : {}),
            };
            submits.set(e.data.id, submit);
            if (!e.data.interim) formal = true;
            if (!out.submitted) {
              // 先按第一次交出的记；Run 结束时知道交付的是哪一个，再换成它的（见下面）
              out.submitted = true;
              out.tokensAtSubmit = submit.tokens;
              out.usdAtSubmit = submit.usd;
              if (submit.ms !== undefined) {
                out.firstCandidateMs = submit.ms;
                out.firstSubmitMs = submit.ms;
              }
            }
            break;
          }
          case 'bet.created':
            if (e.data.kind === 'direct') out.routes++;
            break;
          case 'branch.created':
            out.branches++;
            break;
          default:
            break;
        }
        // token 上限防跑飞：交了正式候选，Run 在收尾，才不再管
        if (!formal && out.tokens >= input.budget) await cancel('cut');
      };
      try {
        while (!final) {
          if (input.signal.aborted) await cancel('cancelled');
          const now = Date.now();
          const wait = reason
            ? graceMs - (now - cancelledAt)
            : Math.min(stallMs - (now - lastEventAt), maxWall - (now - t0));
          if (wait <= 0) {
            if (!reason) {
              await cancel(now - t0 >= maxWall ? 'timeout' : 'stalled');
              continue;
            }
            // 宽限期到了：已经在流里的事件读完再停（最后一条事件可能刚到）
            for (;;) {
              pending ??= iterator.next();
              const next = await withTimeout(pending, DRAIN_MS);
              if (next === 'timeout') break;
              pending = undefined;
              if (next.done) break;
              await onEvent(next.value);
              if (final) break;
            }
            break;
          }
          pending ??= iterator.next();
          const next = await Promise.race([withTimeout(pending, wait), ...(reason ? [] : [interrupted])]);
          if (next === 'timeout' || next === 'interrupted') continue;
          pending = undefined;
          if (next.done) break;
          await onEvent(next.value);
        }
      } catch (e) {
        out.error = errorText(e);
        // 事件流断了太久（Melina 崩了、卡死或连不上）：算 Melina 这边的失败。Run 可能还在跑，尽量取消，免得没人管还在花 token
        await cancel('melina_error');
      } finally {
        stop.abort();
      }
      out.wallMs = Date.now() - t0;
      if (final?.endReason) out.endReason = final.endReason;
      if (final && run.summary) {
        // 路线数、花在被叫停路线上的 token、各角色的用量：Run 结束以后从摘要里算；取不到只少这几项，不影响成败
        try {
          const summary = await run.summary();
          writeFileSync(join(input.dir, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
          Object.assign(out, routeStats(summary));
          // 账本按秒合并，最后一秒的 usage.updated 可能晚于结束的那条事件：用量以摘要为准
          if (summary.usage && totalTokens(summary.usage) >= out.tokens) {
            out.usage = summary.usage;
            out.tokens = totalTokens(summary.usage);
          }
        } catch (e) {
          input.log(`取 Run 摘要失败：${errorText(e)}`);
        }
      }
      // 交过一版的：Run 被取消、放弃、出错结束时交付它挑的那一版，照交付取、照常判。
      // 交出的时刻、那一刻的 token 和费用、模式都按交付的那一个记
      const deliveredId = final?.result?.candidateId;
      const version = final !== undefined && final.status !== 'done' && deliveredId !== undefined;
      const delivered = deliveredId === undefined ? undefined : submits.get(deliveredId);
      if (delivered) {
        if (delivered.ms !== undefined) out.firstCandidateMs = delivered.ms;
        out.tokensAtSubmit = delivered.tokens;
        out.usdAtSubmit = delivered.usd;
      }
      if (final?.status === 'done' || version) {
        out.status = 'done';
        if (version) out.deliveredVersion = true;
        try {
          const result: RunResultResponse = await run.result();
          const into = join(input.dir, 'delivered');
          const files = input.world.deliverables();
          const via = await deliver({
            repo: input.workspace,
            result,
            run,
            starter: input.world.starter(),
            into,
            files,
          });
          out.delivered = into;
          input.log(`交付取到了 ${into}（${via === 'branch' ? `分支 ${result.branch}` : 'patch'}）`);
        } catch (e) {
          // 说做完了却取不到交付（Melina 回错、分支不在、patch 取不到或打不上、交付里什么都没有）：Melina 没交付，算失败；
          // 本机读不出交付（git 起不来、磁盘满）：跑分这边的问题，记成出错，不算误交付
          out.status = deliveryMelinaSide(e) ? 'melina_error' : 'error';
          out.error = `取交付失败：${errorText(e)}`;
        }
      } else if (final) {
        out.status = reason ?? (final.status as 'cancelled' | 'failed');
      } else {
        out.status = reason ?? 'error';
        out.error ??= reason ? '取消以后没等到 Run 结束' : '事件流断了，没等到 Run 结束';
      }
      return out;
    },
  };
}

/** 不经过 Melina：直接跑任务的标准解或直接做法，交付物写进起点 workspace */
export function solutionContender(kind: 'reference' | 'naive', clock: SimClock = realClock): Contender {
  return {
    name: kind,
    title: kind === 'reference' ? '标准解（不经过 Melina）' : '直接的做法（不经过 Melina）',
    restartable: false,
    needsGit: false,
    async attempt(input) {
      const t0 = Date.now();
      const materials = Object.fromEntries(
        input.materials.map((m) => [m.name, materialText(m.name, readFileSync(m.path))]),
      );
      const ctx = {
        url: input.localUrl,
        dir: input.workspace,
        statement: input.statement,
        materials,
        sleep: (ms: number) => clock.sleep(ms),
      };
      const base = { tokens: 0, usage: ZERO_USAGE, routes: 1, branches: 1 };
      try {
        await (kind === 'reference' ? input.task.solve(ctx) : input.task.naive(ctx));
      } catch (e) {
        return { ...base, status: 'error', submitted: false, error: errorText(e), wallMs: Date.now() - t0 };
      }
      return {
        ...base,
        status: 'done',
        submitted: true,
        tokensAtSubmit: 0,
        usdAtSubmit: 0,
        delivered: input.workspace,
        wallMs: Date.now() - t0,
        firstCandidateMs: Date.now() - t0,
      };
    },
  };
}

/** 建 Run 时 Melina 这边的问题：连不上（fetch 本身失败）、Melina 回 5xx；回 4xx 是跑分这边的请求不对 */
function melinaSide(e: unknown): boolean {
  if (e instanceof MelinaHttpError) return e.status >= 500;
  if (e instanceof MelinaDeliveryError) return true;
  return e instanceof TypeError && e.message === 'fetch failed';
}

/**
 * 取交付时 Melina 这边的问题：连不上、Melina 回的任何错误
 * （Run 说结束了，GET /result 却回 409、patch 产物 404），交付指的分支不在、patch 打不上起点、交付里什么都没有
 */
function deliveryMelinaSide(e: unknown): boolean {
  return melinaSide(e) || e instanceof MelinaHttpError;
}

/** 一个候选、一版交出那一刻：从开跑算的时间、用了多少 token、花了多少钱、当时的模式 */
interface Submit {
  ms?: number;
  tokens: number;
  usd: number;
}

/** 宽限期到了以后，已经在流里的事件一条最多等这么久 */
const DRAIN_MS = 200;

/** 等 promise，最多等 ms；超时返回 'timeout'，定时器用完就清掉 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
