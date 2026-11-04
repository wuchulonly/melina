// 运行配置、模型页和设置页的格式。
//
// 两类配置：
// - RunConfig：可以按 Run 覆盖（POST /runs 的 config）。建 Run 时和默认值合并，存进 Run.config，之后不变，
//   工作台页的「配置」标签显示的就是它。
// - GlobalConfig：管整台机器的（limits.*、retries.model、model.idleTimeoutMs、models.fallback、domains、sandbox.*），
//   只能全局改（PUT /settings 的 config），存在 settings 表里。
// 配置以数据库为准：模型页、设置页改的都是数据库里那份，SDK 的构造参数只在数据库为空时当初值。
// 这里只有默认值、schema 和合并规则，读写数据库在配置存储（src/config/，见 interfaces/config-store.ts）。

import { posix } from 'node:path';
import Type, { type Static, type TObject } from 'typebox';
import { CONTAINER_PATHS } from './interfaces/container.ts';
import { ModelChoice, ModelRef, Tier } from './model-ref.ts';
import { Arr, Bool, Enum, IdS, Nat, Num, Obj, Opt, Str, Text } from './schema.ts';

// ── RunConfig：可以按 Run 覆盖 ────────────────────────────────────────────

/**
 * 初始求解分支使用的模型：同时开跑，工作区彼此隔离，先提交最终候选的进入交付。
 * 写档位时按模型页顺序选择配了 key 的模型，再循环分配到 copies 份；没有 copies 时每个模型一份。
 * 显式数组按顺序开路并保留重复模型，忽略 copies。
 * 建 Run 时换成具体的模型列表存进 Run.config，初始路数以该列表的长度为准。
 */
export const Bet0Models = Type.Union([Obj({ tier: Tier }), Arr(ModelRef, { minItems: 1 })]);
export type Bet0Models = Static<typeof Bet0Models>;

export const RunConfig = Obj({
  bet0: Obj({
    models: Bet0Models,
    copies: Opt(Nat({ minimum: 1, maximum: 16 })), // 仅在 models 为档位时生效。
  }),
  continuation: Opt(
    Obj({
      enabled: Bool(),
      forkCopies: Nat({ minimum: 1, maximum: 8 }),
      maxActive: Nat({ minimum: 1, maximum: 16 }),
      momentumToolCalls: Opt(Nat({ minimum: 1 })), // 得分后再执行这么多次工具调用仍无新验收，才检查分叉价值。
      accessToolCalls: Nat({ minimum: 1 }), // 每新增这么多次工具调用，检查一次可复用入口。
    }),
  ),
  // 分支连续失败达到 maxFailures 时转为 failed；正常工作在持续会话中执行。
  episode: Obj({
    maxFailures: Nat({ minimum: 1 }), // 连续这么多个 episode 失败就转 failed
  }),
  toolOutput: Obj({
    inlineMaxTokens: Nat({ minimum: 100 }), // 超过就落盘，只给摘要和沙箱里的只读路径
  }),
  sh: Obj({
    timeoutMs: Nat({ minimum: 1000 }), // sh 调用的默认超时
    maxBackground: Nat(), // 每个分支同时存活的后台进程数
  }),
  workspace: Obj({
    setup: Opt(Text()), // 每次创建 workspace 后执行的命令；不配就用 Scoper 给的
  }),
  // 巡检器：主干直解路线开跑 1 分钟后看第一轮，之后每轮完成 5 分钟后再看；每份各有各的巡检器。
  // 每份独立巡检；没有这组配置时关闭。
  watch: Opt(
    Obj({
      enabled: Bool(),
      // 初始求解分支按创建顺序从 1 编号；接力会话不占用这些编号。
      disabledBet0Copies: Opt(Arr(Nat({ minimum: 1 }), { uniqueItems: true })),
      // 接力会话默认单独观察，可显式关闭。
      continuationEnabled: Opt(Bool()),
      // 巡检器用的模型；不写就用它看的那份主干直解路线自己的模型，那家这时没 key、正在熔断时换别家的（和它不同家的，
      // agents/watcher.ts 的 watcherModel），每轮现挑。写档位的在建任务时换成那一档的首选。
      model: Opt(ModelChoice),
    }),
  ),
});
export type RunConfig = Static<typeof RunConfig>;

