// 分支的容器跟着分支状态走：排队时不建；开始跑时建或起；暂停（分支暂停、任务暂停）时停掉，
// 恢复时起同一个容器，装过的东西还在；分支结束就删掉，workspace 在宿主机上照常保留。Scoper 用一个只读的临时容器。
//
// runtime 按分支状态管理容器启停，并通过 CallerContext 提供 container；ToolGateway 在该容器里执行。
//
// 数据目录里 runtime 自己放的东西（与 workspace 布局并排，删 Run 时一起删）：
//   <dataDir>/empty/<runId>/             没选工作目录时新建的空目录；最后一段是 Run id，前端靠它认出这是新建的空目录
//   <dataDir>/<runId>/materials/         附件，按 Material.name 放硬链接或副本，只读挂到 /melina/materials
//   <dataDir>/<runId>/views/<branchId>/  这条分支的 /melina/artifacts 视图，ToolGateway 往里放文件，容器只读挂载
//   <dataDir>/melina.lock                  数据目录的文件锁，Melina 打开 RunStore 之前拿（api/data-lock.ts），runtime 不碰

import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Id } from '../core/ids.ts';
import {
  CONTAINER_PATHS,
  type ContainerRef,
  type ContainerRuntime,
  type ContainerSpec,
  type ResolvedCredential,
} from '../core/interfaces/container.ts';
import type { Bet, Branch, Run } from '../core/types.ts';
import { errorText, KeyedQueue } from './async.ts';

export interface RuntimePaths {
  dataDir: string;
  /** 一个 Run 在数据目录里的东西：删 Run 时删这个目录，连同 emptyRoot */
  run(runId: Id): string;
  /** 没选工作目录时新建的空目录 */
  emptyRoot(runId: Id): string;
  materials(runId: Id): string;
  /** 分支（或 Scoper，branchId 传 'scoper'）的 /melina/artifacts 视图 */
  artifactsView(runId: Id, branchId: Id | 'scoper'): string;
}

export function runtimePaths(dataDir: string): RuntimePaths {
  const root = resolve(dataDir);
  return {
    dataDir: root,
    run: (runId) => join(root, runId),
    emptyRoot: (runId) => join(root, 'empty', runId),
    materials: (runId) => join(root, runId, 'materials'),
    artifactsView: (runId, branchId) => join(root, runId, 'views', branchId),
  };
}

export interface BranchEnv {
  /** 分支的容器：没有就建，同领域的恢复或复用，领域变化时换镜像；没有容器引擎时是 undefined */
  ensure(run: Run, branch: Branch, bet: Bet): Promise<ContainerRef | undefined>;
  /** 停掉：后台进程随之结束，装过的东西还在 */
  stop(branch: Branch, strict?: boolean): Promise<void>;
  /** 删掉 */
  remove(branch: Branch): Promise<void>;
  /** Scoper 的只读临时容器：使用任务领域镜像，挂起点（工作目录或接着做时建的副本） */
  scoper(run: Run, workspacePath: string): Promise<ContainerRef | undefined>;
  removeScoper(runId: Id, strict?: boolean): Promise<void>;
}

export interface ContainerEnvDeps {
  runtime: ContainerRuntime;
  paths: RuntimePaths;
  /** 设置里的凭证（解密后的）：每个容器都给，配了哪个系统的凭证就等于允许 AI 读写它 */
  credentials: () => readonly ResolvedCredential[];
  /** 可选领域（GlobalConfig.domains）；未指定或不可用时选 general，没有 general 就选第一个 */
  domains: () => readonly string[];
  log?: (text: string) => void;
}

export function containerName(runId: Id, who: Id | 'scoper'): string {
  return `melina-${runId}-${who}`.toLowerCase();
}

export function domainOf(run: Run, domains: readonly string[]): string {
  const d = run.goal.domain;
  if (d && domains.includes(d)) return d;
  return domains.includes('general') ? 'general' : (domains[0] ?? 'general');
}

/**
 * 只读挂到 /melina/origin 的目录：人选的工作目录原样挂进来，被 .gitignore 忽略、
 * 没抄进 workspace 的大目录（数据集这类）在这里读。没选工作目录的任务（Melina 建的 <dataDir>/empty/<runId>，最后一段是 Run id）不挂；
 * 路径里有冒号、换行的挂不了（容器引擎的 -v 用冒号分隔），也不挂
 */
export function originDirOf(run: Run): string | undefined {
  const root = run.workspace.root;
  if (!isAbsolute(root) || /[:\n\0]/.test(root)) return undefined;
  if (basename(root) === run.id && basename(dirname(root)) === 'empty') return undefined;
  return root;
}

