// 订单服务的三档任务：简单（门槛 1，文档写的就是全部）、中等（门槛 2：分页和归档藏了起来，照文档做会少算）、
// 难（门槛 3：v2、精确金额、令牌过期、限流、页间重复，几件事要分别摸清；没有能直接核对答案的接口，容易交错）。

import type { CompletionSpec } from '../../../src/core/types.ts';
import type { SimClock } from '../kit/clock.ts';
import {
  type CheckResult,
  type Difficulty,
  type Gate,
  parseJson,
  readDeliverable,
  type SimTask,
  type SimWorld,
} from '../task.ts';
import { serviceHandler } from './api.ts';
import { naiveService } from './naive.ts';
import { solveService } from './solve.ts';
import { generateService, Q3_FROM, Q3_TO, type ServiceParams, type ServiceWorld } from './world.ts';

export const SERVICE_PRESETS: Record<Difficulty, ServiceParams> = {
  easy: {
    orders: 120,
    archivedShare: 0,
    pageSize: 50,
    pagination: 'page',
    archived: 'none',
    precision: 'exact',
    v2Overlap: false,
  },
  medium: {
    orders: 300,
    archivedShare: 0.12,
    pageSize: 50,
    pagination: 'cursor-body',
    archived: 'param',
    precision: 'exact',
    v2Overlap: false,
  },
  hard: {
    orders: 480,
    archivedShare: 0.15,
    pageSize: 50,
    pagination: 'cursor-header',
    archived: 'v2',
    precision: 'v2-cents',
    v2Overlap: true,
    rateLimit: 5,
    tokenTtl: 30,
  },
};

const GATE: Record<Difficulty, Gate> = { easy: 1, medium: 2, hard: 3 };
const LABEL: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '难' };

export function serviceTask(difficulty: Difficulty, params: ServiceParams = SERVICE_PRESETS[difficulty]): SimTask {
  return {
    id: `service-${difficulty}`,
    env: 'service',
    difficulty,
    gate: GATE[difficulty],
    title: `订单服务（${LABEL[difficulty]}）`,
    domain: 'general',
    create: (seed) => serviceWorld(generateService(params, seed), seed),
    solve: solveService,
    naive: naiveService,
  };
}

export function serviceTasks(): SimTask[] {
  return (['easy', 'medium', 'hard'] as const).map((d) => serviceTask(d));
}

function serviceWorld(world: ServiceWorld, seed: string): SimWorld {
  return {
    seed,
    // 交付物的格式写进目标（检查只认这两个键）：开着 Scoper、不给固定完成标准时，Melina 只看得到目标（ 的简单题对照里，
    // Scoper 自己起的键名 order_count、count 被判没过，数其实是对的）。另两个任务的目标本来就写了格式
    statement: (url) =>
      `用附件 api.md 里的账号，算出 ${url} 这个订单服务里 2026 年第三季度（7 月 1 日至 9 月 30 日，UTC）下的全部订单` +
      '（包括已归档的）一共多少单、总金额多少分，结果写进工作目录里的 answer.json，' +
      '格式是 {"orders": 单数, "total_cents": 总金额（分）}。',
    completion: (): CompletionSpec => ({
      interpretation:
        '第三季度按下单时间 created_at 算，2026-07-01T00:00:00Z（含）到 2026-10-01T00:00:00Z（不含）；已归档的订单也算；金额精确到分',
      criteria: [
        '工作目录根下有 answer.json，格式是 {"orders": 单数, "total_cents": 总金额（分）}，两个都是整数',
        `orders 等于服务里 created_at 在 ${Q3_FROM}（含）到 ${Q3_TO}（不含）之间的订单数，包括已归档的，同一个订单只算一次`,
        'total_cents 等于这些订单的金额之和，单位是分，没有四舍五入',
      ],
    }),
    materials: (url) => [{ name: 'api.md', content: apiDoc(world, url) }],
    starter: () => ({ 'README.md': '# 订单统计\n\n这次任务的交付物 answer.json 放在这个目录。\n' }),
    handler: (clock: SimClock) => serviceHandler(world, clock),
    deliverables: () => ['answer.json'],
    check: (dir) => checkService(world, dir),
    summary: () => ({
      truth: world.truth,
      orders: world.orders.length,
      archived: world.orders.filter((o) => o.archived).length,
      params: world.params,
    }),
  };
}

