// 单 agent 基线（ 评估设计：「同一个最强模型、同样工具的单 agent」；plan ：同一个模型、同样的工具和容器，
// 一条对话做到底，截断内失败可以从头重来）。
//
// 和 Melina 用同一套东西，只去掉 Melina 的架构：
// - 模型：Melina 的模型层（melinaStream：重试、过载、没动静超时、一家几个 key 都一样）和一次角色调用（agents/episode.ts 的 RoleCallRunner：
//   工具按顺序执行、模型停下没交付时提醒一次）；模型和思考级别同 Melina 的求解分支（默认 strong 档，思考 high）。
// - 工具：Melina 的 sh、read、edit、write 的实现（src/tools/sh.ts、files.ts：在容器里执行、大输出落盘只给摘要和 /melina/artifacts 路径、
//   读写都在容器里做），只是 sh 没有 expect；多一个 done 交付。独立会话使用同一套环境工具。
// - 容器：和 Melina 同一个运行时（开发机是 test/dev 的 proot，装了 Podman 的机器是 Podman），同样挂 /workspace、/melina/materials、/melina/artifacts。
// - 提示：通用的做事原则（src/prompts/principles.md）和 Melina 的 Explorer 原样共用一份、放在同样的位置；凭证的用法、
//   对外部系统的规矩、临时东西放 /tmp、核对到完成标准为止也两边一样教。
// 一次尝试 = 一条对话。模型交付（done）就结束；到截断、模型停下两次没交付、上下文撑爆、模型出错都算这次没交，跑分脚本截断内从头再来。
// 并行的基线（parallelBaselineContender， 照 U01 加）：同时开 k 条这样的对话，谁先交用谁的。

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Type from 'typebox';
import { createRoleCallRunner, type RoleCallDeps } from '../../src/agents/episode.ts';
import { loadPrinciples, loadSharedPrompt } from '../../src/context/prompts.ts';
import { type RunConfigOverride, resolveGlobalConfig, resolveRunConfig } from '../../src/core/config.ts';
import { type UsageTotals, ZERO_USAGE } from '../../src/core/events.ts';
import { newId, ROOT } from '../../src/core/ids.ts';
import type { RoleCallRunner } from '../../src/core/interfaces/agents.ts';
import type { ResolvedProviderKey } from '../../src/core/interfaces/config-store.ts';
import {
  CONTAINER_PATHS,
  type ContainerRef,
  type ContainerRuntime,
  type Redactor,
} from '../../src/core/interfaces/container.ts';
import type {
  CallerContext,
  MelinaTool,
  ToolCall,
  ToolOutcome,
  ToolSession,
} from '../../src/core/interfaces/gateway.ts';
import type { ModelCallMeta } from '../../src/core/interfaces/models.ts';
import type { ModelRef } from '../../src/core/model-ref.ts';
import { Str } from '../../src/core/schema.ts';
import {
  type ClosingToolName,
  type EditArgs,
  type ReadArgs,
  ShArgs,
  TOOL_SPECS,
  type ToolName,
  type ToolSpec,
  type WriteArgs,
} from '../../src/core/tools.ts';
import type { CompletionSpec, Run } from '../../src/core/types.ts';
import { builtinProviders } from '../../src/models/builtin.ts';
import { createModelRegistry } from '../../src/models/registry.ts';
import { createMelinaStream } from '../../src/models/stream.ts';
import { FileArtifactStore } from '../../src/storage/artifacts.ts';
import { runEdit, runRead, runWrite } from '../../src/tools/files.ts';
import { type Secret, SecretRedactor } from '../../src/tools/redact.ts';
import { secretsInFile } from '../../src/tools/secret-scan.ts';
import { emptyState, type ToolEnv } from '../../src/tools/session.ts';
import { runSh } from '../../src/tools/sh.ts';
import { ArtifactViews } from '../../src/tools/views.ts';
import type { AttemptInput, AttemptOutcome, Contender } from './contenders.ts';
import { totalTokens } from './tokens.ts';
import { MAX_ATTEMPTS } from './trial.ts';
import { prepareWorkspace, snapshotDelivery } from './workspace.ts';

