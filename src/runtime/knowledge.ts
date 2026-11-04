import { watchMap } from '../context/watch.ts';
import type { Handle, Id, SnapshotId } from '../core/ids.ts';
import { ROOT } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { KnowledgeReportWriter } from '../core/interfaces/runtime.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import type { WorkspaceProviders } from '../core/interfaces/workspace.ts';
import type { Candidate, Run } from '../core/types.ts';
import { currentVersion, picksOf } from '../projections/versions.ts';
import { allWatchAttempts, latestWatch } from '../projections/watch.ts';
import { errorText } from './async.ts';
export interface KnowledgeDeps {
  queries: RunStoreQueries;
  artifacts: ArtifactStore;
  workspaces: WorkspaceProviders;
  log?: (text: string) => void;
}
export type Ending = { status: 'done' } | { status: 'cancelled' | 'failed'; reason: string };
export interface KnowledgeOptions {
  mainRoute?: Id | undefined;
  ending?: Ending;
  delivered?: Candidate | undefined;
  stopSnapshot?: SnapshotId | undefined;
}
export function mainRoute(q: RunStoreQueries, runId: Id): Id | undefined {
  const candidates = q.candidates(runId);
  const selected = candidates.find((c) => !c.interim) ?? currentVersion(candidates, picksOf(q, runId));
  if (selected) return selected.branchId;
  return [...q.listBranches(runId)].sort((a, b) => b.toolCalls - a.toolCalls || a.seq - b.seq)[0]?.id;
}
export class RuntimeKnowledgeReport implements KnowledgeReportWriter {
  private readonly deps: KnowledgeDeps;
  constructor(deps: KnowledgeDeps) {
    this.deps = deps;
  }
  async write(runId: Id, opts: KnowledgeOptions = {}): Promise<{ report: Handle; patch?: Handle }> {
    const q = this.deps.queries;
    const run = q.getRun(runId);
    if (!run) throw new Error('任务不存在');
    const ending =
      opts.ending ??
      (run.status === 'done' ? { status: 'done' } : { status: 'cancelled', reason: run.endReason ?? '任务停止' });
    const main = opts.mainRoute ?? mainRoute(q, runId);
    const tip = opts.stopSnapshot ?? (main ? q.getBranch(main)?.lastSnapshot : undefined);
    let patch: Handle | undefined;
    if (ending.status !== 'done' && !opts.delivered && tip && tip !== ROOT) {
      try {
        const h = await this.deps.workspaces.forRun(run).diffSnapshots(ROOT, tip);
        if ((await this.deps.artifacts.stat(runId, h))?.size) patch = h;
      } catch (e) {
        this.deps.log?.(`保存未完成改动失败：${errorText(e)}`);
      }
    }
    const report = await this.deps.artifacts.put(runId, renderReport(q, run, ending, opts.delivered));
    return { report, ...(patch ? { patch } : {}) };
  }
}
function renderReport(q: RunStoreQueries, run: Run, ending: Ending, delivered?: Candidate): string {
  const lines = [
    '# 任务记录',
    '',
    run.goal.statement,
    `开始：${run.createdAt}`,
    `结果：${ending.status === 'done' ? '已交付' : ending.reason}`,
  ];
  const candidate = delivered ?? q.candidates(run.id).find((c) => !c.interim);
  if (candidate) lines.push('', '## 交付说明', candidate.claim);
  for (const b of q.listBranches(run.id)) {
    const bet = q.getBet(b.betId);
    lines.push('', `## ${bet?.label ?? '路线'}`, `状态：${b.state}；环境调用 ${b.toolCalls} 次。`);
    const handoff = b.handoff ?? bet?.continuation?.handoff;
    if (handoff) lines.push(handoff);
    const watch = latestWatch(q, run.id, b.id);
    if (watch) {
      lines.push(watchMap(watch));
      for (const direction of watch.directions) {
        lines.push(`### ${direction.direction}`, direction.result);
        if (direction.doubt) lines.push(`疑点：${direction.doubt}`);
        for (const attempt of allWatchAttempts(direction)) {
          lines.push(`- ${attempt.action}：${attempt.result}`);
        }
      }
    }
    const latest = q.observations(b.id, { limit: 3, excludeWatcher: true }).items.reverse();
    for (const o of latest) lines.push(`- ${o.tool}：${o.summary}`);
  }
  for (const i of q.humanInputs(run.id)) lines.push('', `人或宿主补充：${i.text}`);
  return lines.join('\n');
}
