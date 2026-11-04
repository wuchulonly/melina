import { expect, it } from 'vitest';
import { BranchDetail, RunListResponse, RunResultResponse, RunSummary } from '../../../src/core/api.ts';
import { eventIssues, issues } from '../../../src/core/validate.ts';
import { allScripts } from '../../fixtures/runs/index.ts';
import { branchDetail, runList, runResult, runSummary } from '../../fixtures/runs/project.ts';

it('演示记录只使用当前事件与 direct 路线，并能投影当前 HTTP 数据', () => {
  for (const script of allScripts()) {
    script.events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      expect(eventIssues(e)).toEqual([]);
    });
    expect(issues(RunListResponse, runList(script.events))).toEqual([]);
    for (const runId of script.runIds) {
      const summary = runSummary(script.events, runId);
      expect(issues(RunSummary, summary)).toEqual([]);
      for (const b of summary.branches) {
        expect(b.bet.kind).toBe('direct');
        expect(issues(BranchDetail, branchDetail(script.events, runId, b.branch.id))).toEqual([]);
      }
      if (summary.run.result) expect(issues(RunResultResponse, runResult(script.events, runId))).toEqual([]);
    }
  }
});
