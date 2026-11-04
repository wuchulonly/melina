// 订单服务的标准解：从 api.md 拿地址和账号，照响应里能看到的线索一步步来：
// Link 头里有 successor-version 就去 v2（先看 v2 自带的接口说明）；否则在 v1 上用一个不认识的参数探出允许的参数，
// 下一页看响应体的 next_cursor、Link 头的 next，都没有才按 page 翻；429 按 Retry-After 等，令牌过期就重新拿；按 id 去重。
// 不 import world.ts 和 api.ts。

import { type HttpResult, http, parseLink, writeJson } from '../client.ts';
import type { SolveContext } from '../task.ts';

const Q3_FROM = '2026-07-01T00:00:00Z';
const Q3_TO = '2026-10-01T00:00:00Z';

interface Found {
  cents: number;
  createdAt: string;
}

export async function solveService(ctx: SolveContext): Promise<void> {
  const api = new Api(ctx);
  const first = await api.get('/v1/orders?page=1');
  const found = parseLink(first.headers.get('link'))['successor-version'] ? await viaV2(api) : await viaV1(api, first);
  writeJson(ctx.dir, 'answer.json', summarize(found));
}

export function summarize(found: Map<string, Found>): { orders: number; total_cents: number } {
  let orders = 0;
  let cents = 0;
  for (const o of found.values()) {
    if (o.createdAt >= Q3_FROM && o.createdAt < Q3_TO) {
      orders++;
      cents += o.cents;
    }
  }
  return { orders, total_cents: cents };
}

/** 账号在 api.md 的请求体例子里 */
export function credentialsOf(doc: string): { id: string; secret: string } {
  const id = /"client_id":\s*"([^"]+)"/.exec(doc)?.[1];
  const secret = /"client_secret":\s*"([^"]+)"/.exec(doc)?.[1];
  if (!id || !secret) throw new Error('api.md 里没找到账号');
  return { id, secret };
}

/** 带令牌的请求：429 按 Retry-After 等，令牌过期重新拿 */
export class Api {
  readonly ctx: SolveContext;
  readonly creds: { id: string; secret: string };
  token = '';
  requests = 0;

  constructor(ctx: SolveContext) {
    this.ctx = ctx;
    this.creds = credentialsOf(ctx.materials['api.md'] ?? '');
  }

  async auth(): Promise<void> {
    const res = await http(`${this.ctx.url}/oauth/token`, {
      method: 'POST',
      body: { client_id: this.creds.id, client_secret: this.creds.secret },
    });
    const token = (res.body as { access_token?: string } | undefined)?.access_token;
    if (!token) throw new Error(`拿不到令牌：${res.status} ${res.text}`);
    this.token = token;
  }

  async get(pathOrUrl: string): Promise<HttpResult> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.ctx.url}${pathOrUrl}`;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!this.token) await this.auth();
      this.requests++;
      const res = await http(url, { headers: { authorization: `Bearer ${this.token}` } });
      if (res.status === 429) {
        await this.ctx.sleep(Number(res.headers.get('retry-after') ?? '1') * 1000);
        continue;
      }
      if (res.status === 401) {
        this.token = '';
        continue;
      }
      return res;
    }
    throw new Error(`${url} 一直不成功`);
  }
}

async function viaV2(api: Api): Promise<Map<string, Found>> {
  const index = (await api.get('/v2')).body as {
    endpoints?: { path: string; params?: Record<string, string> }[];
  };
  const listing = index.endpoints?.find((e) => e.path === '/v2/orders');
  const include = /^\s*([a-z_]+)\s*[：:]/.exec(listing?.params?.include ?? '')?.[1];
  const found = new Map<string, Found>();
  let next: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const query = new URLSearchParams({ limit: '100' });
    if (include) query.set('include', include);
    if (next) query.set('cursor', next);
    const res = await api.get(`/v2/orders?${query}`);
    if (res.status !== 200) throw new Error(`v2 列表返回 ${res.status}：${res.text}`);
    const body = res.body as { items: { id: string; amount_cents: number; created_at: string }[]; next: string | null };
    for (const o of body.items) found.set(o.id, { cents: o.amount_cents, createdAt: o.created_at });
    next = body.next;
    if (!next) break;
  }
  return found;
}

async function viaV1(api: Api, first: HttpResult): Promise<Map<string, Found>> {
  // 用一个不认识的参数，看服务认哪些参数
  const probe = await api.get('/v1/orders?page=1&probe=1');
  const allowed = (probe.body as { allowed?: string[] } | undefined)?.allowed ?? [];
  const extra = allowed.includes('include_archived') ? '&include_archived=true' : '';
  const found = new Map<string, Found>();
  let res = extra ? await api.get(`/v1/orders?page=1${extra}`) : first;
  for (let page = 1; page < 1000; page++) {
    if (res.status !== 200) throw new Error(`v1 列表返回 ${res.status}：${res.text}`);
    const body = res.body as {
      data: { id: string; amount: string | number; created_at: string }[];
      next_cursor?: string;
    };
    for (const o of body.data) found.set(o.id, { cents: centsOf(o.amount), createdAt: o.created_at });
    const link = parseLink(res.headers.get('link')).next;
    if (body.next_cursor) res = await api.get(`/v1/orders?cursor=${encodeURIComponent(body.next_cursor)}${extra}`);
    else if (link) res = await api.get(`${link}${extra}`);
    else if (body.data.length > 0) res = await api.get(`/v1/orders?page=${page + 1}${extra}`);
    else break;
  }
  return found;
}

/** 金额（元）换成分：字符串按小数点拆开，不过浮点 */
export function centsOf(amount: string | number): number {
  const text = String(amount);
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`金额看不懂：${text}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
