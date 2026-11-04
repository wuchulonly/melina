// DirCopyProvider：工作目录不是 git 仓库（或者是仓库的子目录、没选目录）时用。
//
// - 每个 snapshot 是 snap/<id>/ 下的一整棵目录，建好后再也不改。打 snapshot 时，和 workspace 当前对齐的那个 snapshot 比，
//   没变的文件（大小、权限、修改时间都一样）直接硬链接过去，变了的才复制；复制先试写时复制（reflink），不支持就完整复制。
// - workspace 从 snapshot 复制出来，绝不和 snapshot 共用 inode（agent 原地改文件会改坏 snapshot）。
// - 目录里的东西全收（没有「被忽略的文件」），包括嵌套的 .git；符号链接照原样收，不跟随。
// - diff、交付的 patch 用 git 的格式（dir-diff.ts）；交付只有 patch，在结果页下载。

import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MelinaError } from '../core/errors.ts';
import { type Handle, ROOT, type SnapshotId } from '../core/ids.ts';
import type { WorkspaceCreateOpts } from '../core/interfaces/workspace.ts';
import type { Run, WorkspaceRef } from '../core/types.ts';
import { applyPatch } from './apply.ts';
import { BaseProvider } from './base.ts';
import { writeTreePatch } from './dir-diff.ts';
import { copyTree, diskFull, isCode, isInside, isRealDir, lstatOrNull, removeTree, syncTree } from './files.ts';
import { git } from './git.ts';
import { checkSnapshotId, runPaths } from './layout.ts';
import { listMeta, readMeta, readWsState, writeMeta, writeWsState } from './meta.ts';

export class DirCopyProvider extends BaseProvider {
  readonly kind = 'dir-copy' as const;

  async init(run: Run): Promise<void> {
    this.bind(run);
    if (run.workspace.kind !== 'dir-copy')
      throw new MelinaError('invalid', `这个 Run 的 workspace 是 ${run.workspace.kind}`);
    await this.initLock.run(async () => {
      const rootSnap = this.paths.snap(ROOT);
      if (await isRealDir(rootSnap)) return; // 已经 init 过
      await this.ensureRunDirs();
      await mkdir(join(this.paths.dir, 'snap'), { recursive: true });
      const tmp = `${rootSnap}.tmp`;
      await removeTree(tmp);
      try {
        const from = run.workspace.from;
        if (from) {
          const prev = runPaths(this.ctx.dataDir, from.runId);
          const src = prev.snap(checkSnapshotId(from.snapshot));
          if (!(await isRealDir(src))) throw new MelinaError('not_found', '上个任务的 snapshot 已经不在了，不能接着做');
          await copyTree(src, tmp);
        } else {
          // 工作目录本身可以是指向目录的符号链接（人选的路径），里面的链接一律不跟随
          const root = await realpath(resolve(run.workspace.root)).catch(() => undefined);
          if (!root || !(await isRealDir(root))) {
            throw new MelinaError('invalid', `工作目录不存在或不是目录：${run.workspace.root}`);
          }
          const dataDir = resolve(this.ctx.dataDir);
          // 工作目录包住了数据目录时跳过数据目录，免得把自己复制进自己（API 本来就拒收这种目录）
          await copyTree(root, tmp, {
            skip: (rel) => isInside(join(root, ...rel.split('/')), dataDir),
            skipVanished: true,
          });
        }
        await rename(tmp, rootSnap);
      } catch (e) {
        await removeTree(tmp).catch(() => {});
        throw diskFull(e, '打根 snapshot');
      }
      await writeMeta(this.paths, { id: ROOT, at: new Date().toISOString() });
    });
  }

  async create(from: SnapshotId, opts: WorkspaceCreateOpts = {}): Promise<WorkspaceRef> {
    checkSnapshotId(from);
    const ref = await this.storeLock.shared(async () => {
      const src = await this.snapDir(from);
      const id = this.ctx.newId();
      const path = this.paths.ws(id);
      const tmp = join(this.paths.tmp, `ws-${id}`);
      await this.ensureRunDirs();
      await mkdir(join(this.paths.dir, 'ws'), { recursive: true });
      try {
        // 文件与状态就绪后再发布，外部扫描不会看到半成品。
        await copyTree(src, tmp);
        await writeWsState(this.paths, id, { base: from, from, createdAt: new Date().toISOString() });
        await rename(tmp, path);
      } catch (e) {
        await this.rmTree(tmp).catch(() => {});
        await rm(this.paths.wsState(id), { force: true }).catch(() => {});
        throw diskFull(e, '建 workspace');
      }
      return this.refOf(id);
    });
    return this.withSetup(ref, opts.signal);
  }

  async snapshot(ws: WorkspaceRef, label?: string): Promise<SnapshotId> {
    const wsId = this.wsId(ws);
    return this.snapshotWorkspace(wsId, async () => {
      const id = this.ctx.newId();
      const state = await readWsState(this.paths, wsId);
      const base = state ? this.paths.snap(state.base) : undefined;
      const dest = this.paths.snap(id);
      const tmp = `${dest}.tmp`;
      try {
        const linkFrom = base && (await isRealDir(base)) ? base : undefined;
        await copyTree(this.paths.ws(wsId), tmp, { skipVanished: true, ...(linkFrom ? { linkFrom } : {}) });
        await rename(tmp, dest);
      } catch (e) {
        await removeTree(tmp).catch(() => {});
        throw diskFull(e, '打 snapshot');
      }
      await writeMeta(this.paths, {
        id,
        ws: wsId,
        ...(state ? { base: state.base } : {}),
        ...(label ? { label } : {}),
        at: new Date().toISOString(),
      });
      if (state) await writeWsState(this.paths, wsId, { ...state, base: id });
      return id;
    });
  }

