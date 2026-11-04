import type { Id } from '../core/ids.ts';
import type { WatchContext, WatchRequest } from '../core/interfaces/context.ts';
import type { RunStoreQueries, StoreRecord } from '../core/interfaces/store.ts';
import { observationRef } from '../core/observation-ref.ts';
import { countsAsToolCall } from '../core/tools.ts';
import type { Observation } from '../core/types.ts';
import { WATCH_INPUT } from '../core/watch-input.ts';
import { isWatchState } from './watch-state.ts';

const EVIDENCE_KINDS = new Set(['observation', 'candidate', 'inbox', 'input']);

export interface WatchSnapshot {
  records: readonly StoreRecord[];
  stateRefs: ReadonlySet<Id>;
}

export function isWatchObservation(o: Observation, branchId: Id): boolean {
  if (o.branchId !== branchId) return false;
  return (
    o.role === 'explorer' ||
    (o.role === 'watcher' &&
      [WATCH_INPUT.platform, WATCH_INPUT.receipt, WATCH_INPUT.extension, WATCH_INPUT.http].some(
        (tool) => tool === o.tool,
      ))
  );
}

/** 数据层：切出可见记录；不读原文、不渲染、不处理草稿或覆盖进度。 */
export function freezeWatchSnapshot(q: RunStoreQueries, runId: Id, request: WatchRequest): WatchSnapshot {
  const records = new Map<Id, StoreRecord>();
  const stateRefsInWindow = new Set<Id>();
  const viewer = { kind: 'branch' as const, branchId: request.branchId };
  const stateRefs = new Set([...(request.state?.refs ?? []), ...(request.previous?.stateRefs ?? [])]);
  const stateUntil =
    request.state?.untilSeq ??
    Math.max(
      request.untilSeq,
      request.previous?.stateSeq ?? 0,
      ...(request.previous?.stateRefs ?? []).map((id) => q.getRecord(id)?.record.seq ?? 0),
    );
  for (const event of q.events({ runId: runId, since: 0 })) {
    if (event.seq > Math.max(request.untilSeq, stateUntil)) break;
    if (!('id' in event.data) || typeof event.data.id !== 'string') continue;
    const record = q.getRecord(event.data.id);
    if (!record || !EVIDENCE_KINDS.has(record.kind) || !q.isVisible(viewer, record.record.id)) continue;
    const state =
      stateRefs.has(record.record.id) && record.record.seq <= stateUntil && isWatchState(q, request.branchId, record);
    if (record.record.seq > request.untilSeq && !state) continue;
    if (state) stateRefsInWindow.add(record.record.id);
    if (record.kind === 'observation' && !isWatchObservation(record.record, request.branchId)) continue;
    records.set(record.record.id, structuredClone(record));
  }
  return { records: [...records.values()], stateRefs: stateRefsInWindow };
}

/** 巡检器使用稳定的观测短码，其他记录保留原身份。 */
export function watchRecordRef(record: StoreRecord): string {
  return record.kind === 'observation' ? observationRef(record.record.seq) : record.record.id;
}

/** 宿主按已展示摘要计算续读位置；这不是提交门禁，最新状态不跳过未展示的历史。 */
export function watchReadStatus(request: WatchRequest, input: WatchContext, seen = new Set(input.covered)) {
  const since = request.previous?.basedOnSeq ?? 0;
  const pending = input.history.reduce((first, seq) => (seen.has(seq) ? first : Math.min(first, seq)), Infinity);
  const untilSeq = pending === Infinity ? request.untilSeq : Math.max(since, pending - 1);
  const toolCalls =
    (request.previous?.toolCalls ?? 0) +
    input.records.filter(
      (r) =>
        r.kind === 'observation' &&
        r.record.branchId === request.branchId &&
        r.record.role === 'explorer' &&
        r.record.seq > since &&
        r.record.seq <= untilSeq &&
        countsAsToolCall(r.record),
    ).length;
  const stateRefs = new Set(input.stateRefs);
  const current = new Set(request.state?.refs);
  const complete = input.records.every(
    (r) => !current.has(r.record.id) || !stateRefs.has(r.record.id) || seen.has(r.record.seq),
  );
  return {
    baseRevision: request.previous?.rev ?? 0,
    window: { sinceSeq: since, untilSeq: request.untilSeq },
    progress: { coveredUntilSeq: untilSeq, toolCalls, complete: untilSeq === request.untilSeq },
    ...(request.state
      ? {
          state: {
            untilSeq: request.state.untilSeq,
            seenSeq: complete ? request.state.untilSeq : (request.previous?.stateSeq ?? since),
            complete,
          },
        }
      : {}),
  };
}
