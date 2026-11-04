// 组装调度、角色调用、工具网关、分支循环、任务生命周期、恢复与交付组件。
// 调度器先于模型流创建；启动时先恢复，再接收任务，关闭时等待任务与资源清理。
// 巡检结果持久化后，在模型请求前读取最新地图，作为独立参考材料提供。

import { statfs } from 'node:fs/promises';
import type { GlobalConfig, ModelsConfig } from '../core/config.ts';
import type { Id } from '../core/ids.ts';
import type { ExplorerAgent, ScoperAgent, SelectVersion, WatcherAgent } from '../core/interfaces/agents.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { ContainerRuntime, ResolvedCredential } from '../core/interfaces/container.ts';
import type { ContextAssembler } from '../core/interfaces/context.ts';
import type { ToolGateway, ToolSessionOptions } from '../core/interfaces/gateway.ts';
import type { ModelRegistry } from '../core/interfaces/models.ts';
import type { CreateRunInput } from '../core/interfaces/runtime.ts';
import type { EventBus, RunStoreQueries, RunStoreWriter } from '../core/interfaces/store.ts';
import type { WorkspaceProviders } from '../core/interfaces/workspace.ts';
import type { Bet, Branch, Run } from '../core/types.ts';
import { type Clock, realClock } from './async.ts';
import { type BranchEnv, ContainerBranchEnv, NO_CONTAINERS, runtimePaths, serialized } from './branch-env.ts';
import { RuntimeBranchManager } from './branch-manager.ts';
import { BranchRunners, RunScopes } from './branch-runner.ts';
import { Courier } from './courier.ts';
import { RuntimeKnowledgeReport } from './knowledge.ts';
import { VersionPicks } from './picks.ts';
import { RuntimeRecovery } from './recovery.ts';
import { type RunSecretsHook, RuntimeRunManager } from './run-manager.ts';
import { createScheduler, type MelinaScheduler } from './scheduler.ts';
import { WatchDesk, type WatchDeskDeps } from './watch.ts';

export interface RuntimeSchedulerDeps {
  queries: RunStoreQueries;
  /** GlobalConfig.limits 和模型页的 RPM、TPM，现读 */
  config: { global(): GlobalConfig; models(): ModelsConfig };
  /** 放 workspace 的目录：按它所在的磁盘看剩余空间 */
  dataDir: string;
  clock?: Clock;
  onChange?: () => void;
}

export function createRuntimeScheduler(deps: RuntimeSchedulerDeps): MelinaScheduler {
  const q = deps.queries;
  return createScheduler({
    limits: () => deps.config.global().limits,
    rates: () => deps.config.models().providers,
    diskFree: async () => {
      const st = await statfs(deps.dataDir);
      return Number(st.bavail) * Number(st.bsize);
    },
    jobOf: () => 'explorer_episode',
    weightOf: (id) => q.getBranch(id)?.weight,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.onChange ? { onChange: deps.onChange } : {}),
  });
}

