#!/usr/bin/env node
// 进程入口：melina serve —— 先占端口，再打开数据目录（先拿锁）、跑崩溃恢复，恢复完才把请求交给 Melina，起不来回 503
// （只听 127.0.0.1，托管前端）。端口被占时不会启动任务。
//
//   pnpm melina serve [--port 7474] [--data ~/.melina] [--web <前端的 dist 目录>]
//
// 数据目录（默认 ~/.melina，或环境变量 MELINA_HOME）：melina.db、melina.key（加密 API key 和凭证的密钥）、artifacts/、workspaces/。
// 其他环境变量：MELINA_PORT、MELINA_WEB、MELINA_SECRET_KEY（不用密钥文件时给密钥）、MELINA_CONTAINER_ENGINE（podman、docker 或可执行文件的路径）。

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { setGlobalDispatcher } from 'undici';
import { accessPolicy } from './api/access.ts';
import { expandPath } from './api/dirs.ts';
import { Melina, type MelinaInternals } from './api/sdk.ts';
import type { ModelsConfig } from './core/config.ts';
import { MODEL_DISPATCHER } from './models/stream.ts';

export const DEFAULT_PORT = 7474;
const DEFAULT_WEB = fileURLToPath(new URL('../web/dist', import.meta.url));

const USAGE = `用法：melina serve [选项]

  --port, -p <端口>   HTTP 端口，默认 ${DEFAULT_PORT}（环境变量 MELINA_PORT）
  --data <目录>       数据目录，默认 ~/.melina（环境变量 MELINA_HOME）
  --web <目录>        前端打包出来的 dist 目录，默认仓库里的 web/dist（环境变量 MELINA_WEB）
  --help, -h          显示这段说明

Melina 只监听 127.0.0.1，浏览器打开启动时打印的地址。`;

export interface ServeOptions {
  port: number;
  home: string;
  web?: string;
}

