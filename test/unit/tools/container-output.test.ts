// exec 输出的收集：只留头尾、找结束标记（标记切在任意位置都认得出来）、标记之后的丢掉。
import { describe, expect, it } from 'vitest';
import { contentionOf, OutputCollector } from '../../../src/tools/container-output.ts';

const SENTINEL = '\nMELINA-EXIT-0123456789abcdef ';

function collect(chunks: (string | Buffer)[], opts: { head?: number; tail?: number; sentinel?: string } = {}) {
  const c = new OutputCollector({
    headBytes: opts.head ?? 1024,
    tailBytes: opts.tail ?? 1024,
    sentinel: opts.sentinel,
  });
  for (const chunk of chunks) c.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return c;
}

describe('OutputCollector', () => {
  it('没有标记时原样收集', () => {
    const c = collect(['hello ', 'world']);
    c.end();
    expect(c.result()).toEqual({ head: 'hello world', tail: '', omitted: 0, total: 11 });
    expect(c.done).toBe(false);
  });

  it('只留开头和结尾，记下省略了多少', () => {
    const c = collect(['a'.repeat(10), 'b'.repeat(100), 'c'.repeat(10)], { head: 10, tail: 10 });
    c.end();
    expect(c.result()).toEqual({ head: 'a'.repeat(10), tail: 'c'.repeat(10), omitted: 100, total: 120 });
  });

  it('结尾一段跨很多小块也只留最后那几个字节', () => {
    const chunks = Array.from({ length: 50 }, (_, i) => String(i % 10));
    const c = collect(chunks, { head: 3, tail: 5 });
    c.end();
    const r = c.result();
    expect(r.head).toBe('012');
    expect(r.tail).toBe('56789');
    expect(r.omitted).toBe(42);
  });

  it('找到结束标记：读出退出码，标记之后的内容丢掉', () => {
    const c = collect([`out1\nout2${SENTINEL}3\nleftover from a child`], { sentinel: SENTINEL });
    expect(c.done).toBe(true);
    expect(c.exitCode).toBe(3);
    expect(c.result().head).toBe('out1\nout2');
    c.push(Buffer.from('more leftover'));
    expect(c.result().head).toBe('out1\nout2');
  });

  it('标记切在任何位置都认得出来', () => {
    const text = `前面的输出${SENTINEL}137\n`;
    const bytes = Buffer.from(text);
    for (let cut = 1; cut < bytes.length; cut++) {
      const c = collect([bytes.subarray(0, cut), bytes.subarray(cut)], { sentinel: SENTINEL });
      expect(c.done, `切在第 ${cut} 个字节`).toBe(true);
      expect(c.exitCode).toBe(137);
      expect(c.result().head).toBe('前面的输出');
    }
  });

  it('一个字节一个字节地来也行', () => {
    const bytes = Buffer.from(`x${SENTINEL}0\n`);
    const c = new OutputCollector({ headBytes: 100, tailBytes: 100, sentinel: SENTINEL });
    for (const b of bytes) c.push(Buffer.from([b]));
    expect(c.done).toBe(true);
    expect(c.exitCode).toBe(0);
    expect(c.result().head).toBe('x');
  });

  it('像标记又不是标记的内容照常算进输出', () => {
    const c = collect(['\nMELINA-EXIT-0123456789abcdeX 5\n', '\nMELINA-EXIT-'], { sentinel: SENTINEL });
    c.end();
    expect(c.done).toBe(false);
    expect(c.result().head).toBe('\nMELINA-EXIT-0123456789abcdeX 5\n\nMELINA-EXIT-');
  });

  it('流结束时退出码后面没有换行也照读', () => {
    const c = collect([`ok${SENTINEL}42`], { sentinel: SENTINEL });
    expect(c.done).toBe(false);
    c.end();
    expect(c.done).toBe(true);
    expect(c.exitCode).toBe(42);
  });

  it('退出码后面跟着 cgroup 计数的增量：读出来；读不到的 - 和对不上的负数当没读到', () => {
    const c = collect([`out${SENTINEL}3 37 0 2500000\n`], { sentinel: SENTINEL });
    expect(c.exitCode).toBe(3);
    expect(c.counters).toEqual({ pidsMax: 37, oomKills: 0, cpuUs: 2_500_000 });
    expect(c.result().head).toBe('out');

    const partial = collect([`${SENTINEL}0 - 1 -5\n`], { sentinel: SENTINEL });
    expect(partial.exitCode).toBe(0);
    expect(partial.counters).toEqual({ oomKills: 1 });

    const plain = collect([`${SENTINEL}2\n`], { sentinel: SENTINEL });
    expect(plain.exitCode).toBe(2);
    expect(plain.counters).toBeUndefined();

    const broken = collect([`${SENTINEL}0 1 2\n`], { sentinel: SENTINEL });
    expect(broken.exitCode).toBeUndefined();
  });

  it('计数换成撞到的资源上限：等 CPU 的微秒数按用时折成比例，最多 1；三项都没读到就没有', () => {
    expect(contentionOf({ pidsMax: 37, oomKills: 0, cpuUs: 2_500_000 }, 5000, 'host')).toEqual({
      scope: 'host',
      pidsMax: 37,
      oomKills: 0,
      cpuWait: 0.5,
    });
    expect(contentionOf({ cpuUs: 9_000_000 }, 1000, 'container')).toEqual({ scope: 'container', cpuWait: 1 });
    expect(contentionOf({ cpuUs: 10 }, 0, 'container')).toBeUndefined();
    expect(contentionOf({}, 1000, 'container')).toBeUndefined();
    expect(contentionOf(undefined, 1000, 'container')).toBeUndefined();
  });

  it('截断处不把多字节字符切成乱码', () => {
    const c = collect(['中文中文', 'x'.repeat(50), '结尾结尾'], { head: 7, tail: 7 });
    c.end();
    const r = c.result();
    expect(r.head).toBe('中文'); // 第 7 个字节在第三个字中间，去掉半个字
    expect(r.tail).toBe('结尾'); // 开头半个字去掉
    expect(r.head).not.toContain('�');
    expect(r.tail).not.toContain('�');
  });
});
