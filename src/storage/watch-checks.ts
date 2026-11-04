// 巡检器的领域校验；Writer 在写事务内调用，校验通过后才追加版本与事件。
import { invalid } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import type { RunStoreQueries, WatchInput } from '../core/interfaces/store.ts';
import type { Branch, WatchNote } from '../core/types.ts';
import { latestWatch, mergeWatch, platformFlags, watchEvidence, watchExecutionIssues } from '../projections/watch.ts';
import { isWatchObservation } from '../projections/watch-snapshot.ts';
import { isWatchState } from '../projections/watch-state.ts';

export function prepareWatch(
  q: RunStoreQueries,
  input: WatchInput,
  branch: Branch,
  lastSeq: number,
  mustSee: (id: Id, what: string) => unknown,
): WatchNote {
  const previous = latestWatch(q, input.runId, branch.id);
  if (previous && input.basedOnSeq < previous.basedOnSeq) {
    throw invalid(`basedOnSeq ${input.basedOnSeq} 比上一版看到的（${previous.basedOnSeq}）还早`);
  }
  const body = mergeWatch(previous, input.draft);
  const state = input.state;
  if (
    state &&
    (state.untilSeq > lastSeq || state.seenSeq > state.untilSeq || state.seenSeq < (previous?.stateSeq ?? 0))
  )
    throw invalid('最新状态版本超出冻结边界或早于上一版');
  const stateRefs = new Set([...(previous?.stateRefs ?? []), ...(state?.refs ?? [])]);
  for (const id of stateRefs) {
    mustSee(id, '巡检器的最新状态');
    const record = q.getRecord(id);
    if (
      !record ||
      !isWatchState(q, branch.id, record) ||
      (state?.refs.includes(id) && record.record.seq > state.untilSeq)
    )
      throw invalid('最新状态只能引用冻结时可见的提示、宿主状态和回执');
  }
  const delivered = new Set([...(previous?.deliveredRefs ?? []), ...(input.delivered?.refs ?? [])]);
  if (input.delivered && input.delivered.untilSeq > lastSeq) throw invalid('证据展示边界超过最新记录');

  for (const id of delivered) {
    mustSee(id, '巡检器已展示的证据');
    const record = q.getRecord(id);
    if (
      !record ||
      (input.delivered?.refs.includes(id) && record.record.seq > input.delivered.untilSeq) ||
      (record.kind === 'observation' && !isWatchObservation(record.record, branch.id))
    )
      throw invalid('已展示证据超出冻结边界或分支');
  }
  const deliveredRefs = [...delivered].filter((id) => (q.getRecord(id)?.record.seq ?? 0) > input.basedOnSeq);
  const covered = (id: Id) =>
    (q.getRecord(id)?.record.seq ?? Infinity) <= input.basedOnSeq || stateRefs.has(id) || delivered.has(id);
  const flags = platformFlags(q, input.runId, branch.id, input.basedOnSeq, body, previous, stateRefs);
  if (flags.length) body.flags = flags;
  for (const id of watchEvidence(input.draft)) {
    mustSee(id, '巡检器的看法');
    if (!covered(id)) throw invalid('巡检器的看法引用了已覆盖窗口之后的记录');
    const record = q.getRecord(id);
    if (record?.kind === 'observation' && !isWatchObservation(record.record, branch.id))
      throw invalid('巡检器的看法引用了冻结窗口外或不支持的观测');
  }
  const errors = watchExecutionIssues(input.draft, (id) => {
    const record = q.getRecord(id);
    return record && covered(id) ? record : undefined;
  });
  if (errors.length) throw invalid(`巡检器的看法不合格：${errors.join('；')}`);
  const note: WatchNote = {
    branchId: branch.id,
    rev: (previous?.rev ?? 0) + 1,
    toolCalls: input.toolCalls,
    basedOnSeq: input.basedOnSeq,
    ...(state || previous?.stateSeq !== undefined
      ? {
          stateSeq: state?.seenSeq ?? previous?.stateSeq,
          stateRefs: [...stateRefs].filter((id) => (q.getRecord(id)?.record.seq ?? 0) > input.basedOnSeq),
        }
      : {}),
    ...(deliveredRefs.length ? { deliveredRefs } : {}),
    model: input.model,
    ...body,
  };
  return note;
}
