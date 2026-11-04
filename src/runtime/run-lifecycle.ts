// Run 生命周期共用的依赖和串行队列；准备、状态转换、收尾使用同一个实例。
import type { GlobalConfig } from '../core/config.ts';
import { notFound } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import type { ScoperAgent } from '../core/interfaces/agents.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { ContextAssembler } from '../core/interfaces/context.ts';
import type { ToolGateway } from '../core/interfaces/gateway.ts';
import type { ModelRegistry } from '../core/interfaces/models.ts';
import type { CreateRunInput } from '../core/interfaces/runtime.ts';
import type { EventBus, RunStoreQueries, RunStoreWriter } from '../core/interfaces/store.ts';
import type { WorkspaceProviders } from '../core/interfaces/workspace.ts';
import { type Candidate, ENDED_RUN_STATUSES, type Run } from '../core/types.ts';
import { type Clock, errorText, KeyedQueue } from './async.ts';
import type { BranchEnv, RuntimePaths } from './branch-env.ts';
import type { RuntimeBranchManager } from './branch-manager.ts';
import type { BranchRunners, RunScopes } from './branch-runner.ts';
import type { RuntimeKnowledgeReport } from './knowledge.ts';
import type { MelinaScheduler } from './scheduler.ts';

/** 工作目录和附件里原有的密钥进打码表 */
export interface RunSecretsHook {
  add(run: Run): Promise<number>;
  drop(runId: Id): void;
  /** 交付的 patch 里像密钥的东西在哪（给人看的，不含值）；没有是空数组。 */
  leaksIn?(patch: string): string[];
}

export interface RunManagerDeps {
  writer: RunStoreWriter;
  queries: RunStoreQueries;
  bus: EventBus;
  artifacts: ArtifactStore;
  workspaces: WorkspaceProviders;
  env: BranchEnv;
  assembler: Pick<ContextAssembler, 'forScoper'>;
  gateway: ToolGateway;
  scoper: ScoperAgent;
  /** apiKey 有就用来挑主干直解路线开哪几份：一档里没配 key 的模型不开（models/registry.ts 的 MelinaModelRegistry 有） */
  registry: Pick<ModelRegistry, 'resolve' | 'tier'> & { apiKey?(provider: string): string | undefined };
  config: { global(): GlobalConfig };
  branches: RuntimeBranchManager;
  runners: BranchRunners;
  scheduler: MelinaScheduler;
  knowledge: RuntimeKnowledgeReport;
  scopes: RunScopes;
  paths: RuntimePaths;
  clock: Clock;
  /** 创建任务前检查宿主条件；失败时不创建任务或工作目录。 */
  beforeCreate?: (input: CreateRunInput) => void | Promise<void>;
  /** Scoper 出系统错误（容器起不来这类）后的重试间隔；用完还不行任务转 failed */
  retryDelaysMs?: readonly number[];
  /** 结束、收尾最后写结果那一步出错后的重试间隔；用完以后一直按最后一个间隔重试，直到写进去或者 Melina 退出 */
  commitRetryDelaysMs?: readonly number[];
  /** 删不掉的目录交给它（容器里别的用户写的文件，比如 podman unshare rm -rf） */
  forceRemove?: (path: string) => Promise<void>;
  /** 准备时把工作目录和附件里原有的密钥登记进打码表，结束、删除时撤掉 */
  secrets?: RunSecretsHook;
  /** 后台的事（准备、收尾）开始和做完：测试等它们做完用 */
  onBackground?: (work: Promise<void>) => void;
  /**
   * 挑版：任务停下时交过两版以上，先请模型挑一版，交付挑中的那一版。
   * 不给就不挑：交付以前挑中的，没挑过就是最先存的那一版。
   */
  picks?: { settle(runId: Id): Promise<Candidate | undefined> };
  log?: (text: string) => void;
}

export class RunLifecycle {
  readonly deps: RunManagerDeps;
  /** 同一个 Run 的准备、暂停、恢复、收尾和结束一次做一个。Scoper 等待单独用 prepare:<runId>。 */
  readonly locks = new KeyedQueue();

  constructor(deps: RunManagerDeps) {
    this.deps = deps;
  }

  mustRun(id: Id): Run {
    const run = this.deps.queries.getRun(id);
    if (!run) throw notFound(`任务 ${id} 不存在`);
    return run;
  }

  background(work: Promise<void>): void {
    const tracked = work.catch((error) => this.deps.log?.(`后台的事出错：${errorText(error)}`));
    this.deps.onBackground?.(tracked);
  }
}

export function isEnded(run: Run): boolean {
  return (ENDED_RUN_STATUSES as readonly string[]).includes(run.status);
}
