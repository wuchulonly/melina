// 场景题·接口越权审计（难）：一个四五十个接口的小 Web 应用（starter/），上线前要把所有越权的接口找全——
// 不能漏、也不能多（交错就算没做成）。活很宽（每个接口都要看），可以按模块拆给 Helper；开头摸清整个应用
// 的鉴权是怎么串起来的（全局只认人不拦、谁用装饰器、谁用蓝图钩子、谁在函数体里手写）很值钱。
//
// 两种办法各自会漏不同的坑，正好是多条路线的用武之地：
// - 只读代码（静态）：看不出「先删后查、回 403」的副作用，也看不出运行时按 id 取到的是不是别人的资源。
// - 只拿测试客户端调（动态）：只看状态码会漏「先删后查」（回了 403 但东西已经删了）；碰不到的分支也测不到。
// 有一个坑是装饰器顺序写反（注册进去的是没包装的函数）——只扫「有没有写鉴权装饰器」的静态检查会漏；
// 有一个坑是先删了再查权限回 403——只看状态码的动态测试会漏。
//
// 交付工作目录根下的 answer.json：{"vulnerable": ["METHOD 路径模板", ...]}，写法和 `python -m app routes`
// 列出来的一样。检查只比这个集合和真值相不相等（方法大小写、首尾空格宽容，路径模板要一样）。
// 真值由题目目录下的 verify_truth.py 用真实请求逐条核对过（见单测）。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { here, readAnswer, readTree, realTask, writeAnswer } from '../../test/eval/real/kit.ts';
import type { EvalTask } from '../../test/eval/task.ts';
import type { CheckResult, SolveContext } from '../../test/sim/task.ts';

// 越权的三类：a 不登录就能调非公开接口；b 普通用户越过数据归属读/改/删别人的；c 普通用户做管理员的事。
interface Vuln {
  route: string; // 规范写法：METHOD 路径模板
  type: 'a' | 'b' | 'c';
  note: string; // 这条是什么坑（只进存档）
}

// 真值：10 条。和 verify_truth.py 的 EXPECTED 必须一致（单测跑 verify_truth.py 核对）。
const TRUTH: Vuln[] = [
  { route: 'GET /api/reports/summary', type: 'a', note: '同模块别的接口都有 @login_required，这个忘了加' },
  {
    route: 'POST /api/webhooks/<webhook_id>/rotate',
    type: 'a',
    note: '@login_required 写在 @bp.route 上面，注册进去的是没包装的函数',
  },
  {
    route: 'GET /api/publications/<pub_id>',
    type: 'a',
    note: 'before_request 用 path.startswith("/api/public") 放行，publications 也被放行',
  },
  {
    route: 'GET /api/v1/reports/<report_id>',
    type: 'a',
    note: 'v1 兼容层用 add_url_rule 把没包装的内部实现 _report_detail 挂上去',
  },
  { route: 'GET /api/invoices/<invoice_id>', type: 'b', note: '只查了登录没查归属，谁都能按 id 看别人的发票' },
  {
    route: 'PATCH /api/projects/<project_id>/tasks/<task_id>',
    type: 'b',
    note: '查了项目成员，但任务按 id 取、没核对是不是这个项目的',
  },
  {
    route: 'DELETE /api/files/<file_id>',
    type: 'b',
    note: '先 pop 删掉再查归属、回 403，文件已经没了（只看状态码会漏）',
  },
  { route: 'DELETE /api/notes/<note_id>', type: 'b', note: '同一视图按方法分支，只有 GET/PUT 查了归属，DELETE 漏了' },
  { route: 'PATCH /api/users/me', type: 'c', note: '把请求体整个 update 进用户，含 role，能给自己提权' },
  { route: 'PUT /api/flags/<flag>', type: 'c', note: 'staff 存成字符串 "false"，用 bool() 判断，非员工也为真' },
];