type Provider = ReturnType<typeof builtinProviders>[number];

export interface BaselineOptions {
  /**  的独立评测插桩；生产 runtime 不使用。 */
  observer?: (deps: BaselineObserverDeps) => BaselineObserver;
  /** 和 Melina 的求解分支使用同一个模型；tier 决定思考级别（strong 是 high，同 Melina）。 */
  model: ModelRef;
  /** 这家的 key，按顺序（第一个是首选） */
  keys: ResolvedProviderKey[];
  containers: Pick<ContainerRuntime, 'start' | 'exec' | 'remove'>;
  /** 落盘和返回之前换掉的值（开发机上是 key 文件里的值） */
  redactor: Pick<Redactor, 'redact'>;
  /** 和 Melina 一样的 sh 默认超时、大输出上限；不给就是附录 B 的默认值 */
  config?: RunConfigOverride;
  /** 一次尝试最多跑多久，默认 3 小时（同 Melina 的 Run） */
  maxWallMs?: number;
  /** 被测方的名字，默认 baseline */
  name?: string;
  /** pi 的供应商；测试里换成 fauxProvider */
  providers?: readonly Provider[];
  /** 供应商那边出错的重试次数等，默认附录 B（retries.model 3） */
  global?: Parameters<typeof resolveGlobalConfig>[0];
  /** 并行基线某一道起不来（一个 token 都没花就结束）时隔多久再试，默认 5 秒；测试里改短 */
  laneRetryMs?: number;
  /**
   * 记回复原文：每次尝试的思考、文字、工具调用和工具结果写进那次尝试目录的
   * baseline-transcript.jsonl，和 Melina 那边 serve.ts --transcript 记的同一个格式（agents/episode.ts 的 TranscriptEntry）
   */
  transcript?: boolean;
}

export interface BaselineObserverDeps {
  runner: RoleCallRunner;
  meta: ModelCallMeta;
  goal: string;
  dir: string;
  caller: CallerContext;
  redactor: Pick<Redactor, 'redact'>;
}

export interface BaselineObserver {
  system(original: string): string;
  observe(call: ToolCall, outcome: ToolOutcome): void;
  close(): Promise<void>;
}

export const DONE_TOOL = 'done';

const ShPlain = Type.Object(
  {
    cmd: ShArgs.properties.cmd,
    timeoutMs: ShArgs.properties.timeoutMs,
    background: ShArgs.properties.background,
  },
  { additionalProperties: false },
);
const DoneArgs = Type.Object(
  { summary: Str({ description: '一两句话：交付了什么，每条完成标准是怎么核对的' }) },
  { additionalProperties: false },
);

/** 基线的工具：sh、read、edit、write 照 Melina 的，加 done */
export function baselineToolSpecs(): ToolSpec[] {
  return [
    {
      name: TOOL_SPECS.sh.name,
      description:
        '在你的容器里用 bash 执行一条命令，工作目录是 /workspace。输出太长时只返回摘要和原文的只读路径，用 sed、grep、jq 按需查看。',
      parameters: ShPlain,
    },
    TOOL_SPECS.read,
    TOOL_SPECS.edit,
    TOOL_SPECS.write,
    {
      name: DONE_TOOL as ToolName,
      description: '认为已经达到全部完成标准时调用：交付 /workspace 里的结果，任务随之结束。要单独调用。',
      parameters: DoneArgs,
    },
  ];
}

