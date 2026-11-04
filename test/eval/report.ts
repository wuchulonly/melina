// 把试验结果汇总成表：成功率按截断点算、画成曲线；按任务集和难度分组报告； 的全部指标——成功率、
// 首个候选的时间、做对的时间、总 token 与费用、实际探索到的不同路线数、误交付率；
// 有基线和 Melina 完整版时，再对照  的初始目标，并按同一个世界成对比较。
// 成功 = 交出了、检查过了；按时间截断算的还要交出时离开跑不超过截断点（U01：难任务比速度，是主口径），
// 按 token 截断算的要交出时用的 token 不超过截断点（只报，不当门槛）。

import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty } from '../sim/task.ts';
import { sameBatch, worldKey } from './results.ts';
import { SUITE_LABEL, SUITES, type Suite } from './task.ts';
import { formatDuration, formatTokens } from './tokens.ts';
import { succeeded, successAt, successWithin, type TrialResult, timeToCorrect } from './trial.ts';

export interface Ratio {
  hit: number;
  of: number;
}

export interface GroupStats {
  contender: string;
  suite?: Suite;
  difficulty?: Difficulty;
  task?: string;
  n: number; // 有效的次数：跑分这边出错的不算
  success: Ratio[]; // 和 cutoffs（token）一一对应，分母是有效的次数
  successByTime: Ratio[]; // 和 timeCutoffs 一一对应
  done: Ratio; // 做成的（交出了、检查过了），不看时间和 token：截断由跑分时的上限保证
  /** 做对用的时间，中位数（medianTime）：没做成（没交出、交错了）算无穷大；null 是做成的不到一半 */
  medianTimeToCorrect?: number | null;
  submitted: number;
  misdelivered: Ratio; // 取到交付、做了检查的里面，检查不过的
  unchecked: number;
  medianTokensToSuccess?: number;
  /**
   * 成功的那几次交出那一刻花了多少钱（美元），中位数：和成功时的 token、随费用的曲线一个口径。
   * token 按「输入 + 命中缓存」算，命中缓存便宜得多，费用和 token 两个口径一起看
   */
  medianUsdToSuccess?: number;
  /** 首个候选的时间：第一次交出（Melina 的一版或候选，哪个早算哪个），中位数 */
  medianFirstCandidateMs?: number;
  medianWallMs?: number; // 端到端耗时（可以重来的被测方含重来的几次）
  meanTokens: number; // 平均每次用的 token（成没成都算）
  notSubmitted: number; // 到最大截断都没提交（含被截断、放弃、卡住、超时）
  errors: number; // 跑分这边出错的（起点仓库、本机读不出交付、世界不合格、检查环境出了问题），不算任务难
  usd: number; // 有效的那几次的费用合计（不含出错的）
  errorUsd: number; // 跑分出错的那几次也花了钱，另列
  meanRoutes: number; // 开过的路线（direct 的 Bet）
  meanRoutesExplored?: number; // 占这一组全部 token 的比例
  cacheHit?: number; // 全部模型调用的输入 token 缓存命中率
  workerCacheHit?: number; // 干活的那个角色（Melina 的 Explorer、基线自己）的缓存命中率
}

/**  初始目标的一行：Melina 完整版、基线（有并行基线时再加一列）各一个值，能判的给出达没达到 */
export interface TargetRow {
  target: string;
  melina: string;
  baseline: string;
  /** 同时开 k 个单 agent 的基线（U01）；没跑的时候没有 */
  parallel?: string;
  verdict: string;
}

/** 同一个世界（任务、第几次）上 Melina 和基线成对比较 */
export interface PairStats {
  difficulty: Difficulty;
  pairs: number;
  both: number;
  melinaOnly: number;
  baselineOnly: number;
  neither: number;
  /** 两边都成功时，Melina 提交时的 token ÷ 基线提交时的 token，中位数 */
  medianTokenRatio?: number;
  /** 两边都成功时，Melina 首个候选耗时 ÷ 基线的，中位数 */
  medianTimeRatio?: number;
  /** Melina 更快做对的世界数（只有 Melina 做对的也算；两边都没做成的不算） */
  melinaFaster: number;
  /** 后者更快做对的世界数 */
  baselineFaster: number;
}

export interface Summary {
  cutoffs: number[]; // token 截断
  timeCutoffs: number[]; // 时间截断（毫秒）
  byGroup: GroupStats[]; // 按被测方 × 任务集 × 难度
  byTask: GroupStats[];
  /** 拿哪几个被测方对照 （没有基线或没有 Melina 完整版时没有）；parallel 是同时开 k 个单 agent 的基线 */
  versus?: { melina: string; baseline: string; parallel?: string };
  targets: TargetRow[];
  /**  那几行用了哪些世界：几方都有效、同一批跑的世界；没算进来的，按被测方数它自己有效的那几次 */
  targetWorlds?: { used: number; dropped: Record<string, number> };
  pairs: PairStats[];
  /** Melina 对并行基线的成对比较（有并行基线时） */
  pairsParallel: PairStats[];
}

/** 时间截断的默认值 */
export const DEFAULT_TIME_CUTOFFS = [5, 10, 20, 40, 80].map((m) => m * 60_000);

export interface SummarizeOptions {
  /** 当「Melina 完整版」比的被测方，默认叫 melina 的那个 */
  melina?: string;
  /** 当基线比的被测方，默认第一个名字以 baseline 开头、不是并行基线的 */
  baseline?: string;
  /** 同时开 k 个单 agent 的基线，默认第一个名字以 baseline-k 开头的 */
  parallel?: string;
  /** 上面三个是照被测方登记的角色给的（rolesOf）：没给的就是没有，不再按名字猜 */
  explicitRoles?: boolean;
  /** 时间截断（毫秒） */
  timeCutoffs?: readonly number[];
}

