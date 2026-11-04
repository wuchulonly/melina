// 按工作目录自动选 provider，每个 Run 一个实例。进程入口用 createWorkspaceProviders 组装，
// 别的模块只认 core 里的 WorkspaceProviders、WorkspaceProvider 接口。
//
// 没写进接口、别的模块要知道的约定：
// - 一个 Run 的 workspace 数据全在 <dataDir>/<runId>/ 下（layout.ts），删 Run 时删这个目录就干净了；
// - 没选工作目录时，RunManager 自己建一个空目录当 root（比如 <dataDir>/<runId>/root），kind 是 dir-copy；
// - forRun 每次传最新的 Run：Scoper 起草完才有 workspace.setup；
// - create 返回的 WorkspaceRef 多了 id、runId 和 setup（setup 的结果），存进 Branch.workspace 时原样存，之后原样传回来；
// - restore 之前先停掉这个 workspace 的容器；prune 的 keep 要包括还没开跑的分支要用的 snapshot。

import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MelinaError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { WorkspaceProvider, WorkspaceProviders } from '../core/interfaces/workspace.ts';
import type { Run, WorkspaceKind } from '../core/types.ts';
import type { BaseProvider, ProviderContext, WorkspaceExec, WorkspaceFreeze } from './base.ts';
import { DirCopyProvider } from './dir-copy.ts';
import { GitCloneProvider, isRepoTop } from './git-clone.ts';

export interface WorkspaceDeps {
  /** 放 workspace 的目录（MelinaOptions.dataDir，默认和 db 同目录下的 workspaces/） */
  dataDir: string;
  artifacts: ArtifactStore;
  /** 在 workspace 所属的容器里跑命令；不给就跑不了 exec，workspace.setup 记成没跑 */
  exec?: WorkspaceExec;
  /** 生产入口必须接上容器冻结；纯文件系统测试没有容器写入 */
  freeze?: WorkspaceFreeze;
  /** 删不掉的目录交给它（subuid 的文件，比如 podman unshare rm -rf） */
  forceRemove?: (path: string) => Promise<void>;
  /** 测试用：固定 id */
  newId?: () => string;
}

export function createWorkspaceProviders(deps: WorkspaceDeps): WorkspaceProviders {
  const ctx: ProviderContext = {
    dataDir: resolve(deps.dataDir),
    artifacts: deps.artifacts,
    ...(deps.exec ? { exec: deps.exec } : {}),
    ...(deps.freeze ? { freeze: deps.freeze } : {}),
    ...(deps.forceRemove ? { forceRemove: deps.forceRemove } : {}),
    newId: deps.newId ?? newId,
  };
  const providers = new Map<string, BaseProvider>();

  return {
    /** git 仓库的顶层用 git-clone，其余（普通目录、仓库的子目录）用 dir-copy；目录不存在就拒绝 */
    async detect(root: string): Promise<WorkspaceKind> {
      const st = await stat(root).catch(() => null);
      if (!st) throw new MelinaError('invalid', `工作目录不存在：${root}`);
      if (!st.isDirectory()) throw new MelinaError('invalid', `工作目录不是目录：${root}`);
      const real = await realpath(root);
      const data = await realpath(ctx.dataDir).catch(() => ctx.dataDir);
      if (data === real || data.startsWith(`${real}/`)) {
        throw new MelinaError('invalid', `工作目录包含 Melina 的数据目录：${root}`);
      }
      return (await isRepoTop(real)) ? 'git-clone' : 'dir-copy';
    },

    forRun(run: Run): WorkspaceProvider {
      const cached = providers.get(run.id);
      if (cached && cached.kind === run.workspace.kind) {
        cached.bind(run);
        return cached;
      }
      const p = run.workspace.kind === 'git-clone' ? new GitCloneProvider(ctx, run) : new DirCopyProvider(ctx, run);
      providers.set(run.id, p);
      return p;
    },
  };
}