export const BASELINE_SYSTEM = [
  '你是一个在命令行里干活的 agent，独自把下面的任务从头做到尾。',
  '',
  // 通用的做事原则和 Melina 的 Explorer 原样共用一份，放的位置也一样（紧跟开头那句）：两边原则一样，比出来的才是架构的差别
  // （src/prompts/principles.md）
  loadPrinciples(),
  '',
  loadSharedPrompt('environment'),
  '',
  loadSharedPrompt('credentials'),
  '',
  loadSharedPrompt('workspace'),
  '',
  loadSharedPrompt('delivery'),
  '',
  loadSharedPrompt('sources'),
  '',
  '达到完成标准后调用 done，交付 /workspace 里的结果并结束任务。',
].join('\n');

/** 给模型的目标：和 Melina 拿到的同一份目标、完成标准和附件，去掉 Melina 自己的说法（分支、候选、Observation） */
export function baselineGoal(input: {
  statement: string;
  completion: CompletionSpec;
  domain: string;
  materials: readonly { name: string }[];
}): string {
  const { completion } = input;
  const lines = [
    '# 目标',
    '',
    input.statement,
    '',
    `对目标的理解：${completion.interpretation}`,
    '',
    '## 完成标准',
    '',
  ];
  completion.criteria.forEach((c, i) => {
    lines.push(`${i + 1}. ${c}`);
  });
  const m = completion.metric;
  if (m) {
    const better = m.better === 'lower' ? '越小越好' : '越大越好';
    lines.push('', '## 主指标', '', `${m.name}${m.unit ? `，单位 ${m.unit}` : ''}，${better}，目标 ${m.target}。`);
  }
  lines.push('', '## 约束（不许做的事）', '', '没有额外的约束。', '', '## 环境', '', `领域：${input.domain}。`);
  lines.push('你在自己的容器里，工作目录 /workspace 是一个 git 仓库。原始输出在 /melina/artifacts（只读）。');
  if (input.materials.length > 0) {
    lines.push('人给的附件（只读）：');
    for (const mat of input.materials) lines.push(`- /melina/materials/${mat.name}`);
  }
  return lines.join('\n');
}

export function baselineContender(opts: BaselineOptions): Contender {
  const providers = opts.providers ?? builtinProviders();
  const maxWallMs = opts.maxWallMs ?? 3 * 3600_000;
  return {
    name: opts.name ?? 'baseline',
    title: `单 agent 基线（${opts.model.provider}/${opts.model.model}）`,
    restartable: true,
    needsGit: true,
    async attempt(input): Promise<AttemptOutcome> {
      const t0 = Date.now();
      const usage: UsageTotals = { ...ZERO_USAGE };
      const out: AttemptOutcome = {
        status: 'failed',
        submitted: false,
        tokens: 0,
        usage,
        wallMs: 0,
        routes: 1,
        branches: 1,
      };
      const stop = stopper(input, Math.min(maxWallMs, input.deadline - t0));
      let doneAt: { tokens: number; usd: number; ms: number } | undefined;
      const r = await converse(opts, providers, {
        input,
        workspace: input.workspace,
        dir: input.dir,
        signal: stop.signal,
        onUsage: (delta) => {
          addInto(usage, delta);
          out.tokens = totalTokens(usage);
          if (!doneAt && out.tokens >= input.budget) stop.halt('cut');
        },
        onDone: () => {
          doneAt = { tokens: out.tokens, usd: usage.usd, ms: Date.now() - t0 };
          return true;
        },
      });
      stop.dispose();
      out.wallMs = Date.now() - t0;
      out.usage = usage;
      if (r.error) out.error = r.error;
      // 基线干的是 Melina 里 Explorer 的活：用量记在 explorer 名下，报告里和 Melina 的 Explorer 比缓存命中率
      if (out.tokens > 0) out.byRole = r.byRole;
      if (doneAt) {
        out.status = 'done';
        out.submitted = true;
        out.tokensAtSubmit = doneAt.tokens;
        out.usdAtSubmit = doneAt.usd;
        out.firstCandidateMs = doneAt.ms;
        out.delivered = deliveredOf(input, input.workspace);
        delete out.error;
      } else if (stop.why) {
        out.status = stop.why;
      } else if (out.error && out.tokens === 0) {
        // 一个 token 都没花就出错（容器起不来、key 不对）：跑分这边的问题，不算基线失败，也不重来
        out.status = 'error';
      }
      input.log(`单 agent 基线：${out.status}，${out.tokens} token，${Math.round(out.wallMs / 1000)} 秒`);
      return out;
    },
  };
}