export function checkService(world: ServiceWorld, dir: string): CheckResult {
  const file = readDeliverable(dir, 'answer.json');
  if ('error' in file) return { pass: false, summary: file.error };
  const parsed = parseJson(file.text, 'answer.json');
  if ('error' in parsed) return { pass: false, summary: parsed.error };
  const v = parsed.value as { orders?: unknown; total_cents?: unknown } | null;
  if (!v || typeof v !== 'object' || !Number.isInteger(v.orders) || !Number.isInteger(v.total_cents)) {
    return { pass: false, summary: 'answer.json 要是 {"orders": 整数, "total_cents": 整数}' };
  }
  const { orders, cents } = world.truth;
  const wrong: string[] = [];
  if (v.orders !== orders) wrong.push(`单数写的 ${v.orders}，实际 ${orders}`);
  if (v.total_cents !== cents) wrong.push(`总金额写的 ${v.total_cents} 分，实际 ${cents} 分`);
  if (wrong.length > 0) return { pass: false, summary: wrong.join('；') };
  return { pass: true, summary: `第三季度 ${orders} 单、${cents} 分，都对` };
}

function apiDoc(world: ServiceWorld, url: string): string {
  const amount = world.params.precision === 'exact' ? '"1234.56"' : '1235';
  return `# 订单服务接口说明（v1）

地址：${url}

## 认证

\`POST ${url}/oauth/token\`，请求体：

\`\`\`json
{"client_id": "${world.clientId}", "client_secret": "${world.clientSecret}"}
\`\`\`

返回 \`{"access_token": "…", "token_type": "Bearer", "expires_in": 3600}\`。之后的请求都带请求头 \`Authorization: Bearer <access_token>\`。

## 订单

\`GET ${url}/v1/orders?page=1\`

按页列出订单，按订单号从小到大，每页 ${world.params.pageSize} 条，page 从 1 开始。返回 \`{"data": [订单…], "page": 1, "per_page": ${world.params.pageSize}}\`；data 是空数组表示没有了。可以加 \`status=paid|shipped|refunded\` 按状态筛。

\`GET ${url}/v1/orders/<id>\`：一个订单。

订单长这样：

\`\`\`json
{"id": "ORD-10234", "customer": "星河商贸", "city": "杭州", "status": "shipped", "amount": ${amount}, "created_at": "2026-08-03T10:22:00Z"}
\`\`\`

amount 是金额（元），created_at 是下单时间（UTC）。

## 统计

\`GET ${url}/v1/stats\`：\`{"orders": 订单总数}\`
${quotaDoc(world)}`;
}

/** 配额写进文档（真实的服务都会写）：几个人共用一个账号时谁也看不到别人用了多少，只能看响应头里的余量 */
function quotaDoc(world: ServiceWorld): string {
  const q = world.params.quota;
  if (!q) return '';
  const minutes = (ms: number) => `${Math.round(ms / 60_000)} 分钟`;
  return `
## 配额

每个账号（client_id）每 ${minutes(q.windowMs)}最多 ${q.requests} 次订单接口请求，这个账号的所有令牌加在一起算（拿令牌不算）。
用完以后整个账号锁 ${minutes(q.lockMs)}，期间所有请求都回 429（\`{"error": "quota_exceeded"}\`，\`Retry-After\` 是还要等的秒数）。
每个响应的 \`X-Quota-Remaining\` 头是这 ${minutes(q.windowMs)}里还剩几次。
`;
}
