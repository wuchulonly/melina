// 大的 JSON 响应用 gzip 压，减少远程访问的数据传输量。规矩：
// - 只压 application/json；客户端的 Accept-Encoding 允许 gzip，而且超过 GZIP_MIN_BYTES 才压（小的压了也省不了什么）；
// - SSE（text/event-stream）不压：事件要一条条马上推出去，压就得攒（SSE_HEADERS 也带着 no-transform）；
// - 产物下载（/artifacts）不压：照原样给，Content-Length、HEAD、附件下载和 nosniff、CSP sandbox 这些头都不动，
//   内容寻址、长缓存，一个浏览器同一份只下一次；
// - 用 node:zlib 的异步 gzip，在线程池里压，不占事件循环。

import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

/** 超过这么多字节才压 */
export const GZIP_MIN_BYTES = 8 * 1024;

const gzipAsync = promisify(gzip);

/** 把一段文字或字节压成 gzip（异步，在线程池里） */
export function gzipBytes(body: string | Uint8Array): Promise<Buffer> {
  return gzipAsync(body);
}

/** Buffer 当响应体：不拷贝，换个类型（zlib 压出来的 Buffer 底下是普通的 ArrayBuffer） */
function view(b: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);
}

/** Accept-Encoding 允不允许 gzip：明写 gzip 看它的 q，没写看 *，q=0 是不要（RFC 9110 .3） */
export function acceptsGzip(header: string | null | undefined): boolean {
  if (!header) return false;
  let star: number | undefined;
  for (const part of header.split(',')) {
    const [name = '', ...params] = part.split(';').map((s) => s.trim());
    const q = qValue(params);
    const coding = name.toLowerCase();
    if (coding === 'gzip' || coding === 'x-gzip') return q > 0;
    if (coding === '*') star = q;
  }
  return star !== undefined && star > 0;
}

function qValue(params: readonly string[]): number {
  for (const p of params) {
    const m = /^q\s*=\s*([0-9.]+)$/i.exec(p);
    if (m) {
      const q = Number(m[1]);
      return Number.isFinite(q) ? q : 0;
    }
  }
  return 1;
}

function isJson(contentType: string | null): boolean {
  return contentType !== null && /^application\/json\b/i.test(contentType.trim());
}

/** 往 Vary 里加一项（已经有了就不加） */
export function addVary(headers: Headers, field: string): void {
  const current = headers.get('Vary');
  if (current === '*') return;
  const fields = (current ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (fields.includes(field.toLowerCase())) return;
  headers.set('Vary', current ? `${current}, ${field}` : field);
}

/** 中间件：handler 回的 JSON 按上面的规矩压；已经压过的（带 Content-Encoding）、不是 JSON 的原样放过 */
export function compressJson(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (c.req.method === 'HEAD' || !res.body || res.status < 200 || res.status === 204 || res.status === 206) return;
    if (res.headers.has('Content-Encoding') || !isJson(res.headers.get('Content-Type'))) return;
    if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(res.headers.get('Cache-Control') ?? '')) return;
    addVary(res.headers, 'Accept-Encoding');
    if (!acceptsGzip(c.req.header('Accept-Encoding'))) return;
    const body = new Uint8Array(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    headers.delete('Content-Length');
    if (body.byteLength < GZIP_MIN_BYTES) {
      c.res = new Response(body, { status: res.status, headers });
      return;
    }
    const zipped = await gzipBytes(body);
    headers.set('Content-Encoding', 'gzip');
    headers.set('Content-Length', String(zipped.byteLength));
    c.res = new Response(view(zipped), { status: res.status, headers });
  };
}
