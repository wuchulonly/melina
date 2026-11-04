// 沙箱里的 /melina/artifacts：按分支生成的只读视图，只放本分支的原始输出。
// 句柄 art://<sha256> 对应其中的 <sha256 前两位>/<sha256>。
//
// 宿主机上的位置和 runtime 一致：
//   <数据目录>/<runId>/views/<分支 id>/   分支的视图
//   <数据目录>/<runId>/views/scoper/      Scoper 的输出
// 目录里放硬链接，跨文件系统时复制，不能放符号链接：链接指向的宿主机路径在容器里不存在。
// 文件来自 Artifact store，本来就是只读的（0444），容器里再按只读挂载。删 Run 时 runtime 删整个 <数据目录>/<runId>。

import { existsSync } from 'node:fs';
import { chmod, copyFile, link, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { invalid } from '../core/errors.ts';
import { type Handle, handlePath, type Id, isId } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';

export interface ArtifactViewsOptions {
  /** Melina 的数据目录 */
  dataDir: string;
  artifacts: Pick<ArtifactStore, 'path'>;
}

export class ArtifactViews {
  readonly dataDir: string;
  readonly #artifacts: Pick<ArtifactStore, 'path'>;

  constructor(options: ArtifactViewsOptions) {
    this.dataDir = resolve(options.dataDir);
    this.#artifacts = options.artifacts;
  }

  /** 分支的 /melina/artifacts */
  branchDir(runId: Id, branchId: Id): string {
    return join(this.#viewsDir(runId), checkId(branchId, '分支'));
  }

  /** Scoper 的 /melina/artifacts：只有它自己的输出 */
  scoperDir(runId: Id): string {
    return join(this.#viewsDir(runId), 'scoper');
  }

  /** 建好目录（容器挂载前，挂载点的源目录必须已经在） */
  async ensure(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** 把一个产物放进某个视图目录：<dir>/<sha256 前两位>/<sha256>；已经在就什么也不做 */
  async add(runId: Id, dir: string, handle: Handle): Promise<void> {
    const target = join(dir, handlePath(handle));
    if (existsSync(target)) return;
    await mkdir(dirname(target), { recursive: true });
    await place(this.#artifacts.path(runId, handle), target);
  }

  #viewsDir(runId: Id): string {
    return join(this.dataDir, checkId(runId, 'Run'), 'views');
  }
}

function checkId(id: Id, what: string): Id {
  if (!isId(id)) throw invalid(`不是${what}的 id：${String(id)}`);
  return id;
}

/** 硬链接过去；跨文件系统（EXDEV）或不让链接时复制一份，改成只读 */
export async function place(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
    return;
  } catch (error) {
    if (existsSync(target)) return; // 并发放进来了
    const code = (error as { code?: unknown }).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK') throw error;
  }
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await copyFile(source, temp);
  await chmod(temp, 0o444);
  if (existsSync(target)) {
    await rm(temp, { force: true });
    return;
  }
  await rename(temp, target);
}
