// 研究题·故障复盘（难）：一次延迟故障的三个小时的日志（每次试验按种子生成一份）：网关访问日志、链路追踪的 span、发布记录、配置变更。
// 根因是某个下游服务的一次配置变更（连接池调小、缓存关掉、读副本摘掉之一），这个服务的每个操作都变慢，调用它的接口跟着变慢。
// 藏着的坑：故障前几分钟有一次别的服务的发布（被慢接口调用，看起来最像），payments 每 20 分钟一次 GC 停顿（结算接口的 p99 一直有尖刺），
// 根因服务早些时候还有一次无关的配置变更，访问日志里的路径带着具体的 id（要归成模板），超过 3 秒的请求网关回 504。
// 真值是生成时定的；标准解只读附件，按「哪个接口变慢 → 哪个下游的 span 变慢 → 它之前最近的一次变更」推出来。

import { Rng } from '../../../sim/kit/rng.ts';
import type { CheckResult, SolveContext } from '../../../sim/task.ts';
import type { EvalTask } from '../../task.ts';
import { answerCriteria, readAnswer, realTask, writeAnswer } from '../kit.ts';

const DAY = Date.UTC(2026, 8, 20);
const START = DAY + 12 * 3600_000;
const END = DAY + 15 * 3600_000;

type Service = 'search' | 'inventory' | 'pricing' | 'payments' | 'catalog' | 'recs';

const OPS: Record<Service, { op: string; median: number }[]> = {
  search: [{ op: 'search.query', median: 40 }],
  inventory: [
    { op: 'inventory.stock', median: 15 },
    { op: 'inventory.reserve', median: 25 },
  ],
  pricing: [{ op: 'pricing.quote', median: 10 }],
  payments: [{ op: 'payments.charge', median: 180 }],
  catalog: [{ op: 'catalog.get', median: 12 }],
  recs: [{ op: 'recs.rank', median: 60 }],
};

interface Endpoint {
  method: string;
  template: string;
  path: (rng: Rng) => string;
  calls: [Service, string][];
  weight: number;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: 'GET',
    template: '/api/orders/search',
    path: (r) => `/api/orders/search?q=${r.pick(['shoe', 'lamp', 'desk', 'cup', 'bag'])}`,
    calls: [
      ['search', 'search.query'],
      ['inventory', 'inventory.stock'],
    ],
    weight: 30,
  },
  {
    method: 'GET',
    template: '/api/cart',
    path: () => '/api/cart',
    calls: [
      ['inventory', 'inventory.stock'],
      ['pricing', 'pricing.quote'],
    ],
    weight: 20,
  },
  {
    method: 'POST',
    template: '/api/checkout',
    path: () => '/api/checkout',
    calls: [
      ['pricing', 'pricing.quote'],
      ['inventory', 'inventory.reserve'],
      ['payments', 'payments.charge'],
    ],
    weight: 10,
  },
  {
    method: 'GET',
    template: '/api/products/{id}',
    path: (r) => `/api/products/${r.int(10000, 99999)}`,
    calls: [
      ['catalog', 'catalog.get'],
      ['pricing', 'pricing.quote'],
    ],
    weight: 30,
  },
  {
    method: 'GET',
    template: '/api/recommendations/{userId}',
    path: (r) => `/api/recommendations/u${r.int(100000, 999999)}`,
    calls: [
      ['recs', 'recs.rank'],
      ['catalog', 'catalog.get'],
    ],
    weight: 10,
  },
];

const CULPRITS: {
  service: Service;
  key: string;
  from: string;
  to: string;
  decoy: Service;
  harmless: [string, string, string];
}[] = [
  {
    service: 'inventory',
    key: 'db.pool.max_connections',
    from: '50',
    to: '8',
    decoy: 'search',
    harmless: ['cache.ttl_seconds', '60', '120'],
  },
  {
    service: 'pricing',
    key: 'cache.enabled',
    from: 'true',
    to: 'false',
    decoy: 'catalog',
    harmless: ['log.level', 'info', 'debug'],
  },
  {
    service: 'catalog',
    key: 'db.read_replicas',
    from: '3',
    to: '0',
    decoy: 'recs',
    harmless: ['http.keepalive_seconds', '30', '60'],
  },
];

export interface IncidentTruth {
  change: string;
  service: Service;
  endpoints: string[];
  startedAt: string; // HH:MM，UTC
  decoyDeploy: string;
}

export interface IncidentData {
  files: Record<string, string>;
  truth: IncidentTruth;
}

function logNormal(rng: Rng, median: number, sigma = 0.5): number {
  // Box–Muller
  const u = Math.max(1e-12, rng.float());
  const v = rng.float();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(sigma * z);
}