/** 没有巡检配置的任务保持关闭。 */
export function watchEnabled(config: RunConfig): boolean {
  return config.watch?.enabled ?? false;
}

/**
 * 主干直解路线开的几份各用哪个模型，按开的顺序：Run.config 里存的是建 Run 时换好的具体模型。
 * 还是档位（没经过建 Run 的配置）时是空的
 */
export function bet0ModelsOf(config: RunConfig): ModelRef[] {
  const models = config.bet0.models;
  return Array.isArray(models) ? models : [];
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  bet0: { models: { tier: 'strong' }, copies: 3 },
  continuation: {
    enabled: true,
    forkCopies: 2,
    maxActive: 5,
    momentumToolCalls: 12,
    accessToolCalls: 50,
  },
  episode: { maxFailures: 3 },
  toolOutput: { inlineMaxTokens: 2000 },
  sh: { timeoutMs: 120_000, maxBackground: 4 },
  workspace: {},
  // 开跑 1 分钟后首轮巡检，之后每轮完成 5 分钟后再看（runtime/watch.ts）。
  watch: { enabled: true },
};

/** POST /runs 的 config：任意一组、组里任意几项 */
export type RunConfigOverride = { [G in keyof RunConfig]?: Partial<RunConfig[G]> };
export const RunConfigOverride = closedPartialGroups(RunConfig);

// ── GlobalConfig：只能全局改 ──────────────────────────────────────────────

const AutoOr = (n: ReturnType<typeof Nat>) => Type.Union([n, Type.Literal('auto')]);

export const GlobalConfig = Obj({
  limits: Obj({
    // 每个供应商的并发模型调用数。没写的供应商是 auto：默认不封顶，被限流才收紧，之后有作业在等时每分钟放宽 1
    modelCalls: Type.Record(Str(), AutoOr(Nat({ minimum: 1 }))),
    toolExec: AutoOr(Nat({ minimum: 1 })), // 本机同时执行的环境工具命令数（各个 Run 一起算，不限 episode 数）；auto 以 CPU 核数起步，按排队需求和资源压力调
    diskFreeMin: Nat(), // 剩余磁盘低于这么多字节就不再启动新分支
  }),
  retries: Obj({
    model: Nat(), // 供应商那边出错时的最大重试次数，用完就熔断这家
  }),
  model: Obj({
    idleTimeoutMs: Nat({ minimum: 1000 }), // 单次模型调用多久没收到新内容算卡死，不限总时长
  }),
  models: Obj({
    fallback: Enum(['next_in_tier', 'none']), // 熔断时换同档位的下一个模型，或不换
  }),
  domains: Arr(Str(), { minItems: 1 }), // 可选的领域，每个对应仓库 domains/ 下的一个目录
  sandbox: Obj({
    memoryMax: AutoOr(Nat({ minimum: 64 * 1024 * 1024 })), // 每个分支容器的内存上限（字节）；auto 按本机资源和在跑的分支数分
    pidsMax: AutoOr(Nat({ minimum: 16 })), // 每个分支容器的进程数上限
  }),
});
export type GlobalConfig = Static<typeof GlobalConfig>;

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  limits: { modelCalls: {}, toolExec: 'auto', diskFreeMin: 10 * 1024 ** 3 },
  retries: { model: 3 },
  model: { idleTimeoutMs: 900_000 },
  models: { fallback: 'next_in_tier' },
  domains: ['code', 'research', 'general'],
  sandbox: { memoryMax: 'auto', pidsMax: 'auto' },
};

export type GlobalConfigOverride = {
  [G in keyof GlobalConfig]?: GlobalConfig[G] extends unknown[] ? GlobalConfig[G] : Partial<GlobalConfig[G]>;
};
export const GlobalConfigOverride = closedPartialGroups(GlobalConfig);

/**
 * 合并：默认值 ← 覆盖。按组合并，数组和 modelCalls 这类整项替换；组里值为 undefined 的项不覆盖。
 * 结果是新对象，和默认值、覆盖都不共用任何对象：改它不会改到 DEFAULT_RUN_CONFIG（）
 */
export function resolveRunConfig(override: RunConfigOverride = {}, base: RunConfig = DEFAULT_RUN_CONFIG): RunConfig {
  return mergeGroups(base, override);
}

export function resolveGlobalConfig(
  override: GlobalConfigOverride = {},
  base: GlobalConfig = DEFAULT_GLOBAL_CONFIG,
): GlobalConfig {
  return mergeGroups(base, override);
}

