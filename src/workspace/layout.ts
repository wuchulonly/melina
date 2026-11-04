// 一个 Run 的 workspace 数据在磁盘上怎么放。全部在 <dataDir>/<runId>/ 下，删掉这个目录就删干净了：
//
//   store.git/             git-clone：Melina 自己的裸仓库，根 snapshot 和每个 snapshot 是里面的提交（隐藏 ref）
//   index/<wsId>           git-clone：Melina 给每个 workspace 记的 index（打 snapshot 时比 stat，没变的文件不用重算）
//   local/                 git-clone：开跑时从工作目录抄来的、被 .gitignore 忽略的小文件（.env 这类），建 workspace 时放进去
//   snap/<id>/             dir-copy：每个 snapshot 一整棵目录，没变的文件和上一份硬链接
//   snapshots/<id>.json    两种都有：snapshot 是哪个 workspace 打的、从哪个 snapshot 来、内容清理了没有
//   wsstate/<wsId>.json    两种都有：workspace 现在和哪个 snapshot 对齐
//   ws/<wsId>/             workspace 本身，分支的容器挂载它
//   tmp/                   临时文件

import { join, resolve } from 'node:path';
import { MelinaError } from '../core/errors.ts';
import { ID_PATTERN, ROOT, type SnapshotId } from '../core/ids.ts';
import type { WorkspaceRef } from '../core/types.ts';

export interface RunPaths {
  dir: string;
  store: string;
  tmp: string;
  local: string;
  /** snapshots/：每个 snapshot 一个 JSON */
  metaDir: string;
  ws(id: string): string;
  index(id: string): string;
  snap(id: SnapshotId): string;
  meta(id: SnapshotId): string;
  wsState(id: string): string;
}

export function runPaths(dataDir: string, runId: string): RunPaths {
  if (!new RegExp(ID_PATTERN).test(runId)) throw new MelinaError('invalid', `runId 不对：${runId}`);
  const dir = join(resolve(dataDir), runId);
  return {
    dir,
    store: join(dir, 'store.git'),
    tmp: join(dir, 'tmp'),
    local: join(dir, 'local'),
    metaDir: join(dir, 'snapshots'),
    ws: (id) => join(dir, 'ws', id),
    index: (id) => join(dir, 'index', id),
    snap: (id) => join(dir, 'snap', id),
    meta: (id) => join(dir, 'snapshots', `${id}.json`),
    wsState: (id) => join(dir, 'wsstate', `${id}.json`),
  };
}

const ULID = new RegExp(ID_PATTERN);

/** snapshot id 只能是 'root' 或 provider 发的 ULID：它会拼进 ref 名和目录名，别的一律拒绝 */
export function checkSnapshotId(id: SnapshotId): SnapshotId {
  if (id === ROOT || ULID.test(id)) return id;
  throw new MelinaError('invalid', `不是这个 provider 的 snapshot：${id}`);
}

/** provider 自己加在 WorkspaceRef 上的字段 */
export interface MelinaWorkspaceRef extends WorkspaceRef {
  /** workspace 的 id（ULID），也是 ws/ 下的目录名 */
  id: string;
  /** 属于哪个 Run：执行器的 fallback 按它找领域镜像和凭证 */
  runId: string;
}

/**
 * 认出这个 Run 自己的 workspace。restore、dispose 会删改 ref.path 下的东西，
 * 所以 path 必须正好是 ws/<id>，不认就拒绝，免得一个伪造的 ref 把别的目录清掉。
 */
export function wsIdOf(paths: RunPaths, ref: WorkspaceRef & { id?: unknown }): string {
  const id = typeof ref.id === 'string' ? ref.id : undefined;
  if (!id || !ULID.test(id) || resolve(ref.path) !== paths.ws(id)) {
    throw new MelinaError('invalid', `不是这个 Run 的 workspace：${ref.path}`);
  }
  return id;
}