/**
 * 并行的单 agent 基线（U01）：同时开 k 个和上面一样的单 agent，各用各的 workspace 和容器，谁先调用 done 就交谁的、
 * 别的马上停；交错了算没做成（没有第二次机会，和 Melina 先交先赢一样）。每一道没交就停下的（模型停下两次、上下文撑爆、出错），
 * 截断内在新的 workspace 里从头再来。token 几道加起来算。回答「Melina 快是不是只因为多开了几路」：k 跟 Melina 在这批题上开的路线数对齐。
 */
export function parallelBaselineContender(opts: BaselineOptions & { k: number }): Contender {
  const providers = opts.providers ?? builtinProviders();
  const maxWallMs = opts.maxWallMs ?? 3 * 3600_000;
  const k = Math.max(1, Math.floor(opts.k));
  return {
    name: opts.name ?? `baseline-k${k}`,
    title: `同时开 ${k} 个单 agent，谁先交用谁的（${opts.model.provider}/${opts.model.model}）`,
    // 每一道自己从头再来，跑分脚本不用再整组重来
    restartable: false,
    needsGit: true,
    async attempt(input): Promise<AttemptOutcome> {
      const t0 = Date.now();
      const usage: UsageTotals = { ...ZERO_USAGE };
      const out: AttemptOutcome = {
        status: 'failed',
        submitted: false,
        tokens: 0,
        usage,
        wallMs: 0,
        routes: k,
        branches: 0,
      };
      const budgetMs = Math.min(maxWallMs, input.deadline - t0);
      const stop = stopper(input, budgetMs);
      const lanes = Array.from({ length: k }, () => new AbortController());
      stop.signal.addEventListener('abort', () => {
        for (const l of lanes) l.abort(stop.signal.reason);
      });
      let winner: { lane: number; tokens: number; usd: number; ms: number; workspace: string } | undefined;
      const errors: string[] = [];
      // 起不来的道（连着 3 次一个 token 都没花就结束）：这次就不是 k 道在比，整次记成跑分这边出错、接着跑时重来。
      // 别的道先交了、还没轮到它起来就被停掉的不算
      const dead = Array.from({ length: k }, () => false);
      const lane = async (i: number) => {
        let fresh = 0; // 连着几次一个 token 都没花就结束（容器起不来、第一次模型调用就出错）
        for (let n = 1; n <= MAX_ATTEMPTS && !lanes[i]?.signal.aborted; n++) {
          const dir = join(input.dir, `lane-${i + 1}`, `try-${n}`);
          const workspace = i === 0 && n === 1 ? input.workspace : join(dir, 'workspace');
          let r: { tokens: number; error?: string };
          try {
            if (workspace !== input.workspace) prepareWorkspace(workspace, input.world.starter(), { git: true });
            out.branches++;
            r = await converse(opts, providers, {
              input,
              workspace,
              dir,
              signal: (lanes[i] as AbortController).signal,
              onUsage: (delta) => {
                addInto(usage, delta);
                out.tokens = totalTokens(usage);
                if (!winner && out.tokens >= input.budget) stop.halt('cut');
              },
              onDone: () => {
                if (winner || stop.why) return false;
                winner = { lane: i, tokens: out.tokens, usd: usage.usd, ms: Date.now() - t0, workspace };
                lanes.forEach((l, j) => {
                  if (j !== i) l.abort(new Error('别的道先交了'));
                });
                return true;
              },
            });
          } catch (e) {
            r = { tokens: 0, error: e instanceof Error ? e.message : String(e) };
          }
          if (winner || stop.why) return;
          if (r.error) errors.push(`第 ${i + 1} 道第 ${n} 次：${r.error}`);
          if (Date.now() > t0 + budgetMs - 60_000) return; // 离截断不到一分钟不再重来
          if (r.tokens === 0) {
            // 起不来的隔几秒再试，最多 3 次，不空转
            if (++fresh >= 3) {
              dead[i] = true;
              return;
            }
            await new Promise((ok) => setTimeout(ok, opts.laneRetryMs ?? 5000));
            continue;
          }
          fresh = 0;
          input.log(`并行基线第 ${i + 1} 道没交就停了，从头再来`);
        }
      };
      try {
        await Promise.all(lanes.map((_, i) => lane(i)));
      } finally {
        stop.dispose();
        for (const l of lanes) l.abort(new Error('这次结束了'));
      }
      out.wallMs = Date.now() - t0;
      out.usage = usage;
      if (out.tokens > 0) out.byRole = { explorer: { ...usage } };
      const won = winner as typeof winner | undefined;
      const deadLanes = dead.filter(Boolean).length;
      if (deadLanes > 0) {
        out.status = 'error';
        out.error = `${k} 道里有 ${deadLanes} 道起不来：${errors[0] ?? '没花 token 就结束了'}`;
        input.log(`并行基线：${out.error}`);
      } else if (won) {
        out.status = 'done';
        out.submitted = true;
        out.tokensAtSubmit = won.tokens;
        out.usdAtSubmit = won.usd;
        out.firstCandidateMs = won.ms;
        out.delivered = deliveredOf(input, won.workspace);
        input.log(`并行基线：第 ${won.lane + 1} 道先交，${Math.round(won.ms / 1000)} 秒，几道一共 ${out.tokens} token`);
      } else {
        if (errors.length > 0) out.error = errors[0];
        out.status = stop.why ?? (out.tokens === 0 && errors.length > 0 ? 'error' : 'failed');
        input.log(`并行基线：${out.status}，几道一共 ${out.tokens} token，${Math.round(out.wallMs / 1000)} 秒`);
      }
      return out;
    },
  };
}