/** 被测方在报告里是什么：Melina 完整版、别的 Melina 变体、单 agent 基线、同时开 k 个的基线、独立并行的一道、标准解或直接做法 */
export type ContenderRole = 'melina' | 'variant' | 'baseline' | 'parallel' | 'independent' | 'solution';

/**
 * 按登记的角色认拿谁对照 ：按名字猜会认错，比如单 agent 基线的模型叫 k3 时名字是 baseline-k3。
 * 老存档没登记角色，返回空的，照旧按名字猜
 */
export function rolesOf(contenders: ReportMeta['contenders']): SummarizeOptions {
  if (!contenders.some((c) => c.role !== undefined)) return {};
  const first = (role: ContenderRole) => contenders.find((c) => c.role === role)?.name;
  const out: SummarizeOptions = { explicitRoles: true };
  const melina = first('melina');
  const baseline = first('baseline');
  const parallel = first('parallel');
  if (melina) out.melina = melina;
  if (baseline) out.baseline = baseline;
  if (parallel) out.parallel = parallel;
  return out;
}

export function summarize(
  results: readonly TrialResult[],
  cutoffs: readonly number[],
  options: SummarizeOptions = {},
): Summary {
  const times = [...(options.timeCutoffs ?? DEFAULT_TIME_CUTOFFS)];
  const contenders = [...new Set(results.map((r) => r.contender))];
  const byGroup: GroupStats[] = [];
  for (const c of contenders) {
    for (const s of SUITES) {
      for (const d of DIFFICULTIES) {
        const group = results.filter((r) => r.contender === c && suiteOfResult(r) === s && r.difficulty === d);
        if (group.length > 0) byGroup.push({ ...stats(group, cutoffs, times), contender: c, suite: s, difficulty: d });
      }
    }
  }
  const tasks = [...new Set(results.map((r) => r.task))];
  const byTask: GroupStats[] = [];
  for (const t of tasks) {
    for (const c of contenders) {
      const group = results.filter((r) => r.contender === c && r.task === t);
      if (group.length > 0) byTask.push({ ...stats(group, cutoffs, times), contender: c, task: t });
    }
  }
  const guess = !options.explicitRoles;
  const melina = options.melina ?? (guess && contenders.includes('melina') ? 'melina' : undefined);
  const isParallel = (c: string) => /^baseline-k\d/.test(c);
  const baseline =
    options.baseline ?? (guess ? contenders.find((c) => c.startsWith('baseline') && !isParallel(c)) : undefined);
  const parallel = options.parallel ?? (guess ? contenders.find(isParallel) : undefined);
  const summary: Summary = {
    cutoffs: [...cutoffs],
    timeCutoffs: times,
    byGroup,
    byTask,
    targets: [],
    pairs: [],
    pairsParallel: [],
  };
  if (melina && baseline && contenders.includes(melina) && contenders.includes(baseline)) {
    const par = parallel && contenders.includes(parallel) ? parallel : undefined;
    summary.versus = { melina, baseline, ...(par ? { parallel: par } : {}) };
    const worlds = targetWorlds(results, [melina, baseline, ...(par ? [par] : [])]);
    summary.targets = targets(results, times, melina, baseline, par, worlds.used);
    summary.targetWorlds = { used: worlds.used.size, dropped: worlds.dropped };
    summary.pairs = pairs(results, melina, baseline);
    if (par) summary.pairsParallel = pairs(results, melina, par);
  }
  return summary;
}

/**  之前的结果没有 suite：都是仿真任务 */
export function suiteOfResult(r: Pick<TrialResult, 'suite'>): Suite {
  return r.suite ?? 'sim';
}

function stats(
  group: readonly TrialResult[],
  cutoffs: readonly number[],
  times: readonly number[],
): Omit<GroupStats, 'contender'> {
  const ratio = (hit: number, of: number): Ratio => ({ hit, of });
  const valid = group.filter((r) => r.status !== 'error');
  const checked = valid.filter((r) => r.submitted && r.delivered);
  const out: Omit<GroupStats, 'contender'> = {
    n: valid.length,
    success: cutoffs.map((c) => ratio(valid.filter((r) => successAt(r, c)).length, valid.length)),
    successByTime: times.map((t) => ratio(valid.filter((r) => successWithin(r, t)).length, valid.length)),
    done: ratio(valid.filter(succeeded).length, valid.length),
    submitted: valid.filter((r) => r.submitted).length,
    misdelivered: ratio(checked.filter((r) => !r.checkPass).length, checked.length),
    unchecked: valid.filter((r) => r.submitted && !r.delivered).length,
    meanTokens: mean(valid.map((r) => r.tokens)) ?? 0,
    notSubmitted: valid.filter((r) => !r.submitted).length,
    errors: group.length - valid.length,
    usd: valid.reduce((s, r) => s + r.usage.usd, 0),
    errorUsd: group.filter((r) => r.status === 'error').reduce((s, r) => s + r.usage.usd, 0),
    meanRoutes: mean(valid.map((r) => r.routes)) ?? 0,
  };
  const winners = valid.filter(succeeded);
  if (valid.length > 0) out.medianTimeToCorrect = finiteOrNull(medianTime(valid.map(timeToCorrect)));
  const tokens = median(winners.map((r) => r.tokensAtSubmit ?? 0));
  if (tokens !== undefined) out.medianTokensToSuccess = tokens;
  const usd = median(winners.flatMap((r) => usdAtSubmit(r) ?? []));
  if (usd !== undefined) out.medianUsdToSuccess = usd;
  // 第一次交出的时刻： 之前的结果只有交付那一个的（firstCandidateMs）
  const firstCandidate = median(valid.flatMap((r) => r.firstSubmitMs ?? r.firstCandidateMs ?? []));
  if (firstCandidate !== undefined) out.medianFirstCandidateMs = firstCandidate;
  const wall = median(valid.map((r) => r.wallMs));
  if (wall !== undefined) out.medianWallMs = wall;
  const explored = valid.flatMap((r) => (r.routesExplored === undefined ? [] : [r.routesExplored]));
  if (explored.length > 0) out.meanRoutesExplored = mean(explored) as number;

  const hit = cacheHitRate(valid.map((r) => r.usage));
  if (hit !== undefined) out.cacheHit = hit;
  const worker = cacheHitRate(valid.flatMap((r) => (r.byRole?.explorer ? [r.byRole.explorer] : [])));
  if (worker !== undefined) out.workerCacheHit = worker;
  return out;
}