  async restore(ws: WorkspaceRef, to: SnapshotId): Promise<void> {
    checkSnapshotId(to);
    const wsId = this.wsId(ws);
    await this.wsLock.run(wsId, () =>
      this.storeLock.shared(async () => {
        const src = await this.snapDir(to);
        const path = this.paths.ws(wsId);
        try {
          const st = await lstatOrNull(path);
          if (st && !st.isDirectory()) await this.rmTree(path);
          if (!st?.isDirectory()) await mkdir(path, { recursive: true });
          await syncTree(src, path, this.ctx.forceRemove ? { force: this.ctx.forceRemove } : {});
        } catch (e) {
          throw diskFull(e, '恢复 workspace');
        }
        const state = await readWsState(this.paths, wsId);
        await writeWsState(this.paths, wsId, {
          base: to,
          from: state?.from ?? to,
          createdAt: state?.createdAt ?? new Date().toISOString(),
        });
      }),
    );
  }

  async diff(ws: WorkspaceRef, base: SnapshotId): Promise<Handle> {
    checkSnapshotId(base);
    const wsId = this.wsId(ws);
    return this.wsLock.run(wsId, () =>
      this.storeLock.shared(async () => {
        const from = await this.snapDir(base);
        return this.patchBetween(from, this.paths.ws(wsId));
      }),
    );
  }

  async apply(ws: WorkspaceRef, patch: Handle): Promise<{ ok: boolean; conflicts?: string[] }> {
    const wsId = this.wsId(ws);
    return this.wsLock.run(wsId, async () => {
      await this.ensureRunDirs();
      const scratch = this.tmpPath('apply');
      const gitDir = join(scratch, 'apply.git');
      const file = join(scratch, 'patch');
      try {
        await mkdir(scratch, { recursive: true });
        await git({ args: ['init', '-q', '--bare', gitDir] });
        await writeFile(file, await this.ctx.artifacts.read(this.run.id, patch));
        return await applyPatch(gitDir, this.paths.ws(wsId), file);
      } finally {
        await removeTree(scratch);
      }
    });
  }

  async prune(ws: WorkspaceRef, keep: SnapshotId[]): Promise<void> {
    const wsId = this.wsId(ws);
    const keepSet = new Set(keep.map(checkSnapshotId));
    // 独占：正在从这些 snapshot 复制的 create、restore 做完了才删
    await this.wsLock.run(wsId, () =>
      this.storeLock.exclusive(async () => {
        for (const meta of await listMeta(this.paths)) {
          if (meta.id === ROOT || meta.ws !== wsId || keepSet.has(meta.id) || meta.pruned) continue;
          await removeTree(this.paths.snap(meta.id));
          await writeMeta(this.paths, { ...meta, pruned: new Date().toISOString() });
        }
      }),
    );
  }

  async diffSnapshots(base: SnapshotId, target: SnapshotId): Promise<Handle> {
    checkSnapshotId(base);
    checkSnapshotId(target);
    return this.storeLock.shared(async () => this.patchBetween(await this.snapDir(base), await this.snapDir(target)));
  }

  /** 交付只有 patch：这个 snapshot 相对根 snapshot 的改动，在结果页下载 */
  async deliver(_ws: WorkspaceRef, snapshot: SnapshotId): Promise<{ branch?: string; patch: Handle }> {
    checkSnapshotId(snapshot);
    return this.storeLock.shared(async () => {
      const root = await this.snapDir(ROOT);
      const snap = await this.snapDir(snapshot);
      return { patch: await this.patchBetween(root, snap) };
    });
  }

  async dispose(ws: WorkspaceRef): Promise<void> {
    const wsId = this.wsId(ws);
    await this.wsLock.run(wsId, async () => {
      await this.rmTree(this.paths.ws(wsId));
      await rm(this.paths.wsState(wsId), { force: true });
    });
  }

  private async snapDir(id: SnapshotId): Promise<string> {
    const dir = this.paths.snap(id);
    if (await isRealDir(dir)) return dir;
    if (id === ROOT) throw new MelinaError('not_found', '这个 Run 的 workspace 还没打根 snapshot（init 没跑）');
    const meta = await readMeta(this.paths, id);
    if (meta?.pruned) throw new MelinaError('not_found', `snapshot ${id} 的内容已经清理了：只留各分支的 lastSnapshot`);
    throw new MelinaError('not_found', `没有这个 snapshot：${id}`);
  }

  /** b 可以是还在跑的 workspace：算到一半文件被后台进程删了，就整个重来，最多三次 */
  private async patchBetween(a: string, b: string): Promise<Handle> {
    await this.ensureRunDirs();
    for (let attempt = 1; ; attempt++) {
      const scratch = this.tmpPath('diff');
      const out = `${scratch}.patch`;
      try {
        await writeTreePatch({ a, b, out, scratch });
        return await this.ctx.artifacts.putFile(this.run.id, out);
      } catch (e) {
        const vanished = isCode(e, 'ENOENT') || (e instanceof MelinaError && e.code === 'internal');
        if (!vanished || attempt >= 3) throw diskFull(e, '生成 patch');
      } finally {
        await rm(out, { force: true });
      }
    }
  }
}
