// 订单服务的 HTTP 接口。附件 api.md 只写 v1 的一部分；其余照 world.ts 的参数决定藏多少：
// 游标分页、include_archived、v2（自带一页接口说明）、令牌按次数过期、按令牌限流、v2 页间重复，
// 还有整个账号共用的配额。
// 游标是加密的，里面带着第一页的筛选条件：翻页时不用再带筛选参数，带了又和第一页不一样就报错（不让人悄悄少拿数据）。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SimClock } from '../kit/clock.ts';
import { json, noRoute, type SimHandler, type SimRequest, type SimResponse, segments } from '../kit/http.ts';
import { type Order, type ServiceWorld, v1Amount, v2Overlap } from './world.ts';

interface Token {
  uses: number;
  recent: number[]; // 最近一秒内的请求时间
}

const MAX_TOKENS = 10_000;
const V2_PAGE_DEFAULT = 50;
const V2_PAGE_MAX = 100;

export function serviceHandler(world: ServiceWorld, clock: SimClock): SimHandler {
  const tokens = new Map<string, Token>();
  const p = world.params;
  // 账号级配额：窗口里记过账的请求时间；用完以后锁到 lockedUntil，锁期间的请求不记账
  let quotaLog: number[] = [];
  let lockedUntil = 0;

  /** 配额：锁着或者刚好用完就回 429（带 Retry-After），否则记一次账 */
  function spend(): SimResponse | undefined {
    const q = p.quota;
    if (!q) return undefined;
    const now = clock.now();
    if (now >= lockedUntil) {
      quotaLog = quotaLog.filter((t) => now - t < q.windowMs);
      if (quotaLog.length < q.requests) {
        quotaLog.push(now);
        return undefined;
      }
      lockedUntil = now + q.lockMs;
      quotaLog = [];
    }
    const wait = Math.ceil((lockedUntil - now) / 1000);
    return json(
      429,
      { error: 'quota_exceeded', error_description: `这个账号的配额用完了，整个账号锁定中，${wait} 秒后恢复` },
      { 'retry-after': String(wait), ...quotaHeaders() },
    );
  }

  /** 每个带令牌的响应都带上配额的余量（像 GitHub 的 X-RateLimit-*） */
  function quotaHeaders(): Record<string, string> {
    const q = p.quota;
    if (!q) return {};
    const now = clock.now();
    const used = now < lockedUntil ? q.requests : quotaLog.filter((t) => now - t < q.windowMs).length;
    return { 'x-quota-limit': String(q.requests), 'x-quota-remaining': String(Math.max(0, q.requests - used)) };
  }

  function deprecation(base: string, successor: string): Record<string, string> {
    if (!world.hasV2) return {};
    return {
      deprecation: 'true',
      sunset: 'Thu, 31 Dec 2026 23:59:59 GMT',
      link: `<${base}${successor}>; rel="successor-version"`,
    };
  }

  function issue(req: SimRequest): SimResponse {
    const form = req.body === undefined && req.text.includes('=') ? new URLSearchParams(req.text) : undefined;
    const body = (req.body ?? {}) as { client_id?: unknown; client_secret?: unknown };
    const id = form?.get('client_id') ?? body.client_id;
    const secret = form?.get('client_secret') ?? body.client_secret;
    if (id !== world.clientId || secret !== world.clientSecret) {
      return json(401, { error: 'invalid_client', error_description: 'client_id 或 client_secret 不对' });
    }
    const token = randomBytes(16).toString('hex');
    if (tokens.size >= MAX_TOKENS) {
      // 太多了就丢最久没用的：一条分支一直重新拿令牌时不把内存吃光，也不挤掉别的分支正在用的
      const stale = tokens.keys().next().value;
      if (stale !== undefined) tokens.delete(stale);
    }
    tokens.set(token, { uses: 0, recent: [] });
    return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
  }

  /** 认证、限流、按次数过期；通过返回 undefined */
  function guard(req: SimRequest): SimResponse | undefined {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) {
      return json(
        401,
        { error: 'unauthorized', error_description: '缺少 Authorization: Bearer <token>，先 POST /oauth/token 拿令牌' },
        { 'www-authenticate': 'Bearer' },
      );
    }
    const key = m[1] as string;
    const token = tokens.get(key);
    if (!token) return json(401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
    tokens.delete(key);
    tokens.set(key, token); // 挪到最后：Map 的顺序就是最久没用的在前
    // 配额先于限流记账：被限流的请求也算一次（真实的服务大多这样算，猛刷重试的会把配额烧光）
    const exhausted = spend();
    if (exhausted) return exhausted;
    const now = clock.now();
    if (p.rateLimit) {
      token.recent = token.recent.filter((t) => now - t < 1000);
      if (token.recent.length >= p.rateLimit) {
        return json(429, { error: 'rate_limited', error_description: 'too many requests' }, { 'retry-after': '1' });
      }
      token.recent.push(now);
    }
    token.uses++;
    if (p.tokenTtl && token.uses > p.tokenTtl) {
      return json(
        401,
        { error: 'invalid_token', error_description: 'token expired' },
        { 'www-authenticate': 'Bearer error="invalid_token", error_description="token expired"' },
      );
    }
    return undefined;
  }

  function unknownParams(req: SimRequest, allowed: string[], listAllowed: boolean): SimResponse | undefined {
    for (const key of req.query.keys()) {
      if (allowed.includes(key)) continue;
      return json(
        400,
        listAllowed ? { error: `unknown parameter: ${key}`, allowed } : { error: `unknown parameter: ${key}` },
      );
    }
    return undefined;
  }

  function v1Order(o: Order, withArchived: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: o.id,
      customer: o.customer,
      city: o.city,
      status: o.status,
      amount: v1Amount(world, o.cents),
      created_at: o.createdAt,
    };
    if (withArchived) out.archived = o.archived;
    return out;
  }

  function v2Order(o: Order): Record<string, unknown> {
    return {
      id: o.id,
      customer: o.customer,
      city: o.city,
      status: o.status,
      amount_cents: o.cents,
      created_at: o.createdAt,
      archived: o.archived,
    };
  }

  function v1Visible(includeArchived: boolean, status: string | null): Order[] {
    return world.orders.filter(
      (o) => (!o.archived || (p.archived === 'param' && includeArchived)) && (!status || o.status === status),
    );
  }

  function v1List(req: SimRequest): SimResponse {
    const cursorMode = p.pagination !== 'page';
    const allowed = [
      'page',
      'status',
      ...(cursorMode ? ['cursor'] : []),
      ...(p.archived === 'param' ? ['include_archived'] : []),
    ];
    const bad = unknownParams(req, allowed, p.archived === 'param');
    if (bad) return bad;
    let include = p.archived === 'param' && req.query.get('include_archived') === 'true';
    let status = req.query.get('status');
    const page = Number(req.query.get('page') ?? '1');
    if (!Number.isInteger(page) || page < 1) return json(400, { error: 'page 要是从 1 开始的整数' });
    let start: number | undefined;
    const cursor = req.query.get('cursor');
    if (cursorMode && cursor) {
      const decoded = decodeCursor(world, cursor, 'v1');
      if (decoded === undefined) return json(400, { error: 'cursor 不对' });
      const filtered = req.query.has('include_archived') || req.query.has('status');
      if (filtered && decoded.filter !== v1Filter(include, status)) return json(400, { error: FILTER_CHANGED });
      [include, status] = parseV1Filter(decoded.filter);
      start = decoded.offset;
    }
    const visible = v1Visible(include, status);
    // 游标分页的服务只认第 1 页：没带游标时 page 再大就当没有了
    start ??= cursorMode ? (page === 1 ? 0 : visible.length) : (page - 1) * p.pageSize;
    const items = visible.slice(start, start + p.pageSize);
    const more = start + p.pageSize < visible.length;
    const body: Record<string, unknown> = {
      data: items.map((o) => v1Order(o, include)),
      page: cursorMode && cursor ? null : page,
      per_page: p.pageSize,
    };
    const headers = deprecation(req.base, '/v2/orders');
    if (more && cursorMode) {
      const next = encodeCursor(world, {
        api: 'v1',
        offset: start + p.pageSize,
        page: 0,
        filter: v1Filter(include, status),
      });
      if (p.pagination === 'cursor-body') body.next_cursor = next;
      else {
        const link = `<${req.base}/v1/orders?cursor=${next}>; rel="next"`;
        headers.link = headers.link ? `${link}, ${headers.link}` : link;
      }
    }
    return json(200, body, headers);
  }

  function v1Detail(req: SimRequest, id: string): SimResponse {
    const allowed = p.archived === 'param' ? ['include_archived'] : [];
    const bad = unknownParams(req, allowed, p.archived === 'param');
    if (bad) return bad;
    const include = p.archived === 'param' && req.query.get('include_archived') === 'true';
    const o = v1Visible(include, null).find((x) => x.id === id);
    if (!o) return json(404, { error: '没有这个订单' }, deprecation(req.base, `/v2/orders/${id}`));
    return json(200, v1Order(o, include), deprecation(req.base, `/v2/orders/${id}`));
  }

  function v1Stats(req: SimRequest): SimResponse {
    const bad = unknownParams(req, [], false);
    if (bad) return bad;
    // param 模式下统计连归档的一起算（和列表对不上，是个线索）；v2 模式下 v1 只算没归档的
    const count = p.archived === 'v2' ? world.orders.filter((o) => !o.archived).length : world.orders.length;
    return json(200, { orders: count }, deprecation(req.base, '/v2/stats'));
  }

  function v2Index(req: SimRequest): SimResponse {
    return json(200, {
      version: '2',
      auth: '和 v1 一样：Authorization: Bearer <token>，令牌从 POST /oauth/token 拿',
      endpoints: [
        {
          method: 'GET',
          path: '/v2/orders',
          params: {
            limit: `每页条数，1 到 ${V2_PAGE_MAX}，默认 ${V2_PAGE_DEFAULT}`,
            cursor: '上一页返回的 next；next 为 null 表示没有了',
            include: 'archived：连已归档的订单一起返回',
          },
        },
        { method: 'GET', path: '/v2/orders/{id}' },
        { method: 'GET', path: '/v2/stats' },
      ],
      order_fields: {
        id: '订单号',
        customer: '客户',
        city: '城市',
        status: 'paid、shipped、refunded',
        amount_cents: '金额，单位分',
        created_at: '下单时间，UTC',
        archived: '是否已归档',
      },
      base: `${req.base}/v2`,
    });
  }

  function v2List(req: SimRequest): SimResponse {
    const allowed = ['limit', 'cursor', 'include'];
    const bad = unknownParams(req, allowed, true);
    if (bad) return bad;
    let include = (req.query.get('include') ?? '').split(',').includes('archived');
    const limit = Number(req.query.get('limit') ?? String(V2_PAGE_DEFAULT));
    if (!Number.isInteger(limit) || limit < 1 || limit > V2_PAGE_MAX) {
      return json(400, { error: `limit 要是 1 到 ${V2_PAGE_MAX} 的整数` });
    }
    let start = 0;
    let page = 0;
    const cursor = req.query.get('cursor');
    if (cursor) {
      const decoded = decodeCursor(world, cursor, 'v2');
      if (decoded === undefined) return json(400, { error: 'cursor 不对' });
      if (req.query.has('include') && decoded.filter !== (include ? 'archived' : '')) {
        return json(400, { error: FILTER_CHANGED });
      }
      include = decoded.filter === 'archived';
      start = decoded.offset;
      page = decoded.page;
    }
    const visible = world.orders.filter((o) => include || !o.archived);
    const items = visible.slice(start, start + limit);
    let next: string | null = null;
    if (start + limit < visible.length) {
      // 下一页开头重复上一页末尾的几条，但至少往前走一条
      const overlap = Math.min(v2Overlap(world, page + 1), limit - 1);
      next = encodeCursor(world, {
        api: 'v2',
        offset: start + limit - overlap,
        page: page + 1,
        filter: include ? 'archived' : '',
      });
    }
    return json(200, { items: items.map(v2Order), next });
  }

  /** 带令牌的响应加上配额的余量头（已经带了的不覆盖） */
  function withQuota(res: SimResponse): SimResponse {
    if (!p.quota) return res;
    return { ...res, headers: { ...quotaHeaders(), ...(res.headers ?? {}) } };
  }

  function route(req: SimRequest, parts: string[]): SimResponse {
    const [version, resource, id, ...rest] = parts;
    if (rest.length > 0) return noRoute();
    if (version === 'v1') {
      if (resource === 'orders' && id === undefined) return v1List(req);
      if (resource === 'orders' && id !== undefined) return v1Detail(req, id);
      if (resource === 'stats' && id === undefined) return v1Stats(req);
      return noRoute();
    }
    if (resource === 'orders' && id === undefined) return v2List(req);
    if (resource === 'orders' && id !== undefined) {
      const o = world.orders.find((x) => x.id === id);
      return o ? json(200, v2Order(o)) : json(404, { error: '没有这个订单' });
    }
    if (resource === 'stats' && id === undefined) {
      return json(200, { orders: world.orders.length, archived: world.orders.filter((o) => o.archived).length });
    }
    return noRoute();
  }

  return {
    handle(req) {
      const parts = segments(req.path);
      if (parts.length === 0) return json(200, { service: '订单服务', docs: '接口见附件 api.md' });
      if (parts[0] === 'oauth' && parts[1] === 'token' && parts.length === 2) {
        if (req.method !== 'POST') return json(405, { error: '拿令牌用 POST' });
        return issue(req);
      }
      if (parts[0] === 'v2' && world.hasV2 && parts.length === 1) return v2Index(req);
      if (parts[0] !== 'v1' && !(parts[0] === 'v2' && world.hasV2)) return noRoute();
      if (req.method !== 'GET') return json(405, { error: '订单接口只读，用 GET' });
      const denied = guard(req);
      // 没带令牌、令牌不对的认不出是哪个账号，不带配额头
      if (denied) return denied.status === 401 ? denied : withQuota(denied);
      return withQuota(route(req, parts));
    },
  };
}