/**
 * 交付照 Melina 交付成分支的样子取到这一次的存档目录：.gitignore 盖住的新文件、
 * 符号链接、FIFO 不算交付，和 Melina 一样。取不出来（工作区不是起点那样的目录了）就原样交给检查，在日志里写一句
 */
function deliveredOf(input: AttemptInput, workspace: string): string {
  const into = join(input.dir, 'delivered');
  try {
    snapshotDelivery(workspace, Object.keys(input.world.starter()), into, input.world.deliverables());
    return into;
  } catch (e) {
    input.log(`照 Melina 的取法取交付失败，原样检查 workspace：${e instanceof Error ? e.message : String(e)}`);
    return workspace;
  }
}

/** 一次尝试的停止开关：到截断（token）、到时间、人按了 Ctrl-C 都从这里停，记下为什么 */
function stopper(input: AttemptInput, budgetMs: number) {
  const ctrl = new AbortController();
  const state = {
    signal: ctrl.signal,
    why: undefined as 'cut' | 'timeout' | 'cancelled' | undefined,
    halt(reason: 'cut' | 'timeout' | 'cancelled') {
      if (ctrl.signal.aborted) return;
      state.why = reason;
      ctrl.abort(new Error(reason));
    },
    dispose() {
      clearTimeout(wall);
      input.signal.removeEventListener('abort', onAbort);
    },
  };
  const onAbort = () => state.halt('cancelled');
  input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.signal.aborted) state.halt('cancelled');
  const wall = setTimeout(() => state.halt('timeout'), Math.max(0, budgetMs));
  return state;
}