/** 缓存命中率 = cacheRead ÷（input + cacheRead + cacheWrite），和 Melina 的账本、test/dev/usage.ts 同一个口径 */
export function cacheHitRate(
  usages: readonly { input: number; cacheRead: number; cacheWrite: number }[],
): number | undefined {
  let read = 0;
  let all = 0;
  for (const u of usages) {
    read += u.cacheRead;
    all += u.input + u.cacheRead + u.cacheWrite;
  }
  return all === 0 ? undefined : read / all;
}

/**
 *  那几行用哪些世界：几方都有效（不是跑分这边出错的）、又是同一批跑的世界。各算各的分母时，
 * 一方出错的世界只从那一方去掉，另一方在那个世界上的成败照算，两边比的不是同一批题：一方出错多，结论就偏向它
 */
function targetWorlds(
  results: readonly TrialResult[],
  sides: readonly string[],
): { used: Set<string>; dropped: Record<string, number> } {
  const byWorld = new Map<string, Map<string, TrialResult>>();
  for (const r of results) {
    if (!sides.includes(r.contender) || r.status === 'error') continue;
    const m = byWorld.get(worldKey(r)) ?? new Map<string, TrialResult>();
    m.set(r.contender, r);
    byWorld.set(worldKey(r), m);
  }
  const used = new Set<string>();
  const dropped: Record<string, number> = Object.fromEntries(sides.map((c) => [c, 0]));
  for (const [world, m] of byWorld) {
    const rs = sides.map((c) => m.get(c));
    const paired = rs.every((r) => r !== undefined) && new Set(rs.map((r) => r?.batch)).size === 1;
    if (paired) used.add(world);
    else for (const c of m.keys()) dropped[c] = (dropped[c] ?? 0) + 1;
  }
  return { used, dropped };
}

