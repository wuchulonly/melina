import { afterEach, expect, it } from 'vitest';
import { freezeWatchSnapshot, watchRecordRef } from '../../../src/projections/watch-snapshot.ts';
import { newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

let runStore: TestRunStore;
afterEach(() => runStore?.close());
it('冻结记录和短码表，不包含后续记录或隔离分支；修改快照不写回 RunStore', () => {
  runStore = testRunStore();
  const run = newRun(runStore);
  const own = startBranch(runStore, run, { kind: 'direct' }).branch;
  const other = startBranch(runStore, run).branch;
  const visible = observe(runStore, own, '本轮执行');
  observe(runStore, other, '隔离执行');
  const request = { branchId: own.id, untilSeq: runStore.queries.lastSeq() };
  const snapshot = freezeWatchSnapshot(runStore.queries, run.id, request);
  const original = structuredClone(snapshot);
  observe(runStore, own, '冻结之后');
  expect(freezeWatchSnapshot(runStore.queries, run.id, request)).toEqual(original);
  expect(snapshot.records.filter((r) => r.kind === 'observation').map((r) => r.record.id)).toEqual([visible.id]);
  expect(watchRecordRef(snapshot.records.find((r) => r.record.id === visible.id)!)).toBe(`o${visible.seq}`);
  const record = snapshot.records.find((r) => r.record.id === visible.id)!;
  if (record.kind === 'observation') record.record.summary = '只改本地副本';
  expect(runStore.queries.getObservation(visible.id)?.summary).toBe('本轮执行');
});
