// 任务、分支、观测、交付与巡检的数据契约。
// 类型从 TypeBox schema 推导；存储校验、工具参数与 HTTP 接口共用同一份定义。
// 持久化记录显式携带所属任务与事件序号，资源争用记录保留执行时的作用范围。

import Type, { type Static } from 'typebox';
import { RunConfig } from './config.ts';
import { ModelRef } from './model-ref.ts';
import {
  Arr,
  Bool,
  Enum,
  HandleS,
  IdS,
  Ids,
  Nat,
  Num,
  Obj,
  OpenObj,
  Opt,
  RecordMeta,
  Seq,
  SnapshotS,
  Str,
  Text,
  Time,
} from './schema.ts';
import { SemanticDigest, TaskProfile } from './telemetry.ts';
import { FeedbackSource } from './watch-input.ts';

// ── 角色 ──────────────────────────────────────────────────────────────────

// watcher：巡检器：主干直解路线每做一段，看一遍它跑了什么、结果怎样，整理成看法给它（runtime/watch.ts）
export const Role = Enum(['explorer', 'scoper', 'watcher']);
export type Role = Static<typeof Role>;

// ── 完成标准 ─────────────────────────────────────────────────────

export const Metric = Obj(
  {
    name: Str({ description: '指标名，例如「冷启动」「覆盖率」' }),
    unit: Text({ description: '单位，例如 ms、%；没有单位就留空' }),
    better: Enum(['lower', 'higher'], { description: '越小越好（lower）还是越大越好（higher）' }),
    target: Num({ description: '目标值' }),
  },
  { description: '目标能量化时的主指标；拿不准就不写' },
);
export type Metric = Static<typeof Metric>;

/** Scoper 起草的完成标准，起草后只读；求解分支可先开跑，提交候选时按标准逐条附证据。 */
export const CompletionSpec = Obj(
  {
    interpretation: Str({ description: '你对目标的理解；有歧义时写清选了哪种理解。会显示在工作台最上面' }),
    criteria: Arr(Str(), {
      minItems: 1,
      description:
        '什么算完成，写成能核对的条目，例如「312 个测试全过」「Lean 编译通过、没有 sorry」。只写结果，不写做法；测试、检查已经会查的不再单列',
    }),
    metric: Opt(Metric),
  },
  { description: '完成标准：开跑后不再改' },
);
export type CompletionSpec = Static<typeof CompletionSpec>;

// ── Run 和 Goal ───────────────────────────────────────────────────────────

/** 附件：每个容器里只读挂在 /melina/materials/<name>，name 只取文件名，重名的加序号 */
export const Material = Obj({ name: Str(), handle: HandleS() });
export type Material = Static<typeof Material>;

export const Goal = Obj({
  statement: Str(), // 人写的目标，创建后只读
  constraints: Arr(Str()), // 禁止事项，Scoper 从目标里整理；起草前是空的
  materials: Arr(Material), // 人上传的；接着做时加上上个任务的附件、知识报告和没做完时的 patch
  domain: Opt(Str()), // 领域，决定分支容器用哪个镜像；Scoper 起草前没有
  sharedSystems: Opt(Arr(Str())), // 目标要改、又没法复制的外部系统；Scoper 填
  profile: Opt(TaskProfile), // 开题画像，未知项保持未知；不是完成标准
  // Scoper 起草前没有；评估时可在建 Run 时直接给，之后仍调用 Scoper 整理约束、共用系统并补充未给定的领域。
  completion: Opt(CompletionSpec),
});
export type Goal = Static<typeof Goal>;

export const RunMode = Enum(['direct', 'settling']);
export type RunMode = Static<typeof RunMode>;
export const RunStatus = Enum(['running', 'paused', 'done', 'cancelled', 'failed']);
export type RunStatus = Static<typeof RunStatus>;
export const ENDED_RUN_STATUSES = ['done', 'cancelled', 'failed'] as const satisfies readonly RunStatus[];

export const WorkspaceKind = Enum(['git-clone', 'dir-copy']);
export type WorkspaceKind = Static<typeof WorkspaceKind>;

export const RunWorkspace = Obj({
  root: Str(), // 人选的工作目录（GET /dirs）；没选就是 <dataDir>/empty/<runId>（最后一段是 Run id，前端靠它认出新建的空目录）
  kind: WorkspaceKind, // 按目录自动选：git 仓库用 git-clone，否则 dir-copy
  from: Opt(Obj({ runId: IdS(), snapshot: SnapshotS() })), // 起点；不填就是目录现状（git 仓库含未提交的改动）；接着做时是上个 Run 的 snapshot
  setup: Opt(Text()), // 每次创建 workspace 后执行的命令：config.workspace.setup，没配就用 Scoper 给的
});
export type RunWorkspace = Static<typeof RunWorkspace>;