function targets(
  results: readonly TrialResult[],
  times: readonly number[],
  melina: string,
  baseline: string,
  parallel: string | undefined,
  worlds: ReadonlySet<string>,
): TargetRow[] {
  const valid = (c: string, d?: Difficulty) =>
    results.filter(
      (r) =>
        r.contender === c && r.status !== 'error' && worlds.has(worldKey(r)) && (d === undefined || r.difficulty === d),
    );
  const rows: TargetRow[] = [];
  const withParallel = (row: TargetRow, value: (c: string) => string): TargetRow =>
    parallel ? { ...row, parallel: value(parallel) } : row;
  // 1. 简单任务（fast 模式直接完成）的端到端耗时：做成了的简单题，
  //    端到端耗时的中位数。只报，不当门槛（10-03 用户定：简单题不要求比单 agent 快，主要看难题；原来是 ≤ 基线的 1.1 倍）
  const easyWall = (c: string) =>
    median(
      valid(c, 'easy')
        .filter(succeeded)
        .map((r) => r.wallMs),
    );
  const kw = easyWall(melina);
  const bw = easyWall(baseline);
  rows.push(
    withParallel(
      {
        target: '简单任务的端到端耗时（含 Scoper，过了检查的简单题，中位数）：照报，不设门槛',
        melina: duration(kw),
        baseline: duration(bw),
        verdict:
          kw === undefined || bw === undefined || bw === 0 ? '只报（缺数据）' : `只报（${(kw / bw).toFixed(2)} 倍）`,
      },
      (c) => duration(easyWall(c)),
    ),
  );
  // 2、3. 难任务做对的耗时（中位数，交错了、没交出算没做成）：低于单 agent 基线，也不慢于同时开 k 个单 agent（U01）
  const hardK = valid(melina, 'hard');
  const hardB = valid(baseline, 'hard');
  const correct = (rs: readonly TrialResult[]) => (rs.length === 0 ? undefined : medianTime(rs.map(timeToCorrect)));
  const kc = correct(hardK);
  const bc = correct(hardB);
  const cmp = (a: number | undefined, b: number | undefined, ok: (x: number, y: number) => boolean): string => {
    if (a === undefined || b === undefined) return '没法判（没跑难题）';
    if (!Number.isFinite(a) && !Number.isFinite(b)) return '没法判（两边做成的都不到一半）';
    const ratio = Number.isFinite(a) && Number.isFinite(b) ? `（${(a / b).toFixed(2)} 倍）` : '';
    return `${ok(a, b) ? '达到' : '没达到'}${ratio}`;
  };
  rows.push(
    withParallel(
      {
        target: '难任务做对的耗时（中位数，没交出、交错了算没做成）低于单 agent 基线',
        melina: correctText(kc),
        baseline: correctText(bc),
        verdict: cmp(kc, bc, (a, b) => a < b),
      },
      (c) => correctText(correct(valid(c, 'hard'))),
    ),
  );
  if (parallel) {
    const pc = correct(valid(parallel, 'hard'));
    rows.push({
      target: '难任务做对的耗时不慢于同时开 k 个单 agent（谁先交用谁的）',
      melina: correctText(kc),
      baseline: '—',
      parallel: correctText(pc),
      verdict: cmp(kc, pc, (a, b) => a <= b),
    });
  }
  // 4. 同一个时间截断下的成功率不低于基线（U01）
  if (hardK.length > 0 && hardB.length > 0) {
    const at = (rs: readonly TrialResult[], t: number) => rs.filter((r) => successWithin(r, t)).length / rs.length;
    const cells = times.map((t) => ({ t, k: at(hardK, t), b: at(hardB, t) }));
    const worse = cells.filter((x) => x.k < x.b).length;
    const better = cells.filter((x) => x.k > x.b).length;
    rows.push(
      withParallel(
        {
          target: '难任务同一个时间截断下的成功率不低于单 agent 基线',
          melina: cells.map((x) => `@${formatDuration(x.t)} ${pct(x.k)}`).join('，'),
          baseline: cells.map((x) => `@${formatDuration(x.t)} ${pct(x.b)}`).join('，'),
          verdict:
            worse === 0
              ? `达到（${better} 个截断点更高、${cells.length - better} 个持平）`
              : `没达到（${worse} 个截断点更低、${better} 个更高）`,
        },
        (c) => {
          const rs = valid(c, 'hard');
          return rs.length === 0 ? '—' : times.map((t) => `@${formatDuration(t)} ${pct(at(rs, t))}`).join('，');
        },
      ),
    );
  } else {
    rows.push({
      target: '难任务同一个时间截断下的成功率不低于单 agent 基线',
      melina: '—',
      baseline: '—',
      verdict: '没法判（没跑难题）',
    });
  }
  // 5. token 和费用：照报，多花是预期，不设门槛（U01）
  const spend = (c: string) => {
    const rs = valid(c, 'hard');
    if (rs.length === 0) return '—';
    const tokens = median(rs.filter(succeeded).map((r) => r.tokensAtSubmit ?? r.tokens));
    const usd = rs.reduce((s, r) => s + r.usage.usd, 0);
    return `做成时 token 中位数 ${tokens === undefined ? '—' : formatTokens(tokens)}，费用 $${usd.toFixed(2)}（${rs.length} 次）`;
  };
  rows.push(
    withParallel(
      {
        target: '难任务的 token 和费用：照报，不设门槛',
        melina: spend(melina),
        baseline: spend(baseline),
        verdict: '只报',
      },
      spend,
    ),
  );
  // 6. Explorer 调用的输入 token 缓存命中率 ≥ 50%
  const workerHit = (c: string) =>
    cacheHitRate(valid(c).flatMap((r) => (r.byRole?.explorer ? [r.byRole.explorer] : [])));
  const kh = workerHit(melina);
  const bh = workerHit(baseline);
  rows.push(
    withParallel(
      {
        target: 'Explorer 调用的输入 token 缓存命中率 ≥ 50%（基线是它自己的命中率，只作对照）',
        melina: kh === undefined ? '—' : pct(kh),
        baseline: bh === undefined ? '—' : pct(bh),
        verdict: kh === undefined ? '没法判（Melina 没报按角色的用量）' : kh >= 0.5 ? '达到' : '没达到',
      },
      (c) => {
        const h = workerHit(c);
        return h === undefined ? '—' : pct(h);
      },
    ),
  );
  return rows;
}

/** 做对的时间：做成的不到一半写清楚 */
function correctText(ms: number | undefined | null): string {
  if (ms === undefined) return '—';
  if (ms === null || !Number.isFinite(ms)) return '做成的不到一半';
  return duration(ms);
}

function finiteOrNull(v: number | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  return Number.isFinite(v) ? v : null;
}