// 看着可疑、其实没事的诱饵（只进存档）：解答里不该出现它们。
const DECOYS: string[] = [
  'GET /api/admin/users 等管理后台接口：没有逐个装饰器，但蓝图的 before_request 要求管理员',
  'GET /api/admin/stats：带「# TODO: 鉴权？」注释，其实被蓝图钩子保护',
  'GET /api/teams/<team_id>：函数体里手写了成员检查，非成员直接 404',
  'GET /api/projects：按当前用户的参与情况过滤，只返回自己的',
  'PATCH /api/users/<user_id>：看着像批量赋值，但 @require_role("admin") 卡着，只有管理员能用',
  'GET /api/flags：@cache_response 写在 @bp.route 上面，但那是缓存、和鉴权无关，且 @login_required 在 route 下面（生效）',
  'GET /api/files/<file_id>/download、GET /api/invoices/<invoice_id>/pdf：和出问题的接口相邻，但归属检查是对的',
  'GET /api/v1/me：同样走 add_url_rule，但挂的是已经包过 @login_required 的函数（安全）',
  'GET /api/public/status、GET /api/public/plans、POST /api/auth/login：docs/security.md 里写明的公开接口',
];

function truthRoutes(): string[] {
  return TRUTH.map((v) => v.route);
}

// 直接的做法（必须过不了）：只扫路由上有没有写鉴权装饰器，有就当安全、没有就当越权。
// 会漏掉顺序写反（源码里有 @login_required）、IDOR、先删后查、批量赋值、方法分支、角色 bug（这些源码里都有装饰器），
// 还会把被蓝图钩子保护的管理后台、项目接口，和公开接口全算成越权。
const NAIVE: string[] = [
  'GET /api/reports/summary',
  'GET /api/publications/<pub_id>',
  'GET /api/v1/reports/<report_id>',
  'GET /api/v1/me',
  'POST /api/auth/login',
  'GET /api/public/status',
  'GET /api/public/plans',
  'GET /api/projects',
  'POST /api/projects',
  'GET /api/projects/<project_id>',
  'PATCH /api/projects/<project_id>',
  'DELETE /api/projects/<project_id>',
  'GET /api/projects/<project_id>/tasks',
  'POST /api/projects/<project_id>/tasks',
  'PATCH /api/projects/<project_id>/tasks/<task_id>',
  'GET /api/admin/users',
  'GET /api/admin/stats',
  'POST /api/admin/users/<user_id>/promote',
  'DELETE /api/admin/users/<user_id>',
];

/** 规范化一条「METHOD 路径」：方法大写、首尾和中间多余空格压掉；路径模板原样比 */
function normRoute(s: string): string | null {
  const m = /^\s*([A-Za-z]+)\s+(\S.*?)\s*$/.exec(s);
  if (!m) return null;
  return `${(m[1] as string).toUpperCase()} ${m[2] as string}`;
}

function checkAnswer(dir: string): CheckResult {
  const a = readAnswer(dir);
  if ('error' in a) return { pass: false, summary: a.error };
  const raw = (a.value as { vulnerable?: unknown }).vulnerable;
  if (!Array.isArray(raw)) {
    return { pass: false, summary: 'answer.json 里要有一个字符串数组 vulnerable（每项是「METHOD 路径模板」）' };
  }
  const got = new Set<string>();
  for (const x of raw) {
    const n = normRoute(String(x));
    if (n) got.add(n);
  }
  const truth = new Set(truthRoutes().map((r) => normRoute(r) as string));
  const missed = [...truth].filter((r) => !got.has(r));
  const extra = [...got].filter((r) => !truth.has(r));
  if (missed.length === 0 && extra.length === 0) {
    return { pass: true, summary: `全部 ${truth.size} 条越权都找对了，没有漏也没有多` };
  }
  const part = (label: string, xs: string[]) => `${label} ${xs.length} 条${xs.length ? `（${xs.join('、')}）` : ''}`;
  return { pass: false, summary: `${part('漏了', missed)}；${part('多了', extra)}` };
}

