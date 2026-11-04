// 假 Melina 的独立进程：/api 按剧本回放，其余路径托管打包好的前端（--static），找不到的页面回 index.html，
// 和 Melina 进程自己托管前端时一样。Playwright 用它；开发时用 pnpm dev（Vite 里已经挂了同一个假后端）。
//
//   node fake/server.ts [--port 5174] [--speed 5] [--start live|end|begin] [--status ok|trouble]
//

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { createFakeHandler } from './http.ts';
import { FakeMelina, type FakeOptions, type StartPreset } from './melina.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5174' },
    host: { type: 'string', default: '127.0.0.1' },
    speed: { type: 'string', default: '5' },
    start: { type: 'string', default: 'live' },
    status: { type: 'string', default: 'ok' },
    models: { type: 'string', default: 'two' },
    static: { type: 'string' },
  },
});

const options: FakeOptions = {
  speed: Number(values.speed),
  start: values.start as StartPreset,
  status: values.status as FakeOptions['status'],
  models: values.models as FakeOptions['models'],
};
const melina = new FakeMelina(options);
const handle = createFakeHandler(melina);
const serveStatic = values.static ? staticFiles(resolve(values.static)) : undefined;

const server = createServer((req, res) => {
  handle(req, res)
    .then(async (done) => {
      if (done) return;
      if (serveStatic && (await serveStatic(req, res))) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('没有这个页面');
    })
    .catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(error));
    });
});

server.listen(Number(values.port), values.host, () => {
  const where = `http://${values.host}:${values.port}`;
  console.log(`假 Melina 在 ${where}（剧本倍速 ${melina.getSpeed()}，起点 ${values.start}）`);
  if (serveStatic) console.log(`前端：${where}/`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    melina.close();
    server.close();
    server.closeAllConnections();
  });

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** 托管 dist：文件在就给文件；GET 一个不存在的页面路径（/runs/xxx 这种）回 index.html，由前端的路由接手 */
function staticFiles(root: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url ?? '/', 'http://melina.local');
    const file = resolve(join(root, decodeURIComponent(url.pathname)));
    if (file !== root && !file.startsWith(root + sep)) return false;
    const found = await stat(file).catch(() => null);
    const target = found?.isFile() ? file : extname(url.pathname) ? null : join(root, 'index.html');
    if (!target) return false;
    const html = target.endsWith('.html');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': html ? 'no-store' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(target).pipe(res);
    return true;
  };
}
