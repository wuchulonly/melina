// SSE：用真的 HTTP 服务器（@hono/node-server）连，按 since、Last-Event-ID 续传，心跳，断开就退订。

import { readdirSync, readlinkSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessPolicy } from '../../../src/api/access.ts';
import { sseStream } from '../../../src/api/sse.ts';
import type { MelinaEvent } from '../../../src/core/events.ts';
import type { EventBus } from '../../../src/core/interfaces/store.ts';
import type { LocalEventBus } from '../../../src/storage/events.ts';
import { openRunStore } from '../../../src/storage/state.ts';
import { newRun, observe, startBranch } from '../storage/kit.ts';
import { type TestMelina, testMelina } from './kit.ts';

interface Message {
  id?: string;
  event?: string;
  data?: string;
  retry?: string;
  comment?: string;
}

/** 读 SSE 响应体，按空行切成一条条消息 */
class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = '';
  /** 超时时还没回来的 read：留着下次接着等，不然那一块数据就丢了 */
  #pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> | undefined;

  constructor(res: Response) {
    if (!res.body) throw new Error('没有响应体');
    this.#reader = res.body.getReader();
  }

  async next(timeoutMs = 2000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.#buffer.indexOf('\n\n');
      if (i >= 0) {
        const block = this.#buffer.slice(0, i);
        this.#buffer = this.#buffer.slice(i + 2);
        return parse(block);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('等不到下一条消息');
      this.#pending ??= this.#reader.read();
      const chunk = await Promise.race([
        this.#pending,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left)),
      ]);
      if (chunk === 'timeout') throw new Error('等不到下一条消息');
      this.#pending = undefined;
      if (chunk.done) throw new Error('流结束了');
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  /** 下一条事件（跳过 retry 和心跳）；timeoutMs 是总的，心跳不续期 */
  async event(timeoutMs = 2000): Promise<MelinaEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = await this.next(Math.max(1, deadline - Date.now()));
      if (m.data !== undefined && m.event === undefined) {
        const event = JSON.parse(m.data) as MelinaEvent;
        expect(m.id).toBe(String(event.seq));
        return event;
      }
    }
  }

  /** 一段时间里没有新事件 */
  async quiet(ms: number): Promise<void> {
    try {
      const m = await this.event(ms);
      throw new Error(`不该有事件：${m.seq} ${m.type}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('等不到')) throw error;
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }
}

function parse(block: string): Message {
  const m: Message = {};
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) m.comment = line.slice(1).trim();
    else if (line.startsWith('id: ')) m.id = line.slice(4);
    else if (line.startsWith('event: ')) m.event = line.slice(7);
    else if (line.startsWith('data: ')) m.data = line.slice(6);
    else if (line.startsWith('retry: ')) m.retry = line.slice(7);
  }
  return m;
}

let runId: string;
let runEvents: MelinaEvent[];
let script: { events: MelinaEvent[] };
let lastSeq: number;
let k: TestMelina;
let server: Server;
let base: string;
let port: number;
/** Melina 自己订阅的条数（系统状态跟着 run.updated 刷新） */
let ownSubscriptions: number;

beforeAll(async () => {
  k = await testMelina({ heartbeatMs: 100 });
  const run = await k.runs.create({ statement: 'SSE 集成测试', materials: [] });
  runId = run.id;
  const bet = k.runs.deps.writer.createBet({
    runId,
    kind: 'direct',
    label: '直接路线',
    startFrom: { snapshot: 'root' },
    model: { provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' },
    source: { kind: 'template' },
  });
  const branch = k.runs.deps.writer.createBranch({ runId, betId: bet.id, lastSnapshot: 'root' });
  k.runs.deps.writer.updateBranch(branch.id, { state: 'running', queued: false, workspace: { path: '/tmp/sse' } });
  script = { events: k.runs.deps.queries.events({ since: 0 }) };
  runEvents = script.events.filter((e) => e.runId === runId);
  lastSeq = k.runs.deps.queries.lastSeq();
  let app: Hono | undefined;
  server = createAdaptorServer({ fetch: (req: Request) => (app as Hono).fetch(req) }) as Server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  app = k.melina.app({ port, access: accessPolicy(port), heartbeatMs: 100 });
  base = `http://127.0.0.1:${port}`;
  ownSubscriptions = subscriptions();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await k.close();
});

const open = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
  return new SseReader(res);
};

