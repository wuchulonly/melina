// ToolGateway：所有工具调用都经过它，负责校验、执行、落盘和记录 Observation。
// 每次角色调用开一个 ToolSession；session.tools 的顺序和 ContextAssembler 给模型的工具定义一致（都由 core/tools.ts 按角色给出），
// agents/harness.ts 注册工具，执行前调用 session.check。
//
// 一次环境工具调用：角色检查、参数校验和扩展策略→ sh 调用先写 sh.intent → 在调用方的容器里带超时执行 →
// 原文进 Artifact store、放进本分支的 /melina/artifacts 视图 → 超过 toolOutput.inlineMaxTokens 只回摘要和只读路径 →
// 写 Observation，返回 { observationId, summary, path? }（sh.ts、files.ts、observe.ts）。

// 读取工具各记一行工具账（readUsage）。
//
// /melina/artifacts 视图：本分支的输出写入时就放进去。

import { conflict, invalid, notFound } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import type {
  CallerContext,
  MelinaTool,
  ToolCall,
  ToolGateway,
  ToolOutcome,
  ToolSession,
  ToolSessionOptions,
} from '../core/interfaces/gateway.ts';
import {
  type ClosingToolName,
  type DeliverArgs,
  type EditArgs,
  explorerTools,
  isClosingTool,
  type ObservationContextArgs,
  type ReadArgs,
  type ShArgs,
  type SubmitWatchArgs,
  type SubmitWatchInput,
  scoperTools,
  TOOL,
  type ToolSpec,
  type WriteArgs,
  watcherTools,
  watchFromArgs,
} from '../core/tools.ts';
import type { Bet, Branch } from '../core/types.ts';
import { formatIssues, issues } from '../core/validate.ts';
import { watchRecordRef } from '../projections/watch-snapshot.ts';
import { closeTool } from './builtins/close.ts';
import { deliverTool } from './builtins/deliver.ts';
import { missingObservationSession, ObservationSession } from './builtins/watch.ts';
import { availableExtensions, extendTools, validateExtensions } from './extensions.ts';
import { runEdit, runRead, runWrite } from './files.ts';
import { RunningCommands } from './running.ts';
import { checkTool, emptyState, fail, failFrom, type GatewayDeps, type ToolEnv } from './session.ts';
import { runSh } from './sh.ts';

const DEFAULT_FILE_TIMEOUT_MS = 60_000;

const ROLE_NAME: Record<CallerContext['role'], string> = {
  explorer: 'Explorer',
  scoper: 'Scoper',
  watcher: '巡检器',
};

export class MelinaToolGateway implements ToolGateway {
  readonly #deps: ToolEnv['deps'];

  constructor(deps: GatewayDeps) {
    validateExtensions(deps.extensions ?? []);
    this.#deps = {
      ...deps,
      newId: deps.newId ?? newId,
      onError: deps.onError ?? ((error, what) => console.error(`[工具] ${what}：`, error)),
      fileTimeoutMs: deps.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS,
      running: deps.running ?? new RunningCommands(),
    };
  }

  open(caller: CallerContext, options: ToolSessionOptions = {}): ToolSession {
    const deps = this.#deps;
    const run = deps.queries.getRun(caller.runId);
    if (!run) throw notFound(`Run ${caller.runId} 不存在`);
    let branch: Branch | undefined;
    let bet: Bet | undefined;
    if (caller.branchId) {
      branch = deps.queries.getBranch(caller.branchId);
      if (!branch || branch.runId !== run.id) throw invalid(`分支 ${caller.branchId} 不在 Run ${run.id} 里`);
      bet = deps.queries.getBet(branch.betId);
    }
    if (caller.role === 'explorer') {
      if (!branch || !bet) throw invalid('Explorer 的调用要带 branchId');
      if (caller.episode !== undefined && caller.episode !== branch.episode) {
        throw conflict(`episode 号对不上：分支在第 ${branch.episode} 个，调用带的是第 ${caller.episode} 个`);
      }
    }

    const env: ToolEnv = {
      deps,
      caller,
      run,
      ...(branch ? { branch } : {}),
      ...(bet ? { bet } : {}),
      state: emptyState(),
      ready: Promise.resolve(),
    };
    env.ready = prepareView(env);
    const specs = extendTools(toolSpecs(env, options), deps.extensions ?? [], caller.role);
    const observation =
      caller.role === 'watcher' && options.observation ? new ObservationSession(env, options.observation) : undefined;
    const tools: MelinaTool[] = specs.map((spec) => {
      const normalizeArguments =
        spec.name === TOOL.submitWatch && observation
          ? (raw: unknown) => observation.normalizeArguments(raw)
          : undefined;
      return {
        spec,
        ...(spec.name === TOOL.observationContext && observation
          ? { available: () => observation.contextAvailable() }
          : {}),
        ...(normalizeArguments ? { normalizeArguments } : {}),
        run: (call, signal) => runTool(env, spec, call, signal, options, observation),
      };
    });
    return new Session(env, tools);
  }
}