const FILTER_CHANGED = 'cursor 是按另一组筛选条件发的：翻页时筛选条件要和第一页一样，或者干脆不带';

interface CursorState {
  api: 'v1' | 'v2';
  offset: number;
  page: number;
  filter: string; // 第一页的筛选条件
}

function v1Filter(includeArchived: boolean, status: string | null): string {
  return `${includeArchived ? 'archived' : ''}|${status ?? ''}`;
}

function parseV1Filter(filter: string): [boolean, string | null] {
  const [archived = '', status = ''] = filter.split('|');
  return [archived === 'archived', status === '' ? null : status];
}

function cursorKey(world: ServiceWorld): Buffer {
  return createHash('sha256').update(`cursor/${world.salt}`).digest();
}

/** 加密的游标：外人看不出里面是什么，也改不了 */
function encodeCursor(world: ServiceWorld, state: CursorState): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(world), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

function decodeCursor(world: ServiceWorld, cursor: string, api: CursorState['api']): CursorState | undefined {
  try {
    const raw = Buffer.from(cursor, 'base64url');
    if (raw.length < 29) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(world), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const v = JSON.parse(text) as CursorState;
    if (v.api !== api || !Number.isInteger(v.offset) || v.offset < 0 || !Number.isInteger(v.page)) return undefined;
    return v;
  } catch {
    return undefined;
  }
}