export const RunResult = Obj({
  // 交付的候选：收尾（done）时是 end_episode 交的那个；取消或出错结束时是存过的阶段版——
  // 最近一次挑中的那一版：交过两版以上时 runtime 让一个模型比较各版、挑一版，

  candidateId: Opt(IdS()),
  branch: Opt(Str()), // 仓库类任务写回用户仓库的分支名 melina/<runId>
  patch: Opt(HandleS()), // 相对起点的 diff：交付的候选或一版的；什么都没交就结束时是主路线停下时的改动，没做完、没核对
  knowledgeReport: HandleS(), // 知识报告（Markdown）：观察地图、交接、工具记录与未决问题，runtime 直接拼，不调模型
});
export type RunResult = Static<typeof RunResult>;

export const Run = Obj({
  id: IdS(),
  seq: Seq(),
  goal: Goal,
  workspace: RunWorkspace,
  continuedFrom: Opt(IdS()), // 接着哪个 Run 做
  mode: RunMode,
  status: RunStatus, // paused：人暂停了整个任务
  config: RunConfig, // 生效配置：默认值合并 POST /runs 的覆盖，模型档位已换成具体模型
  createdAt: Time(),
  endedAt: Opt(Time()),
  endReason: Opt(Str()), // 结束原因：「你取消了任务」或系统错误；done 没有
  result: Opt(RunResult), // 结束时写
});
export type Run = Static<typeof Run>;

// ── Bet 和 Branch ─────────────────────────────────────────────────────────

export const BetDraft = Obj({
  kind: Type.Literal('direct'), // 求解路线的存储标识。
  label: Str({ maxLength: 40 }),
  model: ModelRef,
  startFrom: Obj({ snapshot: SnapshotS() }),
  diffFrom: Opt(Obj({ branchId: IdS(), note: Str() })),
  continuation: Opt(
    Obj({
      key: Str(),
      slot: Nat(),
      handoff: Str(),
      direction: Str(),
      task: Opt(Str()),
      baseWatermark: Opt(Nat()),
    }),
  ),
});
export type BetDraft = Static<typeof BetDraft>;
export const BetSource = Obj({ kind: Type.Literal('template') });
export type BetSource = Static<typeof BetSource>;
export const Bet = Obj({
  ...BetDraft.properties,
  id: IdS(),
  ...RecordMeta,
  source: BetSource,
  status: Enum(['active', 'closed']), // 分支结束时关闭
});
export type Bet = Static<typeof Bet>;

export const BranchState = Enum(['starting', 'running', 'paused', 'succeeded', 'cancelled', 'failed']);
export type BranchState = Static<typeof BranchState>;
export const TERMINAL_BRANCH_STATES = ['succeeded', 'cancelled', 'failed'] as const satisfies readonly BranchState[];

/** workspace.setup 跑完的结果：失败不让分支失败，runtime 把输出的最后一段放进收件箱，由 Explorer 修 */
export const SetupResult = Obj({
  cmd: Str(),
  ok: Bool(),
  exitCode: Type.Union([Type.Integer(), Type.Null()]), // 被杀或超时时为 null
  timedOut: Bool(),
  durationMs: Num({ minimum: 0 }),
  tail: Text(), // 输出的最后一段，凭证已换掉
  skipped: Opt(Str()), // 没跑的原因
});
export type SetupResult = Static<typeof SetupResult>;

/**
 * workspace 在宿主机上的目录，容器挂载它。provider 可以加自己的字段；下面几项是 create 给、别的模块会读的，
 * 写进契约免得一边改了名另一边静默失效
 */
export const WorkspaceRef = OpenObj({
  path: Str(),
  id: Opt(Str()), // provider 里这个 workspace 的 id
  runId: Opt(IdS()), // 属于哪个 Run：进程入口的执行器找不到在跑的容器时，按它找 Run 的领域和凭证起临时容器
  setup: Opt(SetupResult), // create 时跑了 workspace.setup 就有
});
export type WorkspaceRef = Static<typeof WorkspaceRef>;

