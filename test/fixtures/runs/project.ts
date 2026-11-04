import type { BranchDetail, RunListItem, RunResultResponse, RunSummary } from '../../../src/core/api.ts';
import { notFound } from '../../../src/core/errors.ts';
import { type MelinaEvent, ZERO_USAGE } from '../../../src/core/events.ts';
import type { Bet, Branch, Candidate, Observation, Run } from '../../../src/core/types.ts';

export function replay(events: readonly MelinaEvent[]) {
  const runs = new Map<string, Run>(),
    bets = new Map<string, Bet>(),
    branches = new Map<string, Branch>();
  const candidates: Candidate[] = [],
    observations: Observation[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'run.created':
      case 'run.updated':
      case 'completion.drafted':
        runs.set(e.data.id, e.data);
        break;
      case 'bet.created':
      case 'bet.updated':
        bets.set(e.data.id, e.data);
        break;
      case 'branch.created':
      case 'branch.updated':
        branches.set(e.data.id, e.data);
        break;
      case 'candidate.created':
        candidates.push(e.data);
        break;
      case 'observation.created':
        observations.push(e.data);
        break;
    }
  }
  return { runs, bets, branches, candidates, observations };
}
export function runSummary(events: readonly MelinaEvent[], runId: string): RunSummary {
  const state = replay(events),
    run = state.runs.get(runId);
  if (!run) throw notFound('没有这个任务');
  return {
    run,
    branches: [...state.branches.values()]
      .filter((b) => b.runId === runId)
      .map((branch) => ({ branch, bet: state.bets.get(branch.betId)! })),
    candidates: state.candidates.filter((c) => c.runId === runId),
    usage: ZERO_USAGE,
    lastSeq: events.at(-1)?.seq ?? 0,
  };
}
export function runList(events: readonly MelinaEvent[]): { runs: RunListItem[] } {
  return {
    runs: [...replay(events).runs.values()].map((run) => ({
      id: run.id,
      statement: run.goal.statement,
      status: run.status,
      mode: run.mode,
      workspace: run.workspace.root,
      createdAt: run.createdAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      usage: ZERO_USAGE,
    })),
  };
}
export function branchDetail(
  events: readonly MelinaEvent[],
  runId: string,
  branchId: string,
  cursor?: string,
  limit = 50,
): BranchDetail {
  const summary = runSummary(events, runId),
    card = summary.branches.find((c) => c.branch.id === branchId);
  if (!card) throw notFound('没有这条路线');
  const all = replay(events)
    .observations.filter(
      (o) => o.runId === runId && o.branchId === branchId && (cursor === undefined || o.seq < Number(cursor)),
    )
    .sort((a, b) => b.seq - a.seq);
  const items = all.slice(0, limit);
  return {
    ...card,
    observations: { items, ...(all.length > limit ? { next: String(items.at(-1)!.seq) } : {}) },
    lastSeq: summary.lastSeq,
  };
}
export function runResult(events: readonly MelinaEvent[], runId: string): RunResultResponse {
  const summary = runSummary(events, runId);
  if (!summary.run.result) throw notFound('任务还没有结果');
  return {
    runId,
    status: summary.run.status,
    unfinished: summary.run.status !== 'done',
    knowledgeReport: summary.run.result.knowledgeReport,
    ...(summary.run.result.candidateId
      ? { candidate: summary.candidates.find((c) => c.id === summary.run.result!.candidateId) }
      : {}),
  };
}