function addInto(into: UsageTotals, delta: UsageTotals): void {
  into.input += delta.input;
  into.cacheRead += delta.cacheRead;
  into.cacheWrite += delta.cacheWrite;
  into.output += delta.output;
  into.usd += delta.usd;
}

interface ConversationInput {
  input: AttemptInput;
  /** 这条对话的起点 workspace（并行时每道一份） */
  workspace: string;
  /** 存档目录：工具日志、产物视图 */
  dir: string;
  /** 停下：截断、到时间、人按 Ctrl-C、并行时别的道先交了 */
  signal: AbortSignal;
  /** 每次模型调用记一笔（并行时几道合起来算 token 上限） */
  onUsage: (delta: UsageTotals) => void;
  /** 模型调用了 done；返回 false 表示这次不算数（并行时别的道已经先交了） */
  onDone: () => boolean;
}

/**
 * 一条对话：一个单 agent 在自己的容器里从头做到尾，调用 done 就结束。模型层同 Melina（melinaStream：重试、过载、没动静超时、
 * 一家几个 key），一家供应商、一个模型，两档都是它；不经过 Scheduler 的准入，记账只为数 token
 */
async function converse(
  opts: BaselineOptions,
  providers: readonly Provider[],
  c: ConversationInput,
): Promise<{ tokens: number; byRole: Record<string, UsageTotals>; error?: string }> {
  const { input } = c;
  const t0 = Date.now();
  const runId = newId();
  const branchId = newId();
  let tokens = 0;
  let error: string | undefined;
  let observer: BaselineObserver | undefined;
  const byRole: Record<string, UsageTotals> = {};
  const note = (entry: Record<string, unknown>) => {
    try {
      appendFileSync(join(c.dir, 'baseline-tools.jsonl'), `${JSON.stringify({ at: Date.now() - t0, ...entry })}\n`);
    } catch {}
  };
  const transcript: Pick<RoleCallDeps, 'transcript'> = opts.transcript
    ? {
        transcript: (entry) => appendFileSync(join(c.dir, 'baseline-transcript.jsonl'), `${JSON.stringify(entry)}\n`),
      }
    : {};
  const registry = createModelRegistry({
    source: {
      getModels: () => ({
        providers: [{ provider: opts.model.provider, keys: opts.keys.map((k) => ({ id: k.id, hasKey: true })) }],
        strong: [{ ...opts.model, tier: 'strong' }],
        fast: [{ ...opts.model, tier: 'fast' }],
      }),
      apiKeys: (provider) => (provider === opts.model.provider ? opts.keys : []),
      global: () => resolveGlobalConfig(opts.global ?? {}),
    },
    providers: [...providers],
  });
  const stream = createMelinaStream({
    registry,
    scheduler: {
      modelSlot: async (_req, signal) => {
        signal?.throwIfAborted();
        return { release: () => {} };
      },
      throttled: () => {},
      consumed: () => {},
    },
    ledger: {
      model: (e) => {
        const delta: UsageTotals = { ...e.tokens, usd: e.usd };
        tokens += totalTokens(delta);
        const roleUsage = byRole[e.role] ?? { ...ZERO_USAGE };
        addInto(roleUsage, delta);
        byRole[e.role] = roleUsage;
        note({ modelUsage: true, role: e.role, tokens: e.tokens, usd: e.usd });
        c.onUsage(delta);
      },
    },
    onNotice: (text) => note({ notice: text }),
  });
  const runner = createRoleCallRunner({
    registry,
    ...transcript,
    stream: (meta) => {
      const invoke = stream(meta);
      return (model, context, options) => {
        if (!observer) return invoke(model, context, options);
        let replaced = false;
        const messages = context.messages.map((message) => {
          if (replaced || message.role !== 'system') return message;
          replaced = true;
          const text =
            typeof message.content === 'string' ? message.content : message.content.map((part) => part.text).join('\n');
          return { ...message, content: observer!.system(text) };
        });
        return invoke(model, { ...context, messages }, options);
      };
    },
  });

  // 容器：和 Melina 的分支一样挂 /workspace（可写）、/melina/materials、/melina/artifacts（这条对话自己的视图目录）
  const dataDir = join(c.dir, 'baseline-data');
  const artifacts = new FileArtifactStore(join(dataDir, 'artifacts'));
  const views = new ArtifactViews({ dataDir, artifacts });
  let ref: ContainerRef | undefined;
  try {
    mkdirSync(c.dir, { recursive: true });
    const viewDir = await views.ensure(views.branchDir(runId, branchId));
    const materialsDir = input.materials[0] ? dirname(input.materials[0].path) : undefined;
    ref = await opts.containers.start({
      name: `melina-${runId.toLowerCase()}-baseline`,
      domain: input.domain,
      workspace: { host: c.workspace, container: CONTAINER_PATHS.workspace, readOnly: false },
      artifactsDir: viewDir,
      ...(materialsDir ? { materialsDir } : {}),
      credentials: [],
    });
    const run = { id: runId, config: resolveRunConfig(opts.config ?? {}) } as unknown as Run;
    // 附件里像密钥的值照 Melina 的认法遮掉。原来基线这边附件是明文，
    // 订单服务题上 Melina 照抄占位符撞 401、基线不会（第六次评价的会话指出），两边一个口径
    const found = (await Promise.all(input.materials.map((m) => secretsInFile(m.path, `附件 ${m.name}`)))).flat();
    const redactor = withSecrets(opts.redactor, found);
    const caller: CallerContext = {
      runId,
      role: 'explorer',
      branchId,
      episode: 1,
      snapshot: ROOT,
      container: ref,
      workspace: { path: c.workspace },
      readOnly: false,
    };
    observer = opts.observer?.({
      runner: createRoleCallRunner({ stream, registry, ...transcript }),
      meta: {
        runId,
        branchId,
        role: 'watcher',
        job: 'watcher_call',
        sessionId: `${branchId}-observer`,
        model: opts.model,
        signal: c.signal,
      },
      goal: baselineGoal(input),
      dir: c.dir,
      caller,
      redactor,
    });
    const session = new BaselineSession(toolEnv(run, caller, opts, redactor, artifacts, views), note, (summary) => {
      const counted = c.onDone();
      note({ done: summary, counted });
      return counted;
    });
    const result = await runner.start({
      meta: {
        runId,
        branchId,
        role: 'explorer',
        job: 'explorer_episode',
        sessionId: branchId,
        model: opts.model,
        signal: c.signal,
      },
      layout: {
        role: 'explorer',
        system: BASELINE_SYSTEM,
        tools: session.tools.map((t) => t.spec),
        messages: [{ role: 'user', text: baselineGoal(input) }],
        basedOnSeq: 0,
      },
      session,
      onToolResult: (call, outcome) => observer?.observe(call, outcome),
      closeReminder: '你停下了，但还没调用 done。没做完就接着做；已经达到完成标准就单独调用 done 交付。',
    }).done;
    note({ outcome: result.outcome.kind, turns: result.turns, toolCalls: result.toolCalls });
    if (result.outcome.kind === 'model_error') error = result.outcome.message;
    if (result.outcome.kind === 'context_overflow') error = '上下文撑爆了';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    note({ error });
  } finally {
    await observer?.close();
    if (ref) await opts.containers.remove(ref).catch(() => {});
  }
  return error === undefined ? { tokens, byRole } : { tokens, byRole, error };
}

