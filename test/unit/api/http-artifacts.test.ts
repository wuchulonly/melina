import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { GZIP_MIN_BYTES } from '../../../src/api/compress.ts';
import { sha256OfHandle } from '../../../src/core/ids.ts';
import { type TestMelina, testMelina } from './kit.ts';

let k: TestMelina, runId: string;
beforeAll(async () => {
  k = await testMelina();
  runId = (await k.runs.create({ statement: '长文本'.repeat(4000), materials: [] })).id;
});
afterAll(async () => {
  await k.close();
});
it.each(['文本', '二进制'] as const)('产物下载保留 %s 内容与隔离响应头', async (kind) => {
  const binary = kind === '二进制',
    body = binary ? Buffer.from([60, 104, 116, 109, 108, 62, 0, 255]) : Buffer.from('<script>正文</script>');
  const handle = await k.runs.deps.artifacts.put(runId, body),
    path = `/api/runs/${runId}/artifacts/${sha256OfHandle(handle)}`;
  const result = await k.request(path);
  expect(result.status).toBe(200);
  expect(result.headers.get('x-content-type-options')).toBe('nosniff');
  expect(result.headers.get('content-security-policy')).toBe('sandbox');
  expect(result.headers.get('cache-control')).toContain('immutable');
  expect(result.headers.get('content-type')).toBe(binary ? 'application/octet-stream' : 'text/plain; charset=utf-8');
  expect(result.headers.get('content-disposition')).toBe(binary ? 'attachment' : null);
  expect(Buffer.from(await result.arrayBuffer())).toEqual(body);
  const head = await k.request(path, { method: 'HEAD' });
  expect(head.headers.get('content-length')).toBe(String(body.byteLength));
  expect((await head.arrayBuffer()).byteLength).toBe(0);
});
it('大产物保持原样下载，非法句柄和不存在的产物给出错误状态', async () => {
  const body = '输出正文\n'.repeat(4000),
    handle = await k.runs.deps.artifacts.put(runId, body),
    path = `/api/runs/${runId}/artifacts/${sha256OfHandle(handle)}`;
  const result = await k.request(path, { headers: { 'accept-encoding': 'gzip' } });
  expect(result.headers.get('content-encoding')).toBeNull();
  expect(await result.text()).toBe(body);
  expect((await k.request(`/api/runs/${runId}/artifacts/invalid`)).status).toBe(400);
  expect((await k.request(`/api/runs/${runId}/artifacts/${'0'.repeat(64)}`)).status).toBe(404);
});
it('大 JSON 根据 Accept-Encoding 压缩，q=0 和 HEAD 保持原响应', async () => {
  const path = `/api/runs/${runId}`,
    plain = await k.request(path),
    text = await plain.text();
  expect(Buffer.byteLength(text)).toBeGreaterThan(GZIP_MIN_BYTES);
  const zipped = await k.request(path, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  expect(zipped.headers.get('content-encoding')).toBe('gzip');
  const raw = Buffer.from(await zipped.arrayBuffer());
  expect(gunzipSync(raw).toString()).toBe(text);
  expect(zipped.headers.get('content-length')).toBe(String(raw.byteLength));
  const disabled = await k.request(path, { headers: { 'accept-encoding': 'gzip;q=0' } });
  expect(disabled.headers.get('content-encoding')).toBeNull();
  const head = await k.request(path, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  expect(head.headers.get('content-encoding')).toBeNull();
  expect(await head.text()).toBe('');
});
