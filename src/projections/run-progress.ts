import type { RunProgress } from '../core/api.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import { countsAsToolCall } from '../core/tools.ts';
import type { Run, WatchNote } from '../core/types.ts';
import { bet0WatchEnabled } from './bet0.ts';
export function runProgress(q: RunStoreQueries, run: Run, now = Date.now() / 1000): RunProgress {
  const history = q.events({ runId: run.id, since: 0 });
  const branches = q.listBranches(run.id);
  const live = branches.filter((b) => b.state === 'running' || b.state === 'starting');
  const liveIds = new Set(live.map((b) => b.id));
  const watched = live.filter((b) => bet0WatchEnabled(q, run, b.betId));
  const watchedIds = new Set(watched.map((b) => b.id));
  const result: RunProgress = {
    runId: run.id,
    sampledAt: now,
    windowSeconds: 600,
    lastSeq: history.at(-1)?.seq ?? run.seq,
    branchesCount: branches.length,
    activeBranches: live.filter((b) => b.state === 'running' && !b.queued).length,
    queuedBranches: live.filter((b) => b.state === 'starting' || b.queued).length,
    recentBranches: 0,
    lastBranchAt: null,
    episodesCount: 0,
    recentEpisodes: 0,
    episodesSinceProgress: 0,
    toolCallsCount: 0,
    recentToolCalls: 0,
    toolCallsSinceProgress: 0,
    goalProgressSeq: 0,
    lastGoalProgressAt: null,
    lastGoalProgressKind: null,
    candidatesCount: q.candidates(run.id).length,
    observer: null,
    ...(run.goal.profile ? { profile: run.goal.profile } : {}),
  };
  const recent = (at: number) => Number.isFinite(at) && at >= now - 600 && at <= now;
  const latest = (before: number | null, at: number) =>
    Number.isFinite(at) && at <= now ? Math.max(before ?? 0, at) : before;
  const notes = new Map<string, { note: WatchNote; at: number }>();
  const semantic = new Map<string, NonNullable<RunProgress['semantic']>[number]>();
  const observations = new Map<string, number>();
  const accepted = new Map<string, number>();
  for (const e of history) {
    const at = Date.parse(e.at) / 1000;
    let progress: false | 'record' | 'acceptance' = false;
    if (e.type === 'input.created' && e.data.acceptance) {
      const a = e.data.acceptance;
      if (a.accepted > (accepted.get(a.task) ?? 0)) {
        accepted.set(a.task, a.accepted);
        progress = 'acceptance';
      }
    }
    if (e.type === 'candidate.created' && !e.data.interim) progress = 'record';
    if (progress) {
      result.goalProgressSeq = e.seq;
      result.lastGoalProgressAt = latest(null, at);
      result.lastGoalProgressKind = progress;
      result.toolCallsSinceProgress = 0;
      result.episodesSinceProgress = 0;
    }
    if (e.type === 'branch.created') {
      result.lastBranchAt = latest(result.lastBranchAt, at);
      if (recent(at)) result.recentBranches++;
    }
    if (e.type === 'episode.closed') {
      result.episodesCount++;
      result.episodesSinceProgress++;
      if (recent(at)) result.recentEpisodes++;
    }
    if (e.type === 'observation.created' && countsAsToolCall(e.data)) {
      result.toolCallsCount++;
      result.toolCallsSinceProgress++;
      observations.set(e.data.id, at);
      if (recent(at)) result.recentToolCalls++;
    }
    if (e.type === 'watch.noted') {
      if (watchedIds.has(e.data.branchId)) notes.set(e.data.branchId, { note: e.data, at });
      if (e.data.telemetry && Number.isFinite(at) && at <= now) {
        semantic.set(e.data.branchId, {
          ...e.data.telemetry,
          source: 'observer',
          branchId: e.data.branchId,
          branchActive: liveIds.has(e.data.branchId),
          reportedAt: at,
          basedOnSeq: e.data.basedOnSeq,
        });
        if (e.data.telemetry.profile) result.profile = e.data.telemetry.profile;
      } else if (e.data.telemetry === null && Number.isFinite(at) && at <= now) semantic.delete(e.data.branchId);
    }
  }
  if (notes.size > 0) {
    const observer: NonNullable<RunProgress['observer']> = {
      branchesObserved: notes.size,
      branchesUnobserved: watched.length - notes.size,
      lastNoteAt: null,
      oldestNoteAt: null,
      lagToolCalls: 0,
      untried: 0,
      trying: 0,
      works: 0,
      failed: 0,
      unclear: 0,
      recentAttempts: 0,
    };
    for (const branch of watched) {
      const entry = notes.get(branch.id);
      if (!entry) continue;
      const { note, at } = entry;
      observer.lastNoteAt = latest(observer.lastNoteAt, at);
      if (Number.isFinite(at) && at <= now) observer.oldestNoteAt = Math.min(observer.oldestNoteAt ?? at, at);
      observer.lagToolCalls += Math.max(0, branch.toolCalls - note.toolCalls);
      for (const direction of note.directions) {
        if (direction.retired) continue;
        observer[direction.status]++;
        for (const attempt of direction.attempts) {
          if (!attempt.evidence.some((id) => recent(observations.get(id) ?? Number.NaN))) continue;
          observer.recentAttempts++;
        }
      }
    }
    result.observer = observer;
  }
  if (semantic.size) {
    result.semantic = [...semantic.values()]
      .sort((a, b) => b.reportedAt - a.reportedAt)
      .slice(0, 16)
      .map((report) => {
        let evidenceAt: number | null = null;
        for (const id of report.evidence) {
          const record = q.getRecord(id);
          if (!record || (record.kind === 'run' ? record.record.id : record.record.runId) !== run.id) continue;
          const event = q.events({ runId: run.id, since: record.record.seq - 1, limit: 1 })[0];
          if (event?.seq === record.record.seq) evidenceAt = latest(evidenceAt, Date.parse(event.at) / 1000);
        }
        return { ...report, evidenceAt };
      });
  }
  return result;
}