/** 在 base 之外再遮掉 secrets（附件里认出来的）；没有就是 base */
function withSecrets(base: Pick<Redactor, 'redact'>, secrets: readonly Secret[]): Pick<Redactor, 'redact'> {
  if (secrets.length === 0) return base;
  const extra = new SecretRedactor();
  extra.hold('materials', secrets);
  return { redact: (text) => extra.redact(base.redact(text)) };
}

function toolEnv(
  run: Run,
  caller: CallerContext,
  opts: BaselineOptions,
  redactor: Pick<Redactor, 'redact'>,
  artifacts: FileArtifactStore,
  views: ArtifactViews,
): ToolEnv {
  let seq = 0;
  return {
    deps: {
      // 观测不进 RunStore：只要一个 id 让工具结果的格式和 Melina 一样
      writer: {
        recordWatch: () => {
          throw new Error('baseline does not publish Melina observations');
        },
        appendObservation: (o) => ({ ...o, id: o.id ?? newId(), seq: ++seq, at: new Date().toISOString() }) as never,
        appendShIntent: () => ++seq,
      },
      queries: {} as never,
      artifacts,
      runtime: opts.containers,
      redactor,
      views,
      newId,
      onError: () => {},
      fileTimeoutMs: 60_000,
    },
    caller,
    run,
    state: emptyState(),
    ready: Promise.resolve(),
  };
}

