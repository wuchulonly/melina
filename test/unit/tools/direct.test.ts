import { afterEach, expect, it } from 'vitest';
import { prepareToolArgs } from '../../../src/agents/tool-args.ts';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { branch, call, type Kit, kit, openExplorer, submitCandidate } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());
it('布局和执行网关使用同一组直接工具', async () => {
  k = kit();
  const b = await branch(k),
    layout = new MelinaContextAssembler({ queries: k.runStore.queries }).forExplorer(b.branch),
    session = openExplorer(k, b);
  expect(layout.tools).toEqual(session.tools.map((t) => t.spec));
  expect(layout.tools.map((t) => t.name)).toEqual(['sh', 'read', 'edit', 'write', 'deliver', 'end_episode']);
  expect(layout.system).not.toContain('Notebook');
});
it('交接保留当前文字结构，超长交接在执行前退回', async () => {
  k = kit();
  const session = openExplorer(k, await branch(k)),
    spec = session.tools.find((t) => t.spec.name === 'end_episode')!.spec;
  expect(() => prepareToolArgs(spec, { handoff: '字'.repeat(8001) })).toThrow();
  expect(session.closed()).toBeUndefined();
  const handoff = '已完成初步验证；恢复服务后检查剩余条件。';
  expect(await call(session, 'end_episode', prepareToolArgs(spec, { handoff }).args)).toMatchObject({
    isError: false,
    terminate: true,
  });
  expect(session.closed()?.args).toEqual({ kind: 'continue', handoff });
});
it('执行无须预测，模型只看到摘要和路径，宿主保留观测 ID', async () => {
  k = kit();
  const session = openExplorer(k, await branch(k));
  const result = await call(session, 'sh', { cmd: 'printf actual' });
  expect(result.isError).toBe(false);
  expect(result.observationId).toBeDefined();
  expect(result.json).toHaveProperty('summary');
  expect(result.json).not.toHaveProperty('ref');
  expect(result.json).not.toHaveProperty('observationId');
  expect(await submitCandidate(session, { claim: '完成说明' })).toMatchObject({ terminate: true });
});
