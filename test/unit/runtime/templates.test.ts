import { describe, expect, it } from 'vitest';
import { bet0Draft, literalScope, SCOPED_NOTICE_HEAD, scopedNotice } from '../../../src/runtime/templates.ts';
import { COMPLETION, STRONG } from './kit.ts';

describe('Bet 0 路线提示', () => {
  it('只在目标、约束或环境有新内容时补充', () => {
    expect(scopedNotice({ constraints: [], setup: '  ' })).toBeUndefined();
    const text = scopedNotice({ constraints: ['不改业务代码'], sharedSystems: ['订单库'], setup: 'pnpm install' });
    expect(text?.startsWith(SCOPED_NOTICE_HEAD)).toBe(true);
    expect(text).toContain('不改业务代码');
    expect(text).toContain('订单库');
    expect(text).toContain('pnpm install');
  });
  it('明确领域切换只保留工作区文件', () => {
    const text = scopedNotice({ constraints: [], domain: 'research' });
    expect(text).toContain('下一轮开始时使用该领域的镜像');
    expect(text).toContain('后台进程和另装的依赖不保留');
  });
  it('完成标准保留编号和精确指标，不要求模型填写证据协议', () => {
    const text = scopedNotice({
      completion: { ...COMPLETION, metric: { name: '冷启动', unit: 'ms', better: 'lower', target: 0.1 + 0.2 } },
      constraints: [],
    });
    expect(text).toContain('1. 覆盖率不低于 80%');
    expect(text).toContain('2. 测试全过');
    expect(text).toContain('目标 0.3');
    expect(text).toContain('外部验收通过后再交最终结果');
    expect(text).not.toContain('checks');
    expect(text).not.toContain('Fact');
  });
  it('开局卡只定义模型和快照', () => {
    expect(bet0Draft(STRONG)).toEqual({
      kind: 'direct',
      label: '主干直解路线',
      startFrom: { snapshot: 'root' },
      model: STRONG,
    });
  });
  it('Scoper 降级按目标字面理解并选择可用领域', () => {
    expect(literalScope('冷启动降到 200 ms', ['code', 'general'])).toEqual({
      completion: { interpretation: '按字面理解', criteria: ['冷启动降到 200 ms'] },
      constraints: [],
      domain: 'general',
    });
    expect(literalScope('写调研', ['research', 'code']).domain).toBe('research');
  });
});
