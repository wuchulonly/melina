import { afterEach, expect, it } from 'vitest';
import { RunProgress, type RunSummary } from '../../../src/core/api.ts';
import { newId } from '../../../src/core/ids.ts';
import { isValid } from '../../../src/core/validate.ts';
import { json, MODEL, ORIGIN, type TestMelina, testMelina } from './kit.ts';

let k: TestMelina;
afterEach(async () => {
  await k?.close();
});
it('任务与分支接口直接返回执行记录，进展只含调度数据', async () => {
  k = await testMelina();
  const run = await k.runs.create({ statement: '接口正文不能进入遥测', materials: [] }),
    w = k.runs.deps.writer;
  const bet = w.createBet({
    runId: run.id,
    kind: 'direct',
    label: '直接路线',
    startFrom: { snapshot: 'root' },
    model: MODEL,
    source: { kind: 'template' },
  });
  const branch = w.createBranch({ runId: run.id, betId: bet.id, lastSnapshot: 'root' });
  w.updateBranch(branch.id, { state: 'running', queued: false, workspace: { path: '/tmp/ws' } });
  const summary = await json<RunSummary>(await k.request(`/api/runs/${run.id}`));
  expect(summary.run.id).toBe(run.id);
  expect(summary.branches[0]?.branch.id).toBe(branch.id);
  const detail = await json<Record<string, unknown>>(await k.request(`/api/runs/${run.id}/branches/${branch.id}`));
  expect(detail).toHaveProperty('observations');
  const res = await k.request(`/api/runs/${run.id}/progress`),
    progress = await json<RunProgress>(res);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(isValid(RunProgress, progress)).toBe(true);
  expect(progress.windowSeconds).toBe(600);
  expect(JSON.stringify(progress)).not.toContain(run.goal.statement);
  expect(progress).not.toHaveProperty('lastFactAt');
});
it('输入广播到当前直接分支，删除端点不提供旧接口', async () => {
  k = await testMelina();
  const run = await k.runs.create({ statement: '输入测试', materials: [] });
  const response = await k.request(`/api/runs/${run.id}/input`, {
    method: 'POST',
    origin: ORIGIN,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'hint', text: '优先检查边界' }),
  });
  expect(response.status).toBe(200);
  expect(k.runs.deps.queries.humanInputs(run.id)[0]?.text).toBe('优先检查边界');
  for (const suffix of ['board', 'chain', 'asks'])
    expect((await k.request(`/api/runs/${run.id}/${suffix}`)).status).toBe(404);
});
it('请求校验保留不存在任务和无效 body 的错误状态', async () => {
  k = await testMelina();
  expect((await k.request(`/api/runs/${newId()}`)).status).toBe(404);
  expect(
    (
      await k.request('/api/runs', {
        method: 'POST',
        origin: ORIGIN,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(400);
  expect((await k.request('/api/runs', { host: 'evil.example' })).status).toBe(403);
});