const iso = (t: number) => new Date(t).toISOString();
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

export function generate(seed: string): IncidentData {
  const rng = new Rng(`incident/${seed}`);
  const culprit = rng.pick(CULPRITS);
  const t0 = DAY + 13 * 3600_000 + rng.int(0, 12) * 60_000; // 故障开始（整分钟）
  const changeId = `CHG-${rng.int(4000, 4999)}`;
  const decoyId = `DEP-${rng.int(7000, 7999)}`;
  const access: string[] = [];
  const spans: string[] = [];
  const hex = () => rng.hex(16);
  const gcMinute = (t: number) => Math.floor((t - START) / 60_000) % 20 === 10;
  let t = START;
  while (t < END) {
    t += rng.int(300, 1700); // 平均每秒一个请求
    const ep = rng.weighted(
      ENDPOINTS,
      ENDPOINTS.map((e) => e.weight),
    );
    const trace = hex();
    let at = t + rng.int(1, 5);
    let total = logNormal(rng, 8, 0.3);
    for (const [service, op] of ep.calls) {
      const base = OPS[service].find((o) => o.op === op)?.median ?? 20;
      let ms = logNormal(rng, base);
      if (service === culprit.service && t >= t0) ms += -Math.log(Math.max(1e-12, rng.float())) * 700;
      if (service === 'payments' && gcMinute(t) && rng.chance(0.5)) ms += 1500 + rng.int(0, 800);
      ms = Math.round(ms);
      spans.push(`${iso(at)} trace=${trace} service=${service} op=${op} ms=${ms}`);
      at += ms;
      total += ms;
    }
    total = Math.round(total);
    const status = total > 3000 ? 504 : rng.chance(0.004) ? 500 : 200;
    access.push(`${iso(t)} ${ep.method} ${ep.path(rng)} ${status} ${Math.min(total, 3000)}ms trace=${trace}`);
  }
  // 发布：几次正常的，加一次故障前几分钟的诱饵（被变慢的接口调用的、但不是根因的服务）
  const deploys = [
    `${iso(START + 14 * 60_000 + 12_000)} deploy id=DEP-${rng.int(6000, 6999)} service=payments version=v3.4.1 by=ci`,
    `${iso(START + 38 * 60_000 + 40_000)} deploy id=DEP-${rng.int(6000, 6999)} service=recs version=v1.18.0 by=ci`,
    `${iso(t0 - rng.int(5, 8) * 60_000 - 20_000)} deploy id=${decoyId} service=${culprit.decoy} version=v2.${rng.int(20, 40)}.0 by=ci`,
    `${iso(t0 + 52 * 60_000)} deploy id=DEP-${rng.int(8000, 8999)} service=gateway version=v5.2.3 by=ci`,
  ];
  const changes = [
    `${iso(START + 20 * 60_000 + 5_000)} change=CHG-${rng.int(3000, 3999)} service=${culprit.service} key=${culprit.harmless[0]} old=${culprit.harmless[1]} new=${culprit.harmless[2]} by=alice`,
    `${iso(t0 - rng.int(20, 70) * 1000)} change=${changeId} service=${culprit.service} key=${culprit.key} old=${culprit.from} new=${culprit.to} by=ops-bot`,
    `${iso(t0 + 2 * 60_000 + 30_000)} change=CHG-${rng.int(5000, 5999)} service=recs key=feature.new_ranker old=off new=on by=bob`,
    `${iso(START + 95 * 60_000)} change=CHG-${rng.int(5000, 5999)} service=gateway key=log.sample_rate old=0.1 new=0.05 by=carol`,
  ];
  const endpoints = ENDPOINTS.filter((e) => e.calls.some(([s]) => s === culprit.service))
    .map((e) => e.template)
    .sort();
  const sortByTime = (lines: string[]) => [...lines].sort();
  return {
    files: {
      'gateway-access.log': `${access.join('\n')}\n`,
      'spans.log': `${sortByTime(spans).join('\n')}\n`,
      'deploys.log': `${sortByTime(deploys).join('\n')}\n`,
      'config-changes.log': `${sortByTime(changes).join('\n')}\n`,
    },
    truth: { change: changeId, service: culprit.service, endpoints, startedAt: hhmm(t0), decoyDeploy: decoyId },
  };
}

