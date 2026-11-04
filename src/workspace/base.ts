// 两种 provider 共用的部分：绑定 Run、认 workspace、锁、exec 和 workspace.setup。

import { mkdir } from 'node:fs/promises';
import { MelinaError } from '../core/errors.ts';
import type { Handle, SnapshotId } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { ExecOpts, ExecResult, WorkspaceCreateOpts, WorkspaceProvider } from '../core/interfaces/workspace.ts';
import type { Run, WorkspaceKind, WorkspaceRef } from '../core/types.ts';
import { removeTree } from './files.ts';
import { type MelinaWorkspaceRef, type RunPaths, runPaths, wsIdOf } from './layout.ts';
import { KeyedMutex, Mutex, RwLock } from './locks.ts';
import {
  SETUP_CANCELLED,
  SETUP_TIMEOUT_MS,
  type SetupOutcome,
  setupCancelled,
  setupError,
  setupOutcome,
  setupSkipped,
} from './setup.ts';

/**
 * 在 workspace 所属的容器里执行。provider 不知道 workspace 归哪条分支、该给哪些凭证，
 * 所以由进程入口注入：createWorkspaceExec(runtime, fallback) 先找可写挂着这个 workspace、正在跑的容器，
 * 没有就按 fallback(ws) 的 spec 起一个临时容器，跑完删掉。fallback 用 ws.runId 找到 Run，取它的领域和凭证。
 */
export type WorkspaceExec = WorkspaceProvider['exec'];

/** 先冻结挂着 workspace 的容器，再在宿主机上读取；成功或失败都恢复容器 */
export type WorkspaceFreeze = <T>(path: string, work: () => Promise<T>) => Promise<T>;

export interface ProviderContext {
  /** 放 workspace 的目录（MelinaOptions.dataDir），每个 Run 一个子目录 */
  dataDir: string;
  artifacts: ArtifactStore;
  exec?: WorkspaceExec;
  freeze?: WorkspaceFreeze;
  /** 删不掉的目录交给它：容器里非 root 用户写的文件在宿主机上属于 subuid，比如用 podman unshare rm -rf */
  forceRemove?: (path: string) => Promise<void>;
  newId: () => string;
}

/** create 返回的 WorkspaceRef：多了 id，配了 workspace.setup 时还有它的结果 */
export interface CreatedWorkspace extends MelinaWorkspaceRef {
  setup?: SetupOutcome;
}

export abstract class BaseProvider implements WorkspaceProvider {
  abstract readonly kind: WorkspaceKind;
  protected run: Run;
  protected readonly ctx: ProviderContext;
  protected readonly paths: RunPaths;
  /** 同一个 workspace 的操作串行 */
  protected readonly wsLock = new KeyedMutex();
  /** store 的清理独占，其余共享（locks.ts） */
  protected readonly storeLock = new RwLock();
  /** init 只能同时跑一个 */
  protected readonly initLock = new Mutex();

  constructor(ctx: ProviderContext, run: Run) {
    this.ctx = ctx;
    this.run = run;
    this.paths = runPaths(ctx.dataDir, run.id);
  }

  /** 换成最新的 Run：Scoper 起草完才有 workspace.setup */
  bind(run: Run): void {
    if (run.id !== this.run.id) throw new MelinaError('internal', `provider 属于 Run ${this.run.id}，不是 ${run.id}`);
    this.run = run;
  }

  abstract init(run: Run): Promise<void>;
  abstract create(from: SnapshotId, opts?: WorkspaceCreateOpts): Promise<WorkspaceRef>;
  abstract snapshot(ws: WorkspaceRef, label?: string): Promise<SnapshotId>;
  abstract restore(ws: WorkspaceRef, to: SnapshotId): Promise<void>;
  abstract diff(ws: WorkspaceRef, base: SnapshotId): Promise<Handle>;
  abstract apply(ws: WorkspaceRef, patch: Handle): Promise<{ ok: boolean; conflicts?: string[] }>;
  abstract prune(ws: WorkspaceRef, keep: SnapshotId[]): Promise<void>;
  abstract deliver(ws: WorkspaceRef, snapshot: SnapshotId): Promise<{ branch?: string; patch: Handle }>;
  abstract dispose(ws: WorkspaceRef): Promise<void>;
  /** 两个 snapshot 之间的 patch（不碰任何 workspace）：没做完时主路线停下时的改动、在跑路线现在的改动用它 */
  abstract diffSnapshots(base: SnapshotId, target: SnapshotId): Promise<Handle>;

  /** 在 workspace 所属的容器里执行。没配执行器就做不了 */
  async exec(ws: WorkspaceRef, cmd: string[], opts: ExecOpts): Promise<ExecResult> {
    wsIdOf(this.paths, ws);
    if (!this.ctx.exec) throw new MelinaError('unavailable', '没有配容器执行器，workspace 里跑不了命令');
    return this.ctx.exec(ws, cmd, opts);
  }

  protected wsId(ws: WorkspaceRef): string {
    return wsIdOf(this.paths, ws);
  }

  /** snapshot 的锁挡不住容器后台写入；读目录树之前还要冻结容器，避免文件被换成宿主机上的符号链接 */
  protected snapshotWorkspace<T>(wsId: string, work: () => Promise<T>): Promise<T> {
    return this.wsLock.run(wsId, () => {
      const capture = () => this.storeLock.shared(work);
      return this.ctx.freeze ? this.ctx.freeze(this.paths.ws(wsId), capture) : capture();
    });
  }

  /**
   * 建完 workspace 后执行 workspace.setup；没配就返回原样，失败也照样返回（结果记在 setup 上）。
   * signal 取消时停掉正在跑的 setup（kill、暂停、取消任务、退出 Melina），记成没跑完；workspace 照样交回，调用方看情况删掉
   */
  protected async withSetup(ref: MelinaWorkspaceRef, signal?: AbortSignal): Promise<CreatedWorkspace> {
    const cmd = this.run.workspace.setup?.trim();
    if (!cmd) return ref;
    if (!this.ctx.exec) return { ...ref, setup: setupSkipped(cmd, '没有配容器执行器，setup 没跑') };
    if (signal?.aborted) return { ...ref, setup: setupSkipped(cmd, SETUP_CANCELLED) };
    try {
      const r = await this.ctx.exec(ref, ['bash', '-lc', cmd], {
        timeoutMs: SETUP_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      const outcome = setupOutcome(cmd, r);
      return { ...ref, setup: r.cancelled || signal?.aborted ? setupCancelled(outcome) : outcome };
    } catch (e) {
      const outcome = setupError(cmd, e);
      return { ...ref, setup: signal?.aborted ? setupCancelled(outcome) : outcome };
    }
  }

  /** 删一棵树；权限不够（subuid 的文件）时交给 forceRemove */
  protected rmTree(path: string): Promise<void> {
    return removeTree(path, this.ctx.forceRemove);
  }

  /** 新 workspace 的 ref：path、id，加上 runId（给 exec 的 fallback 找 Run 用） */
  protected refOf(id: string): MelinaWorkspaceRef {
    return { path: this.paths.ws(id), id, runId: this.run.id };
  }

  protected async ensureRunDirs(): Promise<void> {
    await mkdir(this.paths.tmp, { recursive: true });
  }

  protected tmpPath(name: string): string {
    return `${this.paths.tmp}/${name}-${this.ctx.newId()}`;
  }
}
