import { describe, expect, it } from 'vitest';
import {
  createIdGenerator,
  handleFromSha256,
  handleOf,
  handlePath,
  idTime,
  isHandle,
  isId,
  newId,
  sha256OfHandle,
} from '../../../src/core/ids.ts';

describe('ULID', () => {
  it('26 位 Crockford base32，前 10 位是时间', () => {
    const gen = createIdGenerator({ now: () => 1_790_000_000_000 });
    const id = gen();
    expect(isId(id)).toBe(true);
    expect(idTime(id)).toBe(1_790_000_000_000);
  });

  it('同一毫秒里也严格递增', () => {
    const gen = createIdGenerator({ now: () => 1_790_000_000_000, random: (b) => b.fill(255) });
    const ids = Array.from({ length: 5 }, () => gen());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(5);
  });

  it('时钟回拨时不倒退', () => {
    let t = 1_790_000_000_000;
    const gen = createIdGenerator({ now: () => t });
    const a = gen();
    t -= 1000;
    const b = gen();
    expect(b > a).toBe(true);
  });

  it('默认生成器的 id 合法', () => {
    expect(isId(newId())).toBe(true);
    expect(isId('not-an-id')).toBe(false);
  });
});

describe('Handle', () => {
  it('按内容寻址，相同内容同一个句柄', () => {
    const h = handleOf('hello');
    expect(h).toBe(handleOf(new TextEncoder().encode('hello')));
    expect(isHandle(h)).toBe(true);
    expect(handleFromSha256(sha256OfHandle(h))).toBe(h);
  });

  it('路径是 <前两位>/<sha256>', () => {
    const h = handleOf('x');
    const sha = sha256OfHandle(h);
    expect(handlePath(h)).toBe(`${sha.slice(0, 2)}/${sha}`);
  });

  it('不是 sha256 的拒绝', () => {
    expect(() => handleFromSha256('abc')).toThrow();
    expect(isHandle('art://abc')).toBe(false);
  });
});
