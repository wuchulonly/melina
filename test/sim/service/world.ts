// 第二类：带未公开接口的假服务。一个订单服务，附件 api.md 只写了 v1 的一部分：
// 难度越高，藏起来的越多——分页实际靠游标（在响应体里，或只在 Link 头里），已归档的订单要加没写的参数、或只有 v2 能查，
// v1 的金额四舍五入到元、精确的在 v2，令牌按请求次数过期，按令牌限流，v2 翻页时页和页之间有重复。
// 数据全由种子生成；检查只认 2026 年第三季度（UTC）全部订单（含已归档）的单数和精确到分的总金额。

import { Rng } from '../kit/rng.ts';

export interface ServiceParams {
  orders: number;
  archivedShare: number; // 归档的比例（只从 9 月 15 日以前的订单里挑）
  pageSize: number; // v1 一页几条
  pagination: 'page' | 'cursor-body' | 'cursor-header'; // page：照文档；cursor-*：page 参数只认第 1 页，下一页的游标在响应体或 Link 头里
  archived: 'none' | 'param' | 'v2'; // param：v1 加 include_archived=true 才有；v2：只有 v2 能查
  precision: 'exact' | 'v2-cents'; // v2-cents：v1 的金额四舍五入到元，精确金额只在 v2
  v2Overlap: boolean; // v2 翻页时下一页开头会重复上一页末尾的一两条
  rateLimit?: number; // 每个令牌每秒最多几个请求
  tokenTtl?: number; // 一个令牌能用几次
  quota?: Quota; // 整个账号共用的请求配额
}

/**
 * 账号级配额：windowMs 里所有令牌加起来最多 requests 次订单接口请求（拿令牌不算），用完整个账号锁 lockMs。
 * 几条分支、几个 agent 用的是同一个账号，谁乱扫都会把大家一起锁住：测多 agent 抢同一个外部系统（Goal.sharedSystems）
 */
export interface Quota {
  requests: number;
  windowMs: number;
  lockMs: number;
}

export interface Order {
  id: string;
  customer: string;
  city: string;
  status: 'paid' | 'shipped' | 'refunded';
  cents: number;
  createdAt: string; // ISO，UTC
  archived: boolean;
}

export interface ServiceWorld {
  params: ServiceParams;
  orders: Order[]; // 按订单号从小到大
  clientId: string;
  clientSecret: string;
  salt: string; // 游标里的盐
  truth: { orders: number; cents: number }; // 2026 年第三季度、含归档
  hasV2: boolean;
}

export const Q3_FROM = '2026-07-01T00:00:00Z';
export const Q3_TO = '2026-10-01T00:00:00Z'; // 不含

const CUSTOMERS = [
  '星河商贸',
  '青松文具',
  '北辰电子',
  '远山茶业',
  '朝阳五金',
  '海蓝渔具',
  '金穗粮油',
  '白鹭服饰',
  '橙子数码',
  '竹林家居',
];
const CITIES = ['杭州', '成都', '武汉', '西安', '苏州', '长沙', '青岛', '厦门', '合肥', '昆明'];

export function generateService(params: ServiceParams, seed: string): ServiceWorld {
  const rng = new Rng(`service/${seed}`);
  const ids = new Set<string>();
  const orders: Order[] = [];
  const from = Date.parse('2026-04-01T00:00:00Z');
  const to = Date.parse('2026-12-01T00:00:00Z');
  // 季度边界上各放一单，看 agent 有没有把边界算对（含头不含尾）
  const fixed = ['2026-06-30T23:59:59Z', Q3_FROM, '2026-09-30T23:59:59Z', Q3_TO];
  for (let i = 0; i < params.orders; i++) {
    let id: string;
    do id = `ORD-${rng.int(10000, 99999)}`;
    while (ids.has(id));
    ids.add(id);
    const createdAt =
      i < fixed.length
        ? (fixed[i] as string)
        : new Date(from + Math.floor((rng.float() * (to - from)) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    orders.push({
      id,
      customer: rng.pick(CUSTOMERS),
      city: rng.pick(CITIES),
      status: rng.weighted(['paid', 'shipped', 'refunded'] as const, [3, 6, 1]),
      cents: rng.int(990, 499_999),
      createdAt,
      archived: false,
    });
  }
  if (params.archived !== 'none') {
    const old = orders.filter((o) => o.createdAt < '2026-09-15T00:00:00Z');
    const q3old = old.filter((o) => o.createdAt >= Q3_FROM);
    const n = Math.max(3, Math.round(params.orders * params.archivedShare));
    // 至少 3 单归档的在第三季度里，归档才真影响答案
    for (const o of rng.sample(q3old, Math.min(3, q3old.length))) o.archived = true;
    for (const o of rng.sample(old, n)) o.archived = true;
  }
  // 按订单号排：第一页里各个月的都有，只拿到第一页时算出来的数看着也像回事
  orders.sort((a, b) => a.id.localeCompare(b.id));
  const inQ3 = orders.filter((o) => o.createdAt >= Q3_FROM && o.createdAt < Q3_TO);
  return {
    params,
    orders,
    clientId: 'melina-eval',
    clientSecret: `sk-${rng.hex(24)}`,
    salt: rng.hex(8),
    truth: { orders: inQ3.length, cents: inQ3.reduce((sum, o) => sum + o.cents, 0) },
    hasV2: params.archived === 'v2' || params.precision === 'v2-cents',
  };
}

/** 金额的元表示：exact 是两位小数的字符串，v2-cents 是四舍五入到元的整数 */
export function v1Amount(world: ServiceWorld, cents: number): string | number {
  if (world.params.precision === 'v2-cents') return Math.round(cents / 100);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** v2 翻页：第 i 页从哪条开始；重复的条数由种子和页号定 */
export function v2Overlap(world: ServiceWorld, page: number): number {
  if (!world.params.v2Overlap || page === 0) return 0;
  return new Rng(`overlap/${world.salt}/${page}`).int(0, 2);
}
