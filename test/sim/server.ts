// 仿真环境的 HTTP 服务。环境程序跑在 agent 的容器外面，agent 只能经 HTTP 访问它，读不到规则的实现。
//
// 一个服务进程挂多个实例，每个实例一个随机的路径前缀 /<token>/，评估时每次试验一个实例，互不影响。
// 容器连宿主机：rootless podman 默认连不到宿主机的 127.0.0.1，所以评估时听在 0.0.0.0，
// 给 agent 的地址用 publicHost（比如 host.containers.internal，见 preflight.ts）；随机前缀挡住局域网里乱试的人。
// 每个请求记一行日志（方法、路径、状态码、耗时），评估时存档，用来看 agent 怎么探的。

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { realClock, type SimClock } from './kit/clock.ts';
import { noRoute, type SimHandler, type SimRequest, type SimResponse } from './kit/http.ts';

export interface SimServerOptions {
  /** 听在哪个地址，默认 127.0.0.1；要让容器连上用 0.0.0.0 */
  host?: string;
  /** 默认 0：随机端口 */
  port?: number;
  /** 容器里看到的宿主机地址，拼进给 agent 的 URL；默认和 host 一样（0.0.0.0 时是 127.0.0.1） */
  publicHost?: string;
  clock?: SimClock;
  /** 请求体上限，默认 256 KiB */
  maxBodyBytes?: number;
}

export interface RequestLogEntry {
  at: number;
  method: string;
  path: string;
  query: string;
  status: number;
  ms: number;
}

export interface MountedEnv {
  token: string;
  /** 给 agent 的地址：http://<publicHost>:<port>/<token> */
  url: string;
  /** 请求日志，最多记 MAX_LOG 条（agent 失控刷请求时不把内存吃光）；总数看 stats */
  log: RequestLogEntry[];
  stats: { requests: number };
}

interface Mount {
  handler: SimHandler;
  log: RequestLogEntry[];
  stats: { requests: number };
}

const MAX_LOG = 100_000;

export class SimServer {
  readonly host: string;
  readonly publicHost: string;
  readonly #clock: SimClock;
  readonly #maxBody: number;
  readonly #mounts = new Map<string, Mount>();
  readonly #server: Server;
  #port: number;

  constructor(options: SimServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.publicHost = options.publicHost ?? (this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host);
    this.#port = options.port ?? 0;
    this.#clock = options.clock ?? realClock;
    this.#maxBody = options.maxBodyBytes ?? 256 * 1024;
    this.#server = createServer((req, res) => {
      this.#serve(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '内部错误' }));
      });
    });
    // 开机排队这类请求可能挂一会儿；Node 默认 5 分钟就断
    this.#server.requestTimeout = 15 * 60_000;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#port, this.host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  get port(): number {
    return this.#port;
  }

  /** 挂一个实例，返回它的前缀和给 agent 的地址 */
  mount(handler: SimHandler, options: { token?: string } = {}): MountedEnv {
    const token = options.token ?? randomBytes(8).toString('hex');
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(token)) throw new Error(`前缀不合规：${token}`);
    if (this.#mounts.has(token)) throw new Error(`前缀已经挂了：${token}`);
    const log: RequestLogEntry[] = [];
    const stats = { requests: 0 };
    this.#mounts.set(token, { handler, log, stats });
    return { token, url: this.urlFor(token), log, stats };
  }

  unmount(token: string): void {
    this.#mounts.delete(token);
  }

  urlFor(token: string, host: string = this.publicHost): string {
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${h}:${this.#port}/${token}`;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = this.#clock.now();
    const url = new URL(req.url ?? '/', 'http://sim.local');
    const [, token = '', ...rest] = url.pathname.split('/');
    const mount = this.#mounts.get(token);
    if (!mount) {
      req.resume();
      write(res, noRoute());
      return;
    }
    const text = await readBody(req, this.#maxBody);
    let response: SimResponse;
    if (text === undefined) {
      response = { status: 413, body: { error: `请求体太大，最多 ${this.#maxBody} 字节` } };
    } else {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(', ');
      }
      const request: SimRequest = {
        method: req.method ?? 'GET',
        path: `/${rest.join('/')}`,
        query: url.searchParams,
        headers,
        body: parseBody(text),
        text,
        base: `http://${req.headers.host ?? `${this.publicHost}:${this.#port}`}/${token}`,
      };
      try {
        response = await mount.handler.handle(request);
      } catch {
        response = { status: 500, body: { error: '内部错误' } };
      }
    }
    write(res, response);
    mount.stats.requests++;
    if (mount.log.length >= MAX_LOG) return;
    mount.log.push({
      at: started,
      method: req.method ?? 'GET',
      path: `/${rest.join('/')}`,
      query: url.search,
      status: response.status,
      ms: this.#clock.now() - started,
    });
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooBig ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function write(res: ServerResponse, response: SimResponse): void {
  const headers: Record<string, string> = { ...(response.headers ?? {}) };
  let payload = '';
  if (typeof response.body === 'string') {
    payload = response.body;
    headers['content-type'] ??= 'text/plain; charset=utf-8';
  } else if (response.body !== undefined) {
    payload = `${JSON.stringify(response.body, null, 2)}\n`;
    headers['content-type'] ??= 'application/json; charset=utf-8';
  }
  res.writeHead(response.status, headers);
  res.end(payload);
}