class Session implements ToolSession {
  readonly caller: CallerContext;
  readonly tools: readonly MelinaTool[];
  readonly #env: ToolEnv;
  readonly #names: ReadonlySet<string>;
  #barrier: Promise<unknown> = Promise.resolve();
  readonly #running = new Set<Promise<unknown>>();

  constructor(env: ToolEnv, tools: MelinaTool[]) {
    this.#env = env;
    this.caller = env.caller;
    this.tools = tools.map((tool) => ({
      ...tool,
      run: (call, signal) => {
        const work = this.#barrier.then(() => tool.run(call, signal));
        this.#running.add(work);
        void work.then(
          () => this.#running.delete(work),
          () => this.#running.delete(work),
        );
        return work;
      },
    }));
    this.#names = new Set(tools.map((t) => t.spec.name));
  }

  check(call: ToolCall, turn: readonly ToolCall[]): string | undefined {
    const { state } = this.#env;
    if (state.closed) return '这次调用已经收尾了，不能再调用工具';
    if (!this.#names.has(call.name)) {
      return `${ROLE_NAME[this.caller.role]} 不能用 ${call.name}；能用的是：${[...this.#names].join('、')}`;
    }
    if (this.tools.find((tool) => tool.spec.name === call.name)?.spec.standalone && turn.length > 1)
      return `${call.name} 必须单独调用：这一轮里还有别的工具调用`;
    // deliver 交的是 workspace 那一刻的样子：同一轮里还有改文件的调用就说不清交的是哪一版
    if ((isClosingTool(call.name) || call.name === TOOL.deliver) && turn.length > 1) {
      return `${call.name} 必须单独调用：这一轮里还有别的工具调用。先把别的做完，再单独调用一次 ${call.name}`;
    }
    return checkTool(this.#env, call);
  }

  get toolCalls(): number {
    return this.#env.state.toolCalls;
  }

  get publishedWatch() {
    return this.#env.state.publishedWatch;
  }

  closed(): { tool: ClosingToolName; args: unknown } | undefined {
    return this.#env.state.closed;
  }

  checkpoint(save: () => Promise<void>): Promise<boolean> {
    const work = Promise.allSettled([this.#barrier, ...this.#running]).then(async () => {
      if (this.#env.state.closed) return false;
      await save();
      return true;
    });
    this.#barrier = work.catch(() => {});
    return work;
  }
}

/** 按角色的工具集：和 ContextAssembler 给模型的工具定义用同一份，顺序固定 */
function toolSpecs(env: ToolEnv, options: ToolSessionOptions): ToolSpec[] {
  const { caller } = env;
  switch (caller.role) {
    case 'explorer':
      return explorerTools();
    case 'scoper':
      return scoperTools();
    case 'watcher':
      return watcherTools(options.observation?.input.records.map(watchRecordRef));
  }
}

async function runTool(
  env: ToolEnv,
  spec: ToolSpec,
  call: ToolCall,
  signal: AbortSignal,
  options: ToolSessionOptions,
  observation?: ObservationSession,
): Promise<ToolOutcome> {
  if (env.state.closed) return fail('这次调用已经收尾了，不能再调用工具');
  if (call.name !== spec.name) return fail(`工具调用名称与 ${spec.name} 不匹配`);
  try {
    if (spec.name === TOOL.submitWatch && observation)
      call = { ...call, args: observation.normalizeArguments(call.args) };
    // Harness 与直接调用共用整理入口，整理后再核对同一份声明。
    const found = issues(spec.parameters, call.args);
    if (found.length > 0) return fail(`${spec.name} 的参数不合格式：${formatIssues(found)}`);
    if (spec.name === TOOL.submitWatch)
      call = { ...call, args: watchFromArgs(call.args as SubmitWatchInput, options.observation?.request.previous) };
    const blocked = checkTool(env, call);
    if (blocked !== undefined) return fail(blocked);
    options.onToolIntent?.(call);
    const extension = availableExtensions(env.deps.extensions ?? [], env.caller.role).find(
      (entry) => entry.spec.name === spec.name,
    );
    for (const before of env.deps.beforeTools ?? []) {
      const waiting = await before(env, call, signal);
      if (waiting) return fail(waiting);
    }
    if (signal.aborted) return fail('已取消，没有执行工具');
    const changed = checkTool(env, call);
    if (changed !== undefined) return fail(changed);
    if (extension) return await extension.run(env, call.args, signal);
    switch (spec.name) {
      case TOOL.sh:
        return await runSh(env, call.args as ShArgs, signal);
      case TOOL.read:
        return await runRead(env, call.args as ReadArgs, signal);
      case TOOL.edit:
        return await runEdit(env, call.args as EditArgs, signal);
      case TOOL.write:
        return await runWrite(env, call.args as WriteArgs, signal);
      case TOOL.observationContext:
        return readUsage(
          env,
          call,
          Date.now(),
          observation ? await observation.context(call.args as ObservationContextArgs) : missingObservationSession(),
        );
      case TOOL.submitWatch:
        return observation
          ? await observation.submit(call.args as SubmitWatchArgs, signal)
          : missingObservationSession();
      case TOOL.deliver:
        return rejected(env, call, await deliverTool(env, call.args as DeliverArgs, signal));
      default:
        if (isClosingTool(spec.name))
          return rejected(env, call, await closeTool(env, spec.name, call.args, options, signal));
        return fail(`${spec.name} 还没有实现`);
    }
  } catch (error) {
    return failFrom(env, error, spec.name);
  }
}

/**
 * Explorer 存个阶段版、收尾（含交候选）被退回时记一行系统日志：被退回的尝试不进 RunStore 也不进账本，
 * 不记就分不清「写对了不交」是没想交还是交了被退回。收尾先不收、不占次数的那种（Again， 起能不收的几处第一次都这样）
 * 也记。只记，不改结果
 */
function rejected(env: ToolEnv, call: ToolCall, outcome: ToolOutcome): ToolOutcome {
  if (env.caller.role !== 'explorer' || outcome.terminate) return outcome;
  const again = !outcome.isError && isClosingTool(call.name);
  if (!outcome.isError && !again) return outcome;
  const args = call.args as { candidate?: unknown } | undefined;
  const what =
    call.name === TOOL.deliver ? '存个阶段版' : args?.candidate !== undefined ? '交候选' : `${call.name} 收尾`;
  const why = outcome.content.replace(/\s+/g, ' ').slice(0, 120);
  env.deps.onNotice?.(`分支 ${env.caller.branchId ?? '?'} 的${what}${again ? '先退回（不占次数）' : '被退回'}：${why}`);
  return outcome;
}
function readUsage(env: ToolEnv, call: ToolCall, startedAt: number, outcome: ToolOutcome): ToolOutcome {
  try {
    env.deps.ledger?.tool({
      runId: env.run.id,
      ...(env.caller.branchId ? { branchId: env.caller.branchId } : {}),
      role: env.caller.role,
      tool: call.name,
      bytes: Buffer.byteLength(outcome.content),
      ms: Math.max(0, Date.now() - startedAt),
    });
  } catch (error) {
    env.deps.onError(error, '记录读取用量');
  }
  return outcome;
}

async function prepareView(env: ToolEnv): Promise<void> {
  try {
    if (env.caller.role === 'scoper') await env.deps.views.ensure(env.deps.views.scoperDir(env.run.id));
    else if (env.branch) await env.deps.views.ensure(env.deps.views.branchDir(env.run.id, env.branch.id));
  } catch (error) {
    env.deps.onError(error, '准备输出目录');
  }
}
