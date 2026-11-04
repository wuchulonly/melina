// 订单服务：数据和答案、文档里写了什么、藏起来的几样（游标、归档参数、v2、令牌过期、限流、页间重复）。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../sim/kit/clock.ts';
import { makeRequest, type SimHandler, type SimResponse } from '../../sim/kit/http.ts';
import { serviceHandler } from '../../sim/service/api.ts';
import { checkService, SERVICE_PRESETS, serviceTask } from '../../sim/service/tasks.ts';
import { generateService, Q3_FROM, Q3_TO, type ServiceWorld } from '../../sim/service/world.ts';

function client(world: ServiceWorld, clock = new VirtualClock()) {
  const api: SimHandler = serviceHandler(world, clock);
  let token = '';
  const call = async (method: string, path: string, body?: unknown): Promise<SimResponse> =>
    api.handle(
      makeRequest(method, path, {
        ...(body === undefined ? {} : { body }),
        headers: token ? { authorization: `Bearer ${token}` } : {},
        base: 'http://sim.local/t',
      }),
    );
  const auth = async () => {
    token = '';
    const res = await call('POST', '/oauth/token', { client_id: world.clientId, client_secret: world.clientSecret });
    token = (res.body as { access_token: string }).access_token;
  };
  return { call, auth, clock };
}

describe('generateService', () => {
  it('答案是第三季度（含头不含尾、含归档）的单数和总金额；季度边界上各有一单', () => {
    const w = generateService(SERVICE_PRESETS.hard, 'truth');
    const inQ3 = w.orders.filter((o) => o.createdAt >= Q3_FROM && o.createdAt < Q3_TO);
    expect(w.truth).toEqual({ orders: inQ3.length, cents: inQ3.reduce((s, o) => s + o.cents, 0) });
    const times = new Set(w.orders.map((o) => o.createdAt));
    for (const t of ['2026-06-30T23:59:59Z', Q3_FROM, '2026-09-30T23:59:59Z', Q3_TO]) expect(times.has(t)).toBe(true);
    expect(inQ3.filter((o) => o.archived).length).toBeGreaterThanOrEqual(3);
    expect(new Set(w.orders.map((o) => o.id)).size).toBe(w.orders.length);
  });

  it('同一个种子同样的数据', () => {
    expect(generateService(SERVICE_PRESETS.medium, 's')).toEqual(generateService(SERVICE_PRESETS.medium, 's'));
  });
});

