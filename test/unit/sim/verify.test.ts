// 验世界的口径：这几份对照能不能证明检查判得准。标准解、直接的做法自己出错的，直接的做法什么都没交的，都算不合格；
// 带 UTF-8 BOM 的 JSON 交付照收（环境的接口也收）。

import { describe, expect, it } from 'vitest';
import { parseJson } from '../../sim/task.ts';
import { qualified } from '../../sim/verify.ts';

const pass = { pass: true, summary: '按 9 下到 RUN' };
const wrong = { pass: false, summary: '按完停在 316，目标是 420' };
const nothing = { pass: false, summary: '工作目录里没有 procedure.json' };

describe('qualified', () => {
  it('标准解过、没动过的不过、直接的做法交了东西也不过：合格', () => {
    expect(qualified('medium', pass, wrong, nothing)).toBe(true);
  });

  it('标准解交对了却抛了错：解题的代码坏了，不合格', () => {
    expect(qualified('medium', { ...pass, error: 'boom' }, wrong, nothing)).toBe(false);
  });

  it('直接的做法抛错、或者什么都没交：证明不了藏起来的部分真要摸清，不合格', () => {
    expect(qualified('hard', pass, { ...wrong, error: 'TypeError: x' }, nothing)).toBe(false);
    expect(qualified('hard', pass, nothing, nothing)).toBe(false);
  });

  it('简单题不要求直接的做法不过；没动过的过了、标准解没过都不合格', () => {
    expect(qualified('easy', pass, pass, nothing)).toBe(true);
    expect(qualified('easy', pass, pass, pass)).toBe(false);
    expect(qualified('easy', wrong, wrong, nothing)).toBe(false);
  });
});

describe('parseJson', () => {
  it('开头带 UTF-8 BOM 的照收（环境的接口先 trim 掉了它）；不合法的照旧报', () => {
    expect(parseJson(`${String.fromCharCode(0xfeff)}{"a":1}`, 'x.json')).toEqual({ value: { a: 1 } });
    expect(parseJson('{"a":1}', 'x.json')).toEqual({ value: { a: 1 } });
    expect(parseJson('{a:1}', 'x.json')).toMatchObject({ error: expect.stringContaining('x.json 不是合法的 JSON') });
  });
});