// ── 模型页、设置页 ──────────────────────────────────────────────────

/** 一家供应商的一个 API key；存在 provider_keys 表 */
export const ProviderKey = Obj({
  id: Opt(IdS()), // PUT 时新加的不带，服务端分配；GET 一定有
  name: Opt(Str()), // 给人看的名字，例如「公司账号」
  key: Opt(Text()), // 只写：GET 不回，只回 hasKey；PUT 带 id 不带 key 就保留原值（自定义供应商换了接口的域名、端口或协议时例外，见 ModelsConfig）
  hasKey: Opt(Bool()), // GET 回：存着、解得开
});
export type ProviderKey = Static<typeof ProviderKey>;

/** 自定义供应商的一个模型：历史自定义配置，上下文、价格由人填；当前不注册此类接口 */
export const CustomModel = Obj({
  model: Str(), // 发给接口的模型名，例如 doubao-seed-2-0-pro-260215
  name: Opt(Str()), // 给人看的名字
  contextWindow: Opt(Nat({ minimum: 1 })), // 上下文窗口（token），不填按 CUSTOM_MODEL_DEFAULTS
  maxOutput: Opt(Nat({ minimum: 1 })), // 一次最多输出多少 token，不填按 CUSTOM_MODEL_DEFAULTS
  reasoning: Opt(Bool()), // 思考型：先想再答。Melina 只在认得的接口上替它开关思考，别的接口用它自己的默认
  // 每百万 token 的美元，和 DeepSeek 目录的价格同一个口径；不填就不记这个模型的花费
  price: Opt(
    Obj({
      input: Num({ minimum: 0 }),
      output: Num({ minimum: 0 }),
      cacheRead: Opt(Num({ minimum: 0 })),
      cacheWrite: Opt(Num({ minimum: 0 })),
    }),
  ),
});
export type CustomModel = Static<typeof CustomModel>;

/** 自定义模型没填上下文、最长输出时用的值：多数兼容接口都收得下，填了以人填的为准 */
export const CUSTOM_MODEL_DEFAULTS = { contextWindow: 128_000, maxOutput: 16_384 } as const;

/**
 * 自定义供应商：历史的自定义接口，兼容 OpenAI Chat Completions 或 Anthropic Messages，
 * 地址和模型由人填，API key 照样在 keys 里。provider 是自己起的英文短名，当前运行时拒绝新建这类接口
 */
export const CustomProvider = Obj({
  name: Opt(Str()), // 给人看的名字，例如「火山方舟」；不填就显示 provider
  // 接口地址，写到版本号那一级，例如 https://ark.cn-beijing.volces.com/api/v3。换了域名、端口或协议，原来的 key 作废（见 ModelsConfig）
  baseUrl: Str({ pattern: '^https?://\\S+$' }),
  api: Enum(['openai-completions', 'anthropic-messages']), // 接口格式：兼容 OpenAI Chat Completions，或兼容 Anthropic Messages
  models: Arr(CustomModel, { minItems: 1 }),
});
export type CustomProvider = Static<typeof CustomProvider>;

/** GET /models、PUT /models；存在 providers、provider_keys、models 三张表 */
export const ModelsConfig = Obj({
  providers: Arr(
    Obj({
      provider: Str(), // 供应商 id；运行时目前仅启用 deepseek
      custom: Opt(CustomProvider), // 自定义供应商的接口和模型；DeepSeek 内置目录不带
      // 按顺序：第一个是首选，后面是额度用完或 key 失效时的备用。GET 一定带。
      // PUT 不带就保留这家原来的 key；带了就整份替换：带 id 的是原有的（不带 key 就保留原值），
      // 不带 id 的是新加的（要带 key），没列出的删掉。
      // 例外：自定义供应商的接口地址换了域名、端口或协议（URL 的 origin 变了），原来存的 key 一律作废、不发到新地址：
      // 不带 keys 的、带 id 不带 key 的都删掉，只留这次带了 key 的；照样保存，这家显示没有 key，要重新填
      keys: Opt(Arr(ProviderKey)),
      rpm: Opt(Nat({ minimum: 1 })), // 每分钟请求数上限，不填就只看限流信号
      tpm: Opt(Nat({ minimum: 1 })), // 每分钟 token 上限
    }),
  ),
  strong: Arr(ModelRef), // 每档按顺序：第一个是首选，后面是熔断时的备用（models.fallback）
  fast: Arr(ModelRef), // 同一个模型可以两档都放
});
export type ModelsConfig = Static<typeof ModelsConfig>;

