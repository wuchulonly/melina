// HTTP API的路径、请求和返回，SSE 的格式，SDK 的构造参数。
// 后端（src/api/）照这里实现，前端（web/）照这里写客户端，假后端照这里返回。
//
// 所有接口都在 /api 下（例如 GET /api/runs），避免与前端页面路径冲突；当前接口以 API_ROUTES 为准。

import Type, { type Static } from 'typebox';
import { type ModelsConfig, RunConfigOverride, type Settings } from './config.ts';
import type { ErrorCode } from './errors.ts';
import { SystemStatus, UsageBreakdown, UsageTotals } from './events.ts';
import type { ModelRef } from './model-ref.ts';
import { Arr, Bool, Enum, HandleS, IdS, Nat, Num, Obj, Opt, SnapshotS, Str, Time } from './schema.ts';
import { SemanticDigest, TaskProfile } from './telemetry.ts';
import {
  AcceptanceProgress,
  Bet,
  Branch,
  Candidate,
  CompletionSpec,
  HumanInput,
  Observation,
  Role,
  Run,
  RunMode,
  RunStatus,
  WatchNote,
} from './types.ts';

export const API_BASE = '/api';

/** 接口表。path 里的 :id、:branchId、:hash 换成实际值，用 apiPath() */
export const API_ROUTES = {
  listRuns: { method: 'GET', path: '/runs' },
  createRun: { method: 'POST', path: '/runs' },
  dirs: { method: 'GET', path: '/dirs' }, // ?prefix=
  getRun: { method: 'GET', path: '/runs/:id' },
  runProgress: { method: 'GET', path: '/runs/:id/progress' },
  runEvents: { method: 'GET', path: '/runs/:id/events' },
  branch: { method: 'GET', path: '/runs/:id/branches/:branchId' }, // ?cursor=&limit=
  branchDiff: { method: 'GET', path: '/runs/:id/branches/:branchId/diff' },
  input: { method: 'POST', path: '/runs/:id/input' },
  pause: { method: 'POST', path: '/runs/:id/pause' },
  interrupt: { method: 'POST', path: '/runs/:id/interrupt' },
  resume: { method: 'POST', path: '/runs/:id/resume' },
  cancel: { method: 'POST', path: '/runs/:id/cancel' },
  deleteRun: { method: 'DELETE', path: '/runs/:id' },
  result: { method: 'GET', path: '/runs/:id/result' },
  artifact: { method: 'GET', path: '/runs/:id/artifacts/:hash' },
  events: { method: 'GET', path: '/events' },
  usage: { method: 'GET', path: '/usage' },
  status: { method: 'GET', path: '/status' },
  getModels: { method: 'GET', path: '/models' },
  putModels: { method: 'PUT', path: '/models' },
  modelCatalog: { method: 'GET', path: '/models/catalog' },
  getSettings: { method: 'GET', path: '/settings' },
  putSettings: { method: 'PUT', path: '/settings' },
} as const;
export type ApiRouteName = keyof typeof API_ROUTES;

/** apiPath('/runs/:id/progress', { id }) → '/api/runs/<id>/progress' */
export function apiPath(template: string, params: Record<string, string> = {}): string {
  const path = template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`缺路径参数 ${name}：${template}`);
    return encodeURIComponent(value);
  });
  return API_BASE + path;
}

// ── 错误 ──────────────────────────────────────────────────────────────────

/** 出错时一律返回这个，HTTP 状态码按 code 定（HTTP_STATUS） */
export const ApiError = Obj({
  error: Obj({
    code: Enum(['invalid', 'not_found', 'conflict', 'forbidden', 'unavailable', 'internal']),
    message: Str(), // 给人看的一句话
    details: Opt(Type.Unknown()), // 比如 schema 校验的错误列表
  }),
});
export type ApiError = Static<typeof ApiError>;

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

// ── 任务 ──────────────────────────────────────────────────────────────────

