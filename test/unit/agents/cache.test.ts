import { afterEach, expect, it } from 'vitest';
import { bet, closeInto, episode, type Flow, flow, tool, turn } from './flow-kit.ts';

let f: Flow;
afterEach(() => f?.k.cleanup());
it('交接和人的提示改变 user 消息，系统提示与工具定义保持稳定', async () => {
  f = flow();
  const b = await bet(f);
  const first = f.assembler.forExplorer(b.branch);
  const ep = await episode(f, b, [turn(tool('end_episode', { handoff: '服务启动成功；下一会话核对功能。' }))]);
  closeInto(f, b, ep.outcome);
  f.k.runStore.writer.appendInbox({ runId: f.k.run.id, branchId: b.branch.id, kind: 'human', text: '再检查异常输入' });
  const current = f.k.runStore.queries.getBranch(b.branch.id)!;
  const next = f.assembler.forExplorer(current);
  expect(next.system).toBe(first.system);
  expect(next.tools).toEqual(first.tools);
  expect(next.messages[0]?.text).toContain('服务启动成功');
  expect(next.messages[0]?.text).toContain('再检查异常输入');
});