describe('serviceHandler', () => {
  it('不带令牌 401；账号不对 401；拿到令牌能列', async () => {
    const w = generateService(SERVICE_PRESETS.easy, 'auth');
    const c = client(w);
    expect((await c.call('GET', '/v1/orders')).status).toBe(401);
    expect((await c.call('POST', '/oauth/token', { client_id: w.clientId, client_secret: 'wrong' })).status).toBe(401);
    await c.auth();
    const res = await c.call('GET', '/v1/orders?page=3');
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(20); // 120 单，每页 50
  });

  it('中等：page 只认第 1 页，下一页的游标在响应体里；不认识的参数会把允许的参数列出来', async () => {
    const w = generateService(SERVICE_PRESETS.medium, 'cursor');
    const c = client(w);
    await c.auth();
    const page2 = (await c.call('GET', '/v1/orders?page=2')).body as { data: unknown[] };
    expect(page2.data).toEqual([]);
    const first = (await c.call('GET', '/v1/orders')).body as { next_cursor: string };
    expect(first.next_cursor).toBeTruthy();
    const probe = await c.call('GET', '/v1/orders?foo=1');
    expect(probe.status).toBe(400);
    expect(probe.body).toMatchObject({ allowed: expect.arrayContaining(['include_archived', 'cursor']) });
    const stats = (await c.call('GET', '/v1/stats')).body as { orders: number };
    expect(stats.orders).toBe(w.orders.length); // 连归档的一起算，和默认列表对不上
  });

  it('难：下一页只在 Link 头里；v1 的响应指向 v2；v2 自带说明、有精确金额、翻页有重复', async () => {
    const w = generateService(SERVICE_PRESETS.hard, 'v2');
    const c = client(w);
    await c.auth();
    const first = await c.call('GET', '/v1/orders');
    const body = first.body as { data: { amount: unknown }[]; next_cursor?: string };
    expect(body.next_cursor).toBeUndefined();
    expect(first.headers?.link).toMatch(/rel="next"/);
    expect(first.headers?.link).toMatch(/\/v2\/orders>; rel="successor-version"/);
    expect(first.headers?.deprecation).toBe('true');
    expect(Number.isInteger(body.data[0]?.amount)).toBe(true); // 四舍五入到元
    expect((await c.call('GET', '/v1/orders?include_archived=true')).status).toBe(400);
    const index = (await c.call('GET', '/v2')).body as {
      endpoints: { path: string; params?: Record<string, string> }[];
    };
    expect(index.endpoints.find((e) => e.path === '/v2/orders')?.params?.include).toMatch(/^archived/);
    const ids: string[] = [];
    let next: string | null = null;
    do {
      const q: string = next ? `&cursor=${next}` : '';
      // 难的令牌 30 次就过期，限流 5 次每秒
      await c.clock.sleep(1000);
      let res = await c.call('GET', `/v2/orders?limit=100&include=archived${q}`);
      if (res.status === 401) {
        await c.auth();
        res = await c.call('GET', `/v2/orders?limit=100&include=archived${q}`);
      }
      const page = res.body as { items: { id: string }[]; next: string | null };
      ids.push(...page.items.map((o) => o.id));
      next = page.next;
    } while (next);
    expect(new Set(ids).size).toBe(w.orders.length);
    expect(ids.length).toBeGreaterThan(w.orders.length); // 页和页之间有重复
  });

  it('难：同一个令牌一秒内第 6 个请求 429 带 Retry-After；第 31 次令牌过期', async () => {
    const w = generateService(SERVICE_PRESETS.hard, 'limits');
    const c = client(w);
    await c.auth();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.call('GET', '/v1/stats')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const limited = await c.call('GET', '/v1/stats');
    expect(limited.headers?.['retry-after']).toBe('1');
    let expired: SimResponse | undefined;
    for (let i = 0; i < 40 && !expired; i++) {
      await c.clock.sleep(1000);
      const res = await c.call('GET', '/v1/stats');
      if (res.status === 401) expired = res;
    }
    expect(expired?.body).toMatchObject({ error: 'invalid_token', error_description: 'token expired' });
  });

  it('账号级配额：几个令牌一起算，用完整个账号锁住、锁着时不记账，过了窗口的请求不再占配额', async () => {
    const w = generateService(
      { ...SERVICE_PRESETS.hard, quota: { requests: 5, windowMs: 60_000, lockMs: 120_000 } },
      'quota',
    );
    const clock = new VirtualClock();
    const api = serviceHandler(w, clock);
    const login = async () => {
      const res = await api.handle(
        makeRequest('POST', '/oauth/token', { body: { client_id: w.clientId, client_secret: w.clientSecret } }),
      );
      return (res.body as { access_token: string }).access_token;
    };
    const get = async (token: string) => {
      await clock.sleep(1000); // 隔一秒，不撞每个令牌的限流
      return api.handle(makeRequest('GET', '/v1/stats', { headers: { authorization: `Bearer ${token}` } }));
    };
    const [a, b] = [await login(), await login()];
    const remaining: string[] = [];
    for (const token of [a, b, a, b, a]) {
      const res = await get(token);
      expect(res.status).toBe(200);
      remaining.push(res.headers?.['x-quota-remaining'] ?? '');
    }
    expect(remaining).toEqual(['4', '3', '2', '1', '0']);
    const locked = await get(b);
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({ error: 'quota_exceeded' });
    expect(locked.headers?.['retry-after']).toBe('120');
    expect((await login()).length).toBeGreaterThan(0); // 拿令牌不算、锁着也能拿
    await clock.sleep(60_000);
    const still = await get(a);
    expect(still.status).toBe(429);
    expect(Number(still.headers?.['retry-after'])).toBeLessThan(120);
    await clock.sleep(60_000);
    // 锁过了，配额从头算；锁着时那两次不记账
    const back = await get(a);
    expect(back.status).toBe(200);
    expect(back.headers?.['x-quota-remaining']).toBe('4');
    // 窗口是滑动的：一分钟前的请求不再占配额
    for (let i = 0; i < 3; i++) await get(b);
    await clock.sleep(60_000);
    expect((await get(a)).headers?.['x-quota-remaining']).toBe('4');
    // 没带令牌的不记账、不带配额头
    const anon = await api.handle(makeRequest('GET', '/v1/stats'));
    expect(anon.status).toBe(401);
    expect(anon.headers?.['x-quota-remaining']).toBeUndefined();
  });

  it('没有配额的世界不带配额头', async () => {
    const c = client(generateService(SERVICE_PRESETS.hard, 'no-quota'));
    await c.auth();
    expect((await c.call('GET', '/v1/stats')).headers?.['x-quota-remaining']).toBeUndefined();
  });

  it('v2 翻页的重复不会比一页还长：limit 是 1、2 也一直往前走，一条不落', async () => {
    const w = generateService(SERVICE_PRESETS.hard, 'overlap');
    const c = client(w);
    for (const limit of [1, 2]) {
      await c.auth();
      const ids = new Set<string>();
      let next: string | null = null;
      for (let pages = 0; pages < 1000; pages++) {
        await c.clock.sleep(1000);
        const path: string = `/v2/orders?limit=${limit}&include=archived${next ? `&cursor=${next}` : ''}`;
        let res = await c.call('GET', path);
        if (res.status === 401) {
          await c.auth();
          res = await c.call('GET', path);
        }
        expect(res.status).toBe(200);
        const page = res.body as { items: { id: string }[]; next: string | null };
        for (const o of page.items) ids.add(o.id);
        next = page.next;
        if (!next) break;
      }
      expect(ids.size).toBe(w.orders.length);
    }
  });

  it('游标带着第一页的筛选条件：翻页时不再带也不会少拿；带了不一样的报错', async () => {
    const w = generateService(SERVICE_PRESETS.medium, 'filters');
    const c = client(w);
    await c.auth();
    const ids = new Set<string>();
    let res = await c.call('GET', '/v1/orders?include_archived=true');
    let cursor: string | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = res.body as { data: { id: string }[]; next_cursor?: string };
      for (const o of page.data) ids.add(o.id);
      if (!page.next_cursor) break;
      cursor ??= page.next_cursor;
      res = await c.call('GET', `/v1/orders?cursor=${page.next_cursor}`);
    }
    expect(ids.size).toBe(w.orders.length);
    const changed = await c.call('GET', `/v1/orders?cursor=${cursor}&include_archived=false`);
    expect(changed.status).toBe(400);
    expect((changed.body as { error: string }).error).toContain('筛选条件');
    expect((await c.call('GET', `/v1/orders?cursor=${cursor}&include_archived=true`)).status).toBe(200);
  });

  it('游标是加密的：改一个字、拿 v1 的游标去翻 v2，都不认', async () => {
    const w = generateService(SERVICE_PRESETS.hard, 'opaque');
    const c = client(w);
    await c.auth();
    const link = (await c.call('GET', '/v1/orders')).headers?.link ?? '';
    const v1Cursor = /cursor=([^>&]+)>; rel="next"/.exec(link)?.[1] as string;
    expect(v1Cursor).toBeTruthy();
    expect(Buffer.from(v1Cursor, 'base64url').toString('utf8')).not.toContain('offset');
    const flipped = `${v1Cursor.slice(0, 20)}${v1Cursor[20] === 'A' ? 'B' : 'A'}${v1Cursor.slice(21)}`;
    expect((await c.call('GET', `/v1/orders?cursor=${flipped}`)).status).toBe(400);
    expect((await c.call('GET', `/v2/orders?cursor=${v1Cursor}`)).status).toBe(400);
    expect((await c.call('GET', `/v1/orders?cursor=${v1Cursor}`)).status).toBe(200);
  });
});

describe('checkService', () => {
  it('两个数都对才过；格式不对说清楚', () => {
    const task = serviceTask('medium');
    const world = generateService(SERVICE_PRESETS.medium, 'check');
    const dir = mkdtempSync(join(tmpdir(), 'melina-sim-service-'));
    try {
      const write = (v: unknown) => writeFileSync(join(dir, 'answer.json'), JSON.stringify(v));
      write({ orders: world.truth.orders, total_cents: world.truth.cents });
      expect(checkService(world, dir).pass).toBe(true);
      write({ orders: world.truth.orders, total_cents: world.truth.cents + 1 });
      expect(checkService(world, dir).summary).toContain('总金额');
      write({ orders: String(world.truth.orders), total_cents: world.truth.cents });
      expect(checkService(world, dir).pass).toBe(false);
      write({ orders: world.truth.orders, total_cents: world.truth.cents });
      expect(task.create('check').check(dir).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
