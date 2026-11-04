// 有界读取的分页组合；索引能力由 RunStoreQueries.readModel 显式提供。
import type { EventType, MelinaEvent } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { EventWindow, RunStoreQueries, WatchEvent } from '../core/interfaces/store.ts';
import type { Observation } from '../core/types.ts';
import { WATCH_INPUT } from '../core/watch-input.ts';

type ReadQueries = Pick<RunStoreQueries, 'readModel'>;

export const LOCAL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'observation.created',
  'inbox.created',
  'candidate.created',
  'episode.closed',
  'branch.created',
  'branch.updated',
]);
export const STATE_TOOLS = [WATCH_INPUT.platform, WATCH_INPUT.receipt, WATCH_INPUT.extension];

export function watchEvents(q: ReadQueries, runId: Id, branchId: Id, until?: number, latest = false): WatchEvent[] {
  return q.readModel.watches(runId, branchId, until, latest);
}

export function stateObservations(q: ReadQueries, runId: Id, branchId: Id, until: number): Observation[] {
  return q.readModel.stateObservations(runId, branchId, until);
}

/** 最新的合法平台版本优先；格式不合的版本才继续往前翻。 */
export function* platformObservations(
  q: ReadQueries,
  runId: Id,
  branchId: Id,
  until: number,
  refs: ReadonlySet<Id>,
): Generator<Observation> {
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = q.readModel.platformObservations(runId, branchId, until, [...refs], before);
    yield* page;
    const last = page.at(-1);
    if (page.length < 32 || !last) return;
    before = last.seq;
  }
}

/** 有界分页，调用方找到覆盖点或填满窗口就停止；逆序分页用上页最后一条的 seq - 1 作上界。 */
export function* windowEvents(q: ReadQueries, window: EventWindow): Generator<MelinaEvent> {
  let bounds = window;
  for (;;) {
    const page = q.readModel.events(bounds, 128);
    yield* page;
    if (page.length < 128) return;
    const seq = page.at(-1)?.seq;
    if (seq === undefined) return;
    bounds = window.reverse ? { ...bounds, until: seq - 1 } : { ...bounds, since: seq };
  }
}
