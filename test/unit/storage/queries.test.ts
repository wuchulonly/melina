import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../../src/core/ids.ts';
import { newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

let runStore: TestRunStore;
afterEach(() => runStore?.close());
function setup() {
  runStore = testRunStore();
  const run = newRun(runStore);
  const { branch } = startBranch(runStore, run);
  return { run, branch };
}

describe('运行日志查询', () => {
  it('观察分页从新到旧，不重不漏', () => {
    const { branch } = setup();
    const observations = Array.from({ length: 7 }, (_, i) => observe(runStore, branch, `第 ${i} 次`));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = runStore.queries.observations(branch.id, { limit: 2, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map((o) => o.id));
      cursor = page.next;
    } while (cursor);
    expect(ids).toEqual(observations.reverse().map((o) => o.id));
  });
  it('分支详情只含本分支观测和当前路线', () => {
    const { run, branch } = setup();
    const other = startBranch(runStore, run).branch;
    const observation = observe(runStore, branch, '当前路线');
    observe(runStore, other, '其他路线');
    const detail = runStore.queries.branchDetail(run.id, branch.id);
    expect(detail?.branch.id).toBe(branch.id);
    expect(detail?.observations.items.map((o) => o.id)).toEqual([observation.id]);
    expect(runStore.queries.branchDetail(newId(), branch.id)).toBeUndefined();
  });
  it('分支只能读取自身和 Scoper 的执行原文', () => {
    const { run, branch } = setup();
    const other = startBranch(runStore, run).branch;
    const own = observe(runStore, branch);
    const foreign = observe(runStore, other);
    expect(runStore.queries.isVisible({ kind: 'branch', branchId: branch.id }, own.id)).toBe(true);
    expect(runStore.queries.isVisible({ kind: 'branch', branchId: branch.id }, foreign.id)).toBe(false);
    expect(runStore.queries.isVisible({ kind: 'human', runId: run.id }, foreign.id)).toBe(true);
  });
});
