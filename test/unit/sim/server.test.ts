// 仿真环境的 HTTP 服务：按前缀分实例；不存在的实例和不存在的接口返回一样的内容；curl -d 不带 Content-Type 也解析 JSON；
// 请求体上限；环境出错不漏细节；请求日志；给 agent 的地址用 publicHost。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json } from '../../sim/kit/http.ts';
import { SimServer } from '../../sim/server.ts';

let server: SimServer;

beforeEach(async () => {
  server = new SimServer({ maxBodyBytes: 1024 });
  await server.start();
});

afterEach(async () => {
  await server.close();
});

describe('SimServer', () => {
  it('按前缀分给不同的实例，路径去掉前缀，base 是实例对外的地址', async () => {
    const a = server.mount({
      handle: (req) => json(200, { who: 'a', path: req.path, base: req.base, q: req.query.get('q') }),
    });
    const b = server.mount({ handle: () => json(200, { who: 'b' }) });
    const ra = await (await fetch(`${a.url}/x/y?q=1`)).json();
    const rb = await (await fetch(`${b.url}/`)).json();
    expect(ra).toEqual({ who: 'a', path: '/x/y', base: a.url, q: '1' });
    expect(rb).toEqual({ who: 'b' });
    expect(a.log.map((e) => [e.method, e.path, e.query, e.status])).toEqual([['GET', '/x/y', '?q=1', 200]]);
  });

  it('不存在的实例和不存在的接口长得一样，试探不出别的前缀', async () => {
    const env = server.mount({
      handle: (req) => (req.path === '/' ? json(200, {}) : json(404, { error: '没有这个接口' })),
    });
    const missingRoute = await fetch(`${env.url}/nope`);
    const missingToken = await fetch(`http://127.0.0.1:${server.port}/0123456789abcdef/nope`);
    expect(missingToken.status).toBe(missingRoute.status);
    expect(await missingToken.text()).toBe(await missingRoute.text());
  });

  it('请求体不带 Content-Type 也按 JSON 解析；不是 JSON 时 body 是 undefined', async () => {
    const env = server.mount({ handle: (req) => json(200, { body: req.body ?? null, text: req.text }) });
    const asForm = await fetch(`${env.url}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '{"button":"A"}',
    });
    expect(await asForm.json()).toEqual({ body: { button: 'A' }, text: '{"button":"A"}' });
    const notJson = await fetch(`${env.url}/`, { method: 'POST', body: 'a=1' });
    expect(await notJson.json()).toEqual({ body: null, text: 'a=1' });
  });

  it('请求体太大返回 413，环境抛错返回 500 且不带细节', async () => {
    const env = server.mount({
      handle: () => {
        throw new Error('secret rule table');
      },
    });
    const big = await fetch(`${env.url}/`, { method: 'POST', body: 'x'.repeat(2048) });
    expect(big.status).toBe(413);
    const boom = await fetch(`${env.url}/`);
    expect(boom.status).toBe(500);
    expect(await boom.text()).not.toContain('secret');
  });

  it('给 agent 的地址用 publicHost；unmount 以后就找不到了', async () => {
    const other = new SimServer({ host: '127.0.0.1', publicHost: 'host.containers.internal' });
    await other.start();
    try {
      const env = other.mount({ handle: () => json(200, {}) });
      expect(env.url).toBe(`http://host.containers.internal:${other.port}/${env.token}`);
      expect(other.urlFor(env.token, '::1')).toBe(`http://[::1]:${other.port}/${env.token}`);
      const local = other.urlFor(env.token, '127.0.0.1');
      expect((await fetch(local)).status).toBe(200);
      other.unmount(env.token);
      expect((await fetch(local)).status).toBe(404);
    } finally {
      await other.close();
    }
  });
});