/** 环境工具的结果去掉 Melina 的 observationId，只给摘要（摘要里已经带了原文路径） */
function plain(outcome: ToolOutcome): ToolOutcome {
  try {
    const parsed = JSON.parse(outcome.content) as { summary?: unknown };
    if (typeof parsed.summary === 'string') return { content: parsed.summary, isError: outcome.isError };
  } catch {}
  return { content: outcome.content, isError: outcome.isError };
}

class BaselineSession implements ToolSession {
  readonly caller: CallerContext;
  readonly tools: MelinaTool[];
  #toolCalls = 0;
  #closed: { tool: ClosingToolName; args: unknown } | undefined;

  constructor(env: ToolEnv, note: (entry: Record<string, unknown>) => void, onDone: (summary: string) => boolean) {
    this.caller = env.caller;
    const specs = baselineToolSpecs();
    const spec = (name: string) => specs.find((s) => s.name === name) as ToolSpec;
    const timed =
      (name: string, run: (args: never, signal: AbortSignal) => Promise<ToolOutcome>) =>
      async (call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> => {
        const t = Date.now();
        const r = plain(await run(call.args as never, signal));
        this.#toolCalls++;
        const args = call.args as Record<string, unknown>;
        note({
          tool: name,
          ...(name === 'sh' ? { cmd: String(args.cmd ?? '').slice(0, 300) } : { path: args.path }),
          ms: Date.now() - t,
          isError: r.isError,
        });
        return r;
      };
    this.tools = [
      {
        spec: spec('sh'),
        run: timed('sh', (args: { cmd: string; timeoutMs?: number; background?: boolean }, signal) =>
          runSh(env, { ...args }, signal),
        ),
      },
      { spec: spec('read'), run: timed('read', (args: ReadArgs, signal) => runRead(env, args, signal)) },
      { spec: spec('edit'), run: timed('edit', (args: EditArgs, signal) => runEdit(env, args, signal)) },
      { spec: spec('write'), run: timed('write', (args: WriteArgs, signal) => runWrite(env, args, signal)) },
      {
        spec: spec(DONE_TOOL),
        run: async (call) => {
          const summary = String((call.args as { summary?: unknown }).summary ?? '');
          this.#closed = { tool: DONE_TOOL as ClosingToolName, args: call.args };
          const counted = onDone(summary);
          return {
            content: counted ? '已交付。' : '别的 agent 已经先交了，这次不算。',
            isError: false,
            terminate: true,
          };
        },
      },
    ];
  }

  check(call: ToolCall, turn: readonly ToolCall[]): string | undefined {
    if (call.name === DONE_TOOL && turn.length > 1) return 'done 要单独调用：先把别的工具调完，下一轮再单独调用 done。';
    return undefined;
  }

  get toolCalls(): number {
    return this.#toolCalls;
  }

  staged() {
    return [];
  }

  closed() {
    return this.#closed;
  }
}
