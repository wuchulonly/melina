// 几个要从 RunStore 拼的 HTTP 返回：GET /runs、GET /runs/:id、GET /runs/:id/result。
// 只用 RunStoreQueries 接口，不碰 SQLite；HTTP 层直接用，假后端的参考实现 test/fixtures/project.ts 和它一致。

import type { RunListItem, RunResultResponse, RunSummary } from '../core/api.ts';
import type { Id } from '../core/ids.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import { ENDED_RUN_STATUSES, type Run, type RunStatus } from '../core/types.ts';

/** GET /runs：新的在前 */
export function runList(q: RunStoreQueries): RunListItem[] {
  return q.listRuns().map((run) => ({
    id: run.id,
    statement: run.goal.statement,
    status: run.status,
    mode: run.mode,
    ...(run.goal.domain ? { domain: run.goal.domain } : {}),
    workspace: run.workspace.root,
    createdAt: run.createdAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    usage: q.usageTotals(run.id),
    ...optional('outcome', outcomeOf(q, run)),
  }));
}

/** 结束了的 Run 的一句结果：交付的候选的结论，没交付就是结束原因 */
function outcomeOf(q: RunStoreQueries, run: Run): string | undefined {
  if (!(ENDED_RUN_STATUSES as readonly RunStatus[]).includes(run.status)) return undefined;
  const id = run.result?.candidateId;
  const candidate = id ? q.getRecord(id) : undefined;
  if (candidate?.kind === 'candidate') return candidate.record.claim;
  return run.endReason;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** GET /runs/:id：模式、状态、领域、完成标准（都在 run 里）、分支卡片、候选、用量 */
export function runSummary(q: RunStoreQueries, runId: Id): RunSummary | undefined {
  const run = q.getRun(runId);
  if (!run) return undefined;
  const lastSeq = q.lastSeq();
  const branches = q.listBranches(runId).flatMap((branch) => {
    const bet = q.getBet(branch.betId);
    return bet ? [{ branch, bet }] : [];
  });
  return {
    run,
    branches,
    candidates: q.candidates(runId),
    usage: q.usageTotals(runId),
    usageBy: q.usageBreakdown(runId),
    lastSeq,
  };
}

/** GET /runs/:id/result：结束了才有（没结束返回 undefined，HTTP 层回 conflict） */
export function runResult(q: RunStoreQueries, runId: Id): RunResultResponse | undefined {
  const run = q.getRun(runId);
  if (!run?.result || !(ENDED_RUN_STATUSES as readonly RunStatus[]).includes(run.status)) return undefined;
  const result = run.result;
  const candidate = result.candidateId ? q.candidates(runId).find((c) => c.id === result.candidateId) : undefined;
  return {
    runId,
    status: run.status,
    ...(run.endReason ? { endReason: run.endReason } : {}),
    ...(candidate ? { candidate } : {}),
    ...(result.branch ? { branch: result.branch } : {}),
    ...(result.patch ? { patch: result.patch } : {}),
    unfinished: !candidate && result.patch !== undefined,
    ...(candidate?.artifact && candidate.artifactPath
      ? { artifact: { handle: candidate.artifact, path: candidate.artifactPath } }
      : {}),
    knowledgeReport: result.knowledgeReport,
  };
}