export const Branch = Obj({
  id: IdS(),
  ...RecordMeta,
  betId: IdS(),
  state: BranchState,
  queued: Bool(),
  pendingPause: Opt(Str()),
  stateNote: Opt(Str()), // 状态说明：暂停、取消或失败的原因
  workspace: Opt(WorkspaceRef), // 排队时还没有
  lastSnapshot: SnapshotS(), // 新分支是 Bet.startFrom.snapshot
  seenSeq: Nat(), // 分支消息看到了哪个 seq，episode 正常收尾时随同一个事务更新；新分支取建它时的 seq
  episode: Nat({ minimum: 1 }), // 当前 episode 的序号，从 1 开始，收尾时随同一个事务加 1；closeEpisode 带上它，对不上就拒收
  toolCalls: Nat(), // 本分支累计工具调用数，用于接力检查点；写 Observation 时在同一事务里加 1，收尾时的 branch.updated 带上最新值
  failures: Nat(), // 连续失败的 episode 数，满 episode.maxFailures 转 failed
  weight: Num({ minimum: 0.25, maximum: 4 }),
  parentBranchId: Opt(IdS()),
  handoff: Opt(Str()),
});
export type Branch = Static<typeof Branch>;

/**
 * 一条命令跑的这段时间里，它所在的 cgroup 撞到的资源上限：
 * 容器运行时在命令前后各读一次 cgroup 的计数，这里是增量；读不到的那项没有（没装 cgroup v2、控制器没委派、后台命令）。
 * scope 说计数是谁的：container 是这个容器自己的（路线各有各的上限）；host 是跑命令的整台机器，
 * 几条路线和本机别的进程共用（开发机的 proot 没有每条路线自己的 cgroup）
 */
const contentionFields = {
  scope: Enum(['container', 'host']),
  pidsMax: Opt(Nat()), // 进程数撞到上限的次数（pids.events 的 max）：起进程、起线程因此失败
  oomKills: Opt(Nat()), // 因为内存超限被杀掉的进程数（memory.events 的 oom_kill）
  cpuWait: Opt(Num({ minimum: 0, maximum: 1 })), // 有进程在等 CPU 的时间占这条命令用时的比例（cpu.pressure 的 some）
};
export const ExecContention = Obj(contentionFields);
export type ExecContention = Static<typeof ExecContention>;

/**
 * 记在 Observation 上的撞线（sh 只在真撞了时记：进程数、内存撞到上限，或者一半以上的时间在等 CPU），
 * 加上这条命令跑的时候同一个任务里还有哪些路线也在跑命令（alongside，分支 id）：撞的上限是共用的时候，读的人据此看是谁占的
 */
export const Contention = Obj({ ...contentionFields, alongside: Opt(Ids()) });
export type Contention = Static<typeof Contention>;

/** 一次工具调用的结果，由 ToolGateway 写，原文在 Artifact store */
export const Observation = Obj({
  id: IdS(), // sh 调用的 id 在执行前分配，sh.intent 用同一个 id
  ...RecordMeta,
  branchId: Opt(IdS()), // Scoper 的调用不属于任何分支
  episode: Opt(Nat()),
  role: Role, // 谁调的
  tool: Str(), // sh、read、edit、write
  args: Type.Unknown(),
  expect: Opt(Str()), // sh 调用前写下的预期
  summary: Text(), // 截断后的摘要，带退出码
  output: HandleS(), // 原文
  snapshot: SnapshotS(), // 本 episode 的起点 snapshot
  exitCode: Opt(Type.Integer()), // sh 的退出码
  error: Opt(Str()), // 没跑起来（超时、被取消、容器出错）
  contention: Opt(Contention), // sh 跑的时候撞到了资源上限才有
});
export type Observation = Static<typeof Observation>;

export const Candidate = Obj({
  id: IdS(),
  ...RecordMeta,
  branchId: IdS(),
  snapshot: SnapshotS(),
  claim: Str(), // 保底快照附带的观测，不代表任何完成标准已通过
  artifact: Opt(HandleS()), // 主要交付物是单个文件（文档、证明）时指向它
  artifactPath: Opt(Str()), // 它在 workspace 里的路径，下载时的文件名和渲染方式按它定
  interim: Opt(Bool()), // deliver 交的一版：Run 不结束；end_episode 交的候选没有这一项
});
export type Candidate = Static<typeof Candidate>;

// ── Snapshot、收件箱、人 ─────────────────────────────────────────────────

/** lineage 树的节点；内容可以清理，这条记录一直留着。根 snapshot 不建记录，用 'root' 表示 */
export const Snapshot = Obj({
  id: SnapshotS(),
  ...RecordMeta,
  branchId: IdS(),
  episode: Nat(),
  parent: SnapshotS(),
});
export type Snapshot = Static<typeof Snapshot>;

