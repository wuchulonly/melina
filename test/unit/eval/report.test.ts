// token 口径、截断点、汇总表：成功按截断点算（时间是主口径，token 只报），误交付按当前交付结果计数，出错单独数；
//  按 U01 对照：难任务比做对的时间，没做成的算无穷大，有并行基线时再比一列。

import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../../../src/core/api.ts';
import { ZERO_USAGE } from '../../../src/core/events.ts';
import { routeStats } from '../../eval/contenders.ts';
import {
  costCurveCsv,
  costCurveSvg,
  costTicks,
  curveCsv,
  curveSvg,
  markdownReport,
  median,
  medianTime,
  rolesOf,
  summarize,
  timeCurveCsv,
  timeCurveSvg,
  usdAtSubmit,
} from '../../eval/report.ts';
import {
  formatDuration,
  formatTokens,
  parseCutoffs,
  parseDurations,
  parseTokens,
  totalTokens,
} from '../../eval/tokens.ts';
import type { TrialResult } from '../../eval/trial.ts';
import { succeeded, successAt, successWithin, timeToCorrect } from '../../eval/trial.ts';

function trial(over: Partial<TrialResult>): TrialResult {
  return {
    task: 'machine-hard',
    env: 'machine',
    difficulty: 'hard',
    gate: 3,
    contender: 'melina',
    rep: 0,
    seed: 's',
    status: 'done',
    submitted: true,
    delivered: true,
    checkPass: true,
    checkSummary: '',
    tokens: 1_000_000,
    tokensAtSubmit: 900_000,
    usage: { ...ZERO_USAGE, usd: 1 },
    wallMs: 1000,
    routes: 1,
    branches: 1,
    attempts: 1,
    runIds: [],
    envRequests: 0,
    startedAt: '2026-10-02T00:00:00Z',
    ...over,
  };
}

describe('token 口径', () => {
  it('四项加起来，和 pi 的 totalTokens 一样', () => {
    expect(totalTokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, usd: 9 })).toBe(10);
  });

  it('500k、1.5m 这种写法；截断点去重排序', () => {
    expect(parseTokens('500k')).toBe(500_000);
    expect(parseTokens('1.5M')).toBe(1_500_000);
    expect(parseTokens('42')).toBe(42);
    expect(() => parseTokens('abc')).toThrow();
    expect(parseCutoffs('2m,500k,2m')).toEqual([500_000, 2_000_000]);
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(500_000)).toBe('500k');
  });

  it('时间截断的写法：90s、5m、1.5h，不带单位按分钟；去重排序', () => {
    expect(parseDurations('10m,90s,1.5h,5')).toEqual([90_000, 300_000, 600_000, 5_400_000]);
    expect(() => parseDurations('5 分钟')).toThrow();
    expect(formatDuration(300_000)).toBe('5m');
    expect(formatDuration(5_400_000)).toBe('90m');
    expect(formatDuration(10_800_000)).toBe('3h');
    expect(formatDuration(45_000)).toBe('45s');
  });
});