export const NOTES = `# 2026-09-20 下午延迟升高的复盘材料

值班同学导出的四份日志，时间都是 UTC，覆盖 12:00 到 15:00：

- gateway-access.log：网关访问日志，一行一个请求：时间、方法、路径、状态码、耗时、trace id。网关 3 秒超时，超时的回 504、耗时记 3000ms。
- spans.log：链路追踪，一行一个下游调用（span）：时间、trace id、服务、操作、耗时。网关的一个请求按顺序调用几个下游服务。
- deploys.log：发布记录。
- config-changes.log：配置变更记录。

接口的路径里带着具体的 id，复盘时按模板说，比如 /api/products/{id}、/api/recommendations/{userId}；/api/orders/search 带的查询参数不算路径。
`;

const ANSWER_FIELDS =
  'root_cause（{"change": 根因那条变更或发布的 id，比如 "CHG-1234" 或 "DEP-1234", "service": 出问题的服务}）、started_at（故障开始的时间，UTC 的 "HH:MM"）、affected_endpoints（明显变慢的接口，用模板写，比如 ["/api/cart", "/api/products/{id}"]）';

/** 从日志推根因（标准解；检查用生成时的真值） */
export function investigate(files: Record<string, string>): {
  change: string;
  service: string;
  endpoints: string[];
  startedAt: string;
} {
  const template = (path: string) => {
    const p = (path.split('?')[0] ?? path).replace(/^\/api\/products\/\d+$/, '/api/products/{id}');
    return p.replace(/^\/api\/recommendations\/[^/]+$/, '/api/recommendations/{userId}');
  };
  const byEndpoint = new Map<string, { t: number; ms: number }[]>();
  for (const line of (files['gateway-access.log'] ?? '').trim().split('\n')) {
    const [ts, , path, , took] = line.split(' ');
    if (!ts || !path || !took) continue;
    const list = byEndpoint.get(template(path)) ?? [];
    list.push({ t: Date.parse(ts), ms: Number.parseInt(took, 10) });
    byEndpoint.set(template(path), list);
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length === 0 ? 0 : (s[Math.floor(s.length / 2)] as number);
  };
  // 用中位数看（p99 会被 payments 的 GC 尖刺带偏）：最后一小时比第一小时慢一倍以上的接口
  const affected: string[] = [];
  for (const [ep, list] of byEndpoint) {
    const first = median(list.filter((r) => r.t < START + 3600_000).map((r) => r.ms));
    const last = median(list.filter((r) => r.t >= END - 3600_000).map((r) => r.ms));
    if (last > 2 * first) affected.push(ep);
  }
  affected.sort();
  // 开始时间：变慢的接口按分钟的中位数，第一个连续 3 分钟都超过第一小时中位数 3 倍的分钟
  const perMinute = new Map<number, number[]>();
  const baseline = new Map<string, number>();
  for (const ep of affected) {
    const list = byEndpoint.get(ep) ?? [];
    baseline.set(ep, median(list.filter((r) => r.t < START + 3600_000).map((r) => r.ms)));
    for (const r of list) {
      const m = Math.floor((r.t - START) / 60_000);
      const ratio = r.ms / (baseline.get(ep) as number);
      const arr = perMinute.get(m) ?? [];
      arr.push(ratio);
      perMinute.set(m, arr);
    }
  }
  let start = -1;
  for (let m = 0; m < 180; m++) {
    if ([m, m + 1, m + 2].every((k) => median(perMinute.get(k) ?? [0]) > 3)) {
      start = m;
      break;
    }
  }
  const startedAt = START + Math.max(0, start) * 60_000;
  // 哪个服务的 span 变慢了：开始前一小时和开始后的中位数比
  const spans = new Map<string, { before: number[]; after: number[] }>();
  for (const line of (files['spans.log'] ?? '').trim().split('\n')) {
    const m = /^(\S+) trace=\S+ service=(\S+) op=\S+ ms=(\d+)$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1] as string);
    const s = spans.get(m[2] as string) ?? { before: [], after: [] };
    if (t < startedAt && t >= startedAt - 3600_000) s.before.push(Number(m[3]));
    else if (t >= startedAt) s.after.push(Number(m[3]));
    spans.set(m[2] as string, s);
  }
  let service = '';
  let worst = 0;
  for (const [name, s] of spans) {
    const ratio = median(s.after) / Math.max(1, median(s.before));
    if (ratio > worst) {
      worst = ratio;
      service = name;
    }
  }
  // 这个服务在开始之前最近的一次变更（配置变更或发布）
  const events: { t: number; id: string }[] = [];
  for (const line of (files['config-changes.log'] ?? '').trim().split('\n')) {
    const m = /^(\S+) change=(\S+) service=(\S+) /.exec(line);
    if (m && m[3] === service) events.push({ t: Date.parse(m[1] as string), id: m[2] as string });
  }
  for (const line of (files['deploys.log'] ?? '').trim().split('\n')) {
    const m = /^(\S+) deploy id=(\S+) service=(\S+) /.exec(line);
    if (m && m[3] === service) events.push({ t: Date.parse(m[1] as string), id: m[2] as string });
  }
  const before = events.filter((e) => e.t <= startedAt + 60_000).sort((a, b) => b.t - a.t);
  return { change: before[0]?.id ?? '', service, endpoints: affected, startedAt: hhmm(startedAt) };
}

