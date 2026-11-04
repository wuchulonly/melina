import { afterEach, expect, it } from 'vitest';
import { branch, call, type Kit, kit, openExplorer, submitCandidate } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());
it('交接只写高密度文字，接受后锁住会话', async () => {
  k = kit();
  const b = await branch(k),
    session = openExplorer(k, b);
  expect(await call(session, 'end_episode', {})).toMatchObject({ isError: true });
  const result = await call(session, 'end_episode', { handoff: '已跑通单测；下一会话检查集成。' });
  expect(result).toMatchObject({ isError: false, terminate: true });
  expect(session.closed()).toEqual({
    tool: 'end_episode',
    args: { kind: 'continue', handoff: '已跑通单测；下一会话检查集成。' },
  });
  expect((await call(session, 'sh', { cmd: 'printf forbidden' })).isError).toBe(true);
});
it('候选只需 claim，交付物限定在工作区内', async () => {
  k = kit();
  const b = await branch(k),
    session = openExplorer(k, b);
  expect((await submitCandidate(session, { claim: '完成', artifact: '../escape' })).isError).toBe(true);
  expect(await submitCandidate(session, { claim: '测试通过' })).toMatchObject({ isError: false, terminate: true });
  expect(session.closed()?.args).toEqual({ kind: 'candidate', claim: '测试通过' });
});
it('收尾工具必须单独调用，拒绝不会执行或结束会话', async () => {
  k = kit();
  const session = openExplorer(k, await branch(k));
  expect(
    await call(
      session,
      'end_episode',
      { handoff: '继续' },
      {
        turn: [
          { name: 'sh', args: { cmd: 'pwd' } },
          { name: 'end_episode', args: { handoff: '继续' } },
        ],
      },
    ),
  ).toMatchObject({ blocked: true, isError: true });
  expect(session.closed()).toBeUndefined();
});
it('Scoper 校验领域与完成标准，允许省略安装命令', async () => {
  k = kit({ completion: false });
  const session = k.gateway.open({ runId: k.run.id, role: 'scoper', snapshot: 'root', readOnly: true });
  expect(
    (
      await call(session, 'submit_completion', {
        completion: { interpretation: '完成目标', criteria: ['测试通过'] },
        constraints: [],
        domain: 'unknown',
      })
    ).isError,
  ).toBe(true);
  expect(
    await call(session, 'submit_completion', {
      completion: { interpretation: '完成目标', criteria: ['测试通过'] },
      constraints: [],
      domain: 'code',
    }),
  ).toMatchObject({ isError: false, terminate: true });
});