/** 发给某个分支的消息：正在跑 episode 时立即追加到末尾，否则下个 episode 开头进上下文 */
export const InboxItem = Obj({
  id: IdS(),
  ...RecordMeta,
  branchId: IdS(),

  kind: Enum(['notice', 'human']),
  text: Str(),
  ref: Opt(IdS()), // 关联的 HumanInput；普通运行时通知可以省略。
});
export type InboxItem = Static<typeof InboxItem>;

/** 宿主确认的平台验收计数；只由输入 API 写入，模型的发言和候选不算验收。 */
export const AcceptanceProgress = Obj({
  task: Str({ maxLength: 200 }), // 平台任务标识，同一 Run 内按它比较验收数量
  accepted: Nat({ maximum: Number.MAX_SAFE_INTEGER }),
  total: Nat({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
export type AcceptanceProgress = Static<typeof AcceptanceProgress>;

/** 人或宿主在运行中说的话（POST /runs/:id/input） */
export const HumanInput = Obj({
  id: IdS(),
  ...RecordMeta,
  text: Str(),
  key: Opt(Str({ minLength: 1, maxLength: 200 })), // 宿主追加指令的 Run 内去重键，不带时照常记录每次输入
  acceptance: Opt(AcceptanceProgress),
});
export type HumanInput = Static<typeof HumanInput>;

// ── 用量账本 ─────────────────────────────────────────────────

export const TokenUsage = Obj({ input: Nat(), cacheRead: Nat(), cacheWrite: Nat(), output: Nat() });
export type TokenUsage = Static<typeof TokenUsage>;

/** 每次模型或工具调用一行；只用于观测和评估，模型看不到 */
export const UsageRow = Obj({
  seq: Opt(Seq()), // 账本自己的序号，写库时分配
  runId: IdS(),
  branchId: Opt(IdS()),
  role: Role,
  kind: Enum(['model', 'tool']),
  at: Time(),
  ms: Nat(), // 耗时
  // 模型调用
  provider: Opt(Str()),
  model: Opt(Str()),
  tokens: TokenUsage,
  usd: Num({ minimum: 0 }),
  // 工具调用：工具名（sh 记命令的第一个词）、模式、退出码、输出大小、句柄
  tool: Opt(Str()),
  exitCode: Opt(Type.Integer()),
  bytes: Opt(Nat()),
  handle: Opt(HandleS()),
});
export type UsageRow = Static<typeof UsageRow>;

// ── Scoper ─────────────────────────────────────────────────────────

/** Scoper 输出：完成标准、开题画像、约束、领域、共用系统及工作区准备命令。 */
export const ScoperOutput = Obj({
  completion: CompletionSpec,
  profile: Opt(TaskProfile),
  constraints: Arr(Str(), { description: '从目标里整理出的禁止事项，例如「不许动生产环境」；没有就给空数组' }),
  domain: Str({ description: '领域：按「可选的领域」列表的描述，选择最符合目标和所需工具的一项；拿不准选 general' }),
  sharedSystems: Opt(
    Arr(Str(), { description: '目标要改、又没法复制的外部系统，例如线上服务、远程数据库；没有就不填' }),
  ),
  setup: Opt(Text({ description: '每次创建 workspace 后要执行的命令，例如 npm ci；拿不准就不填' })),
});
export type ScoperOutput = Static<typeof ScoperOutput>;

// ── 巡检器 ─────────────────────────────────────────────────────
// 求解分支开跑 1 分钟后、之后每轮完成 5 分钟后（runtime/watch.ts），另一个模型（巡检器）看一遍
// 它这段跑了什么、预期和结果、记下了什么，维护一份跨轮保存的判断：方向（一种具体做法，下面是试过的每一次）、确定了的结果、

// 看法一版一版只追加，存成 watch.noted 事件，没有表（同 version.picked）。模型更新方向结论，宿主保存尝试。
// 宿主生成尝试编号、去重、滚动归档并投影策略，没写到的方向照留；retired:false 显式恢复方向。
// 摘要与原文引用同等有效，不因阅读进度延后判断；落库核对执行依据与冻结窗口可见性。
// 给主干直解路线看的是证据与有限验证编成的决策简报（context/watch.ts 的 watchMap）：每次请求前现编，作为独立参考材料替换上一张，
// 不写进对话历史（agents/episode.ts）。方向和尝试历史只有巡检器自己看（它下一轮的记忆），人在路线详情里看得到。

// 方向编号由巡检器自己起、跨版不变。
// untried 明确未试；unclear 可表示无法确认执行，不会自动进入推荐池。trying/works/failed 需要真实尝试。
// 活跃方向自动入图：有尝试记录进 EVIDENCE，明确未试可进 NEXT_CHECKS；只有 retired 移出候选池。

export const WatchStatus = Enum(['untried', 'trying', 'works', 'failed', 'unclear'], {
  description:
    'untried 有线索尚未尝试；trying 正在验证；works 实测有推进；failed 本次条件下未奏效；unclear 执行或结果尚无定论',
});
export type WatchStatus = Static<typeof WatchStatus>;

/** 方向编号由模型维护；尝试编号由宿主生成。字母开头，字母、数字、- 和 _ */
export const WATCH_ID_PATTERN = '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$';

/** 一个方向下实际试过的一次，宿主按 t1、t2……编号，跨归档递增。 */
export const WatchAttempt = Obj({
  id: Str({ pattern: WATCH_ID_PATTERN }),
  action: Str(), // 这一次做了什么：用什么、改哪里、在什么条件下
  result: Str(), // 结果怎样
  evidence: Ids(), // 依据
});
export type WatchAttempt = Static<typeof WatchAttempt>;

/** 一个能区分当前假设的有限检查；预期和停止条件是计划，不是已验证的事实。 */
export const WatchExperiment = Obj({
  question: Str({ maxLength: 300, description: '这次检查要消除的具体不确定性' }),
  check: Str({ maxLength: 400, description: '最小、有限的验证动作，不写具体命令或宽泛枚举' }),
  expected: Str({ maxLength: 400, description: '什么可观察结果支持当前假设；其他结果意味着什么' }),
  stopWhen: Str({ maxLength: 300, description: '何时停止、转向或重新评估，不能只写继续尝试' }),
});
export type WatchExperiment = Static<typeof WatchExperiment>;

/** 合并以后的一个方向：编号跨版不变， 起由巡检器自己起 */
export const WatchDirection = Obj({
  id: Str({ pattern: WATCH_ID_PATTERN }),
  direction: Str(), // 求解类别及对象
  status: WatchStatus,
  result: Str(), // 这个方向现在的结论，在什么做法和条件下
  evidence: Ids(), // 这个结论最要紧的依据
  doubt: Opt(Str()), // 还不确定的地方
  experiment: Opt(WatchExperiment), // 当前推荐的有限验证；整项更新时省略即清除
  attempts: Arr(WatchAttempt), // 最近的活跃尝试，宿主最多保留 20 条
  archivedAttempts: Opt(Arr(WatchAttempt)), // 更早的原始尝试，按需读取，绝不丢弃
  priority: Opt(Nat({ minimum: 1, maximum: 4 })),
  retired: Opt(Bool()), // 不再做此方向；false 显式恢复，省略沿用
});
export type WatchDirection = Static<typeof WatchDirection>;

/** 一版看法的内容 */
export const WatchBody = Obj({
  standing: Str(), // 当前工作假设
  telemetry: Opt(Type.Union([SemanticDigest, Type.Null()])), // 省略不更新；null 撤回；旧报告不刷新时间和证据水位
  directions: Arr(WatchDirection),
  tension: Arr(Str()), // 两句互相矛盾的原话，或者没有
  forbid: Opt(Arr(Str())), // 扩展解释的领域策略标记，每版整份重写，空或省略即撤销
  advice: Text(), // 当前决策焦点；证据薄弱时可以为空
  flags: Opt(
    Arr(
      Obj({
        id: Str(),
        label: Str(),
        receipt: IdS(),
        source: Opt(Obj({ ...FeedbackSource.properties, directionIds: Opt(Arr(Str())) })),
        dependsOn: Arr(Str()),
      }),
    ),
  ), // 宿主只从平台已验收回执生成，模型不能提交 flag 节点
});
export type WatchBody = Static<typeof WatchBody>;

/** 一版看法：watch.noted 事件的数据 */
export const WatchNote = Obj({
  branchId: IdS(), // 看的是哪条路线（主干直解路线）
  rev: Nat({ minimum: 1 }), // 第几版，从 1 起
  toolCalls: Nat(), // 看到这条路线第几次工具调用为止
  basedOnSeq: Seq(), // 执行历史已覆盖的连续前缀；独立状态的读取不能推进它
  deliveredRefs: Opt(Arr(IdS())), // 已展示但超过连续历史水位的证据；下一轮仍可引用
  stateSeq: Opt(Nat()), // 已展示摘要的最新状态版本；0 表示本版状态摘要尚未全部展示
  stateRefs: Opt(Arr(IdS())), // 已提供但仍在历史覆盖水位之后的状态证据，跨轮保留可引用性
  model: ModelRef, // 巡检器用的模型
  ...WatchBody.properties,
});
export type WatchNote = Static<typeof WatchNote>;
