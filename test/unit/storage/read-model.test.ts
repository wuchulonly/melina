import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOf, newId } from '../../../src/core/ids.ts';
import type { RunStoreQueries, WatchInput } from '../../../src/core/interfaces/store.ts';
import type { WatchBody } from '../../../src/core/types.ts';
import { WATCH_INPUT } from '../../../src/core/watch-input.ts';
import { latestWatch, mergeWatch, platformFlags, watchVersions } from '../../../src/projections/watch.ts';
import { freezeWatchState } from '../../../src/projections/watch-state.ts';
import { freezeWatchWindow, watchLag } from '../../../src/projections/watch-window.ts';
import type { Store } from '../../../src/storage/store.ts';
import { insertRecord } from '../../../src/storage/tables.ts';
import { MODEL, newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

const runStores: TestRunStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const runStore of runStores.splice(0)) runStore.close();
});
function setup() {
  const runStore = testRunStore();
  runStores.push(runStore);
  const run = newRun(runStore);
  const { branch } = startBranch(runStore, run, { kind: 'direct' });
  const store = (
    runStore.queries as unknown as {
      store: Store;
    }
  ).store;
  const input: WatchInput = {
    runId: run.id,
    branchId: branch.id,
    basedOnSeq: runStore.queries.lastSeq(),
    toolCalls: 0,
    model: MODEL,
    draft: {
      standing: '检查中',
      directions: [],
      tension: [],
      advice: '继续',
    },
  };
  return { runStore, run, branch, store, input };
}
describe('RunStore 内部读模型', () => {
  it('平台状态尊重历史水位和已展示状态，跳过不合格式的新版', () => {
    const { runStore, run, branch, input } = setup();
    const platform = (id: string, valid = true) =>
      runStore.writer.appendObservation(
        {
          runId: run.id,
          branchId: branch.id,
          role: 'watcher',
          tool: WATCH_INPUT.platform,
          args: valid
            ? {
                task: 'task',
                total: 1,
                remaining: 0,
                hintStatus: 'none',
                hint: '',
                accepted: [{ id, label: id }],
                rejectedCount: 0,
              }
            : {},
          summary: '平台状态',
          output: handleOf(id),
          snapshot: 'root',
        },
        { countsAsToolCall: false },
      );
    const first = platform('first');
    const second = platform('second');
    platform('invalid', false);
    const body = mergeWatch(undefined, input.draft);
    const wrapped: RunStoreQueries = runStore.queries;
    for (const queries of [runStore.queries, wrapped]) {
      expect(platformFlags(queries, run.id, branch.id, first.seq, body).map((f) => f.id)).toEqual(['first']);
      expect(
        platformFlags(queries, run.id, branch.id, first.seq, body, undefined, new Set([second.id])).map((f) => f.id),
      ).toEqual(['second']);
      expect(platformFlags(queries, run.id, branch.id, runStore.queries.lastSeq(), body).map((f) => f.id)).toEqual([
        'second',
      ]);
    }
  });
  it('按分支与历史截止点读 Watch；回滚同时撤销事件与索引，删除 Run 级联清理', () => {
    const { runStore, run, branch, store, input } = setup();
    runStore.writer.recordWatch(input);
    const first = latestWatch(runStore.queries, run.id, branch.id)!;
    runStore.writer.recordWatch(input);
    const other = startBranch(runStore, run, { kind: 'direct' }).branch;
    runStore.writer.recordWatch({ ...input, branchId: other.id });
    const events = vi.spyOn(runStore.queries, 'events').mockImplementation(() => {
      throw new Error('不应读事件历史');
    });
    for (const queries of [
      runStore.queries,
      { ...runStore.queries },
      { readModel: runStore.queries.readModel },
      runStore.queries,
    ]) {
      expect(latestWatch(queries, run.id, branch.id)?.rev).toBe(2);
      expect(latestWatch(queries, run.id, branch.id, first.seq)).toEqual(first);
    }
    expect(latestWatch(runStore.queries, run.id, branch.id, first.seq)).toEqual(first);
    expect(latestWatch(runStore.queries, run.id, branch.id, first.seq - 1)).toBeUndefined();
    expect(watchVersions(runStore.queries, run.id, branch.id).map((note) => note.rev)).toEqual([1, 2]);
    const seq = runStore.queries.lastSeq();
    expect(() =>
      store.write(
        (tx) => {
          tx.event(tx.nextSeq(), 'watch.noted', run.id, { ...first, rev: 3 });
          throw new Error('回滚');
        },
        () => {},
      ),
    ).toThrow('回滚');
    expect(runStore.queries.lastSeq()).toBe(seq);
    expect(latestWatch(runStore.queries, run.id, branch.id)?.rev).toBe(2);
    events.mockRestore();
    runStore.writer.endRun(run.id, {
      status: 'cancelled',
      result: { knowledgeReport: handleOf('end') },
      branchNote: '结束',
    });
    runStore.writer.deleteRun(run.id);
    expect(latestWatch(runStore.queries, run.id, branch.id)).toBeUndefined();
    expect(store.stmt('SELECT count(*) FROM watch_notes').pluck().get()).toBe(0);
  });
  it('一万条执行观测不会被最新状态、截窗和覆盖账龄全部解析', () => {
    const { runStore, run, branch, store, input } = setup();
    const host = runStore.writer.appendObservation(
      {
        runId: run.id,
        branchId: branch.id,
        role: 'watcher',
        tool: WATCH_INPUT.extension,
        args: { extension: 'status', value: 'ready' },
        summary: '宿主状态',
        output: handleOf('status'),
        snapshot: 'root',
      },
      { countsAsToolCall: false },
    );
    const template = observe(runStore, branch);
    store.write(
      (tx) => {
        for (let i = 0; i < 10000; i++) {
          const observation = { ...template, id: newId(), seq: tx.nextSeq() };
          insertRecord(store, 'observation', observation);
          tx.event(observation.seq, 'observation.created', run.id, observation);
        }
      },
      () => {},
    );
    const latest = runStore.queries.lastSeq();
    const wrapped: RunStoreQueries = runStore.queries;
    const parsed = vi.spyOn(JSON, 'parse');
    for (const queries of [runStore.queries, wrapped]) {
      parsed.mockClear();
      const state = freezeWatchState(queries, run.id, { branchId: branch.id, untilSeq: latest }, latest);
      expect(state.refs).toEqual([host.id]);
      expect(parsed.mock.calls.length).toBeLessThan(20);
      parsed.mockClear();
      const request = { branchId: branch.id, untilSeq: latest, window: { maxSteps: 3, maxBytes: 100000 } };
      const window = freezeWatchWindow(queries, run.id, request, latest);
      expect(window.toolCalls).toBe(3);
      expect(window.untilSeq).toBeLessThan(latest);
      expect(parsed.mock.calls.length).toBeLessThan(500);
      parsed.mockClear();
      expect(
        watchLag(queries, branch, { ...input, basedOnSeq: latest }, Date.now(), {
          unread: false,
          hintSeq: 0,
          firstUnreadAt: undefined,
        }).coveredAt,
      ).toBeDefined();
      expect(parsed.mock.calls.length).toBeLessThan(300);
    }
  });
  it('查询对象展开后保留索引读取与跨页冻结窗口', () => {
    const { runStore, run, branch } = setup();
    for (let i = 0; i < 140; i++) observe(runStore, branch);
    const latest = runStore.queries.lastSeq();
    const request = { branchId: branch.id, untilSeq: latest, window: { maxSteps: 130, maxBytes: 1000000 } };
    const wrapped: RunStoreQueries = runStore.queries;
    expect(freezeWatchWindow(runStore.queries, run.id, request, latest)).toEqual(
      freezeWatchWindow(wrapped, run.id, request, latest),
    );
    const body: WatchBody = {
      directions: [],
      tension: [],
      standing: '检查中',
      advice: '继续',
    };
    expect(platformFlags(runStore.queries, run.id, branch.id, latest, body)).toEqual(
      platformFlags(wrapped, run.id, branch.id, latest, body),
    );
  });
});
