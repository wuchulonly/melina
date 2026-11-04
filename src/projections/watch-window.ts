import type { WatchLag } from '../core/api.ts';
import type { MelinaEvent } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { WatchRequest } from '../core/interfaces/context.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import { countsAsToolCall } from '../core/tools.ts';
import type { Branch, WatchNote } from '../core/types.ts';
import { WATCH_STATE_BYTES } from '../core/watch-budget.ts';
import { WATCH_INPUT } from '../core/watch-input.ts';
import { windowEvents } from './read-model.ts';
import { freezeWatchState, isWatchHint, isWatchState } from './watch-state.ts';

const MATERIAL_TYPES = [
  'observation.created',
  'candidate.created',
  'inbox.created',
  'input.created',
  'episode.closed',
  'run.recovered',
] as const;

function isWindowMaterial(q: RunStoreQueries, branchId: Id, event: MelinaEvent): boolean {
  if (event.type === 'episode.closed') return event.data.branchId === branchId;
  if (event.type === 'run.recovered') return true;
  if (!('id' in event.data) || !q.isVisible({ kind: 'branch', branchId }, event.data.id)) return false;
  if (event.type === 'observation.created')
    return (
      event.data.branchId === branchId &&
      (event.data.role === 'explorer' ||
        (event.data.role === 'watcher' && (Object.values(WATCH_INPUT) as string[]).includes(event.data.tool)))
    );
  return true;
}

function isBacklogMaterial(q: RunStoreQueries, branchId: Id, event: MelinaEvent): boolean {
  if (!isWindowMaterial(q, branchId, event)) return false;
  switch (event.type) {
    case 'observation.created':
      return true;
    case 'inbox.created':
      return !!event.data.ref && q.getRecord(event.data.ref)?.kind === 'input';
    default:
      return false;
  }
}

export function watchBacklog(
  q: RunStoreQueries,
  branch: Branch,
  seenSeq: number,
  seenTools: number,
  stateSeq = seenSeq,
) {
  let firstUnreadAt: string | undefined;
  let hintSeq = 0;
  for (const event of windowEvents(q, {
    runId: branch.runId,
    branchId: branch.id,
    since: Math.min(seenSeq, stateSeq),
    types: ['observation.created', 'inbox.created'],
  })) {
    if (!isBacklogMaterial(q, branch.id, event)) continue;
    const record = 'id' in event.data ? q.getRecord(event.data.id) : undefined;
    const state = record && isWatchState(q, branch.id, record);
    if (event.seq > seenSeq || (state && event.seq > stateSeq)) firstUnreadAt ??= event.at;
    if (record && event.seq > stateSeq && isWatchHint(q, branch.id, record)) hintSeq = Math.max(hintSeq, event.seq);
  }
  return { unread: branch.toolCalls > seenTools || firstUnreadAt !== undefined, firstUnreadAt, hintSeq };
}

export function watchLag(
  q: RunStoreQueries,
  branch: Branch,
  note: Pick<WatchNote, 'basedOnSeq' | 'toolCalls'>,
  now: number,
  backlog = watchBacklog(q, branch, note.basedOnSeq, note.toolCalls),
): WatchLag {
  let coveredAt: string | undefined;
  for (const event of windowEvents(q, {
    runId: branch.runId,
    branchId: branch.id,
    until: note.basedOnSeq,
    reverse: true,
    types: MATERIAL_TYPES,
  })) {
    if (!isWindowMaterial(q, branch.id, event)) continue;
    coveredAt = event.at;
    break;
  }
  const age = (at: string) => Math.max(0, Math.round(now - Date.parse(at)));
  return {
    lagTools: Math.max(0, branch.toolCalls - note.toolCalls),
    backlogAgeMs: backlog.firstUnreadAt ? age(backlog.firstUnreadAt) : 0,
    ...(backlog.firstUnreadAt ? { firstUnreadAt: backlog.firstUnreadAt } : {}),
    ...(coveredAt ? { coveredAt, coveredAgeMs: age(coveredAt) } : {}),
  };
}

/** 连续前缀窗口：绝不跳到最近 N 条；宿主采集完成后只冻结一次。 */
export function freezeWatchWindow(q: RunStoreQueries, runId: Id, request: WatchRequest, latest: number): WatchRequest {
  const since = request.previous?.basedOnSeq ?? 0;
  let untilSeq = latest;
  let steps = 0;
  let materials = 0;
  let bytes = 0;
  for (const event of windowEvents(q, {
    runId,
    branchId: request.branchId,
    since,
    until: latest,
    types: MATERIAL_TYPES,
  })) {
    if (!isWindowMaterial(q, request.branchId, event)) continue;
    const step =
      event.type === 'observation.created' && event.data.branchId === request.branchId && countsAsToolCall(event.data);
    const size = estimatedBytes(event);
    const limit = request.window;
    if (
      limit &&
      materials > 0 &&
      ((step && steps >= limit.maxSteps) || materials >= limit.maxSteps * 4 || bytes + size > limit.maxBytes)
    ) {
      untilSeq = event.seq - 1;
      break;
    }
    materials++;
    bytes += size;
    if (step) steps++;
  }
  const toolCalls = (request.previous?.toolCalls ?? 0) + steps;
  // Branch.toolCalls 是当前水位；截窗后不能把未来的工具数和 episode 带进旧窗口。
  const activity = windowEvents(q, {
    runId,
    branchId: request.branchId,
    until: untilSeq,
    reverse: true,
    types: ['branch.created', 'branch.updated'],
  }).next().value;
  const branch =
    activity && (activity.type === 'branch.created' || activity.type === 'branch.updated') ? activity.data : undefined;
  return {
    ...request,
    state: freezeWatchState(q, runId, request, latest),
    untilSeq,
    toolCalls,
    ...(branch ? { activity: { toolCalls, episode: branch.episode, state: branch.state, queued: branch.queued } } : {}),
  };
}

/** 概览量的保守估算；原始工具输出按摘要上限估，人的长提示仍按全文计。单条超限保留，首屏摘要与按引用读取的原文分开计量。 */
function estimatedBytes(event: MelinaEvent): number {
  if (event.type === 'observation.created' && event.data.role === 'watcher')
    return (
      (event.data.tool === WATCH_INPUT.platform || event.data.tool === WATCH_INPUT.extension
        ? WATCH_STATE_BYTES
        : 512) + 256
    );
  if (event.type === 'observation.created' && event.data.role === 'explorer') {
    const o = event.data;
    return (
      Buffer.byteLength(
        JSON.stringify({
          tool: o.tool,
          args: JSON.stringify(o.args ?? {}).slice(0, 400),
          expect: o.expect?.slice(0, 300),
          summary: o.summary.slice(0, o.tool === WATCH_INPUT.speech ? 4000 : 1600),
        }),
        'utf8',
      ) + 256
    );
  }
  return Buffer.byteLength(JSON.stringify(event.data), 'utf8') + 128;
}