/** 直接的做法：怪故障前最近的一次发布，变慢的只报最慢的那个接口 */
function naiveGuess(files: Record<string, string>): Record<string, unknown> {
  const found = investigate(files);
  const start = Date.parse(`2026-09-20T${found.startedAt}:00Z`);
  let last: { t: number; id: string; service: string } | undefined;
  for (const line of (files['deploys.log'] ?? '').trim().split('\n')) {
    const m = /^(\S+) deploy id=(\S+) service=(\S+) /.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1] as string);
    if (t <= start && (!last || t > last.t)) last = { t, id: m[2] as string, service: m[3] as string };
  }
  return {
    root_cause: { change: last?.id ?? '', service: last?.service ?? '' },
    started_at: found.startedAt,
    affected_endpoints: found.endpoints.slice(0, 1),
  };
}

export function checkIncident(answer: Record<string, unknown>, truth: IncidentTruth): CheckResult {
  const wrong: string[] = [];
  const rc = answer.root_cause as { change?: unknown; service?: unknown } | undefined;
  if (rc?.change !== truth.change) wrong.push(`root_cause.change（应为 ${truth.change}）`);
  if (rc?.service !== truth.service) wrong.push(`root_cause.service（应为 ${truth.service}）`);
  const minutes = (s: unknown) => {
    const m = typeof s === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(s.trim()) : null;
    return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
  };
  if (!(Math.abs(minutes(answer.started_at) - minutes(truth.startedAt)) <= 3))
    wrong.push(`started_at（应在 ${truth.startedAt} 前后 3 分钟内）`);
  const eps = Array.isArray(answer.affected_endpoints) ? [...answer.affected_endpoints].map(String).sort() : [];
  if (JSON.stringify(eps) !== JSON.stringify(truth.endpoints))
    wrong.push(`affected_endpoints（应为 ${truth.endpoints.join('、')}）`);
  if (wrong.length === 0)
    return { pass: true, summary: `全对：${truth.change}（${truth.service}），${truth.startedAt} 开始` };
  return { pass: false, summary: `不对的：${wrong.join('；')}` };
}

export function incidentTask(): EvalTask {
  let cached: { seed: string; data: IncidentData } | undefined;
  const data = (seed: string) => {
    if (cached?.seed !== seed) cached = { seed, data: generate(seed) };
    return cached.data;
  };
  return realTask({
    id: 'research-incident',
    suite: 'research',
    difficulty: 'hard',
    title: '故障复盘（难）',
    domain: 'research',
    statement: () =>
      '9 月 20 日下午网关的延迟升高，持续到现在还没恢复。用附件里的四份日志做复盘：根因是哪一次变更（配置变更或发布）、哪个服务、几点开始的、哪些接口明显变慢了。',
    completion: () => ({
      interpretation: '从日志里找出这次延迟升高的根因、开始时间和受影响的接口，有证据支撑，不是猜',
      criteria: [
        ...answerCriteria(ANSWER_FIELDS),
        '根因要有日志里的证据：哪些接口变慢、慢在哪个下游、那个下游之前发生了什么变化，写进 report.md。',
      ],
    }),
    starter: () => ({ 'README.md': '# 故障复盘\n\n附件在 /melina/materials：notes.md 说明了四份日志的格式。\n' }),
    materials: (seed) => [
      { name: 'notes.md', content: NOTES },
      ...Object.entries(data(seed).files).map(([name, content]) => ({ name, content })),
    ],
    deliverables: ['answer.json', 'report.md'],
    check: (dir, _ctx, seed) => {
      const a = readAnswer(dir);
      if ('error' in a) return { pass: false, summary: a.error };
      return checkIncident(a.value, data(seed).truth);
    },
    solve: async (ctx: SolveContext) => {
      const found = investigate(ctx.materials);
      writeAnswer(ctx.dir, {
        root_cause: { change: found.change, service: found.service },
        started_at: found.startedAt,
        affected_endpoints: found.endpoints,
      });
    },
    naive: async (ctx: SolveContext) => writeAnswer(ctx.dir, naiveGuess(ctx.materials)),
    summary: (seed) => ({
      truth: data(seed).truth,
      lines: Object.fromEntries(Object.entries(data(seed).files).map(([k, v]) => [k, v.split('\n').length - 1])),
    }),
  });
}
