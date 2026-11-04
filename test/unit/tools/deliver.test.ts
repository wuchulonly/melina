import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { VersionDesk } from '../../../src/tools/session.ts';
import { snapshotId } from '../storage/kit.ts';
import { branch, call, type Kit, kit, openExplorer, SECRET } from './gateway-kit.ts';

let k: Kit;
afterEach(() => {
  vi.restoreAllMocks();
  k?.cleanup();
});
it('存阶段版本后继续同一会话，提交文字先脱敏', async () => {
  const seen: Parameters<VersionDesk['deliver']>[0][] = [];
  k = kit({
    deps: {
      deliver: {
        async deliver(req) {
          seen.push(req);
          const snapshot = snapshotId();
          return k.runStore.writer.deliverVersion({
            branchId: req.branchId,
            episode: req.version.episode,
            snapshot: { id: snapshot },
            candidate: { runId: req.runId, branchId: req.branchId, snapshot, claim: req.version.claim, interim: true },
          });
        },
      },
    },
  });
  const b = await branch(k),
    session = openExplorer(k, b);
  const result = await call(session, 'deliver', { claim: `第一阶段通过 ${SECRET.value}` });
  expect(result.isError).toBe(false);
  expect(result.terminate).toBeUndefined();
  expect(session.closed()).toBeUndefined();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.version.claim).not.toContain(SECRET.value);
  expect(k.runStore.queries.candidates(k.run.id)[0]).toMatchObject({ interim: true, branchId: b.branch.id });
  expect((await call(session, 'sh', { cmd: 'printf continue' })).isError).toBe(false);
});
it('未连接运行时交版台会清楚退回，不能借交版关闭会话', async () => {
  k = kit();
  const session = openExplorer(k, await branch(k));
  expect((await call(session, 'deliver', { claim: '阶段完成' })).isError).toBe(true);
  expect(session.closed()).toBeUndefined();
});
it.each(['deliver', 'end_episode'] as const)('%s 的文件必须在本分支可确认存在，拒绝后可在原会话重试', async (tool) => {
  const deliver = vi.fn<VersionDesk['deliver']>();
  k = kit({ deps: { deliver: { deliver } } });
  const own = await branch(k);
  const peer = await branch(k);
  const session = openExplorer(k, own);
  await writeFile(join(peer.ws, 'report.md'), '仅在其他分支存在');
  const args = { claim: '已验证', artifact: 'report.md' };
  const submit = () => call(session, tool, tool === 'end_episode' ? { candidate: args } : args);
  expect(await submit()).toMatchObject({ isError: true, content: expect.stringContaining('本分支') });
  expect(session.closed()).toBeUndefined();
  expect(deliver).not.toHaveBeenCalled();
  await writeFile(join(own.ws, 'report.md'), '本分支已取得');
  expect(await submit()).toMatchObject({ isError: false });
  if (tool === 'deliver') {
    expect(deliver).toHaveBeenCalledOnce();
    expect(session.closed()).toBeUndefined();
  } else expect(session.closed()?.tool).toBe('end_episode');
});
it.each(['throw', 'timeout', 'cancelled', 'exit', 'empty'] as const)(
  '文件检查 %s 时拒绝交版，保留当前会话',
  async (failure) => {
    const deliver = vi.fn<VersionDesk['deliver']>();
    k = kit({ deps: { deliver: { deliver } } });
    const session = openExplorer(k, await branch(k));
    const exec = vi.spyOn(k.runtime, 'exec');
    if (failure === 'throw') exec.mockRejectedValueOnce(new Error('容器不可用'));
    else
      exec.mockResolvedValueOnce({
        exitCode: failure === 'exit' ? 1 : 0,
        output: failure === 'empty' ? '' : 'MELINA-FILE yes\n',
        timedOut: failure === 'timeout',
        cancelled: failure === 'cancelled',
        durationMs: 0,
      });
    expect(await call(session, 'deliver', { claim: '阶段完成', artifact: 'report.md' })).toMatchObject({
      isError: true,
      content: expect.stringContaining('artifact'),
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(session.closed()).toBeUndefined();
  },
);
it('没有容器时不能附带未经检查的交付文件', async () => {
  const deliver = vi.fn<VersionDesk['deliver']>();
  k = kit({ deps: { deliver: { deliver } } });
  const own = await branch(k);
  const session = k.gateway.open({
    runId: k.run.id,
    branchId: own.branch.id,
    role: 'explorer',
    snapshot: 'root',
    readOnly: false,
  });
  expect(await call(session, 'deliver', { claim: '阶段完成', artifact: 'report.md' })).toMatchObject({
    isError: true,
    content: expect.stringContaining('没有可用容器'),
  });
  expect(deliver).not.toHaveBeenCalled();
});
it('交版必须独占一轮，空正文不能通过 schema', async () => {
  k = kit();
  const session = openExplorer(k, await branch(k));
  expect((await call(session, 'deliver', { claim: '' })).isError).toBe(true);
  expect(
    await call(
      session,
      'deliver',
      { claim: '版本' },
      {
        turn: [
          { name: 'sh', args: { cmd: 'pwd' } },
          { name: 'deliver', args: { claim: '版本' } },
        ],
      },
    ),
  ).toMatchObject({ blocked: true });
});
