import { expect, it } from 'vitest';
import { type TextPosition, textPage } from '../../../src/core/text-page.ts';

it('长单行按明确位置重放，计入 JSON 转义和 UTF-8 预算，不切开 Unicode 字符', () => {
  const lines = ['中文🚀"\\'.repeat(1000), '下一行'];
  const fits = (page: unknown) => Buffer.byteLength(JSON.stringify(page), 'utf8') <= 512;
  let position: TextPosition = { offset: 1, column: 0 };
  let recovered = '';
  for (let count = 0; count < 1000; count++) {
    const page = textPage(lines[position.offset - 1]!, position, lines.length, fits);
    expect(textPage(lines[position.offset - 1]!, position, lines.length, fits)).toEqual(page);
    expect(page.text.isWellFormed()).toBe(true);
    expect(fits({ text: page.text, ...(page.next ? { next: page.next } : {}) })).toBe(true);
    if (position.offset === 1) recovered += page.text;
    else expect(page.text).toBe('下一行');
    if (!page.next) break;
    expect(page.next.offset > position.offset || page.next.column > position.column).toBe(true);
    position = page.next;
  }
  expect(recovered).toBe(lines[0]);
  expect(position.offset).toBe(2);
});

it('拒绝行内越界和落在代理对中间的位置', () => {
  expect(() => textPage('🚀', { offset: 1, column: 1 }, 1, () => true)).toThrow('Unicode');
  expect(() => textPage('abc', { offset: 1, column: 4 }, 1, () => true)).toThrow('column');
});

it('完整文本刚好放得下时，不为不存在的下一页预留位置', () => {
  const text = 'a'.repeat(40);
  const page = textPage(text, { offset: 1, column: 0 }, 1, (value) => JSON.stringify(value).length <= 51);
  expect(page.text).toBe(text);
  expect(page.next).toBeUndefined();
});