const subscriptions = () =>
  (k.runs.deps.bus as LocalEventBus as unknown as { subscriptions: Set<unknown> }).subscriptions.size;

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等不到');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('单个 Run 的事件流', () => {
  it('since=0：先补发这个 Run 的全部历史（按 seq，id 就是 seq），再推新的', async () => {
    const stream = await open(`/api/runs/${runId}/events?since=0`);
    expect((await stream.next()).retry).toBe('2000');
    for (const expected of runEvents) {
      const got = await stream.event();
      expect(got.seq).toBe(expected.seq);
      expect(got.type).toBe(expected.type);
    }
    // 推新的：暂停（fake 运行时用真的 RunStoreWriter 写 run.updated）
    const paused = await fetch(`${base}/api/runs/${runId}/pause`, { method: 'POST', headers: { origin: base } });
    if (paused.status === 200) {
      const live = await stream.event();
      expect(live.seq).toBeGreaterThan(lastSeq);
      expect(live.type).toBe('run.updated');
      await fetch(`${base}/api/runs/${runId}/resume`, { method: 'POST', headers: { origin: base } });
      expect((await stream.event()).type).toBe('run.updated');
    }
    await stream.cancel();
  });

  it('since=N 只补 N 之后的；Last-Event-ID 和 since 取大的', async () => {
    const mid = runEvents[Math.floor(runEvents.length / 2)]?.seq ?? 1;
    const a = await open(`/api/runs/${runId}/events?since=${mid}`);
    expect((await a.event()).seq).toBe(runEvents.find((e) => e.seq > mid)?.seq);
    await a.cancel();
    const b = await open(`/api/runs/${runId}/events?since=1`, { 'last-event-id': String(mid) });
    expect((await b.event()).seq).toBe(runEvents.find((e) => e.seq > mid)?.seq);
    await b.cancel();
    const c = await open(`/api/runs/${runId}/events`, { 'last-event-id': String(mid) });
    expect((await c.event()).seq).toBe(runEvents.find((e) => e.seq > mid)?.seq);
    await c.cancel();
  });

  it('不带 since 也没有 Last-Event-ID：不补历史，只推连上以后的', async () => {
    const stream = await open(`/api/runs/${runId}/events`);
    await stream.quiet(300);
    k.runs.deps.writer.emitUsage(runId, {
      delta: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, usd: 0 },
      total: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, usd: 0 },
    });
    const got = await stream.event();
    expect(got.type).toBe('usage.updated');
    await stream.cancel();
  });

  it('没有系统事件；15 秒（这里调成 100 毫秒）一条心跳：具名事件 ping，data 不空（空的浏览器不派发）', async () => {
    const stream = await open(`/api/runs/${runId}/events`);
    k.runs.deps.writer.emitSystem(k.melina.status());
    await stream.quiet(250);
    let pings = 0;
    for (let i = 0; i < 3; i++) {
      const m = await stream.next(1000);
      if (m.event === 'ping') {
        expect(m.data).toBe('{}');
        expect(m.id).toBeUndefined(); // 不带 id：不动浏览器记的 Last-Event-ID
        pings++;
      }
    }
    expect(pings).toBeGreaterThan(0);
    await stream.cancel();
  });

  it('since 不是非负整数是 400；没有的任务 404', async () => {
    expect((await fetch(`${base}/api/runs/${runId}/events?since=-1`)).status).toBe(400);
    expect((await fetch(`${base}/api/runs/${runId}/events?since=abc`)).status).toBe(400);
    expect((await fetch(`${base}/api/runs/01K6F1W3S2A8Q0Q6YH7J5M4N3P/events`)).status).toBe(404);
  });
});

describe('全局事件流', () => {
  it('所有 Run 的事件加上 system.updated（runId 为 null）', async () => {
    const stream = await open('/api/events');
    const seq = k.runs.deps.writer.emitSystem(k.melina.status());
    const got = await stream.event();
    expect(got).toMatchObject({ seq, type: 'system.updated', runId: null });
    await stream.cancel();
  });

  it('从头补发：所有剧本事件都在，seq 连续递增', async () => {
    const stream = await open('/api/events?since=0');
    let prev = 0;
    for (const expected of script.events) {
      const got = await stream.event();
      expect(got.seq).toBe(expected.seq);
      expect(got.seq).toBeGreaterThan(prev);
      prev = got.seq;
    }
    await stream.cancel();
  });
});