/** 凭证：以环境变量或文件的形式给容器。配了哪个系统的凭证，就等于允许 AI 读写它；能不能给容器见 credentialProblem */
export const Credential = Obj({
  id: Opt(IdS()), // PUT 时新加的不带，服务端分配；GET 一定有
  name: Str(), // 给人看的名字，例如「GitHub 只读 token」
  as: Type.Union([
    Obj({ env: Str({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }) }), // 环境变量名
    Obj({ file: Str({ pattern: '^/' }) }), // 容器里的绝对路径
  ]),
  value: Opt(Text()), // 只写：GET 不回，只回 hasValue；PUT 不带就保留原值，传空串就删掉
  hasValue: Opt(Bool()),
});
export type Credential = Static<typeof Credential>;

/** GET /settings、PUT /settings；存在 settings、credentials 两张表 */
export const Settings = Obj({
  credentials: Arr(Credential), // 容器启动时给进去，改了只影响之后启动的容器
  notify: Bool(), // 浏览器通知：页面开着时，任务结束就弹
  config: Opt(GlobalConfigOverride), // 只能全局改的配置，不进界面，用 API 改
});
export type Settings = Static<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = { credentials: [], notify: true };

// ── 凭证能不能给容器 ──────────────────────────────────────────────

/** 凭证值也会进入引擎进程的环境，只允许明确的凭证名；其他系统的凭证用文件形式，避免漏掉能改变引擎行为的变量 */
export const CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'PYPI_TOKEN',
  'UV_PUBLISH_TOKEN',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
]);

/** 凭证文件不能放的目录：/workspace 会进 snapshot 和交付；/melina 下是只读挂载；/run/melina 是容器里包装脚本的状态目录 */
export const RESERVED_CREDENTIAL_DIRS: readonly string[] = [CONTAINER_PATHS.workspace, '/melina', '/run/melina'];

/**
 * 一条凭证能不能给容器，不能就返回一句人话。PUT /settings 拿它拒收；起容器时拿它跳过数据库里留下的坏凭证、提醒一句，
 * 无效凭证不得阻止其他容器启动（）。value 只在给了的时候查（GET 回来的不带值）
 */
export function credentialProblem(c: Pick<Credential, 'name' | 'as' | 'value'>): string | undefined {
  if ('env' in c.as) {
    if (!CREDENTIAL_ENV_NAMES.includes(c.as.env)) {
      return `凭证「${c.name}」不能用环境变量名 ${c.as.env}：它不在凭证白名单里，请改用 ${CREDENTIAL_ENV_NAMES.join('、')}，或者文件形式`;
    }
    if (c.value?.includes('\0')) return `凭证「${c.name}」的值里有 NUL 字符，不能以环境变量给容器，请改成文件形式`;
    return undefined;
  }
  const file = posix.normalize(c.as.file);
  if (
    !file.startsWith('/') ||
    file === '/' ||
    RESERVED_CREDENTIAL_DIRS.some((d) => file === d || file.startsWith(`${d}/`))
  ) {
    return `凭证「${c.name}」的文件不能放在 /、/workspace、/melina、/run/melina 下面（会进 snapshot、交付，或者被挂载盖住）：${c.as.file}`;
  }
  return undefined;
}

// ── 内部 ──────────────────────────────────────────────────────────────────

function closedPartialGroups(schema: TObject) {
  const groups: Record<string, ReturnType<typeof Opt>> = {};
  for (const [key, group] of Object.entries(schema.properties)) {
    const inner = Type.IsObject(group)
      ? Type.Object(Type.Partial(group).properties, { additionalProperties: false })
      : group;
    groups[key] = Opt(inner);
  }
  return Obj(groups);
}

function mergeGroups<T extends object>(base: T, override: object): T {
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      isPlainObject(current) && isPlainObject(value)
        ? { ...current, ...structuredClone(definedOnly(value)) }
        : structuredClone(value);
  }
  return out as T;
}

/** 去掉值为 undefined 的项：SDK 进程内调用时 { toolCalls: undefined } 能过覆盖的校验，合并后却不合 RunConfig */
function definedOnly(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
