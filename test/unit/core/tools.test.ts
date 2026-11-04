import { describe, expect, it } from 'vitest';
import {
  CLOSING_TOOLS,
  ENV_TOOLS,
  explorerTools,
  type SubmitWatchInput,
  scoperTools,
  TOOL_SPECS,
  watcherTools,
  watchFromArgs,
} from '../../../src/core/tools.ts';
import { isValid } from '../../../src/core/validate.ts';

describe('直接会话的工具协议', () => {
  it('Explorer 只暴露执行、交版与交接入口', () => {
    expect(explorerTools().map((t) => t.name)).toEqual(['sh', 'read', 'edit', 'write', 'deliver', 'end_episode']);
    expect(scoperTools().map((t) => t.name)).toEqual(['sh', 'read', 'submit_completion']);
    expect(watcherTools().map((t) => t.name)).toEqual(['observation_context', 'observation_submit']);
    expect(ENV_TOOLS).toEqual(['sh', 'read', 'edit', 'write']);
    expect(CLOSING_TOOLS).toContain('end_episode');
  });
  it('工具名和顶层封闭对象适合供应商工具调用', () => {
    for (const spec of Object.values(TOOL_SPECS)) {
      expect(spec.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
  it('交接与候选只接收当前字段', () => {
    const p = TOOL_SPECS.endEpisode.parameters;
    expect(isValid(p, { handoff: '恢复服务后继续验证' })).toBe(true);
    expect(isValid(p, { candidate: { claim: '目标已完成', artifact: 'answer.txt' } })).toBe(true);
    for (const args of [
      { notebook: {} },
      { report: { status: '完成' } },
      { candidate: { claim: '完成', checks: [] } },
      { exit: { kind: 'done' } },
    ])
      expect(isValid(p, args)).toBe(false);
  });
  it('命令预测可省略，执行工具保留严格校验', () => {
    expect(isValid(TOOL_SPECS.sh.parameters, { cmd: 'printf done' })).toBe(true);
    expect(isValid(TOOL_SPECS.sh.parameters, { cmd: 'printf done', expect: 'done' })).toBe(true);
    expect(isValid(TOOL_SPECS.sh.parameters, { cmd: 'printf done', mode: 'look' })).toBe(false);
    expect(isValid(TOOL_SPECS.deliver.parameters, { claim: '已完成一部分' })).toBe(true);
  });
  it('Watcher 只提交方向和一层证据，拒绝图字段和嵌套尝试', () => {
    const input: SubmitWatchInput = {
      standing: '核对入口',
      advice: '',
      directions: [
        {
          id: 'entry',
          direction: '入口行为',
          status: 'works',
          result: '实测返回响应',
          evidence: ['o42'],
        },
      ],
    };
    const schema = TOOL_SPECS.submitWatch.parameters;
    expect(isValid(schema, input)).toBe(true);
    const { evidence: _evidence, ...missingEvidence } = input.directions![0]! as Extract<
      NonNullable<SubmitWatchInput['directions']>[number],
      { status: string }
    >;
    expect(isValid(schema, { ...input, directions: [missingEvidence] })).toBe(false);
    expect(isValid(schema, { ...input, directions: [{ id: 'entry', retired: true }] })).toBe(true);
    for (const tension of [[], ['前一个判断', '与前一个矛盾的判断']])
      expect(isValid(schema, { ...input, tension })).toBe(true);
    for (const tension of [['单句疑点'], ['甲', '乙', '丙']])
      expect(isValid(schema, { ...input, tension })).toBe(false);
    for (const extra of [
      { attempts: [] },
      { newAttempts: [] },
      { inMap: 'angle' },
      { dependsOn: [] },
      { kind: 'direction' },
      { api: 'GET /' },
    ])
      expect(isValid(schema, { ...input, directions: [{ ...input.directions![0], ...extra }] })).toBe(false);
    expect(watchFromArgs(input)).toMatchObject({
      directions: [{ evidence: ['o42'], attempts: [] }],
      tension: [],
    });
    expect(watchFromArgs({ standing: input.standing, advice: '' })).toEqual({
      standing: input.standing,
      advice: '',
      directions: [],
      tension: [],
    });
  });
  it('Watcher 画像仅在完整 telemetry 内提交', () => {
    const input = { standing: '当前假设', advice: '' };
    const profile = {
      tags: ['web'],
      hasSource: null,
      attachmentScale: 'unknown',
      estimatedMinutes: null,
      confidence: 0.5,
    };
    const telemetry = {
      stage: 'analysis',
      trajectory: 'unknown',
      bottleneck: 'unknown',
      confidence: 0.5,
      evidence: ['o42'],
      profile,
    };
    const schema = TOOL_SPECS.submitWatch.parameters;
    expect(isValid(schema, { ...input, profile })).toBe(false);
    expect(isValid(schema, { ...input, telemetry: { profile } })).toBe(false);
    expect(isValid(schema, { ...input, telemetry })).toBe(true);
    expect(isValid(schema, { ...input, telemetry: null })).toBe(true);
    for (const key of ['stage', 'trajectory', 'bottleneck', 'confidence', 'evidence']) {
      const partial = { ...telemetry } as Record<string, unknown>;
      delete partial[key];
      expect(isValid(schema, { ...input, telemetry: partial })).toBe(false);
    }
  });
  it('证据短码从本轮冻结目录选择，别的分支或非观测序号不进入声明', () => {
    const schema = watcherTools(['o42', 'o47']).find((tool) => tool.name === 'observation_submit')!.parameters;
    const input = {
      standing: '检查',
      advice: '',
      directions: [{ id: 'check', direction: '检查', status: 'works', result: '有结果', evidence: ['o42'] }],
    };
    expect(isValid(schema, input)).toBe(true);
    for (const ref of ['o41', 'o43', 'o46', 'o48'])
      expect(isValid(schema, { ...input, directions: [{ ...input.directions[0], evidence: [ref] }] })).toBe(false);
  });
});