/** GET /runs 的一行：目标、状态、模式、开始时间、已用 token */
export const RunListItem = Obj({
  id: IdS(),
  statement: Str(),
  status: RunStatus,
  mode: RunMode,
  domain: Opt(Str()),
  workspace: Str(), // 工作目录
  createdAt: Time(),
  endedAt: Opt(Time()),
  usage: UsageTotals, // 任务累计用量
  // 结束了的写一句结果：交付了就是交付的那个候选的结论，没交付就是结束原因（任务列表看不出结果）
  outcome: Opt(Str()),
});
export type RunListItem = Static<typeof RunListItem>;

export const RunListResponse = Obj({ runs: Arr(RunListItem) }); // 新的在前
export type RunListResponse = Static<typeof RunListResponse>;

/**
 * POST /runs。两种发法：
 * - multipart/form-data：一个叫 run 的字段放这个对象的 JSON，附件放在叫 materials 的文件字段里（可以多个，保留原文件名）；
 * - application/json：就是这个对象，没有附件。
 * 工作目录不存在、不是目录、在 Melina 的数据目录里或包含数据目录就拒绝（invalid）。
 */
export const CreateRunRequest = Obj({
  statement: Str(), // 目标，必填；接着做时预填上个任务的，可以改
  workspace: Opt(Str()), // 工作目录；不传就新建空目录；continueFrom 时不传（照旧）
  continueFrom: Opt(IdS()), // 接着哪个已结束的 Run 做
  config: Opt(RunConfigOverride), // 可以按 Run 覆盖的配置
  completion: Opt(CompletionSpec), // 评估用：照样调 Scoper，完成标准照给的用，给主干直解路线的卡、约束由它写
  domain: Opt(Str()), // 和 completion 一起给
});
export type CreateRunRequest = Static<typeof CreateRunRequest>;

export const CreateRunResponse = Obj({ runId: IdS() });
export type CreateRunResponse = Static<typeof CreateRunResponse>;

/** GET /dirs?prefix=：新建任务时补全工作目录 */
export const DirEntry = Obj({ name: Str(), path: Str(), git: Bool() });
export type DirEntry = Static<typeof DirEntry>;
export const DirsResponse = Obj({
  dir: Opt(Str()), // 列的是哪个目录（~ 已展开）；前缀为空时没有
  entries: Arr(DirEntry, { maxItems: 50 }), // 名字对得上的子目录，标出哪些是 git 仓库；隐藏目录只在输入以「.」开头时列
  truncated: Bool(), // 超过 50 个
  recent: Arr(DirEntry), // 最近用过的工作目录，新的在前，最多 10 个
});
export type DirsResponse = Static<typeof DirsResponse>;

/** GET /runs/:id 的分支卡片；路线详情走 GET /runs/:id/branches/:branchId。 */
export const BranchCard = Obj({
  branch: Branch,
  bet: Bet,
});
export type BranchCard = Static<typeof BranchCard>;

/** GET /runs/:id：模式、状态、领域、完成标准（都在 run 里）、分支卡片、候选、用量 */
export const RunSummary = Obj({
  run: Run,
  branches: Arr(BranchCard), // 按开出的先后
  candidates: Arr(Candidate),
  usage: UsageTotals,
  usageBy: Opt(UsageBreakdown), // 按角色、按分支分的用量
  lastSeq: Nat(), // 这份摘要对应到哪个 seq；接着用 GET /runs/:id/events?since=lastSeq 订阅
});
export type RunSummary = Static<typeof RunSummary>;

