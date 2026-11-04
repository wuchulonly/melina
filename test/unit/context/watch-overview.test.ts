import { describe, expect, it } from 'vitest';
import { packWatchOverview } from '../../../src/context/watch-overview.ts';

describe('原生 Markdown 观察首屏', () => {
  it('原样保留换行、引号、反斜线和 Unicode，按实际 UTF-8 字节装箱', () => {
    const text = `# 执行结果\n\n${'"key": "路径\\file"\n🚀'.repeat(1500)}`;
    const header = '# 本轮状态';
    const expected = `${header}\n\n[证据ID: o42]\n${text}`;
    const packet = packWatchOverview(
      [{ text, preview: '执行结果…', ref: 'o42', execution: true, covers: [42] }],
      Buffer.byteLength(expected, 'utf8'),
      header,
    );
    expect(packet.content).toBe(expected);
    expect(packet.covered).toEqual([42]);
    expect(packet.delivered).toEqual([42]);
    expect(packet.content).not.toContain('covered');
    expect(() => JSON.parse(packet.content)).toThrow();
  });

  it('长提示摘要即可推进宿主进度，原文仅按需展开', () => {
    const packet = packWatchOverview(
      [
        { text: '人的完整要求'.repeat(1000), preview: '人的要求…', covers: [1], ref: 'hint', hint: true },
        { text: '后续执行', preview: '后续执行', covers: [2], ref: 'o2', execution: true },
      ],
      512,
      '# 本轮状态',
    );
    expect(Buffer.byteLength(packet.content)).toBeLessThanOrEqual(512);
    expect(packet.content).toContain('# 可按需展开的要求\n\n- hint');
    expect(packet.covered).toEqual([1, 2]);
    expect(packet.delivered).toEqual([1, 2]);
    expect(packet.inspectContext).toEqual(['hint']);
  });
});
