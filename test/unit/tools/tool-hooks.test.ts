import { afterEach, expect, it, vi } from 'vitest';
import type { BeforeTool, ToolCheck } from '../../../src/tools/session.ts';
import { branch, call, type Kit, kit, openExplorer } from './gateway-kit.ts';

const kits: Kit[] = [];
afterEach(() => {
  for (const k of kits.splice(0)) k.cleanup();
});

it('同步策略同时覆盖预检和直接执行，拒绝不产生观测或执行', async () => {
  const check = vi.fn<ToolCheck>(() => '领域策略拒绝');
  const k = kit({ deps: { toolChecks: [check] } });
  kits.push(k);
  const session = openExplorer(k, await branch(k));
  const tool = session.tools.find((tool) => tool.spec.name === 'sh')!;
  const request = { id: 'request', name: 'sh', args: { cmd: 'printf never' } };
  expect(session.check(request, [request])).toBe('领域策略拒绝');
  expect(await tool.run(request, new AbortController().signal)).toMatchObject({
    isError: true,
    content: '领域策略拒绝',
  });
  expect(session.toolCalls).toBe(0);
});

it('异步准备只在参数合法后执行；准备期间策略变化在实际执行前重查', async () => {
  let ready = false;
  const prepare = vi.fn<BeforeTool>(async () => {
    ready = true;
    return undefined;
  });
  const k = kit({ deps: { beforeTools: [prepare], toolChecks: [() => (ready ? '状态已变化' : undefined)] } });
  kits.push(k);
  const session = openExplorer(k, await branch(k));
  expect((await call(session, 'sh', { cmd: 123 })).isError).toBe(true);
  expect(prepare).not.toHaveBeenCalled();
  expect(await call(session, 'sh', { cmd: 'printf never' })).toMatchObject({ content: '状态已变化' });
  expect(session.toolCalls).toBe(0);
});

it('异步准备等待时不执行后续扩展，重试成功后才运行工具', async () => {
  const first = vi.fn<BeforeTool>(async () => '等待领域状态');
  const second = vi.fn<BeforeTool>(async () => undefined);
  const k = kit({ deps: { beforeTools: [first, second] } });
  kits.push(k);
  const session = openExplorer(k, await branch(k));
  expect((await call(session, 'sh', { cmd: 'printf ready' })).content).toBe('等待领域状态');
  expect(second).not.toHaveBeenCalled();
  first.mockResolvedValue(undefined);
  expect((await call(session, 'sh', { cmd: 'printf ready' })).observationId).toBeDefined();
  expect(second).toHaveBeenCalledOnce();
});

it('工具意图通知发生在参数和策略检查后、异步准备前', async () => {
  const order: string[] = [];
  const k = kit({
    deps: {
      beforeTools: [
        async () => {
          order.push('prepare');
          return '等待状态';
        },
      ],
    },
  });
  kits.push(k);
  const own = await branch(k);
  const base = openExplorer(k, own);
  const session = k.gateway.open(base.caller, { onToolIntent: (call) => order.push(call.name) });
  expect((await call(session, 'sh', { cmd: 123 })).isError).toBe(true);
  expect(order).toEqual([]);
  expect((await call(session, 'sh', { cmd: 'printf ready' })).content).toBe('等待状态');
  expect(order).toEqual(['sh', 'prepare']);
  expect(session.toolCalls).toBe(0);
});