/** GET /runs/:id/progress：计数及受限语义态势，时间为 Unix 秒；不含题面或原始输出。 */
const ProgressTime = Type.Union([Num({ minimum: 0 }), Type.Null()]);
export const RunProgress = Obj({
  runId: IdS(),
  sampledAt: Num({ minimum: 0 }),
  windowSeconds: Nat(),
  lastSeq: Nat(),
  branchesCount: Nat(),
  activeBranches: Nat(),
  queuedBranches: Nat(),
  recentBranches: Nat(),
  lastBranchAt: ProgressTime,
  episodesCount: Nat(),
  recentEpisodes: Nat(),
  episodesSinceProgress: Nat(),
  toolCallsCount: Nat(),
  recentToolCalls: Nat(),
  toolCallsSinceProgress: Nat(),
  goalProgressSeq: Nat(),
  lastGoalProgressAt: ProgressTime,
  lastGoalProgressKind: Type.Union([Enum(['record', 'acceptance']), Type.Null()]),
  candidatesCount: Nat(),
  profile: Opt(TaskProfile),
  semantic: Opt(
    Arr(
      Obj({
        ...SemanticDigest.properties,
        source: Enum(['observer']),
        reportedAt: Num({ minimum: 0 }),
        evidenceAt: Opt(ProgressTime),
        basedOnSeq: Nat(),
        branchId: Opt(IdS()),
        branchActive: Opt(Bool()),
      }),
      { maxItems: 16 },
    ),
  ),
  observer: Type.Union([
    Obj({
      branchesObserved: Nat(),
      branchesUnobserved: Nat(),
      lastNoteAt: ProgressTime,
      oldestNoteAt: ProgressTime,
      lagToolCalls: Nat(),
      untried: Nat(),
      trying: Nat(),
      works: Nat(),
      failed: Nat(),
      unclear: Nat(),
      recentAttempts: Nat(),
    }),
    Type.Null(),
  ]),
});
export type RunProgress = Static<typeof RunProgress>;

/** 巡检器地图的覆盖水位；时间差按查询时刻计算，不写回事件。 */
export const WatchLag = Obj({
  lagTools: Nat(),
  backlogAgeMs: Nat(), // 最早未读材料积压多久；没有积压时为 0
  firstUnreadAt: Opt(Time()),
  coveredAt: Opt(Time()), // 覆盖水位以内最后一条可见材料的时间；水位可以落在事件间隙
  coveredAgeMs: Opt(Nat()),
});
export type WatchLag = Static<typeof WatchLag>;

/** GET /runs/:id/branches/:branchId?cursor=&limit=：分支下钻，Observation 分页（默认 50 条，新的在前） */
export const BranchDetail = Obj({
  branch: Branch,
  bet: Bet,
  observations: Obj({ items: Arr(Observation), next: Opt(Str()) }), // next：下一页的 cursor
  // 巡检器对这条路线最新的一版看法：只有主干直解路线有，还没看过一轮时没有
  watch: Opt(WatchNote),
  watchLag: Opt(WatchLag),
  lastSeq: Nat(),
});
export type BranchDetail = Static<typeof BranchDetail>;

/**
 * GET /runs/:id/branches/:branchId/diff：这条路线现在（lastSnapshot）相对起点的改动，git 格式，内容寻址（同一版重复请求不重算）。
 * 没有改动时没有 patch；任务没结束也能看（工作台页的「改动」标签）
 */
export const BranchDiffResponse = Obj({ snapshot: SnapshotS(), patch: Opt(HandleS()) });
export type BranchDiffResponse = Static<typeof BranchDiffResponse>;
export const InputRequest = Obj({
  kind: Type.Literal('hint'),
  text: Str(),
  broadcast: Opt(Bool()),
  key: Opt(Str({ minLength: 1, maxLength: 200 })),
  acceptance: Opt(AcceptanceProgress),
});
export type InputRequest = Static<typeof InputRequest>;

export const InputResponse = Obj({ input: HumanInput });
export type InputResponse = Static<typeof InputResponse>;

/** POST /runs/:id/pause、interrupt、resume、cancel 都返回改完的 Run；收尾中的和已结束的不能暂停（conflict） */
export const RunResponse = Obj({ run: Run });
export type RunResponse = Static<typeof RunResponse>;

// ── 结果 ──────────────────────────────────────────────────────────────────

/**
 * GET /runs/:id/result：结束了才有，没结束返回 conflict。
 * done：候选、相对起点的 diff、产物、写回的分支名、知识报告；没提交候选就结束的：知识报告和主路线停下时的 patch。
 */
