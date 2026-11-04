// 进程入口（melina serve）：参数、数据目录、真的 HTTP 服务（只听 127.0.0.1）；先占端口，再打开数据目录、恢复。

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Melina, type MelinaInternals, notConnectedRuntime, type RuntimeFactory } from '../../src/api/sdk.ts';
import { DEFAULT_PORT, parseServeArgs, startServer } from '../../src/cli.ts';
import { tempDir } from './api/kit.ts';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      s.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('没拿到端口'))));
    });
  });
}

/** 端口能不能再占上（上一个 Melina 放掉了没有） */
async function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** 记下恢复、开始调度、退出有没有被调到的运行时；恢复可以卡在 recovering 上 */
function recording(calls: string[], recovering: Promise<void> = Promise.resolve()): RuntimeFactory {
  return () => ({
    ...notConnectedRuntime(),
    start: async () => {
      calls.push('start');
    },
    close: async () => {
      calls.push('stop');
    },
    recovery: {
      run: async () => {
        calls.push('recover');
        await recovering;
        return { runs: [], branches: [], unknownCommands: [], rescoped: [] };
      },
    },
  });
}

const quiet = { warn: () => {}, error: () => {} };

function internals(runtime: RuntimeFactory): MelinaInternals {
  return { runtime, containers: null, env: {}, log: quiet };
}

/**
 * 发到这个端口的请求到了服务端：http.server.request.start 是服务端收到请求、交给处理函数之前同步发的，
 * await arrived 回来时，请求已经在等 Melina 了
 */
function requestArrives(port: number): { arrived: Promise<void>; off(): void } {
  const arrived = Promise.withResolvers<void>();
  const onStart = (message: unknown) => {
    const address = (message as { server: Server }).server.address();
    if (typeof address === 'object' && address?.port === port) arrived.resolve();
  };
  subscribe('http.server.request.start', onStart);
  return { arrived: arrived.promise, off: () => unsubscribe('http.server.request.start', onStart) };
}

