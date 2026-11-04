// SSE 解析：块切在哪儿都行，CRLF、多行 data、注释心跳、id。

import { describe, expect, it } from 'vitest';
import { type SseMessage, SseParser } from '../../eval/sse.ts';

function parseAll(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const p = new SseParser((m) => out.push(m));
  for (const c of chunks) p.push(c);
  return out;
}

describe('SseParser', () => {
  const stream = ': ping\n\nid: 1\ndata: {"a":1}\n\nid: 2\ndata: line1\ndata: line2\n\n';

  it('按空行分消息，注释跳过，多行 data 用换行接起来', () => {
    expect(parseAll([stream])).toEqual([
      { id: '1', data: '{"a":1}' },
      { id: '2', data: 'line1\nline2' },
    ]);
  });

  it('一个字节一个字节地喂结果一样；CRLF 和 CR 也认', () => {
    expect(parseAll(stream.split(''))).toEqual(parseAll([stream]));
    const crlf = stream.replace(/\n/g, '\r\n');
    expect(parseAll(crlf.split(''))).toEqual(parseAll([stream]));
    expect(parseAll([stream.replace(/\n/g, '\r')])).toEqual(parseAll([stream]));
  });

  it('\\r 结尾的块后面单独来一个 \\n 算同一个换行，再来一个 \\n 才是空行', () => {
    expect(parseAll(['data: {"a":1}\r', '\n', '\n', 'data: {"b":2}\n\n'])).toEqual([
      { data: '{"a":1}' },
      { data: '{"b":2}' },
    ]);
  });

  it('没 data 的消息不发；冒号后面只去掉一个空格', () => {
    expect(parseAll(['id: 5\n\n', 'data:  x\n\n'])).toEqual([{ id: '5', data: ' x' }]);
  });
});