/** 同一个世界、同一批跑的才配成一对 */
function pairs(results: readonly TrialResult[], melina: string, baseline: string): PairStats[] {
  const base = new Map(
    results.filter((r) => r.contender === baseline && r.status !== 'error').map((r) => [worldKey(r), r] as const),
  );
  const out: PairStats[] = [];
  for (const d of DIFFICULTIES) {
    const list = results
      .filter((r) => r.contender === melina && r.status !== 'error' && r.difficulty === d)
      .flatMap((k) => {
        const b = base.get(worldKey(k));
        return b && sameBatch(k, b) ? [{ k, b }] : [];
      });
    if (list.length === 0) continue;
    const ok = succeeded;
    const both = list.filter((p) => ok(p.k) && ok(p.b));
    const row: PairStats = {
      difficulty: d,
      pairs: list.length,
      both: both.length,
      melinaOnly: list.filter((p) => ok(p.k) && !ok(p.b)).length,
      baselineOnly: list.filter((p) => !ok(p.k) && ok(p.b)).length,
      neither: list.filter((p) => !ok(p.k) && !ok(p.b)).length,
      melinaFaster: list.filter((p) => timeToCorrect(p.k) < timeToCorrect(p.b)).length,
      baselineFaster: list.filter((p) => timeToCorrect(p.b) < timeToCorrect(p.k)).length,
    };
    const tokenRatio = median(
      both.flatMap((p) => (p.b.tokensAtSubmit ? [(p.k.tokensAtSubmit ?? 0) / p.b.tokensAtSubmit] : [])),
    );
    if (tokenRatio !== undefined) row.medianTokenRatio = tokenRatio;
    const timeRatio = median(
      both.flatMap((p) =>
        p.k.firstCandidateMs !== undefined && p.b.firstCandidateMs ? [p.k.firstCandidateMs / p.b.firstCandidateMs] : [],
      ),
    );
    if (timeRatio !== undefined) row.medianTimeRatio = timeRatio;
    out.push(row);
  }
  return out;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * 做对的时间的中位数：没做成的算无穷大，取排第 ⌈n/2⌉ 的那个，也就是成功率随时间的曲线升到一半的那一刻。
 * 偶数次时不取中间两个的平均：恰好一半做成时平均出来是无穷大，和曲线对不上
 */
export function medianTime(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((s, v) => s + v, 0) / values.length;
}

export function percent(r: Ratio): string {
  if (r.of === 0) return '—';
  return `${Math.round((100 * r.hit) / r.of)}%（${r.hit}/${r.of}）`;
}

function pct(x: number): string {
  return `${Math.round(100 * x)}%`;
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)} 分钟`;
  return `${(ms / 3600_000).toFixed(1)} 小时`;
}

export interface ReportMeta {
  title: string;
  master: string;
  reps: number;
  /** role： 起登记，报告照它认拿谁对照 （rolesOf） */
  contenders: { name: string; title: string; role?: ContenderRole | undefined }[];
  startedAt: string;
  /** 写在开头的几行说明：模型、容器、截断…… */
  notes?: string[];
}

export function markdownReport(summary: Summary, meta: ReportMeta): string {
  const cut = summary.cutoffs.map((c) => `@${formatTokens(c)}`);
  const timeCut = summary.timeCutoffs.map((t) => `@${formatDuration(t)}`);
  const titleOf = (name: string) => meta.contenders.find((c) => c.name === name)?.title ?? name;
  const group = (g: GroupStats) => [
    titleOf(g.contender),
    SUITE_LABEL[g.suite as Suite],
    DIFFICULTY_LABEL[g.difficulty as Difficulty],
  ];
  const lines: string[] = [];
  lines.push(`# ${meta.title}`, '');
  lines.push(
    `总种子 ${meta.master}，每个任务每个被测方 ${meta.reps} 次，开始于 ${meta.startedAt}。` +
      '同一个任务的第几次，各个被测方用的是同一个世界（同一份数据、同一套隐藏规则）。',
    '',
  );
  for (const note of meta.notes ?? []) lines.push(`- ${note}`);
  if (meta.notes?.length) lines.push('');
  lines.push(
    '成功 = 交出了（Melina 交付的那一个：收尾交的候选，或者停下时交付的那一版；基线调用 done）、Run 外面的检查过了，交错了算没做成；' +
      '按时间截断算的还要它交出时离开跑不超过截断点，按 token 截断算的要它交出时用的 token 不超过截断点。' +
      '做对的时间：从开跑到交出交付的那一个，没做成的算无穷大再取中位数。首个候选的时间：第一次交出（一版或候选，哪个早算哪个）。' +
      '误交付 = 取到交付、做了检查的里面检查不过的。' +
      '「次数」不含跑分这边出错的（世界不合格、本机读不出交付、检查环境出了问题），出错的另列；Melina 说做完了却取不到交付算 Melina 失败。',
    '',
  );

  if (summary.versus) {
    const { melina, baseline, parallel } = summary.versus;
    lines.push(
      `## 对照 §13 的初始目标（${titleOf(melina)} 对 ${titleOf(baseline)}${parallel ? `、${titleOf(parallel)}` : ''}）`,
      '',
    );
    lines.push(row(['目标', titleOf(melina), titleOf(baseline), ...(parallel ? [titleOf(parallel)] : []), '结果']));
    lines.push(row(Array(parallel ? 5 : 4).fill('---')));
    for (const t of summary.targets) {
      lines.push(row([t.target, t.melina, t.baseline, ...(parallel ? [t.parallel ?? '—'] : []), t.verdict]));
    }
    lines.push('');
    if (summary.targetWorlds) {
      const dropped = Object.entries(summary.targetWorlds.dropped).filter(([, n]) => n > 0);
      lines.push(
        `这几行只算几方都有效、同一批跑的 ${summary.targetWorlds.used} 个世界（几方比的是同一批题）。` +
          (dropped.length === 0
            ? '没有去掉的。'
            : `另一方出错或者不是同一批跑的、因此没算进来的：${dropped.map(([c, n]) => `${titleOf(c)} ${n} 次`).join('、')}。`),
        '',
      );
    }
    const pairTable = (title: string, list: readonly PairStats[]) => {
      if (list.length === 0) return;
      lines.push(title, '');
      lines.push(
        row([
          '难度',
          '成对的次数',
          '都做成',
          '只有前者做成',
          '只有后者做成',
          '都没成',
          '前者先做对',
          '后者先做对',
          '交出时 token 比（都做成时，中位数）',
          '交出的耗时比（都做成时，中位数）',
        ]),
      );
      lines.push(row(Array(10).fill('---')));
      for (const p of list) {
        lines.push(
          row([
            DIFFICULTY_LABEL[p.difficulty],
            String(p.pairs),
            String(p.both),
            String(p.melinaOnly),
            String(p.baselineOnly),
            String(p.neither),
            String(p.melinaFaster),
            String(p.baselineFaster),
            p.medianTokenRatio === undefined ? '—' : `${p.medianTokenRatio.toFixed(2)} 倍`,
            p.medianTimeRatio === undefined ? '—' : `${p.medianTimeRatio.toFixed(2)} 倍`,
          ]),
        );
      }
      lines.push('', '比值是前者 ÷ 后者。「先做对」：只有一方做成的算它先；两边都没做成的不算。', '');
    };
    pairTable(`## 同一个世界成对比较（前者：${titleOf(melina)}；后者：${titleOf(baseline)}）`, summary.pairs);
    if (parallel) {
      pairTable(`## 同一个世界成对比较（前者：${titleOf(melina)}；后者：${titleOf(parallel)}）`, summary.pairsParallel);
    }
  }

  lines.push('## 成功率随时间（按任务集和难度）', '');
  lines.push(
    row([
      '被测方',
      '任务集',
      '难度',
      '次数',
      ...timeCut.map((c) => `成功率${c}`),
      '做对的时间（中位数）',
      '没交出',
      '出错',
    ]),
  );
  lines.push(row(Array(timeCut.length + 7).fill('---')));
  for (const g of summary.byGroup) {
    lines.push(
      row([
        ...group(g),
        String(g.n),
        ...g.successByTime.map(percent),
        correctText(g.medianTimeToCorrect),
        String(g.notSubmitted),
        String(g.errors),
      ]),
    );
  }
  lines.push('', '成功率随时间的曲线见 curve-time.svg。', '');

  lines.push('## 成功率随 token（只报，不当门槛）', '');
  lines.push(row(['被测方', '任务集', '难度', '次数', ...cut.map((c) => `成功率${c}`)]));
  lines.push(row(Array(cut.length + 4).fill('---')));
  for (const g of summary.byGroup) {
    lines.push(row([...group(g), String(g.n), ...g.success.map(percent)]));
  }

  lines.push(
    '',
    '成功率随 token 截断的曲线见 curve.svg。token 含命中缓存、按全价算，会放大缓存命中高的一方，所以另有随费用的曲线 curve-cost.svg（横轴是交出那一刻花的钱）。',
  );

  lines.push('', '## 开销', '');
  lines.push(
    row([
      '被测方',
      '任务集',
      '难度',
      '成功时 token 中位数（交出时）',
      '成功时费用中位数（交出时）',
      '平均 token',
      '首个候选耗时中位数',
      '端到端耗时中位数',
      '费用合计（美元）',
      '缓存命中率',
    ]),
  );
  lines.push(row(Array(10).fill('---')));
  for (const g of summary.byGroup) {
    lines.push(
      row([
        ...group(g),
        g.medianTokensToSuccess === undefined ? '—' : formatTokens(g.medianTokensToSuccess),
        g.medianUsdToSuccess === undefined ? '—' : `$${g.medianUsdToSuccess.toFixed(3)}`,
        formatTokens(Math.round(g.meanTokens)),
        duration(g.medianFirstCandidateMs),
        duration(g.medianWallMs),
        spentText(g),
        g.cacheHit === undefined ? '—' : pct(g.cacheHit),
      ]),
    );
  }
  lines.push(
    '',
    '成功时的 token 和费用都取交出交付的那一个时的用量（和随 token、随费用的曲线一个口径）；费用合计是有效的那几次整次花的，跑分出错的那几次另写在括号里。',
  );

  lines.push('', '## 探索与误交付', '');
  lines.push(row(['被测方', '任务集', '难度', '平均开出的路线', '平均实际探索的路线', '误交付']));
  lines.push(row(Array(6).fill('---')));
  for (const g of summary.byGroup) {
    lines.push(
      row([
        ...group(g),
        g.meanRoutes.toFixed(1),
        g.meanRoutesExplored === undefined ? '—' : g.meanRoutesExplored.toFixed(1),
        percent(g.misdelivered),
      ]),
    );
  }
  lines.push('', '实际探索的路线：独立直解和摘要接力的路线里真跑过工具的（排着队就被取消的不算）。', '');

  lines.push('## 按任务', '');
  lines.push(
    row([
      '任务',
      '被测方',
      '次数',
      '做成',
      '做对的时间（中位数）',
      '交出了',
      '交了没收尾',
      '没交出',
      '出错',
      '成功时 token 中位数',
      '平均路线数',
      '费用（美元）',
    ]),
  );
  lines.push(row(Array(12).fill('---')));
  for (const g of summary.byTask) {
    lines.push(
      row([
        g.task as string,
        titleOf(g.contender),
        String(g.n),
        percent(g.done),
        correctText(g.medianTimeToCorrect),
        String(g.submitted),
        String(g.unchecked),
        String(g.notSubmitted),
        String(g.errors),
        g.medianTokensToSuccess === undefined ? '—' : formatTokens(g.medianTokensToSuccess),
        g.meanRoutes.toFixed(1),
        spentText(g),
      ]),
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** 费用合计：有效的那几次；跑分出错的那几次也花了钱的，写在括号里 */
function spentText(g: Pick<GroupStats, 'usd' | 'errorUsd'>): string {
  return g.errorUsd > 0 ? `${g.usd.toFixed(2)}（出错的另花 ${g.errorUsd.toFixed(2)}）` : g.usd.toFixed(2);
}

/** 成功率曲线：每个被测方、每个任务集 × 难度，在 0 到最大截断之间取 points 个点，外加给定的截断点 */
export function curvePoints(
  results: readonly TrialResult[],
  cutoffs: readonly number[],
  points = 20,
): {
  contender: string;
  suite: Suite;
  difficulty: Difficulty;
  n: number;
  curve: { cutoff: number; success: number }[];
}[] {
  const max = cutoffs[cutoffs.length - 1] ?? 0;
  const grid = [
    ...new Set([...Array.from({ length: points }, (_, i) => Math.round((max * (i + 1)) / points)), ...cutoffs]),
  ].sort((a, b) => a - b);
  const out: ReturnType<typeof curvePoints> = [];
  for (const c of [...new Set(results.map((r) => r.contender))]) {
    for (const s of SUITES) {
      for (const d of DIFFICULTIES) {
        const group = results.filter(
          (r) => r.contender === c && suiteOfResult(r) === s && r.difficulty === d && r.status !== 'error',
        );
        if (group.length === 0) continue;
        out.push({
          contender: c,
          suite: s,
          difficulty: d,
          n: group.length,
          curve: grid.map((x) => ({ cutoff: x, success: group.filter((r) => successAt(r, x)).length / group.length })),
        });
      }
    }
  }
  return out;
}

/** 时间口径的成功率曲线数据（U01，主口径）：在每个时间截断点上，做成并且交出时离开跑不超过它的比例 */
export function timeCurveCsv(results: readonly TrialResult[], times: readonly number[]): string {
  const lines = ['contender,suite,difficulty,ms,success,n'];
  for (const g of stepGroups(results, Number.POSITIVE_INFINITY, (r) => r.firstCandidateMs)) {
    for (const t of times)
      lines.push(`${g.contender},${g.suite},${g.difficulty},${t},${g.wins.filter((w) => w <= t).length / g.n},${g.n}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 成功率随时间画成一张 SVG（U01，主口径）：每个成功的试验在它交出时的耗时处升一级，横轴按对数 */
export function timeCurveSvg(
  results: readonly TrialResult[],
  times: readonly number[],
  contenders: readonly { name: string; title: string }[],
): string {
  const max = times[times.length - 1] ?? 3600_000;
  return stepSvg(
    stepGroups(results, max, (r) => r.firstCandidateMs),
    contenders,
    {
      lo: Math.max(1000, (times[0] ?? max) / 4),
      hi: max,
      ticks: times,
      format: formatDuration,
    },
  );
}

export function curveCsv(results: readonly TrialResult[], cutoffs: readonly number[], points = 20): string {
  const lines = ['contender,suite,difficulty,cutoff,success,n'];
  for (const g of curvePoints(results, cutoffs, points)) {
    for (const p of g.curve) lines.push(`${g.contender},${g.suite},${g.difficulty},${p.cutoff},${p.success},${g.n}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 提交那一刻花了多少钱： 加 usdAtSubmit 之前的结果没有这一项，提交都在一次试验的最后，用整次的费用顶 */
export function usdAtSubmit(r: TrialResult): number | undefined {
  if (!r.submitted) return undefined;
  return r.usdAtSubmit ?? r.usage.usd;
}

/** 费用口径的刻度：1、3 一档，盖住成功那几次的花费 */
export function costTicks(results: readonly TrialResult[], _maxTokens: number): number[] {
  const spent = results.filter(succeeded).flatMap((r) => usdAtSubmit(r) ?? []);
  const lo = Math.min(...spent, 0.01);
  const hi = Math.max(...spent, 0.03);
  const ticks: number[] = [];
  for (let e = -4; e <= 3; e++) {
    for (const m of [1, 3]) {
      const t = m * 10 ** e;
      if (t >= lo / 3 && t <= hi * 3) ticks.push(Number(t.toPrecision(1)));
    }
  }
  return ticks;
}

const formatUsd = (v: number) => `$${v >= 1 ? v.toFixed(0) : Number(v.toPrecision(1))}`;

/** 费用口径的成功率曲线数据：在每个刻度上，做成了并且提交时花费不超过它的比例 */
export function costCurveCsv(results: readonly TrialResult[], cutoffs: readonly number[]): string {
  const max = cutoffs[cutoffs.length - 1] ?? Number.POSITIVE_INFINITY;
  const ticks = costTicks(results, max);
  const lines = ['contender,suite,difficulty,usd,success,n'];
  for (const g of stepGroups(results, Number.POSITIVE_INFINITY, usdAtSubmit)) {
    for (const t of ticks)
      lines.push(`${g.contender},${g.suite},${g.difficulty},${t},${g.wins.filter((w) => w <= t).length / g.n},${g.n}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 每个被测方 × 任务集 × 难度：一共几次，成功的那几次在横轴上的位置（排好序）。横轴上没有位置（没记交出时间、token）的、
 * 超出横轴最右端 max 的不画：和表格的口径一样，表格里它们在任何截断点上都不算成功
 */
function stepGroups(
  results: readonly TrialResult[],
  max: number,
  x: (r: TrialResult) => number | undefined,
): { contender: string; suite: Suite; difficulty: Difficulty; n: number; wins: number[] }[] {
  const out: { contender: string; suite: Suite; difficulty: Difficulty; n: number; wins: number[] }[] = [];
  for (const c of [...new Set(results.map((r) => r.contender))]) {
    for (const suite of SUITES) {
      for (const difficulty of DIFFICULTIES) {
        const group = results.filter(
          (r) => r.contender === c && suiteOfResult(r) === suite && r.difficulty === difficulty && r.status !== 'error',
        );
        if (group.length === 0) continue;
        const wins = group
          .filter(succeeded)
          .flatMap((r) => {
            const v = x(r);
            return v === undefined || v > max ? [] : [v];
          })
          .sort((a, b) => a - b);
        out.push({ contender: c, suite, difficulty, n: group.length, wins });
      }
    }
  }
  return out;
}

/**
 * 成功率曲线画成一张 SVG：每个任务集 × 难度一小格，每个被测方一条阶梯线（每个成功的试验在它提交时的 token 处升一级）。
 * 横轴是 token 截断，按对数画（截断点 500k、1M、2M… 是倍数关系），纵轴是成功率
 */
export function curveSvg(
  results: readonly TrialResult[],
  cutoffs: readonly number[],
  contenders: readonly { name: string; title: string }[],
): string {
  const max = cutoffs[cutoffs.length - 1] ?? 1;
  return stepSvg(
    stepGroups(results, max, (r) => r.tokensAtSubmit),
    contenders,
    {
      lo: Math.max(1, (cutoffs[0] ?? max) / 4),
      hi: max,
      ticks: cutoffs,
      format: formatTokens,
    },
  );
}

/**
 * 同上，横轴换成提交那一刻花的钱。
 *  起 token 只报，做成了就画，不再按最大 token 截断挑
 */
export function costCurveSvg(
  results: readonly TrialResult[],
  cutoffs: readonly number[],
  contenders: readonly { name: string; title: string }[],
): string {
  const max = cutoffs[cutoffs.length - 1] ?? Number.POSITIVE_INFINITY;
  const ticks = costTicks(results, max);
  return stepSvg(stepGroups(results, Number.POSITIVE_INFINITY, usdAtSubmit), contenders, {
    lo: ticks[0] ?? 0.001,
    hi: ticks[ticks.length - 1] ?? 1,
    ticks,
    format: formatUsd,
  });
}

function stepSvg(
  groups: { contender: string; suite: Suite; difficulty: Difficulty; n: number; wins: number[] }[],
  contenders: readonly { name: string; title: string }[],
  axis: { lo: number; hi: number; ticks: readonly number[]; format: (v: number) => string },
): string {
  const { lo, hi } = axis;
  const panels = [...new Set(groups.map((g) => `${g.suite}|${g.difficulty}`))];
  const names = [...new Set(groups.map((g) => g.contender))];
  const colors = ['#2f6fdf', '#d9822b', '#2e9e6a', '#b24bb5', '#c23b3b', '#6b7280'];
  const W = 260;
  const H = 170;
  const pad = { l: 40, r: 12, t: 26, b: 30 };
  const cols = Math.min(3, Math.max(1, panels.length));
  const rows = Math.ceil(panels.length / cols);
  const width = cols * W;
  const height = rows * H + 20 + 18 * names.length;
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const log = (v: number) => Math.log(Math.min(hi, Math.max(lo, v)));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif" font-size="11">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
  ];
  panels.forEach((key, i) => {
    const [suite, difficulty] = key.split('|') as [Suite, Difficulty];
    const x0 = (i % cols) * W;
    const y0 = Math.floor(i / cols) * H;
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    const sx = (v: number) => r1(x0 + pad.l + (pw * (log(v) - log(lo))) / (log(hi) - log(lo)));
    const sy = (v: number) => r1(y0 + pad.t + ph * (1 - v));
    out.push(
      `<text x="${x0 + pad.l}" y="${y0 + 16}" font-weight="600" fill="#111">${esc(`${SUITE_LABEL[suite]} · ${DIFFICULTY_LABEL[difficulty]}`)}</text>`,
    );
    for (const v of [0, 0.5, 1]) {
      out.push(`<line x1="${sx(lo)}" x2="${sx(hi)}" y1="${sy(v)}" y2="${sy(v)}" stroke="#e5e7eb"/>`);
      out.push(
        `<text x="${x0 + pad.l - 4}" y="${sy(v) + 4}" text-anchor="end" fill="#6b7280">${Math.round(v * 100)}%</text>`,
      );
    }
    for (const c of axis.ticks) {
      out.push(`<line x1="${sx(c)}" x2="${sx(c)}" y1="${sy(0)}" y2="${sy(0) + 3}" stroke="#9ca3af"/>`);
      out.push(`<text x="${sx(c)}" y="${sy(0) + 14}" text-anchor="middle" fill="#6b7280">${axis.format(c)}</text>`);
    }
    for (const g of groups.filter((x) => `${x.suite}|${x.difficulty}` === key)) {
      const color = colors[names.indexOf(g.contender) % colors.length];
      let d = `M${sx(lo)},${sy(0)}`;
      let level = 0;
      for (const t of g.wins) {
        d += ` H${sx(t)}`;
        level += 1 / g.n;
        d += ` V${sy(level)}`;
      }
      d += ` H${sx(hi)}`;
      out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`);
      out.push(
        `<text x="${sx(hi)}" y="${sy(level) - 4}" text-anchor="end" fill="${color}">${g.wins.length}/${g.n}</text>`,
      );
    }
  });
  names.forEach((name, i) => {
    const y = rows * H + 14 + 18 * i;
    const color = colors[i % colors.length];
    const title = contenders.find((c) => c.name === name)?.title ?? name;
    out.push(`<line x1="12" x2="36" y1="${y}" y2="${y}" stroke="${color}" stroke-width="3"/>`);
    out.push(`<text x="42" y="${y + 4}" fill="#111">${esc(title)}</text>`);
  });
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

function row(cells: readonly string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
}