/** ContainerSpec 里 originDir 那一段（没有就是空的） */
export function originOf(run: Run): { originDir?: string } {
  const dir = originDirOf(run);
  return dir ? { originDir: dir } : {};
}

export class ContainerBranchEnv implements BranchEnv {
  private readonly deps: ContainerEnvDeps;

  constructor(deps: ContainerEnvDeps) {
    this.deps = deps;
  }

  async ensure(run: Run, branch: Branch, _bet: Bet): Promise<ContainerRef | undefined> {
    const ws = branch.workspace;
    if (!ws) throw new Error(`分支 ${branch.id} 还没有 workspace，不能起容器`);
    const artifactsDir = this.deps.paths.artifactsView(run.id, branch.id);
    await mkdir(artifactsDir, { recursive: true });
    const spec: ContainerSpec = {
      name: containerName(run.id, branch.id),
      domain: domainOf(run, this.deps.domains()),
      workspace: { host: ws.path, container: CONTAINER_PATHS.workspace, readOnly: false },
      artifactsDir,
      ...(run.goal.materials.length > 0 ? { materialsDir: this.deps.paths.materials(run.id) } : {}),
      ...originOf(run),
      credentials: [...this.deps.credentials()],
      labels: { 'melina.run': run.id, 'melina.branch': branch.id, 'melina.role': 'explorer' },
    };
    return this.deps.runtime.start(spec);
  }

  async stop(branch: Branch, strict = false): Promise<void> {
    const stop = async () => {
      const ref = await this.deps.runtime.find(containerName(branch.runId, branch.id));
      if (ref) await this.deps.runtime.stop(ref);
    };
    if (strict) await stop();
    else await this.quietly(`停分支 ${branch.id} 的容器`, stop);
  }

  async remove(branch: Branch): Promise<void> {
    await this.quietly(`删分支 ${branch.id} 的容器`, async () => {
      const ref = await this.deps.runtime.find(containerName(branch.runId, branch.id));
      if (ref) await this.deps.runtime.remove(ref);
    });
  }

  async scoper(run: Run, workspacePath: string): Promise<ContainerRef | undefined> {
    const artifactsDir = this.deps.paths.artifactsView(run.id, 'scoper');
    await mkdir(artifactsDir, { recursive: true });
    return this.deps.runtime.ephemeral({
      name: containerName(run.id, 'scoper'),
      domain: domainOf(run, this.deps.domains()),
      workspace: { host: workspacePath, container: CONTAINER_PATHS.workspace, readOnly: true },
      artifactsDir,
      ...(run.goal.materials.length > 0 ? { materialsDir: this.deps.paths.materials(run.id) } : {}),
      ...originOf(run),
      credentials: [...this.deps.credentials()],
      labels: { 'melina.run': run.id, 'melina.role': 'scoper' },
    });
  }

  async removeScoper(runId: Id, strict = false): Promise<void> {
    const remove = async () => {
      const ref = await this.deps.runtime.find(containerName(runId, 'scoper'));
      if (ref) await this.deps.runtime.remove(ref);
    };
    if (strict) await remove();
    else await this.quietly(`删任务 ${runId} 的 Scoper 容器`, remove);
  }

  private async quietly(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.deps.log?.(`${what}失败：${errorText(error)}`);
    }
  }
}

/** 没有容器引擎（测试、只跑 RunStore 的场景）：不起容器，CallerContext 里没有 container */
export const NO_CONTAINERS: BranchEnv = {
  ensure: async () => undefined,
  stop: async () => {},
  remove: async () => {},
  scoper: async () => undefined,
  removeScoper: async () => {},
};

/**
 * 同一条分支的容器操作一次做一个：任务暂停后马上恢复时，「收完尾停容器」和「下个 episode 起容器」按先后来，
 * 不会停在起之后。
 */
export function serialized(env: BranchEnv): BranchEnv {
  const queue = new KeyedQueue();
  return {
    ensure: (run, branch, bet) => queue.run(branch.id, () => env.ensure(run, branch, bet)),
    stop: (branch, strict) => queue.run(branch.id, () => env.stop(branch, strict)),
    remove: (branch) => queue.run(branch.id, () => env.remove(branch)),
    scoper: (run, path) => queue.run(`scoper:${run.id}`, () => env.scoper(run, path)),
    removeScoper: (runId, strict) => queue.run(`scoper:${runId}`, () => env.removeScoper(runId, strict)),
  };
}