describe('连接', () => {
  it('客户端断开以后服务端就退订，不攒事件', async () => {
    await until(() => subscriptions() === ownSubscriptions); // 前面几个测试断开的流
    const streams = await Promise.all([open('/api/events'), open(`/api/runs/${runId}/events`)]);
    await streams[0]?.next(); // retry
    await streams[1]?.next();
    await until(() => subscriptions() === ownSubscriptions + 2);
    for (const s of streams) await s.cancel();
    await until(() => subscriptions() === ownSubscriptions);
  });

  it('客户端要 gzip 也不压：事件一条条马上推', async () => {
    const res = await fetch(`${base}/api/events`, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const stream = new SseReader(res);
    expect((await stream.next()).retry).toBe('2000');
    const seq = k.runs.deps.writer.emitSystem(k.melina.status());
    expect((await stream.event()).seq).toBe(seq);
    await stream.cancel();
  });

  it('读得慢的客户端：服务端只攒有限几条，攒满了就退订；跟上来以后从表里补，照样连续', async () => {
    const runStore = openRunStore({ db: ':memory:', streamQueueMax: 5 });
    try {
      const run = newRun(runStore);
      const { branch } = startBranch(runStore, run);
      const abort = new AbortController();
      const since = runStore.queries.lastSeq();
      const reader = sseStream({ bus: runStore.bus, since, signal: abort.signal, heartbeatMs: 60_000 }).getReader();
      const decoder = new TextDecoder();
      const message = async () => decoder.decode((await reader.read()).value);
      const seqOf = (text: string) => (JSON.parse(parse(text.trimEnd()).data ?? '{}') as MelinaEvent).seq;
      const subscribed = () => (runStore.bus as unknown as { subscriptions: Set<unknown> }).subscriptions.size;
      expect(await message()).toBe('retry: 2000\n\n');
      const first = message(); // 浏览器在读：订阅上了
      observe(runStore, branch);
      expect(seqOf(await first)).toBe(since + 1);
      // 浏览器卡住不读：写 40 条，服务端攒到 5 条就退订、扔掉
      for (let i = 0; i < 40; i++) observe(runStore, branch);
      expect(subscribed()).toBe(0);
      const seqs: number[] = [];
      for (let i = 0; i < 40; i++) seqs.push(seqOf(await message()));
      expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => since + 2 + i));
      abort.abort();
      await reader.cancel();
    } finally {
      runStore.close();
    }
  });

  it('真服务器上照样校验 Host', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/api/runs', headers: { host: `attacker.example:${port}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('真服务器上的 multipart 上传', async () => {
    const form = new FormData();
    form.append('run', JSON.stringify({ statement: '读一下附件' }));
    form.append('materials', new Blob(['内容'.repeat(10_000)]), '笔记 第一版.txt');
    const res = await fetch(`${base}/api/runs`, { method: 'POST', body: form, headers: { origin: base } });
    expect(res.status).toBe(201);
    const call = k.runs.calls.findLast((c) => c.method === 'create');
    if (call?.method !== 'create') throw new Error('没调 create');
    expect(call.input.materials[0]?.name).toBe('笔记 第一版.txt');
    expect(call.contents[0]).toBe('内容'.repeat(10_000));
  });
});

describe('资源', () => {
  it('上传到一半客户端断了：临时文件的 fd 关上，临时目录删掉', async () => {
    const uploads = k.melina.paths.uploads;
    const openUploads = () =>
      readdirSync('/proc/self/fd').filter((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`).includes(uploads);
        } catch {
          return false;
        }
      });
    const boundary = 'melina-test-boundary';
    const head = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="run"',
      '',
      JSON.stringify({ statement: 'x' }),
      `--${boundary}`,
      'Content-Disposition: form-data; name="materials"; filename="big.bin"',
      'Content-Type: application/octet-stream',
      '',
      '',
    ].join('\r\n');
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          [
            'POST /api/runs HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            `Origin: http://127.0.0.1:${port}`,
            `Content-Type: multipart/form-data; boundary=${boundary}`,
            `Content-Length: ${100 * 1024 * 1024}`,
            '',
            head,
          ].join('\r\n'),
        );
        socket.write(Buffer.alloc(1024 * 1024, 1), () => {
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 100);
        });
      });
      socket.on('error', reject);
    });
    await until(() => openUploads().length === 0 && readdirSync(uploads).length === 0, 3000);
  });

  it('等事件的时候心跳再多，也只在那一次 next() 上挂一个回调', async () => {
    let thens = 0;
    class Counting<T> extends Promise<T> {
      // biome-ignore lint/suspicious/noThenProperty: 就是要数有几处在等这个 promise
      override then<A = T, B = never>(
        ok?: ((value: T) => A | PromiseLike<A>) | null,
        bad?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ): Promise<A | B> {
        thens++;
        return super.then(ok, bad);
      }
    }
    const never = new Counting<IteratorResult<MelinaEvent>>(() => {});
    const bus: EventBus = {
      subscribe: () => () => {},
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => never, return: async () => ({ done: true, value: undefined }) }),
      }),
    };
    const abort = new AbortController();
    const reader = sseStream({ bus, since: 0, signal: abort.signal, heartbeatMs: 1 }).getReader();
    for (let i = 0; i < 50; i++) await reader.read(); // retry 加一串心跳
    expect(thens).toBe(1);
    await reader.cancel();
  });
});