export interface KernelDeps {
  writer: RunStoreWriter;
  queries: RunStoreQueries;
  bus: EventBus;
  artifacts: ArtifactStore;
  workspaces: WorkspaceProviders;
  /** 没有容器引擎（测试）就不给：分支不起容器 */
  containers?: ContainerRuntime | undefined;
  gateway: ToolGateway;
  assembler: Pick<ContextAssembler, 'forExplorer' | 'explorerUpdate' | 'forScoper'> &
    Partial<Pick<ContextAssembler, 'watchMap'>>;
  explorer: ExplorerAgent;
  scoper: ScoperAgent;
  /** 挑版（agents/select-version.ts）；不给就不挑，停下时交付最先存的那一版 */
  selectVersion?: SelectVersion | undefined;
  /** 巡检器（agents/watcher.ts）；不给就不看。给主干直解路线的地图还要 assembler 的 watchMap */
  watcher?: WatcherAgent | undefined;
  /** 巡检器一轮的用时上限（测试里调短），默认 WATCH_TIME_MS */
  watchTimeMs?: number;
  /** 宿主采集外部观察材料，再补充冻结窗口内的原文摘录。 */
  watchInputs?: WatchDeskDeps['inputs'];
  /** 巡检器第一轮、之后每轮隔多久，默认 WATCH_FIRST_MS、WATCH_EVERY_MS */
  watchPace?: { firstMs: number; everyMs: number };
  registry: Pick<ModelRegistry, 'resolve' | 'tier'> & { apiKey?(provider: string): string | undefined };
  config: { global(): GlobalConfig; credentials(): readonly ResolvedCredential[] };
  scheduler: MelinaScheduler;
  dataDir: string;
  clock?: Clock;
  /** 开 Explorer 的 ToolSession 时的选项（收尾工具的语义检查），要的话由进程入口接上 */
  sessionOptions?: (run: Run, branch: Branch, bet: Bet) => ToolSessionOptions | undefined;
  /** 换掉容器的启停（测试） */
  env?: BranchEnv;
  /** 系统出错后的重试间隔（测试里调短） */
  retryDelaysMs?: readonly number[];
  /** 结束、收尾写结果出错后的重试间隔（测试里调短） */
  commitRetryDelaysMs?: readonly number[];
  forceRemove?: (path: string) => Promise<void>;
  /** 先冻结挂着 workspace 的容器再在宿主机上读（容器运行时的 withWorkspaceFrozen）：存交付物时用；没有容器就不给 */
  freeze?: <T>(path: string, work: () => Promise<T>) => Promise<T>;
  /** 工作目录和附件里原有的密钥进打码表（进程入口的 api/run-secrets.ts）：准备时、重启恢复时登记，结束、删除时撤掉 */
  secrets?: RunSecretsHook;
  /** 分支与 runner 就绪后创建续接组件；组件自行订阅任务和分支事件。 */
  createContinuations?: (deps: Pick<RuntimeKernel, 'branches' | 'runners' | 'scopes'>) => KernelContinuations;
  beforeCreate?: (input: CreateRunInput) => void | Promise<void>;
  onRecover?: (runId: Id) => Promise<void>;
  onBackground?: (work: Promise<void>) => void;
  log?: (text: string) => void;
}

/** 续接组件的进程生命周期；任务状态由 EventBus 通知。 */
export interface KernelContinuations {
  restore(): Promise<void>;
  start(): void;
  close(): Promise<void>;
}

export interface RuntimeKernel {
  scheduler: MelinaScheduler;
  branches: RuntimeBranchManager;
  runs: RuntimeRunManager;
  recovery: RuntimeRecovery;
  knowledge: RuntimeKnowledgeReport;
  /** 挑版：停下任务时交过两版以上，请模型挑一版，交付挑中的那一版 */
  picks: VersionPicks;
  /** 巡检器：主干直解路线每做一段，请巡检器看一轮，看法写上 RunStore */
  watch: WatchDesk;
  runners: BranchRunners;
  scopes: RunScopes;

  /** 恢复完成后按依赖顺序启动所有组件。 */
  start(): Promise<void>;
  /**
   * 退出：停调度、在途作业作废（下次启动由恢复流程重来）；已经开始的取消、放弃、出错等它写完（RunManager.stop）。
   * 数据目录的锁不归运行时管：进程入口打开 RunStore 之前拿、关完库再放（api/data-lock.ts）
   */
  stop(): Promise<void>;
  /** 同 stop，供 SDK 的 Runtime 契约调用。 */
  close(): Promise<void>;
}