const REPORT_HEAD =
  '# 接口越权审计报告\n\n按 docs/security.md 的三类越权（a 匿名调非公开接口、b 越过数据归属、c 越过角色）审计了全部路由。\n\n';

function solutionReport(): string {
  const lines = TRUTH.map((v) => `- \`${v.route}\`（${v.type}）：${v.note}`);
  return `${REPORT_HEAD}## 确认越权的接口\n\n${lines.join('\n')}\n\n复现方式见 \`python -m app call\` / \`python -m app seq\`；先删后查用 seq 连着查能看到副作用。\n`;
}

const STATEMENT =
  '我们这个内部后台 API（acme-api）要上线了，上线前请你做一次接口越权审计：把所有存在越权的接口找出来，' +
  '不能漏，也不能多报。应用在工作目录里，是用自家迷你框架 miniweb 写的（用法像 Flask），几个模块是不同同事写的，' +
  '没有现成的漏洞清单。请结合材料检查和实际请求调查接口行为，为确认的问题给出可复现的证据。\n\n' +
  '鉴权约定和「什么算越权、哪些是公开接口」写在 docs/security.md，账号、令牌、种子数据的 id 写在 README.md。' +
  '`python -m app routes` 列出全部路由；`python -m app call METHOD PATH --as alice|bob|carol|anon [--json ...]` 发单个请求；' +
  '`python -m app seq FILE` 在同一份数据上连发一串请求（看先改后查这种副作用）；也可以 `from app import create_app` 直接用 test client。\n\n' +
  '越权分三类：(a) 不登录（不带令牌或令牌无效）就能成功调用的非公开接口；(b) 登录的普通用户能读、改、删别人（或别的团队）的数据；' +
  '(c) 普通用户能做只有管理员能做的事，包括给自己提权。这里的「成功」看结果——拿到了不该拿的数据、或者产生了效果' +
  '（被改、被删、密钥被换），状态码是 200 还是 403 不作数。';

export function auditTask(): EvalTask {
  return realTask({
    id: 'security-audit',
    suite: 'research',
    difficulty: 'hard',
    title: '接口越权审计（难）',
    domain: 'research',
    statement: () => STATEMENT,
    completion: () => ({
      interpretation: '把这个应用里所有越权的接口找全，一条不漏、一条不多，交成一份接口清单',
      criteria: [
        '在工作目录根下写 answer.json：{"vulnerable": ["METHOD 路径模板", ...]}，' +
          '路径模板和 `python -m app routes` 列出来的一样（比如 "DELETE /api/files/<file_id>"），同一路径不同方法分开写。',
        '越权按 docs/security.md 的三类判：(a) 匿名能成功调用的非公开接口；(b) 普通用户越过数据归属读/改/删别人的数据；' +
          '(c) 普通用户做了只有管理员能做的事（含给自己提权）。判「成功」看结果（拿到数据或产生效果），不看状态码。',
        '要全：所有越权接口都列出来。也不能多：没越权的接口（包括公开接口、被钩子或函数体正确保护的接口）不要列进去。',
        '另在工作目录根下写 report.md：每条越权的证据和复现步骤（不判分，供人复核）。',
      ],
    }),
    starter: () => readTree(here(import.meta.url, 'starter')),
    materials: () => [],
    deliverables: ['answer.json', 'report.md'],
    check: (dir) => checkAnswer(dir),
    solve: async (ctx: SolveContext) => {
      writeAnswer(ctx.dir, { vulnerable: truthRoutes() });
      writeFileSync(join(ctx.dir, 'report.md'), solutionReport());
    },
    naive: async (ctx: SolveContext) => {
      writeAnswer(ctx.dir, { vulnerable: NAIVE });
      writeFileSync(join(ctx.dir, 'report.md'), `${REPORT_HEAD}（只扫了路由上有没有鉴权装饰器。）\n`);
    },
    summary: () => ({ routeCount: 50, truth: TRUTH, decoys: DECOYS }),
  });
}
