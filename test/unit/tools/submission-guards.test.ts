import { afterEach, expect, it, vi } from 'vitest';
import type { SubmitCandidateArgs } from '../../../src/core/tools.ts';
import type { SubmissionGuard } from '../../../src/tools/session.ts';
import { branch, call, type Kit, kit, openExplorer, sh, submitCandidate } from './gateway-kit.ts';

const kits: Kit[] = [];
afterEach(() => {
  for (const k of kits.splice(0)) k.cleanup();
});

async function setup(guards: SubmissionGuard[], onClose?: () => string | undefined) {
  const k = kit({ deps: { submissionGuards: guards } });
  kits.push(k);
  const session = openExplorer(k, await branch(k), onClose ? { onClose } : {});
  await sh(session, 'echo complete');
  const args = { claim: '已完成' };
  return { k, session, args };
}

it('扩展收到语义检查通过后的提交种类和参数，拒绝时会话继续打开', async () => {
  const guard = vi.fn<SubmissionGuard>(async () => '还需补充说明');
  const { session, args } = await setup([guard]);
  const out = await submitCandidate(session, args);
  expect(out).toMatchObject({ isError: true, content: '还需补充说明' });
  expect(session.closed()).toBeUndefined();
  expect(guard).toHaveBeenCalledOnce();
  const submission = guard.mock.calls[0]?.[1];
  expect(submission?.tool).toBe('end_episode');
  expect((submission?.args as SubmitCandidateArgs | undefined)?.claim).toEqual(args.claim);
});

it('扩展按注册顺序运行，首个拒绝后不执行后续扩展，全部通过才接受', async () => {
  const first = vi.fn<SubmissionGuard>(async () => undefined);
  const second = vi.fn<SubmissionGuard>(async () => '暂不接受');
  const third = vi.fn<SubmissionGuard>(async () => undefined);
  const { session, args } = await setup([first, second, third]);
  expect((await submitCandidate(session, args)).isError).toBe(true);
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0] ?? 0);
  expect(third).not.toHaveBeenCalled();
  second.mockResolvedValue(undefined);
  expect((await submitCandidate(session, args)).terminate).toBe(true);
  expect(third).toHaveBeenCalledOnce();
});

it('内置校验或角色校验拒绝时不调用扩展', async () => {
  const guard = vi.fn<SubmissionGuard>(async () => undefined);
  const { session, args } = await setup([guard]);
  expect((await submitCandidate(session, { ...args, claim: '' })).terminate).toBeUndefined();
  expect(guard).not.toHaveBeenCalled();
  const vetoed = await setup([guard], () => '角色尚未完成');
  expect((await submitCandidate(vetoed.session, vetoed.args)).content).toBe('角色尚未完成');
  expect(guard).not.toHaveBeenCalled();
});

it('扩展出错时保留会话并记录错误', async () => {
  const guard = vi.fn<SubmissionGuard>(async () => {
    throw new Error('服务暂时不可用');
  });
  const { k, session, args } = await setup([guard]);
  expect((await submitCandidate(session, args)).content).toContain('服务暂时不可用');
  expect(session.closed()).toBeUndefined();
  expect(k.errors).toEqual(['检查提交：服务暂时不可用']);
});

it('扩展等待不算格式错误，重复等待后仍可在原会话提交', async () => {
  const guard = vi.fn<SubmissionGuard>(async () => ({ again: '外部验收待确认' }));
  const { session, args } = await setup([guard]);
  for (let i = 0; i < 3; i++) {
    expect(await submitCandidate(session, args)).toMatchObject({ isError: false, content: '外部验收待确认' });
    expect(session.closed()).toBeUndefined();
  }
  guard.mockResolvedValue(undefined);
  expect(await submitCandidate(session, args)).toMatchObject({ terminate: true });
});

it('等待扩展期间取消，即使扩展随后通过也不接受提交', async () => {
  const controller = new AbortController();
  const guard = vi.fn<SubmissionGuard>(async (_env, _submission, signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort();
    return undefined;
  });
  const { session } = await setup([guard]);
  const out = await call(session, 'end_episode', { handoff: '已保存进度' }, { signal: controller.signal });
  expect(out).toMatchObject({ isError: true, content: '调用已停止，未接受提交' });
  expect(session.closed()).toBeUndefined();
});
