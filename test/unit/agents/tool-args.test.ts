import { expect, it } from 'vitest';
import { prepareToolArgs } from '../../../src/agents/tool-args.ts';
import { TOOL_SPECS } from '../../../src/core/tools.ts';

it('可选 null 归一化为空缺，保留候选正文', () => {
  expect(prepareToolArgs(TOOL_SPECS.endEpisode, { candidate: { claim: '验证完成', artifact: null } }).args).toEqual({
    candidate: { claim: '验证完成' },
  });
});
it('空交接与未知协议字段写清错误，模型能按当前 schema 修正', () => {
  expect(() => prepareToolArgs(TOOL_SPECS.endEpisode, { handoff: '字'.repeat(8001) })).toThrow();
  expect(() => prepareToolArgs(TOOL_SPECS.endEpisode, { notebook: { nextStep: '继续' } })).toThrow('notebook');
  expect(prepareToolArgs(TOOL_SPECS.endEpisode, { handoff: '继续检查边界条件' }).args).toEqual({
    handoff: '继续检查边界条件',
  });
});
it('执行参数不吞掉未知字段，Scoper 仍校验完整完成标准', () => {
  expect(() => prepareToolArgs(TOOL_SPECS.sh, { cmd: 'pwd', mode: 'look' })).toThrow('mode');
  const args = {
    completion: { interpretation: '按目标核对', criteria: ['符合要求'] },
    constraints: [],
    domain: 'general',
  };
  expect(prepareToolArgs(TOOL_SPECS.submitCompletion, args).args).toEqual(args);
});
