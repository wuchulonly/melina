import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { BranchDetail, RunSummary } from '../../src/core/api.ts';
import type { ModelRef } from '../../src/core/model-ref.ts';
import { eventIssues, issues } from '../../src/core/validate.ts';
import { createFakeHandler } from '../fake/http.ts';
import { FakeMelina } from '../fake/melina.ts';

const backends: FakeMelina[] = [];
const fake = () => {
  const m = new FakeMelina({ start: 'end', speed: 0 });
  backends.push(m);
  return m;
};
afterEach(() => {
  for (const m of backends.splice(0)) m.close();
});
it('direct 和摘要接力剧本符合当前事件和 HTTP 契约', () => {
  const m = fake();
  for (const e of m.eventsSince(0)) expect(eventIssues(e)).toEqual([]);
  for (const r of m.listRuns().runs) {
    const summary = m.getRun(r.id);
    expect(issues(RunSummary, summary)).toEqual([]);
    for (const b of summary.branches) expect(issues(BranchDetail, m.branch(r.id, b.branch.id))).toEqual([]);
  }
  expect(m.listRuns().runs).toHaveLength(2);
});
it('当前输入、暂停、恢复、取消和删除使用同一任务状态', () => {
  const m = fake();
  const { runId } = m.createRun({ statement: '新目标' });
  expect(m.getRun(runId).branches).toHaveLength(3);
  m.pause(runId);
  expect(m.getRun(runId).run.status).toBe('paused');
  m.input(runId, { kind: 'hint', text: '检查第二阶段' });
  m.resume(runId);
  m.cancel(runId);
  expect(m.result(runId)).toMatchObject({ runId, status: 'cancelled', unfinished: true });
  m.deleteRun(runId);
  expect(() => m.getRun(runId)).toThrow();
});
it('显式模型数组保留副本、顺序和模型，忽略 copies', () => {
  const m = fake();
  const first: ModelRef = { provider: 'provider-a', model: 'model-a', tier: 'strong' };
  const second: ModelRef = { provider: 'provider-b', model: 'model-b', tier: 'fast' };
  const models = [first, second, first];
  const { runId } = m.createRun({ statement: '混合模型', config: { bet0: { models, copies: 5 } } });
  const summary = m.getRun(runId);
  expect(summary.branches.map(({ bet }) => bet.model)).toEqual(models);
  expect(summary.branches).toHaveLength(models.length);
});
it('HTTP 提供路线明细并撤掉黑板端点', async () => {
  const m = fake(),
    handle = createFakeHandler(m);
  const server = createServer((req, res) => {
    handle(req, res).then((done) => {
      if (!done) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const run = m.listRuns().runs[0];
    if (!run) throw new Error('缺少演示任务');
    const branch = m.getRun(run.id).branches[0];
    if (!branch) throw new Error('缺少演示路线');
    expect((await fetch(`${root}/api/runs/${run.id}/branches/${branch.branch.id}`)).ok).toBe(true);
    for (const path of ['board', 'chain']) expect((await fetch(`${root}/api/runs/${run.id}/${path}`)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