export function createKernel(deps: KernelDeps): RuntimeKernel {
  const clock = deps.clock ?? realClock;
  const log = deps.log;
  const paths = runtimePaths(deps.dataDir);
  const scopes = new RunScopes();

  const env = serialized(
    deps.env ??
      (deps.containers
        ? new ContainerBranchEnv({
            runtime: deps.containers,
            paths,
            credentials: () => deps.config.credentials(),
            domains: () => deps.config.global().domains,
            ...(log ? { log } : {}),
          })
        : NO_CONTAINERS),
  );

  const branches = new RuntimeBranchManager({
    writer: deps.writer,
    queries: deps.queries,
    artifacts: deps.artifacts,
    ...(deps.freeze ? { freeze: deps.freeze } : {}),
    ...(log ? { log } : {}),
  });
  const watch = new WatchDesk({
    queries: deps.queries,
    mainLlmInFlight: (branchId) => deps.scheduler.modelInFlight(branchId, 'explorer_episode'),
    ...(deps.watchInputs ? { inputs: deps.watchInputs } : {}),
    bus: deps.bus,
    ...(deps.watcher ? { watcher: deps.watcher } : {}),
    scopes,
    clock,
    ...(deps.watchTimeMs !== undefined ? { timeMs: deps.watchTimeMs } : {}),
    ...(deps.watchPace ? { pace: deps.watchPace } : {}),
    ...(log ? { log } : {}),
  });
  const runners = new BranchRunners({
    bus: deps.bus,
    queries: deps.queries,
    writer: deps.writer,
    branches,
    scheduler: deps.scheduler,
    workspaces: deps.workspaces,
    env,
    assembler: deps.assembler,
    gateway: deps.gateway,
    explorer: deps.explorer,
    scopes,
    clock,
    ...(deps.sessionOptions ? { sessionOptions: deps.sessionOptions } : {}),
    ...(deps.retryDelaysMs ? { retryDelaysMs: deps.retryDelaysMs } : {}),
    ...(log ? { log } : {}),
  });
  const courier = new Courier({
    queries: deps.queries,
    bus: deps.bus,
    assembler: deps.assembler,
    branches,
    clock,
    ...(log ? { log } : {}),
  });
  const knowledge = new RuntimeKnowledgeReport({
    queries: deps.queries,
    artifacts: deps.artifacts,
    workspaces: deps.workspaces,
    ...(log ? { log } : {}),
  });

  const picks = new VersionPicks({
    queries: deps.queries,
    writer: deps.writer,
    artifacts: deps.artifacts,
    workspaces: deps.workspaces,
    selectVersion: deps.selectVersion,
    registry: deps.registry,
    clock,
    ...(log ? { log } : {}),
  });
  const runs = new RuntimeRunManager({
    writer: deps.writer,
    queries: deps.queries,
    bus: deps.bus,
    artifacts: deps.artifacts,
    workspaces: deps.workspaces,
    env,
    assembler: deps.assembler,
    gateway: deps.gateway,
    scoper: deps.scoper,
    registry: deps.registry,
    config: deps.config,
    branches,
    runners,
    scheduler: deps.scheduler,
    knowledge,
    scopes,
    paths,
    clock,
    ...(deps.beforeCreate ? { beforeCreate: deps.beforeCreate } : {}),
    ...(deps.retryDelaysMs ? { retryDelaysMs: deps.retryDelaysMs } : {}),
    ...(deps.commitRetryDelaysMs ? { commitRetryDelaysMs: deps.commitRetryDelaysMs } : {}),
    ...(deps.forceRemove ? { forceRemove: deps.forceRemove } : {}),
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
    ...(deps.onBackground ? { onBackground: deps.onBackground } : {}),
    picks,
    ...(log ? { log } : {}),
  });
  const recovery = new RuntimeRecovery({
    queries: deps.queries,
    writer: deps.writer,
    workspaces: deps.workspaces,
    env,
    containers: deps.containers,
    branches,
    runs,
    ...(deps.onRecover ? { onRecover: deps.onRecover } : {}),
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
    ...(log ? { log } : {}),
  });

  const continuations = deps.createContinuations?.({ branches, runners, scopes });

  // 先保护续接计划的快照，再开 worker；续接调度最后启动。
  const start = async () => {
    await continuations?.restore();
    courier.start();
    picks.start();
    await runs.start();
    watch.start();
    continuations?.start();
  };
  const stop = async () => {
    await continuations?.close();
    courier.stop();
    picks.stop();
    watch.stop();
    await runs.stop();
  };

  return {
    scheduler: deps.scheduler,
    branches,
    runs,
    recovery,
    knowledge,
    picks,
    watch,
    runners,
    scopes,
    start,
    stop,
    close: stop,
  };
}
