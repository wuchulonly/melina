// 托管前端：web/ 打包出来的 dist 目录。
// - /api 以外认不出的 GET 路径回 index.html：/runs/xxx、/models 这些是前端自己的路由；
// - /assets/ 下的文件名带内容哈希，长缓存；index.html 不缓存，换版本马上生效；
// - 页面带 CSP：脚本只许本站的，样式允许内联（KaTeX 的排版用 style 属性），不许被别的网站用 iframe 套（防点击劫持）。

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PAGE_HEADERS = {
  'Content-Security-Policy': PAGE_CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** 前端还没打包时首页显示的说明 */
const PLACEHOLDER = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Melina</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.6">
<h1>Melina 在运行</h1>
<p>前端还没打包，所以这里没有页面。在仓库里跑 <code>pnpm --dir web build</code>，再刷新这一页。</p>
<p>HTTP 接口在 <code>/api</code> 下，照常可以用。</p>
</body></html>`;

/** 返回 undefined 表示交给下一个处理（比如 404） */
export async function serveWeb(root: string | undefined, path: string, method: string): Promise<Response | undefined> {
  if (method !== 'GET' && method !== 'HEAD') return undefined;
  const head = method === 'HEAD';
  if (!root) return page(PLACEHOLDER, head);
  const base = resolve(root);
  const file = safeJoin(base, path);
  if (file) {
    const st = await stat(file).catch(() => undefined);
    if (st?.isFile()) {
      const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      const immutable = path.startsWith('/assets/');
      const headers: Record<string, string> = {
        'Content-Type': type,
        'Content-Length': String(st.size),
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(type.startsWith('text/html') ? PAGE_HEADERS : { 'X-Content-Type-Options': 'nosniff' }),
      };
      const body = head ? null : (Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>);
      return new Response(body, { status: 200, headers });
    }
  }
  // 带扩展名的（/assets/xxx.js、/favicon.ico）找不到就是找不到，不回 index.html
  if (extname(path) !== '' || path.startsWith('/assets/')) return undefined;
  const index = await readFile(join(base, 'index.html'), 'utf8').catch(() => undefined);
  return page(index ?? PLACEHOLDER, head);
}

function page(html: string, head: boolean): Response {
  return new Response(head ? null : html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...PAGE_HEADERS },
  });
}

/** URL 路径对到 root 下的文件；想跳出 root 的返回 undefined */
function safeJoin(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const target = normalize(join(root, decoded));
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return target;
}