describe('summarize', () => {
  const results = [
    trial({ rep: 0, tokensAtSubmit: 400_000 }),
    trial({ rep: 1, tokensAtSubmit: 1_500_000 }),
    trial({ rep: 2, checkPass: false }),
    trial({ rep: 3, submitted: false, status: 'cut', tokensAtSubmit: undefined }),
    trial({ rep: 4, submitted: false, status: 'error', tokensAtSubmit: undefined }),
  ];

  it('成功率按截断点算：提交了、检查过了、提交时不超过截断；跑分这边出错的不进分母', () => {
    expect(successAt(results[0] as TrialResult, 500_000)).toBe(true);
    expect(successAt(results[1] as TrialResult, 1_000_000)).toBe(false);
    const s = summarize(results, [500_000, 2_000_000]);
    const g = s.byGroup[0];
    expect(g?.n).toBe(4);
    expect(g?.success).toEqual([
      { hit: 1, of: 4 },
      { hit: 2, of: 4 },
    ]);
    expect(g?.misdelivered).toEqual({ hit: 1, of: 3 });
    expect(g?.errors).toBe(1);
    expect(g?.notSubmitted).toBe(1);
    expect(g?.medianTokensToSuccess).toBe((400_000 + 1_500_000) / 2);
    expect(g?.medianUsdToSuccess).toBe(1);
    // 费用合计只算有效的那几次，跑分出错的那次另列
    expect(g?.usd).toBe(4);
    expect(g?.errorUsd).toBe(1);
  });

  it('表格和曲线写得出来', () => {
    const s = summarize(results, [500_000, 2_000_000]);
    const md = markdownReport(s, {
      title: '测试',
      master: 'm',
      reps: 5,
      contenders: [{ name: 'melina', title: 'Melina 完整版' }],
      startedAt: 'now',
    });
    expect(md).toContain('| Melina 完整版 | 仿真 | 难 | 4 | 25%（1/4） | 50%（2/4） |');
    // 按任务：做成的（交出了、检查过了）不看 token；没记交出时间的老结果算不进按时间的成功率
    expect(md).toContain('| machine-hard | Melina 完整版 | 4 | 50%（2/4） |');
    const csv = curveCsv(results, [500_000, 2_000_000], 4).trim().split('\n');
    expect(csv[0]).toBe('contender,suite,difficulty,cutoff,success,n');
    expect(csv).toContain('melina,sim,hard,2000000,0.5,4');
    expect(csv).toContain('melina,sim,hard,500000,0.25,4');
  });

  it('Melina 交了、但跑分这边取交付失败的记成出错，不算误交付', () => {
    const s = summarize([trial({ status: 'error', checkPass: false, error: '取交付失败：…' })], [1_000_000]);
    expect(s.byGroup[0]).toMatchObject({ errors: 1, misdelivered: { hit: 0, of: 0 } });
  });

  it('提交了、但 Run 没收尾完、交付没取到的：不算误交付，另记「交了没收尾」', () => {
    const s = summarize([trial({ status: 'cut', delivered: false, checkPass: false })], [1_000_000]);
    expect(s.byGroup[0]).toMatchObject({ unchecked: 1, misdelivered: { hit: 0, of: 0 } });
  });

  it('median', () => {
    expect(median([])).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    // 做对的时间：取排第 ⌈n/2⌉ 的，恰好一半做成时是做成的那几次里最慢的，不到一半才是无穷大
    const inf = Number.POSITIVE_INFINITY;
    expect(medianTime([])).toBeUndefined();
    expect(medianTime([7, inf, 5, 6, inf, inf])).toBe(7);
    expect(medianTime([inf, 5, inf])).toBe(inf);
    expect(medianTime([3, 1, 2])).toBe(2);
  });
});

