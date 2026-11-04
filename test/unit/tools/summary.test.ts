// 大输出的摘要和容器里的路径检查。纯函数。

import { describe, expect, it } from 'vitest';
import { containerPath, displayPath, shQuote } from '../../../src/tools/paths.ts';
import { preview, splitLines, structureOutline, summarize } from '../../../src/tools/summary.ts';

describe('summarize', () => {
  it('放得下就原样给', () => {
    expect(summarize('a\nb\n', { maxTokens: 100, path: '/melina/artifacts/x' })).toEqual({
      inline: true,
      text: 'a\nb\n',
    });
  });

  it('放不下：大小、只读路径、开头和结尾，中间省略几行写明', () => {
    const raw = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    const s = summarize(raw, { maxTokens: 100, path: '/melina/artifacts/ab/abc' });
    expect(s.inline).toBe(false);
    expect(s.text).toMatch(
      /^输出共 1000 行、[\d.]+ KB，太长了，下面只有开头和结尾；原文在 \/melina\/artifacts\/ab\/abc（只读）/,
    );
    expect(s.text).toContain('--- 开头 ---\nline 1\nline 2');
    expect(s.text).toMatch(/--- 结尾 ---\n[\s\S]*line 1000$/);
    expect(s.text).toMatch(/……（中间 \d+ 行没有显示）……/);
  });

  it('一行就超了：按字符截，写明还剩多少', () => {
    const raw = 'x'.repeat(10_000);
    const s = summarize(raw, { maxTokens: 100, path: '/p' });
    expect(s.text).toMatch(/x+…（这一行还有 \d+ 个字符）/);
    expect(s.text.length).toBeLessThan(1000);
  });

  it('中文按一字一个 token 算', () => {
    const raw = '汉'.repeat(150);
    expect(summarize(raw, { maxTokens: 200, path: '/p' }).inline).toBe(true);
    expect(summarize(raw, { maxTokens: 100, path: '/p' }).inline).toBe(false);
  });
});

describe('structureOutline', () => {
  it('JSON 对象：键名、类型、数组长度和元素的键', () => {
    const outline = structureOutline(JSON.stringify({ items: [{ id: 1, tags: ['a'] }], total: 1, meta: { page: 2 } }));
    expect(outline).toBe(
      [
        'JSON 结构：',
        '整体：对象，3 个键',
        '  .items：数组，长度 1，元素是对象',
        '    .items[].id：数字',
        '    .items[].tags：数组，长度 1，元素是字符串',
        '  .total：数字',
        '  .meta：对象，1 个键',
        '    .meta.page：数字',
      ].join('\n'),
    );
  });

  it('JSON Lines：行数和第一行的结构', () => {
    const outline = structureOutline('{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n');
    expect(outline).toBe(
      ['JSON Lines：2 行，第一行：', '  整体：对象，2 个键', '    .a：数字', '    .b：字符串'].join('\n'),
    );
  });

  it('不是 JSON 就没有', () => {
    expect(structureOutline('hello')).toBeUndefined();
    expect(structureOutline('{ not json')).toBeUndefined();
    expect(structureOutline('42')).toBeUndefined();
  });
});

describe('preview、splitLines', () => {
  it('太长的字符串只留开头，写明一共多少字', () => {
    expect(preview('短的')).toBe('短的');
    expect(preview('长'.repeat(30), 10)).toBe(`${'长'.repeat(10)}…（共 30 个字符）`);
  });

  it('最后一个换行后面没内容时不算一行', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });
});

describe('containerPath', () => {
  const read = { allowMelina: true, file: false };
  const write = { allowMelina: false, file: true };

  it('相对路径按 /workspace 算，规范化', () => {
    expect(containerPath('src/a.ts', write)).toEqual({ ok: true, path: '/workspace/src/a.ts' });
    expect(containerPath('./src/../b.ts', write)).toEqual({ ok: true, path: '/workspace/b.ts' });
    expect(containerPath('/workspace/x/', read)).toEqual({ ok: true, path: '/workspace/x' });
  });

  it('read 能读 /melina 下的，edit、write 不行；跑出 workspace 的都不行', () => {
    expect(containerPath('/melina/materials/a.md', read)).toEqual({ ok: true, path: '/melina/materials/a.md' });
    expect(containerPath('/melina/materials/a.md', write).ok).toBe(false);
    for (const p of ['/etc/passwd', '../x', '/workspace/../etc', '/workspacefoo/a', '/kingdom/a', '']) {
      expect(containerPath(p, read).ok, p).toBe(false);
    }
    expect(containerPath('/workspace', write).ok).toBe(false);
    expect(containerPath('/workspace', read).ok).toBe(true);
    expect(containerPath('a\0b', read).ok).toBe(false);
  });

  it('displayPath：workspace 里的写成相对路径', () => {
    expect(displayPath('/workspace/src/a.ts')).toBe('src/a.ts');
    expect(displayPath('/workspace')).toBe('.');
    expect(displayPath('/melina/materials/a.md')).toBe('/melina/materials/a.md');
  });

  it('shQuote：单引号里的单引号', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
});
