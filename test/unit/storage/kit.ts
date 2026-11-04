// 持久化测试辅助：内存 SQLite、固定时钟与真实写入接口。
import { DEFAULT_RUN_CONFIG, type RunConfig } from '../../../src/core/config.ts';
import type { MelinaEvent } from '../../../src/core/events.ts';
import { handleOf, type Id, newId, type SnapshotId } from '../../../src/core/ids.ts';
import type { CloseEpisodeInput } from '../../../src/core/interfaces/store.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import type { Bet, BetDraft, BetSource, Branch, CompletionSpec, Observation, Run } from '../../../src/core/types.ts';
import { openRunStore, type RunStore } from '../../../src/storage/state.ts';

export const MODEL: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' };

export const COMPLETION: CompletionSpec = {
  interpretation: '按测试覆盖率算',
  criteria: ['覆盖率不低于 80%', '测试全过'],
  metric: { name: '覆盖率', unit: '%', better: 'higher', target: 80 },
};

export interface TestRunStore extends RunStore {
  /** 发出去的事件，按收到的顺序 */
  published: MelinaEvent[];
}

/** now：换掉固定的时钟（比如跟着运行时的假时钟走）；不给就从 10-02 零点起每次走一秒 */
export function testRunStore(options: { artifacts?: string; now?: () => Date } = {}): TestRunStore {
  let t = Date.parse('2026-10-02T00:00:00.000Z');
  const tick = () => {
    t += 1000;
    return new Date(t);
  };
  const runStore = openRunStore({
    db: ':memory:',
    now: options.now ?? tick,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
  });
  const published: MelinaEvent[] = [];
  runStore.bus.subscribe((e) => published.push(e));
  return Object.assign(runStore, { published });
}

export function newRun(
  runStore: RunStore,
  opts: { completion?: CompletionSpec | false; statement?: string; config?: Partial<RunConfig> } = {},
): Run {
  const id = newId();
  const run = runStore.writer.createRun({
    id,
    goal: { statement: opts.statement ?? '把 search 模块的测试覆盖率提到 80% 以上', constraints: [], materials: [] },
    workspace: { root: `/tmp/melina-test/${id}`, kind: 'dir-copy' },
    config: { ...DEFAULT_RUN_CONFIG, bet0: { models: [MODEL] }, ...opts.config },
    createdAt: '2026-10-02T00:00:00.000Z',
  });
  if (opts.completion === false) return run;
  return runStore.writer.draftCompletion(run.id, {
    completion: opts.completion ?? COMPLETION,
    constraints: [],
    domain: 'code',
  });
}

export function betDraft(over: Partial<BetDraft> = {}): BetDraft {
  return {
    kind: 'direct',
    label: '一条路',
    startFrom: { snapshot: 'root' },
    model: MODEL,
    ...over,
  };
}

/** 建 Bet 和分支，并让它开始跑（有容量、workspace 建好） */
export function startBranch(
  runStore: RunStore,
  run: Run,
  over: Partial<BetDraft> = {},
  opts: { source?: BetSource; parent?: Branch; start?: boolean } = {},
): { bet: Bet; branch: Branch } {
  const bet = runStore.writer.createBet({
    ...betDraft(over),
    runId: run.id,
    source: opts.source ?? { kind: 'template' },
  });
  let branch = runStore.writer.createBranch({
    runId: run.id,
    betId: bet.id,
    lastSnapshot: bet.startFrom.snapshot,
    ...(opts.parent ? { parentBranchId: opts.parent.id } : {}),
  });
  if (opts.start !== false) {
    branch = runStore.writer.updateBranch(branch.id, {
      state: 'running',
      queued: false,
      workspace: { path: `/tmp/melina-test/${run.id}/${branch.id}` },
    });
  }
  return { bet, branch };
}

export function observe(runStore: RunStore, branch: Branch | Id, summary = '跑了一下', counts = true): Observation {
  const b = typeof branch === 'string' ? (runStore.queries.getBranch(branch) as Branch) : branch;
  const current = runStore.queries.getBranch(b.id) as Branch;
  return runStore.writer.appendObservation(
    {
      runId: current.runId,
      branchId: current.id,
      episode: current.episode,
      role: 'explorer',
      tool: 'sh',
      args: { cmd: 'pnpm test' },
      summary,
      output: handleOf(summary),
      snapshot: current.lastSnapshot,
      exitCode: 0,
    },
    { countsAsToolCall: counts },
  );
}

let snapshotCounter = 0;
export function snapshotId(): SnapshotId {
  snapshotCounter++;
  return `snap-${String(snapshotCounter).padStart(4, '0')}-${newId().slice(-6).toLowerCase()}`;
}

/** 正常结束会话并保存快照与文字交接。 */
export function closeEpisode(runStore: RunStore, branch: Branch | Id, over: Partial<CloseEpisodeInput> = {}) {
  const b = runStore.queries.getBranch(typeof branch === 'string' ? branch : branch.id) as Branch;
  return runStore.writer.closeEpisode({
    branchId: b.id,
    episode: b.episode,
    outcome: 'ended',
    snapshot: { id: snapshotId() },
    seenSeq: runStore.queries.lastSeq(),
    handoff: '接着做',
    ...over,
  });
}