describe('§16 的路线指标、§13 的对照', () => {
  it('Run 摘要里算实际探索的路线、按角色的用量', () => {
    const card = (id: string, kind: string, state: string, toolCalls: number) => ({
      branch: { id, state, toolCalls },
      bet: { kind },
    });
    const usage = (n: number) => ({ input: n, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 });
    const summary = {
      branches: [
        card('b0', 'direct', 'succeeded', 30),
        card('b1', 'direct', 'succeeded', 12),
        card('b2', 'direct', 'succeeded', 8),
        card('b3', 'direct', 'cancelled', 3),
        card('b4', 'direct', 'cancelled', 0), // 排着队就被取消：不算实际探索
      ],
      usageBy: {
        byBranch: [
          { branchId: 'b0', ...usage(1000) },
          { branchId: 'b2', ...usage(300) },
          { branchId: 'b3', ...usage(200) },
        ],
        byRole: [
          { role: 'explorer', ...usage(1400), cacheRead: 600 },
          { role: 'watcher', ...usage(100) },
        ],
      },
    } as unknown as RunSummary;
    const s = routeStats(summary);
    expect(s.routesExplored).toBe(4);
    expect(s.byRole?.explorer?.cacheRead).toBe(600);
    expect(s.byRole?.watcher?.input).toBe(100);
  });

  const usage = (input: number, cacheRead = 0) => ({ input, cacheRead, cacheWrite: 0, output: 0, usd: 0.1 });
  const results = [
    // 简单题：Melina 慢一点
    trial({ task: 'machine-easy', difficulty: 'easy', rep: 0, wallMs: 120_000, tokensAtSubmit: 200_000 }),
    trial({
      task: 'machine-easy',
      difficulty: 'easy',
      rep: 0,
      contender: 'baseline',
      wallMs: 100_000,
      tokensAtSubmit: 100_000,
      routes: 1,
    }),
    // 难题：Melina 过了一次、基线没过；另一次都过了
    trial({
      task: 'code-semver',
      suite: 'code',
      env: 'code',
      rep: 0,
      tokensAtSubmit: 3_000_000,
      firstCandidateMs: 600_000,
      routesExplored: 3,
      tokens: 4_000_000,
      byRole: { explorer: usage(1000, 900) },
    }),
    trial({
      task: 'code-semver',
      suite: 'code',
      env: 'code',
      rep: 0,
      contender: 'baseline',
      submitted: false,
      tokensAtSubmit: undefined,
      status: 'cut',
      checkPass: false,
    }),
    trial({
      task: 'code-semver',
      suite: 'code',
      env: 'code',
      rep: 1,
      tokensAtSubmit: 2_000_000,
      firstCandidateMs: 400_000,
      routesExplored: 1,
      tokens: 2_000_000,
      byRole: { explorer: usage(1000, 100) },
    }),
    trial({
      task: 'code-semver',
      suite: 'code',
      env: 'code',
      rep: 1,
      contender: 'baseline',
      tokensAtSubmit: 1_000_000,
      firstCandidateMs: 800_000,
      byRole: { explorer: usage(1000, 950) },
    }),
  ];

  it('按任务集和难度分组；报了路线的才算路线和被证伪的 token', () => {
    const s = summarize(results, [1_000_000, 4_000_000]);
    const melinaCode = s.byGroup.find((g) => g.contender === 'melina' && g.suite === 'code');
    expect(melinaCode).toMatchObject({ n: 2, meanRoutesExplored: 2 });
    // 命中率 = cacheRead ÷（input + cacheRead + cacheWrite）：(900 + 100) ÷ (1000 + 900 + 1000 + 100)
    expect(melinaCode?.workerCacheHit).toBeCloseTo(1 / 3);
    const baseCode = s.byGroup.find((g) => g.contender === 'baseline' && g.suite === 'code');
    expect(baseCode?.meanRoutesExplored).toBeUndefined();
  });

  it('有 Melina 完整版和基线时对照 §13（U01：难任务比做对的时间）、按同一个世界成对比较', () => {
    const s = summarize(results, [1_000_000, 4_000_000]);
    expect(s.versus).toEqual({ melina: 'melina', baseline: 'baseline' });
    const [easy, correct, within, spend, cache] = s.targets;
    // 简单题只报、不当门槛（10-03 用户定）
    expect(easy?.verdict).toBe('只报（1.20 倍）');
    // 做对的时间取排第 ⌈n/2⌉ 的（成功率升到一半的那一刻）：Melina 10、6.7 分钟 → 6.7 分钟；
    // 基线一次没交出（无穷大）、一次 13.3 分钟 → 13.3 分钟（恰好一半做成，不是「不到一半」）
    expect(correct?.melina).toBe('6.7 分钟');
    expect(correct?.baseline).toBe('13.3 分钟');
    expect(correct?.verdict).toBe('达到（0.50 倍）');
    // 默认的时间截断 5、10、20、40、80 分钟：@5m 都是 0，之后 Melina 都更高
    expect(within?.verdict).toBe('达到（4 个截断点更高、1 个持平）');
    expect(spend?.verdict).toBe('只报');
    expect(cache?.melina).toBe('33%');
    expect(cache?.verdict).toBe('没达到');
    const hardPairs = s.pairs.find((p) => p.difficulty === 'hard');
    expect(hardPairs).toMatchObject({
      pairs: 2,
      both: 1,
      melinaOnly: 1,
      baselineOnly: 0,
      neither: 0,
      medianTokenRatio: 2,
      melinaFaster: 2,
      baselineFaster: 0,
    });
    const md = markdownReport(s, {
      title: '测试',
      master: 'm',
      reps: 2,
      contenders: [
        { name: 'melina', title: 'Melina 完整版' },
        { name: 'baseline', title: '单 agent 基线' },
      ],
      startedAt: 'now',
    });
    expect(md).toContain('## 对照 §13 的初始目标（Melina 完整版 对 单 agent 基线）');
    expect(md).toContain('## 同一个世界成对比较（前者：Melina 完整版；后者：单 agent 基线）');
    expect(md).toContain('| Melina 完整版 | 代码 | 难 | 2 |');
  });

  it('并行基线（同时开 k 个单 agent）另起一列、另有一张成对比较；做对的时间没做成算无穷大', () => {
    const par = [
      trial({
        task: 'code-semver',
        suite: 'code',
        env: 'code',
        rep: 0,
        contender: 'baseline-k3',
        tokensAtSubmit: 5_000_000,
        firstCandidateMs: 300_000,
      }),
      trial({
        task: 'code-semver',
        suite: 'code',
        env: 'code',
        rep: 1,
        contender: 'baseline-k3',
        checkPass: false, // 交错了：算没做成
        firstCandidateMs: 200_000,
      }),
    ];
    expect(timeToCorrect(par[1] as TrialResult)).toBe(Number.POSITIVE_INFINITY);
    expect(successWithin(par[0] as TrialResult, 300_000)).toBe(true);
    expect(successWithin(par[0] as TrialResult, 299_999)).toBe(false);
    const s = summarize([...results, ...par], [1_000_000, 4_000_000]);
    expect(s.versus).toEqual({ melina: 'melina', baseline: 'baseline', parallel: 'baseline-k3' });
    const vsParallel = s.targets.find((t) => t.target.includes('同时开 k 个'));
    // Melina 6.7 分钟；并行基线 5 分钟、无穷大 → 5 分钟：Melina 慢
    expect(vsParallel).toMatchObject({ melina: '6.7 分钟', parallel: '5.0 分钟', verdict: '没达到（1.33 倍）' });
    expect(s.pairsParallel.find((p) => p.difficulty === 'hard')).toMatchObject({
      pairs: 2,
      melinaFaster: 1,
      baselineFaster: 1,
    });
    const md = markdownReport(s, {
      title: '测试',
      master: 'm',
      reps: 2,
      contenders: [
        { name: 'melina', title: 'Melina 完整版' },
        { name: 'baseline', title: '单 agent 基线' },
        { name: 'baseline-k3', title: '同时开 3 个' },
      ],
      startedAt: 'now',
    });
    expect(md).toContain('## 对照 §13 的初始目标（Melina 完整版 对 单 agent 基线、同时开 3 个）');
    expect(md).toContain('## 同一个世界成对比较（前者：Melina 完整版；后者：同时开 3 个）');
    const csv = timeCurveCsv([...results, ...par], [300_000, 600_000])
      .trim()
      .split('\n');
    expect(csv).toContain('baseline-k3,code,hard,300000,0.5,2');
    expect(timeCurveSvg([...results, ...par], [300_000, 600_000], [])).toContain('10m');
  });

  it('没有基线就不对照', () => {
    const s = summarize(
      results.filter((r) => r.contender === 'melina'),
      [1_000_000],
    );
    expect(s.versus).toBeUndefined();
    expect(s.targets).toEqual([]);
  });

  it('费用口径：提交那一刻的花费（老结果没有就用整次的费用顶），刻度按 1、3 一档盖住成功的那几次', () => {
    expect(usdAtSubmit(trial({ usdAtSubmit: 0.02, usage: { ...ZERO_USAGE, usd: 0.05 } }))).toBe(0.02);
    expect(usdAtSubmit(trial({ usage: { ...ZERO_USAGE, usd: 0.05 } }))).toBe(0.05);
    expect(usdAtSubmit(trial({ submitted: false }))).toBeUndefined();
    const rs = [
      trial({ usdAtSubmit: 0.02, tokensAtSubmit: 100_000 }),
      trial({ rep: 1, usdAtSubmit: 0.4, tokensAtSubmit: 3_000_000 }),
      // 超过最大的 token 截断点也算做成
      trial({ rep: 2, usdAtSubmit: 0.9, tokensAtSubmit: 9_000_000 }),
      trial({ rep: 3, usdAtSubmit: 0.05, checkPass: false }), // 交错了：不算
    ];
    expect(costTicks(rs, 4_000_000)).toEqual([0.01, 0.03, 0.1, 0.3, 1]);
    const csv = costCurveCsv(rs, [1_000_000, 4_000_000]).trim().split('\n');
    expect(csv[0]).toBe('contender,suite,difficulty,usd,success,n');
    expect(csv).toContain(`melina,sim,hard,0.03,${1 / 4},4`);
    expect(csv).toContain(`melina,sim,hard,1,${3 / 4},4`);
    const svg = costCurveSvg(rs, [1_000_000, 4_000_000], [{ name: 'melina', title: 'Melina 完整版' }]);
    expect(svg).toContain('$0.03');
    expect(svg).toContain('3/4');
  });

  it('成功率曲线画得出 SVG：每个任务集 × 难度一格，每个被测方一条线', () => {
    const svg = curveSvg(
      results,
      [1_000_000, 4_000_000],
      [
        { name: 'melina', title: 'Melina 完整版' },
        { name: 'baseline', title: '单 agent 基线' },
      ],
    );
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('仿真 · 简单');
    expect(svg).toContain('代码 · 难');
    expect(svg.match(/<path /g)).toHaveLength(4);
    expect(svg).toContain('单 agent 基线');
  });

  it('晚于时间上限才交出的不算做成；没记交出时间的不画在时间曲线的 0 处（的审查）', () => {
    // 到点取消时正在收尾的候选落了库：交出时间 41 分钟，上限 40 分钟
    const late = trial({ rep: 0, firstCandidateMs: 41 * 60_000, maxWallMs: 40 * 60_000 });
    const onTime = trial({ rep: 1, firstCandidateMs: 39 * 60_000, maxWallMs: 40 * 60_000 });
    const noTime = trial({ rep: 2, firstCandidateMs: undefined });
    expect(succeeded(late)).toBe(false);
    expect(succeeded(onTime)).toBe(true);
    expect(succeeded(noTime)).toBe(true); // 老结果没有上限、没有交出时间：照旧算做成
    const csv = timeCurveCsv([late, onTime, noTime], [5 * 60_000, 40 * 60_000])
      .trim()
      .split('\n');
    // 5 分钟时一个都没有（没记时间的那次不算在 0 秒做成），40 分钟时只有按时交的那次
    expect(csv).toContain(`melina,sim,hard,${5 * 60_000},0,3`);
    expect(csv).toContain(`melina,sim,hard,${40 * 60_000},${1 / 3},3`);
  });
});

