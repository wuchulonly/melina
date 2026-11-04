// 凭证脱敏：原值和几种常见变形都换掉，太短的不换，老容器手里的旧值换到容器删掉为止。
import { describe, expect, it } from 'vitest';
import type { ResolvedCredential } from '../../../src/core/interfaces/container.ts';
import { MIN_SECRET_LENGTH, SecretRedactor, variantsOf } from '../../../src/tools/redact.ts';

const cred = (name: string, value: string, as: ResolvedCredential['as'] = { env: 'TOKEN' }): ResolvedCredential => ({
  id: '01J00000000000000000000000',
  name,
  as,
  value,
});

describe('SecretRedactor', () => {
  it('把配置过的凭证值换成带名字的占位符', () => {
    const r = new SecretRedactor();
    r.update([cred('GitHub token', 'ghp_abcdef1234567890')]);
    expect(r.redact('Authorization: token ghp_abcdef1234567890\nok')).toBe(
      'Authorization: token [凭证「GitHub token」已隐藏]\nok',
    );
    expect(r.redact('没有凭证的输出')).toBe('没有凭证的输出');
  });

  it('太短的值不换，只提醒一次', () => {
    const warnings: string[] = [];
    const r = new SecretRedactor({ onWarn: (m) => warnings.push(m) });
    r.update([cred('短', 'abc'), cred('也短', 'x'.repeat(MIN_SECRET_LENGTH - 1))]);
    r.update([cred('短', 'abc')]);
    expect(r.redact('abc true 1234')).toBe('abc true 1234');
    expect(warnings).toHaveLength(2);
    expect(r.size).toBe(0);
  });

  it('换掉常见变形：去掉首尾空白、多行值的每一行、URL 编码、JSON 转义、base64', () => {
    const pem = '-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END KEY-----\n';
    const r = new SecretRedactor();
    r.update([cred('私钥', pem, { file: '/run/secrets/key' }), cred('密码', 'p@ss word/1&2')]);
    const text = [
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', // 只打出其中一行
      JSON.stringify({ key: pem.trim() }), // JSON 里转义过的
      `https://u:${encodeURIComponent('p@ss word/1&2')}@example.com`, // URL 编码
      Buffer.from('p@ss word/1&2').toString('base64'), // base64
    ].join('\n');
    const out = r.redact(text);
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(out).not.toContain('BKcwggSjAgEAAoIBAQC7');
    expect(out).not.toContain(encodeURIComponent('p@ss word/1&2'));
    expect(out).not.toContain(Buffer.from('p@ss word/1&2').toString('base64').replace(/=+$/, ''));
    expect(out).toContain('[凭证「私钥」已隐藏]');
    expect(out).toContain('[凭证「密码」已隐藏]');
  });

  it('base64 里的凭证不管前后挨着什么都换掉（Basic 认证、docker 的 auth、token:x-oauth-basic）', () => {
    for (const secret of ['ghp_0123456789abcdefXYZ', 'ghp_0123456789abcdefXY', 'ghp_0123456789abcdefX']) {
      const r = new SecretRedactor();
      r.update([cred('t', secret)]);
      for (const raw of [`user:${secret}`, `oauth2:${secret}`, `${secret}:x-oauth-basic`, `a:${secret}:b`]) {
        const b64 = Buffer.from(raw).toString('base64');
        const out = r.redact(`Authorization: Basic ${b64}`);
        expect(out, `${raw}（${secret.length} 个字符）`).toContain('[凭证「t」已隐藏]');
        // 留下的 base64 解出来不再含完整的凭证
        const rest = out.replace('Authorization: Basic ', '').replace(/\[凭证「t」已隐藏\]/g, '');
        expect(Buffer.from(rest, 'base64').toString('latin1')).not.toContain(secret);
      }
      // URL 安全的 base64（JWT 这类）
      const urlSafe = Buffer.from(`{"k":"${secret}"}`).toString('base64url');
      expect(r.redact(urlSafe)).toContain('[凭证「t」已隐藏]');
    }
  });

  it('一个值是另一个的前缀时取长的', () => {
    const r = new SecretRedactor();
    r.update([cred('短的', 'secret-123'), cred('长的', 'secret-123-extended')]);
    expect(r.redact('a secret-123-extended b secret-123 c')).toBe('a [凭证「长的」已隐藏] b [凭证「短的」已隐藏] c');
  });

  it('再脱敏一遍不变', () => {
    const r = new SecretRedactor();
    r.update([cred('t', 'tok_9f8e7d6c5b4a')]);
    const once = r.redact('x tok_9f8e7d6c5b4a y');
    expect(r.redact(once)).toBe(once);
  });

  it('设置改了：容器手里的旧值照样换，容器删掉以后才不换', () => {
    const r = new SecretRedactor();
    r.update([cred('t', 'old-value-111')]);
    r.hold('melina-run-branch', [{ name: 't', value: 'old-value-111' }]);
    r.update([cred('t', 'new-value-222')]);
    expect(r.redact('old-value-111 new-value-222')).toBe('[凭证「t」已隐藏] [凭证「t」已隐藏]');
    r.release('melina-run-branch');
    expect(r.redact('old-value-111 new-value-222')).toBe('old-value-111 [凭证「t」已隐藏]');
  });

  it('截断处切在凭证中间：开头一段末尾的前半截、结尾一段开头的后半截也换掉', () => {
    const r = new SecretRedactor();
    r.update([cred('t', 'abcdefghijklmnop')]);
    const { head, tail } = r.redactCut('前面 abcdefgh', 'ijklmnop 后面');
    expect(head).toBe('前面 [凭证「t」已隐藏]');
    expect(tail).toBe('[凭证「t」已隐藏] 后面');
    // 太短的半截不动（少于 MIN_SECRET_LENGTH 个字符）
    expect(r.redactCut('前面 abc', 'nop 后面')).toEqual({ head: '前面 abc', tail: 'nop 后面' });
  });
});

describe('variantsOf', () => {
  it('都不短于 MIN_SECRET_LENGTH，不重复', () => {
    const v = variantsOf('  line-one-long\nab\nline-three-long  ');
    expect(v.every((x) => x.length >= MIN_SECRET_LENGTH)).toBe(true);
    expect(new Set(v).size).toBe(v.length);
    expect(v).toContain('line-one-long');
    expect(v).toContain('line-three-long');
    expect(v).not.toContain('ab');
  });

  it('登记的是 JSON 里转义过的写法（服务账号文件的私钥）：jq -r 打出来的解开转义的样子也遮', () => {
    const lines = [
      `-----BEGIN ${'PRIVATE'} KEY-----`,
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
      'MZw2u3JfnI0bCxqRvT8sP2w9xYz1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
      `-----END ${'PRIVATE'} KEY-----`,
      '',
    ];
    const escaped = JSON.stringify(lines.join('\n')).slice(1, -1); // 文件里 "private_key" 的样子
    const r = new SecretRedactor();
    r.hold('run:1', [{ name: 'credentials.json 里的 private_key', value: escaped }]);
    const printed = r.redact(lines.join('\n')); // jq -r .private_key
    expect(printed).not.toContain(lines[1]);
    expect(printed).not.toContain(lines[2]);
  });
});
