// WorkspaceProvider。实现在 src/workspace/。
// 每个 Run 一个实例，init 时绑定这个 Run；'root' 指本 Run 的根 snapshot。fork 就是 create(源分支的 snapshot)。
// 每个 snapshot 记录它的父 snapshot，构成 lineage 树（Snapshot 记录由 RunStoreWriter.closeEpisode 写）。
// 一个 Run 的 workspace 数据都在 <dataDir>/<runId>/ 下（runtime 的 materials/、views/ 也在这里），删 Run 时整个目录删掉。

import type { Handle, SnapshotId } from '../ids.ts';
import type { Run, WorkspaceKind, WorkspaceRef } from '../types.ts';

export interface ExecOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** 相对 workspace 的工作目录，默认 workspace 根 */
  cwd?: string;
}

export interface ExecResult {
  exitCode: number | null; // 被杀或超时时为 null
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface WorkspaceCreateOpts {
  /** 取消时停掉正在跑的 workspace.setup（kill、取消任务、退出 Melina），setup 的结果记成被取消；不给就跑完为止 */
  signal?: AbortSignal;
}

export interface WorkspaceProvider {
  readonly kind: WorkspaceKind;
  /** 开跑时按起点打根 snapshot：目录现状（git 仓库含未提交的改动），或 Run.workspace.from（接着做） */
  init(run: Run): Promise<void>;
  /**
   * 从 'root' 或某个 snapshot 建一个 workspace（git 是独立 clone，目录是 reflink 副本），建完执行 workspace.setup。
   * 返回的 ref 带 id、runId，跑了 setup 时带 setup 的结果（失败不抛错，由 runtime 放进收件箱）
   */
  create(from: SnapshotId, opts?: WorkspaceCreateOpts): Promise<WorkspaceRef>;
  /** git 用临时 index 提交到隐藏 ref，不动 agent 的 HEAD 和暂存区，同时记下 HEAD 和当前分支 */
  snapshot(ws: WorkspaceRef, label?: string): Promise<SnapshotId>;
  /** 原地改回某个 snapshot，HEAD 和当前分支一起还原，被忽略的文件不动；崩溃恢复用 */
  restore(ws: WorkspaceRef, to: SnapshotId): Promise<void>;
  /** 相对 base 的 patch，存进 Artifact store */
  diff(ws: WorkspaceRef, base: SnapshotId): Promise<Handle>;
  /**
   * 两个 snapshot 之间的 patch（git 格式），存进 Artifact store，不碰任何 workspace：
   * 没做完时主路线停下时的改动、在跑路线现在的改动（GET /runs/:id/branches/:branchId/diff）用它
   */
  diffSnapshots(base: SnapshotId, target: SnapshotId): Promise<Handle>;
  apply(ws: WorkspaceRef, patch: Handle): Promise<{ ok: boolean; conflicts?: string[] }>;
  /** 在 workspace 所属的容器里执行（workspace.setup 用） */
  exec(ws: WorkspaceRef, cmd: string[], opts: ExecOpts): Promise<ExecResult>;
  /** 只留这些 snapshot 的内容，lineage 记录照留 */
  prune(ws: WorkspaceRef, keep: SnapshotId[]): Promise<void>;
  /** 交付：仓库类任务推成用户仓库的 melina/<runId> 分支，不动用户当前的分支和工作区；都另存相对起点的 patch */
  deliver(ws: WorkspaceRef, snapshot: SnapshotId): Promise<{ branch?: string; patch: Handle }>;
  dispose(ws: WorkspaceRef): Promise<void>;
}

export interface WorkspaceProviders {
  /** 按工作目录自动选：git 仓库用 git-clone，否则 dir-copy */
  detect(root: string): Promise<WorkspaceKind>;
  /** 这个 Run 的 provider（还没 init 的） */
  forRun(run: Run): WorkspaceProvider;
}