async function until(ok: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('参数', () => {
  it('serve 的默认值：端口、~/.melina', () => {
    const o = parseServeArgs(['serve'], {});
    if (o === 'help') throw new Error('不该是 help');
    expect(o.port).toBe(DEFAULT_PORT);
    expect(o.home).toBe(join(homedir(), '.melina'));
  });

  it('命令行优先于环境变量；~ 展开', () => {
    const o = parseServeArgs(['serve', '--port', '9000', '--data', '~/k'], { MELINA_PORT: '7000', MELINA_HOME: '/x' });
    expect(o).toMatchObject({ port: 9000, home: join(homedir(), 'k') });
    const e = parseServeArgs(['serve'], { MELINA_PORT: '7000', MELINA_HOME: '/srv/melina' });
    expect(e).toMatchObject({ port: 7000, home: '/srv/melina' });
  });

  it('命令行和环境变量里的相对路径按当前目录算', () => {
    const o = parseServeArgs(['serve', '--data', 'rel/data', '--web', 'nowhere/dist'], {});
    expect(o).toMatchObject({ home: join(process.cwd(), 'rel/data') });
    expect(o !== 'help' && o.web).toBeFalsy(); // 不存在的前端目录不用
    const e = parseServeArgs(['serve'], { MELINA_HOME: 'rel/env' });
    expect(e).toMatchObject({ home: join(process.cwd(), 'rel/env') });
  });

  it('不是 serve、--help 都显示用法；端口不对报错', () => {
    expect(parseServeArgs([], {})).toBe('help');
    expect(parseServeArgs(['run'], {})).toBe('help');
    expect(parseServeArgs(['serve', '-h'], {})).toBe('help');
    expect(() => parseServeArgs(['serve', '--port', '70000'], {})).toThrow('端口不对');
  });
});

describe('melina serve', () => {
  it('建好数据目录（0700），只听 127.0.0.1，托管前端，接口能用，停得干净', async () => {
    dir = tempDir('melina-cli-');
    const home = join(dir, 'home');
    const web = join(dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Melina</title>');
    const port = await freePort();
    // 单测只验证 HTTP 入口：机器上装了容器引擎也不探测它，不读取调用者的模型环境。
    const { server, stop } = await startServer(
      { port, home, web },
      { internals: { containers: null, env: {}, log: quiet } },
    );
    try {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, 'melina.db')).isFile()).toBe(true);
      expect(server.address()).toMatchObject({ address: '127.0.0.1', port });
      const page = await fetch(`http://127.0.0.1:${port}/runs`);
      expect(await page.text()).toContain('<title>Melina</title>');
      const runs = await fetch(`http://localhost:${port}/api/runs`);
      expect(await runs.json()).toEqual({ runs: [] });
      const created = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ statement: '试试' }),
      });
      expect(created.status).toBe(503); // 运行时还没接上
    } finally {
      await stop();
    }
    await expect(fetch(`http://127.0.0.1:${port}/api/runs`)).rejects.toThrow();
  });

  it('端口被占了说清楚；数据目录一下都不碰，不恢复、不开始调度（原来先恢复后绑端口，恢复出来的任务先开跑、马上又被停掉）', async () => {
    dir = tempDir('melina-cli-');
    const home = join(dir, 'home');
    const calls: string[] = [];
    const blocker = createServer();
    const port = await new Promise<number>((resolve) =>
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as { port: number }).port)),
    );
    try {
      await expect(startServer({ port, home }, { internals: internals(recording(calls)) })).rejects.toThrow(
        `端口 ${port} 已经被占了`,
      );
      expect(calls).toEqual([]);
      expect(existsSync(home)).toBe(false);
    } finally {
      blocker.close();
    }
  });

  it('先占端口再恢复：恢复跑完之前进来的请求先等着，跑完再交给 Melina（§14 先恢复再接新活）', async () => {
    dir = tempDir('melina-cli-');
    const port = await freePort();
    const calls: string[] = [];
    let recovered = () => {};
    const recovering = new Promise<void>((r) => {
      recovered = r;
    });
    const starting = startServer(
      { port, home: join(dir, 'home') },
      { internals: internals(recording(calls, recovering)) },
    );
    await until(() => calls.includes('recover'), '开始恢复');
    let answered = false;
    const early = fetch(`http://127.0.0.1:${port}/api/runs`).finally(() => {
      answered = true;
    });
    early.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    expect(answered).toBe(false); // 端口已经占上了，请求在等恢复
    recovered();
    const { stop } = await starting;
    try {
      const res = await early;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ runs: [] });
      expect(calls).toEqual(['recover', 'start']);
    } finally {
      await stop();
    }
    expect(calls).toEqual(['recover', 'start', 'stop']);
  });

  it('起不来：恢复期间等着的请求拿到 503，写出去了才断连接，端口放掉（合并前的审查：原来先断连接，客户端只看到连接被重置）', async () => {
    dir = tempDir('melina-cli-');
    const port = await freePort();
    const calls: string[] = [];
    const recovering = Promise.withResolvers<void>();
    const request = requestArrives(port);
    try {
      const starting = startServer(
        { port, home: join(dir, 'home') },
        { internals: internals(recording(calls, recovering.promise)) },
      );
      starting.catch(() => {});
      await until(() => calls.includes('recover'), '开始恢复');
      const early = fetch(`http://127.0.0.1:${port}/api/runs`);
      early.catch(() => {});
      await request.arrived; // 请求到了，在等恢复
      recovering.reject(new Error('恢复出错（模拟）'));
      await expect(starting).rejects.toThrow('恢复出错（模拟）');
      const res = await early;
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('Melina 没起来');
      expect(calls).toEqual(['recover', 'stop']); // 没开始调度；关 Melina 时停了运行时
      expect(await canListen(port)).toBe(true);
    } finally {
      request.off();
    }
  });

  it('同一份数据已经有 Melina 开着：打开数据目录时就说清楚、不恢复，占上的端口放掉（锁在打开库之前拿）', async () => {
    dir = tempDir('melina-cli-');
    const home = join(dir, 'home');
    mkdirSync(home);
    const first = new Melina(
      { db: join(home, 'melina.db'), artifacts: join(home, 'artifacts'), dataDir: join(home, 'workspaces') },
      internals(notConnectedRuntime),
    );
    const port = await freePort();
    const calls: string[] = [];
    try {
      await expect(startServer({ port, home }, { internals: internals(recording(calls)) })).rejects.toThrow(
        '数据目录正被本进程里的另一个 Melina 使用',
      );
      expect(calls).toEqual([]);
      expect(await canListen(port)).toBe(true);
    } finally {
      await first.close();
    }
  });
});