export const RunResultResponse = Obj({
  runId: IdS(),
  status: RunStatus,
  endReason: Opt(Str()),
  candidate: Opt(Candidate),
  branch: Opt(Str()), // 写回用户仓库的分支名 melina/<runId>
  patch: Opt(HandleS()),
  unfinished: Bool(), // patch 是没做完时主路线的改动，没核对过
  artifact: Opt(Obj({ handle: HandleS(), path: Str() })), // 交付物是单个文件时
  knowledgeReport: HandleS(), // Markdown
});
export type RunResultResponse = Static<typeof RunResultResponse>;

// ── 用量、系统状态 ────────────────────────────────────────────────────────

/** GET /usage：按模型、按天汇总的 token 与费用 */
export const UsageResponse = Obj({
  total: UsageTotals,
  byModel: Arr(Obj({ provider: Str(), model: Str(), ...UsageTotals.properties })),
  byDay: Arr(Obj({ day: Str({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), ...UsageTotals.properties })), // 本地时区的日期
  byRole: Opt(Arr(Obj({ role: Role, ...UsageTotals.properties }))), // 按角色
});
export type UsageResponse = Static<typeof UsageResponse>;

/** GET /status */
export const StatusResponse = SystemStatus;
export type StatusResponse = SystemStatus;

// ── 模型页 ────────────────────────────────────────────────────────
//
// PUT /models、PUT /settings 返回存下来的样子（和 GET 一样，key、凭证的值不回）。
// PUT /settings 的 config 不带就保留原值，{} 是清掉覆盖、回到默认值；凭证有 credentialProblem（config.ts）说的问题就整个拒收（400）。

/**
 * GET /models/catalog：Melina 能用的模型目录，模型页的选择面板用。运行时当前仅注册 DeepSeek。PUT /models 只认这里有的供应商与模型。价格是每百万 token 的美元
 */
export const ModelCatalogResponse = Obj({
  providers: Arr(
    Obj({
      provider: Str(),
      name: Opt(Str()), // 给人看的名字：目录里的显示名称
      baseUrl: Opt(Str()), // 请求发到哪：目录里的 Messages 接口地址；模型页显示它的域名
      custom: Opt(Bool()), // 历史自定义供应商标记；当前运行时不注册
      hasKey: Bool(), // 模型页里填过 key
      models: Arr(
        Obj({
          model: Str(), // DeepSeek 模型 id
          name: Opt(Str()), // 给人看的名字
          contextWindow: Opt(Nat()),
          maxOutput: Opt(Nat()),
          reasoning: Opt(Bool()), // 是不是思考型模型
          price: Opt(Obj({ input: Num(), output: Num(), cacheRead: Opt(Num()), cacheWrite: Opt(Num()) })),
        }),
      ),
    }),
  ),
});
export type ModelCatalogResponse = Static<typeof ModelCatalogResponse>;

// ── SSE ───────────────────────────────────────────────────────────────────
//
// GET /api/runs/:id/events?since=<seq> 和 GET /api/events?since=<seq>：
// - 每条事件一条 SSE 消息：`id: <seq>`，`data: <MelinaEvent 的 JSON>`，不写 event 字段（前端用 onmessage）；
// - 先补发 seq > since 的历史事件，再推新的；断线重连带 since（或浏览器自动带的 Last-Event-ID）续传；
//   since 和 Last-Event-ID 都没有时只推连上以后的新事件，不补历史（要历史给 since=0）；两个都有取大的；
// - 每 15 秒一条心跳：具名事件 `event: ping`、`data: {}`（onmessage 收不到它；前端靠它认出半开的连接，45 秒什么都没收到就重连）。
//   data 不能空着：data 为空的消息浏览器不派发；
// - 全局流带 system.updated（runId 为 null），单个 Run 的流不带。
export const SSE_HEARTBEAT_MS = 15_000;

// ── SDK ────────────────────────────────────────────

/** new Melina(options)。配置以数据库为准：models、sandbox 只在数据库为空时当初值 */
export interface MelinaOptions {
  db: string; // SQLite 文件
  artifacts: string; // Artifact store 的目录
  dataDir?: string; // 放 workspace 的目录，默认和 db 同目录下的 workspaces/
  models?: { strong: ModelRef[]; fast: ModelRef[]; providers?: ModelsConfig['providers'] };
  sandbox?: { credentials: Settings['credentials'] };
}
