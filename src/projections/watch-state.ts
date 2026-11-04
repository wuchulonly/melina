import type { Id } from '../core/ids.ts';
import type { WatchRequest } from '../core/interfaces/context.ts';
import type { RunStoreQueries, StoreRecord } from '../core/interfaces/store.ts';
import { issues } from '../core/validate.ts';
import { WATCH_INPUT, WatchPlatform } from '../core/watch-input.ts';
import { platformObservations, stateObservations } from './read-model.ts';

/** 阅读状态与唤醒信号分开：验收反馈、实例换代通知和扩展状态可读，但不打断观察冷却。 */
export function isWatchHint(q: RunStoreQueries, branchId: Id, record: StoreRecord): boolean {
  if (!isWatchState(q, branchId, record)) return false;
  const input = record.kind === 'inbox' && record.record.ref ? q.getRecord(record.record.ref) : record;
  return (
    input?.kind === 'input' &&
    !input.record.acceptance &&
    !input.record.text.includes('宿主平台验收反馈（不是新的解题 hint）') &&
    !input.record.text.includes('宿主实测事实：本题实例已更换')
  );
}

/** 只信结构化宿主验收；最新有效版本仍有剩余目标时允许继续观察。 */
export function watchTaskComplete(q: RunStoreQueries, runId: Id, branchId: Id): boolean {
  const input = q.humanInputs(runId).findLast((input) => input.acceptance);
  const accepted = !!input?.acceptance && input.acceptance.accepted >= input.acceptance.total;
  for (const o of platformObservations(q, runId, branchId, q.lastSeq(), new Set())) {
    if (issues(WatchPlatform, o.args).length) continue;
    if (input && input.seq > o.seq) return accepted;
    return (o.args as WatchPlatform).remaining === 0;
  }
  return accepted;
}

/** 只有这些状态材料可以越过历史水位；执行、HTTP 和发言仍走连续历史。 */
export function isWatchState(q: RunStoreQueries, branchId: Id, record: StoreRecord): boolean {
  if (record.kind === 'observation') {
    const o = record.record;
    return (
      o.branchId === branchId &&
      o.role === 'watcher' &&
      [WATCH_INPUT.platform, WATCH_INPUT.receipt, WATCH_INPUT.extension].some((tool) => tool === o.tool)
    );
  }
  if (record.kind === 'inbox')
    return (
      record.record.branchId === branchId && !!record.record.ref && q.getRecord(record.record.ref)?.kind === 'input'
    );
  return record.kind === 'input' && q.isVisible({ kind: 'branch', branchId }, record.record.id);
}

/** 新提示保留全部，平台/扩展状态只取各来源最新版本；回执保留可引用的独立身份。 */
export function freezeWatchState(
  q: RunStoreQueries,
  runId: Id,
  request: WatchRequest,
  untilSeq: number,
): NonNullable<WatchRequest['state']> {
  const since = request.previous?.stateSeq ?? request.previous?.basedOnSeq ?? 0;
  const latest = new Map<string, Id>();
  const refs = new Set<Id>();
  const viewer = { kind: 'branch' as const, branchId: request.branchId };
  const records: StoreRecord[] = [
    ...stateObservations(q, runId, request.branchId, untilSeq).map((record) => ({
      kind: 'observation' as const,
      record,
    })),
    ...q
      .inbox(request.branchId, since)
      .filter((record) => record.runId === runId && record.seq <= untilSeq)
      .map((record) => ({ kind: 'inbox' as const, record })),
  ];
  records.sort((a, b) => a.record.seq - b.record.seq);
  for (const r of records) {
    if (!q.isVisible(viewer, r.record.id) || !isWatchState(q, request.branchId, r)) continue;
    if (r.kind === 'observation') {
      const o = r.record;
      if (o.tool === WATCH_INPUT.receipt) refs.add(o.id);
      else
        latest.set(
          `${o.tool}:${JSON.stringify(o.args && typeof o.args === 'object' && 'extension' in o.args ? o.args.extension : '')}`,
          o.id,
        );
    } else if (r.kind === 'inbox' && r.record.seq > since) {
      refs.add(r.record.id);
      if (r.record.ref) refs.add(r.record.ref);
    }
  }
  for (const id of latest.values()) refs.add(id);
  const branch = q.getBranch(request.branchId);
  const run = q.getRun(runId);
  return {
    untilSeq,
    refs: [...refs],
    ...(branch
      ? {
          activity: {
            toolCalls: branch.toolCalls,
            episode: branch.episode,
            state: branch.state,
            queued: branch.queued,
          },
        }
      : {}),
    ...(run ? { task: { status: run.status, mode: run.mode } } : {}),
  };
}
