// 模型写的一句话怎么拆（lib/model-text.ts）：反引号当代码，像密钥的串打码；别把正常内容打掉。

import { describe, expect, it } from 'vitest';
import { maskSecret, secretSpans, splitModelText } from '../src/lib/model-text.ts';

const secrets = (text: string) => secretSpans(text).map((s) => text.slice(s.start, s.end));

describe('像密钥的串', () => {
  it('附件中的示例 client_secret 在模型文本中被打码', () => {
    const text =
      '订单服务的认证方式：POST /eb07e7f51ea5600d/oauth/token，JSON 体 {"client_id":"melina-eval","client_secret":"sk-0123456789abcdef01234567"}，返回 {"access_token":…,"token_type":"Bearer","expires_in":3600}';
    expect(secrets(text)).toEqual(['sk-0123456789abcdef01234567']);
  });

  it('带前缀的 key、Bearer 后面的串、明确叫密码和 token 的键值', () => {
    expect(secrets('export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234')).toEqual(['sk-proj-abcdefghijklmnop1234']);
    expect(secrets('curl -H "Authorization: Bearer abcdefghijklmnopqrstu.vwxyz"')).toEqual([
      'abcdefghijklmnopqrstu.vwxyz',
    ]);
    expect(secrets('登录用 password=hunter2-correct')).toEqual(['hunter2-correct']);
    expect(secrets("{'api_key': 'AbCdEf123456'}")).toEqual(['AbCdEf123456']);
    expect(secrets('ghp_abcdefghijklmnopqrstuvwxyz0123 和 AKIAABCDEFGHIJKLMNOP')).toEqual([
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'AKIAABCDEFGHIJKLMNOP',
    ]);
  });

  it('正常内容不打码：哈希、提交号、token 用量、短值、键名本身', () => {
    expect(secrets('提交 1ce168d、sha256 6b38626bfb7a81f16854550e1715979118500e385e4e2c82d2ef304b90d86d56')).toEqual(
      [],
    );
    expect(secrets('用了 181 万 token（$0.08），"token_type":"Bearer"')).toEqual([]);
    expect(secrets('password: 123，client_secret 字段要从附件里读')).toEqual([]);
    expect(secrets('任务说 sk-learn 不能用')).toEqual([]);
  });

  it('打码只留开头几个字符', () => {
    expect(maskSecret('sk-0123456789abcdef01234567')).toBe('sk-0••••••');
  });
});

describe('反引号', () => {
  it('成对的反引号当代码，里面的密钥照样打码；落单的照原样', () => {
    expect(splitModelText('写进 `answer.json`，用 `curl -H "Authorization: Bearer abcdefghijklmnopqrst"`')).toEqual([
      { kind: 'text', text: '写进 ' },
      { kind: 'code', parts: [{ kind: 'text', text: 'answer.json' }] },
      { kind: 'text', text: '，用 ' },
      {
        kind: 'code',
        parts: [
          { kind: 'text', text: 'curl -H "Authorization: Bearer ' },
          { kind: 'secret', text: 'abcdefghijklmnopqrst' },
          { kind: 'text', text: '"' },
        ],
      },
    ]);
    expect(splitModelText('只有一个 ` 反引号')).toEqual([{ kind: 'text', text: '只有一个 ` 反引号' }]);
  });
});

describe('记录的编号', () => {
  it('换成上标的小序号，前面的空格一起拿掉；同一个编号同一个序号', () => {
    const parts = splitModelText(
      '但事实 01M3Z66GE1VQG3F8073Y1SHWS0 显示 status 参数，事实 01M3Z66GE1VQG3F8073Y1SHWS0 也说了',
    );
    expect(parts).toEqual([
      { kind: 'text', text: '但事实' },
      { kind: 'ref', text: ' 01M3Z66GE1VQG3F8073Y1SHWS0', id: '01M3Z66GE1VQG3F8073Y1SHWS0', n: 1 },
      { kind: 'text', text: ' 显示 status 参数，事实' },
      { kind: 'ref', text: ' 01M3Z66GE1VQG3F8073Y1SHWS0', id: '01M3Z66GE1VQG3F8073Y1SHWS0', n: 1 },
      { kind: 'text', text: ' 也说了' },
    ]);
  });

  it('几个连着写的按出现先后编号；方括号包着的连括号去掉', () => {
    const text = '（事实 01M3Z504BADCZ7M5VPJK21MPBS、01M3Z504B6JAFH8XTJZ1VQ134R）和 [01M421RWQ8B6TSQ7RKB4E3W2KD]';
    const parts = splitModelText(text);
    expect(parts.flatMap((p) => (p.kind === 'ref' ? [[p.n, p.text]] : []))).toEqual([
      [1, ' 01M3Z504BADCZ7M5VPJK21MPBS'],
      [2, '01M3Z504B6JAFH8XTJZ1VQ134R'],
      [3, ' [01M421RWQ8B6TSQ7RKB4E3W2KD]'],
    ]);
    // 拼回去还是原文（ModelText 拿每段的长度算 key）
    expect(parts.map((p) => (p.kind === 'code' ? '' : p.text)).join('')).toBe(text);
  });

  it('代码里的、不是 01 开头的、小写的提交号都不动', () => {
    expect(splitModelText('跑 `melina show 01M3Z66GE1VQG3F8073Y1SHWS0`').some((p) => p.kind === 'ref')).toBe(false);
    expect(splitModelText('序列号 7ZXK3M9QH2P4RT6WY8B5N1CDFG').some((p) => p.kind === 'ref')).toBe(false);
    expect(splitModelText('提交 9c55bd4e1f0a2b3c4d5e6f708192a3b4c5d6e7f8').some((p) => p.kind === 'ref')).toBe(false);
  });
});