export function parseServeArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ServeOptions | 'help' {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      data: { type: 'string' },
      web: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals[0] !== 'serve' || positionals.length > 1) return 'help';
  const portText = values.port ?? env.MELINA_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口不对：${portText}`);
  const home = cliPath(values.data ?? env.MELINA_HOME ?? '~/.melina');
  const web = cliPath(values.web ?? env.MELINA_WEB ?? DEFAULT_WEB);
  return { port, home, ...(existsSync(web) ? { web } : {}) };
}

/** 命令行和环境变量里的路径：~ 展开成 home，相对路径按当前目录算（不像网页的 GET /dirs 那样按 home 算） */
function cliPath(input: string): string {
  return input === '~' || input.startsWith('~/') ? expandPath(input, homedir()) : resolve(input);
}

/**
 * 起一个 Melina 和它的 HTTP 服务；返回停下它们的函数。
 * extra 给开发脚本用（test/dev/serve.ts 换容器运行时、给模型初值），melina serve 不用。
 */
export async function startServer(
  options: ServeOptions,
  extra: StartExtra = {},
): Promise<{ melina: Melina; server: Server; stop(): Promise<void> }> {
  // 进程里的 fetch 都不设 HTTP 层的超时，模型调用卡死只看 model.idleTimeoutMs；不收自定义 fetch 的 SDK（Google）也管到
  setGlobalDispatcher(MODEL_DISPATCHER);
  // 先占端口：被占了就到此为止，数据目录一下都不碰。占上以后进来的请求先等着，恢复跑完再交给 Melina
  const port = await holdPort(options.port);
  const { melina, app } = await boot(options, extra).catch(async (error: unknown) => {
    await port.refuse(); // 起不来：等着的请求回 503，写出去了再断连接、放掉端口
    throw error;
  });
  port.open(app.fetch);
  const { server } = port;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      await closeServer(server);
      await melina.close();
    })();
    return stopping;
  };
  return { melina, server, stop };
}

type StartExtra = { internals?: MelinaInternals; models?: ModelsConfig };

/** 打开数据目录（Melina 先拿锁）、跑崩溃恢复，建好 HTTP 应用；恢复或建应用出错就把 Melina 关干净（放掉锁） */
async function boot(options: ServeOptions, extra: StartExtra): Promise<{ melina: Melina; app: Hono }> {
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  const melina = new Melina(
    {
      db: join(options.home, 'melina.db'),
      artifacts: join(options.home, 'artifacts'),
      dataDir: join(options.home, 'workspaces'),
      ...(extra.models ? { models: extra.models } : {}),
    },
    { ...extra.internals, protectedDirs: [options.home, ...(extra.internals?.protectedDirs ?? [])] },
  );
  try {
    await melina.ready(); // 先恢复，再接请求
    const app = melina.app({
      port: options.port,
      access: accessPolicy(options.port),
      ...(options.web ? { web: options.web } : {}),
    });
    return { melina, app };
  } catch (error) {
    await melina.close();
    throw error;
  }
}

/** 占上的端口：Melina 起来之前进来的请求在这里等着 */
interface HeldPort {
  readonly server: Server;
  /** Melina 起来了：等着的和之后的请求都交给它 */
  open(fetch: Hono['fetch']): void;
  /** Melina 起不来：等着的请求回 503，都写出去了再断连接、放掉端口 */
  refuse(): Promise<void>;
}

/**
 * 占端口。占上以后、Melina 起来之前进来的请求先等着；起不来时等这些请求的 503 都写出去了才断连接：
 * 一上来就 closeAllConnections 的话，503 还没写出去连接就断了，客户端看到的是连接被重置
 */
async function holdPort(port: number): Promise<HeldPort> {
  const melina = Promise.withResolvers<Hono['fetch']>();
  melina.promise.catch(() => {}); // 起不来时没有请求在等，也不算没人接的 rejection
  let opened = false;
  /** Melina 起来之前进来的请求：响应写完或者连接断了（close）就拿掉 */
  const waiting = new Set<Promise<void>>();
  const server = await listen(port, async (request, env) => {
    if (!opened) {
      const response: Writable = env.outgoing;
      const answered = new Promise<void>((done) => response.once('close', () => done()));
      waiting.add(answered);
      answered.then(() => waiting.delete(answered));
    }
    let fetch: Hono['fetch'];
    try {
      fetch = await melina.promise;
    } catch {
      // connection: close：端口马上就放掉了，别在这条连接上接着发
      return new Response('Melina 没起来', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', connection: 'close' },
      });
    }
    return fetch(request, env);
  });
  return {
    server,
    open(fetch) {
      opened = true;
      melina.resolve(fetch);
    },
    async refuse() {
      melina.reject(new Error('Melina 没起来'));
      const closed = new Promise<void>((done) => server.close(() => done())); // 不再接新连接，空着的连接关掉
      while (waiting.size > 0) await Promise.all(waiting);
      server.closeAllConnections(); // 503 都写出去了；剩下的（请求还没发完的）直接断
      await closed;
    },
  };
}

/** @hono/node-server 交给处理函数的：请求，和 Node 的请求、响应对象（env，原样转给 Melina 的 app） */
type ServeFetch = Parameters<typeof serve>[0]['fetch'];

/** 在 127.0.0.1 上占端口；被占了说清楚 */
function listen(port: number, fetch: ServeFetch): Promise<Server> {
  return new Promise<Server>((resolveListen, rejectListen) => {
    const s = serve({ fetch, port, hostname: '127.0.0.1' }) as Server;
    s.once('listening', () => resolveListen(s));
    s.once('error', (error: NodeJS.ErrnoException) => {
      rejectListen(
        error.code === 'EADDRINUSE'
          ? new Error(`端口 ${port} 已经被占了：可能已经有一个 Melina 在跑，或者用 --port 换一个`)
          : error,
      );
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections(); // SSE 是长连接，不断开 close 就一直等
  });
}

async function main(): Promise<void> {
  let options: ServeOptions | 'help';
  try {
    options = parseServeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (options === 'help') {
    console.log(USAGE);
    return;
  }
  const { stop } = await startServer(options);
  console.log(`Melina 在运行：http://127.0.0.1:${options.port}`);
  console.log(`数据目录：${options.home}`);
  if (!options.web) console.log('前端还没打包（pnpm --dir web build），现在只有 HTTP 接口能用');
  let signals = 0;
  const onSignal = () => {
    signals++;
    if (signals > 1) process.exit(1);
    console.log('正在停下……（再按一次 Ctrl+C 直接退出）');
    stop().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