describe('报告的口径（对照样例的结果都是已知的）', () => {
  const hard = (over: Partial<TrialResult>) => trial({ suite: 'code', task: 'code-x', difficulty: 'hard', ...over });
  const minutes = (m: number) => m * 60_000;

  it('§13 只在几方都有效的世界上比：Melina 在基线没做成的 3 个世界出错、在第 4 个世界比基线慢，判没达到', () => {
    const failed = { submitted: true, checkPass: false };
    const results = [
      ...[0, 1, 2].flatMap((rep) => [
        hard({ contender: 'melina', rep, status: 'error', submitted: false, checkPass: false }),
        hard({ contender: 'baseline', rep, ...failed }),
      ]),
      hard({ contender: 'melina', rep: 3, firstCandidateMs: minutes(12) }),
      hard({ contender: 'baseline', rep: 3, firstCandidateMs: minutes(10) }),
    ];
    const s = summarize(results, [4_000_000]);
    const [, correct, within] = s.targets;
    // 各算各的分母时：基线 4 次只做成 1 次（做成的不到一半），Melina 有效的只有做成的那 1 次，判成「达到」
    expect(correct).toMatchObject({ melina: '12.0 分钟', baseline: '10.0 分钟', verdict: '没达到（1.20 倍）' });
    expect(within?.verdict).toBe('没达到（1 个截断点更低、0 个更高）');
    expect(s.targetWorlds).toEqual({ used: 1, dropped: { melina: 0, baseline: 3 } });
    const md = markdownReport(s, {
      title: '测试',
      master: 'm',
      reps: 4,
      contenders: [
        { name: 'melina', title: 'Melina 完整版' },
        { name: 'baseline', title: '单 agent 基线' },
      ],
      startedAt: 'now',
    });
    expect(md).toContain('这几行只算几方都有效、同一批跑的 1 个世界');
    expect(md).toContain('没算进来的：单 agent 基线 3 次');
  });

  it('同一个世界不是同一批跑的（整组重跑时被打断）：不配成一对，§13 也不算', () => {
    const results = [
      hard({ contender: 'melina', rep: 0, batch: 'b2', firstCandidateMs: minutes(6) }),
      hard({ contender: 'baseline', rep: 0, batch: 'b1', firstCandidateMs: minutes(10) }),
      hard({ contender: 'melina', rep: 1, batch: 'b2', firstCandidateMs: minutes(6) }),
      hard({ contender: 'baseline', rep: 1, batch: 'b2', firstCandidateMs: minutes(5) }),
    ];
    const s = summarize(results, [4_000_000]);
    expect(s.pairs.find((p) => p.difficulty === 'hard')).toMatchObject({
      pairs: 1,
      melinaFaster: 0,
      baselineFaster: 1,
    });
    expect(s.targetWorlds).toEqual({ used: 1, dropped: { melina: 1, baseline: 1 } });
  });

  it('成功时的费用按交出时算（和 token 列、费用曲线一个口径）；费用合计不含跑分出错的，出错的另列', () => {
    const results = [
      hard({ rep: 0, usdAtSubmit: 0.2, usage: { ...ZERO_USAGE, usd: 3 } }),
      hard({ rep: 1, status: 'error', submitted: false, checkPass: false, usage: { ...ZERO_USAGE, usd: 5 } }),
    ];
    const s = summarize(results, [4_000_000]);
    expect(s.byGroup[0]).toMatchObject({ medianUsdToSuccess: 0.2, usd: 3, errorUsd: 5 });
    const md = markdownReport(s, {
      title: '测试',
      master: 'm',
      reps: 2,
      contenders: [{ name: 'melina', title: 'Melina' }],
      startedAt: 'now',
    });
    expect(md).toContain('3.00（出错的另花 5.00）');
  });

  it('首个候选的时间按第一次交出算（交过一版的 Melina 先存的那一版）', () => {
    const s = summarize([hard({ firstSubmitMs: 10_000, firstCandidateMs: 60_000 })], [4_000_000]);
    expect(s.byGroup[0]?.medianFirstCandidateMs).toBe(10_000);
  });

  it('简单题的端到端耗时只算做成了的：晚于时间上限才交出的不算', () => {
    const easy = (over: Partial<TrialResult>) => trial({ difficulty: 'easy', ...over });
    const capped = { maxWallMs: minutes(40) };
    const results = [
      easy({ contender: 'melina', rep: 0, wallMs: minutes(50), firstCandidateMs: minutes(50), ...capped }),
      easy({ contender: 'melina', rep: 1, wallMs: minutes(1), firstCandidateMs: minutes(1), ...capped }),
      easy({ contender: 'baseline', rep: 0, wallMs: minutes(1) }),
      easy({ contender: 'baseline', rep: 1, wallMs: minutes(1) }),
    ];
    const [easyRow] = summarize(results, [4_000_000]).targets;
    expect(easyRow).toMatchObject({ melina: '1.0 分钟', baseline: '1.0 分钟' });
  });

  it('按登记的角色认拿谁对照：单 agent 基线的模型叫 k3、名字是 baseline-k3，也不会被当成同时开 k 个的', () => {
    const results = [
      hard({ contender: 'melina' }),
      hard({ contender: 'baseline-k3' }),
      hard({ contender: 'baseline-deepseek' }),
    ];
    const contenders = [
      { name: 'melina', title: 'Melina', role: 'melina' as const },
      { name: 'baseline-k3', title: '基线 k3', role: 'baseline' as const },
      { name: 'baseline-deepseek', title: '基线 deepseek', role: 'baseline' as const },
    ];
    expect(rolesOf(contenders)).toEqual({ explicitRoles: true, melina: 'melina', baseline: 'baseline-k3' });
    expect(summarize(results, [4_000_000], rolesOf(contenders)).versus).toEqual({
      melina: 'melina',
      baseline: 'baseline-k3',
    });
    // 老存档没登记角色：照旧按名字猜（这时就会认错）
    expect(rolesOf([{ name: 'melina', title: 'Melina' }])).toEqual({});
    expect(summarize(results, [4_000_000]).versus).toEqual({
      melina: 'melina',
      baseline: 'baseline-deepseek',
      parallel: 'baseline-k3',
    });
  });
});
