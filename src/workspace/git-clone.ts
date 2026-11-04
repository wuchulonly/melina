// GitCloneProvider：工作目录是 git 仓库时用。
//
// - store.git 是 Melina 自己的裸仓库，从用户仓库 clone 出来（对象硬链接）。根 snapshot 和之后每个 snapshot 都是里面的一个提交，
//   挂在隐藏的 ref 上：refs/melina/root、refs/melina/snapshots/<id>；提交的树是工作区里没被忽略的全部文件（含没提交的改动），
//   父提交是 agent 当时的 HEAD，提交说明里记着 HEAD 和当前分支。agent 的各个分支挂在 refs/melina/snaprefs/<id>/heads/*。
// - 每个 workspace 是 store 的一个独立 clone（ws/<id>/.git，对象硬链接），agent 在里面随便用 git。
// - 打 snapshot、恢复、算 diff 都用 store 当 git-dir、workspace 当 work-tree、Melina 自己的 index（index/<wsId>），
//   所以不动 agent 的 HEAD 和暂存区，也不读 agent 的 .git/config（里面的 filter、hook 不会在宿主机上执行，git.ts）。
// - Melina 从不往 agent 动过的 .git 里写：建 workspace 时 .git 是新 clone 的；恢复时把旧的挪走、重建一个新的，
//   再把 agent 的 config、hooks 抄回去。读（HEAD、分支）只用不执行东西的底层命令，hook 也关着。
// - 交付：在用户仓库里 fetch 出一个新分支 melina/<runId>，不碰用户当前的分支、暂存区和工作区。

import { chmod, copyFile, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MelinaError } from '../core/errors.ts';
import { type Handle, ROOT, type SnapshotId } from '../core/ids.ts';
import type { WorkspaceCreateOpts } from '../core/interfaces/workspace.ts';
import type { Run, WorkspaceRef } from '../core/types.ts';
import { applyPatch } from './apply.ts';
import { BaseProvider } from './base.ts';
import { diskFull, exists, isRealDir, lstatOrNull, removeTree } from './files.ts';
import { EMPTY_TREE, type GitOptions, git, gitOut, splitZ } from './git.ts';
import { checkSnapshotId, runPaths } from './layout.ts';
import { captureLocal, placeLocal, readManifest, writeManifest } from './local-files.ts';
import { readJson, readMeta, readWsState, writeMeta, writeWsState } from './meta.ts';

/** snapshot 时 agent 的 HEAD */
export type HeadInfo =
  | { state: 'commit'; sha: string; branch?: string } // branch 是完整 ref（refs/heads/x），没有就是 detached
  | { state: 'unborn'; branch: string } // 还没有提交
  | { state: 'unknown' }; // .git 被弄坏了读不出来：只记工作区

/** 写在 snapshot 提交说明里的东西 */
interface CommitMeta {
  v: 1;
  kind: 'root' | 'snapshot';
  id: SnapshotId;
  head: HeadInfo;
  /** agent 的 refs/heads/* 记在 refs/melina/snaprefs/<id>/heads/* 下 */
  heads: boolean;
  label?: string;
}

interface RemotesInfo {
  remotes: { name: string; url: string; fetch: string[] }[];
  branches: { name: string; remote?: string; merge?: string }[];
}

const ROOT_REF = 'refs/melina/root';
const snapRef = (id: SnapshotId) => (id === ROOT ? ROOT_REF : `refs/melina/snapshots/${id}`);
const snapHeadsPrefix = (id: SnapshotId) => `refs/melina/snaprefs/${id}/heads/`;
const byWsPrefix = (wsId: string) => `refs/melina/by-ws/${wsId}/`;
const indexRef = (wsId: string) => `refs/melina/ws/${wsId}/index`;
const deliverRef = (id: SnapshotId) => `refs/melina/deliver/${id}`;
const tmpRef = (tag: string) => `refs/melina/tmp/${tag}`;

/** 读 workspace 的 .git 时（只读的底层命令）用短一点的超时：配置 include 了 FIFO 也很快放弃 */
const WS_READ_TIMEOUT_MS = 60_000;

/** 松散对象多到这个数，或者合计这么大（KiB），prune 之后顺手清理一次 store */
const MAINTAIN_LOOSE_COUNT = 5000;
const MAINTAIN_LOOSE_KIB = 256 * 1024;

export class GitCloneProvider extends BaseProvider {
  readonly kind = 'git-clone' as const;

  // ── init：打根 snapshot ───────────────────────────────────────────────

  async init(run: Run): Promise<void> {
    this.bind(run);
    if (run.workspace.kind !== 'git-clone')
      throw new MelinaError('invalid', `这个 Run 的 workspace 是 ${run.workspace.kind}`);
    await this.initLock.run(async () => {
      if (await this.hasCommit(ROOT_REF)) return; // 已经 init 过（崩溃后重来）
      await this.ensureRunDirs();
      try {
        if (!(await isRealDir(this.paths.store))) await this.cloneStore();
        if (run.workspace.from) await this.importRoot(run.workspace.from);
        else await this.captureRoot();
        await this.captureLocalFiles();
        await writeMeta(this.paths, { id: ROOT, at: new Date().toISOString() });
      } catch (e) {
        throw diskFull(e, '打根 snapshot');
      }
    });
  }

  /** 从用户仓库 clone 出 store；接着做而用户目录已经不是仓库了，就从上个 Run 的 store clone */
  private async cloneStore(): Promise<void> {
    const root = this.run.workspace.root;
    const from = this.run.workspace.from;
    const userRepo = await isRepoTop(root);
    if (!userRepo && !from) throw new MelinaError('invalid', `工作目录不是 git 仓库的顶层：${root}`);
    const prevStore = from ? runPaths(this.ctx.dataDir, from.runId).store : undefined;
    const source = userRepo ? root : (prevStore as string);
    const tmp = `${this.paths.store}.tmp`;
    await removeTree(tmp);
    // --no-hardlinks：store 的对象是复制来的，不和用户仓库（或上个 Run 的 store）共用 inode。workspace 是从 store 硬链接 clone 的，
    // agent 在容器里 chmod -R、原地改写 .git 里的文件会改到同一个 inode，原来就改到了用户仓库（10-02 评价的高危之一）。
    // 代价是每个 Run 多一份对象的空间和复制的时间；workspace 和 store 之间照  用硬链接
    await git({ args: ['clone', '--bare', '--no-hardlinks', '-q', source, tmp] });
    for (const [k, v] of [
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      ['core.logAllRefUpdates', 'false'],
    ] as const) {
      await git({ gitDir: tmp, args: ['config', k, v] });
    }
    await git({ gitDir: tmp, args: ['config', '--remove-section', 'remote.origin'], okCodes: [0, 128] });
    await keepPacks(tmp); // 从用户仓库来的 pack 不参与之后的 repack（prune 只清 Melina 自己产生的对象）
    let remotes: RemotesInfo = { remotes: [], branches: [] };
    if (userRepo) {
      await writeFile(join(tmp, 'info', 'exclude'), await userExcludes(root));
      remotes = await readUserRemotes(root);
      await git({
        gitDir: tmp,
        args: ['fetch', '-q', '--no-tags', '--no-write-fetch-head', root, '+refs/remotes/*:refs/remotes/*'],
        okCodes: [0, 1, 128],
      });
    } else if (prevStore) {
      await copyFile(join(prevStore, 'info', 'exclude'), join(tmp, 'info', 'exclude')).catch(() => {});
      const prevRemotes = await readJson<RemotesInfo>(join(dirname(prevStore), 'remotes.json'));
      if (prevRemotes) remotes = prevRemotes;
    }
    await writeFile(join(this.paths.dir, 'remotes.json'), `${JSON.stringify(remotes)}\n`);
    await rename(tmp, this.paths.store);
  }

  /** 根 snapshot = 用户工作目录的现状：HEAD、当前分支，加上没提交的改动和没被忽略的新文件 */
  private async captureRoot(): Promise<void> {
    const root = this.run.workspace.root;
    const head = await userHead(root);
    if (head.state === 'commit' && !(await this.hasCommit(head.sha))) {
      await this.store({
        args: ['fetch', '-q', '--no-tags', '--no-write-fetch-head', root, `+${head.sha}:${tmpRef('root')}`],
      });
    }
    const index = this.paths.index(ROOT);
    await mkdir(dirname(index), { recursive: true });
    await rm(index, { force: true });
    if (head.state === 'commit') await this.store({ indexFile: index, args: ['read-tree', head.sha] });
    const tree = await this.addAll(root, index, head);
    const commit = await this.commit(tree, head, { v: 1, kind: 'root', id: ROOT, head, heads: false });
    await this.refs([
      ['update', ROOT_REF, commit],
      ['delete', tmpRef('root')],
    ]);
  }

  /** 接着做：根 snapshot 就是上个 Run 的那个 snapshot，连同它记下的 agent 分支 */
  private async importRoot(from: { runId: string; snapshot: SnapshotId }): Promise<void> {
    const prev = runPaths(this.ctx.dataDir, from.runId);
    if (!(await isRealDir(prev.store))) {
      throw new MelinaError('not_found', '上个任务的 workspace 已经删了，不能接着做');
    }
    const id = checkSnapshotId(from.snapshot);
    const has = await git({
      gitDir: prev.store,
      args: ['rev-parse', '-q', '--verify', `${snapRef(id)}^{commit}`],
      okCodes: [0, 1, 128],
    });
    if (has.code !== 0) throw new MelinaError('not_found', `上个任务的 snapshot ${id} 已经不在了`);
    await this.store({
      args: [
        'fetch',
        '-q',
        '--no-tags',
        '--no-write-fetch-head',
        prev.store,
        `+${snapRef(id)}:${ROOT_REF}`,
        `+${snapHeadsPrefix(id)}*:${snapHeadsPrefix(ROOT)}*`,
      ],
    });
  }

  /** 被忽略的小文件抄进 local/（local-files.ts） */
  private async captureLocalFiles(): Promise<void> {
    const root = this.run.workspace.root;
    if (!(await isRealDir(root))) return;
    const index = this.paths.index(ROOT);
    if (!(await exists(index))) {
      await mkdir(dirname(index), { recursive: true });
      await this.store({ indexFile: index, args: ['read-tree', `${ROOT_REF}^{tree}`] });
    }
    const listed = await this.store({
      workTree: root,
      indexFile: index,
      cwd: root,
      args: ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    });
    await removeTree(this.paths.local);
    await mkdir(this.paths.local, { recursive: true });
    await writeManifest(this.paths.dir, await captureLocal(root, splitZ(listed.stdout), this.paths.local));
  }

  // ── create：建 workspace（fork 就是从某个 snapshot 建） ───────────────

  async create(from: SnapshotId, opts: WorkspaceCreateOpts = {}): Promise<WorkspaceRef> {
    checkSnapshotId(from);
    const ref = await this.storeLock.shared(async () => {
      const commit = await this.resolve(from);
      const meta = await this.commitMeta(commit);
      const id = this.ctx.newId();
      const path = this.paths.ws(id);
      const tmp = join(this.paths.tmp, `ws-${id}`);
      await this.ensureRunDirs();
      await mkdir(dirname(path), { recursive: true });
      await mkdir(tmp);
      try {
        await this.buildGitDir(tmp, from, meta);
        await this.checkoutTree(tmp, id, commit);
        await this.writeWsIndex(tmp, meta.head);
        const local = await readManifest(this.paths.dir);
        await placeLocal(this.paths.local, local.files, tmp);
        await writeWsState(this.paths, id, { base: from, from, createdAt: new Date().toISOString() });
        await rename(tmp, path);
      } catch (e) {
        await this.rmTree(tmp).catch(() => {});
        await rm(this.paths.index(id), { force: true }).catch(() => {});
        await rm(this.paths.wsState(id), { force: true }).catch(() => {});
        await this.refs([['delete', indexRef(id)]]).catch(() => {});
        throw diskFull(e, '建 workspace');
      }
      return this.refOf(id);
    });
    return this.withSetup(ref, opts.signal); // setup 可能跑很久，不占着 store 的锁
  }

  // ── snapshot ───────────────────────────────────────────────────────────

  async snapshot(ws: WorkspaceRef, label?: string): Promise<SnapshotId> {
    const wsId = this.wsId(ws);
    return this.snapshotWorkspace(wsId, async () => {
      const id = this.ctx.newId();
      try {
        const { tree, head, heads } = await this.capture(this.paths.ws(wsId), wsId, id);
        const meta: CommitMeta = { v: 1, kind: 'snapshot', id, head, heads, ...(label ? { label } : {}) };
        const commit = await this.commit(tree, head, meta);
        await this.refs([
          ['create', snapRef(id), commit],
          ['create', `${byWsPrefix(wsId)}${id}`, commit],
          ['delete', tmpRef(id)],
        ]);
        const state = await readWsState(this.paths, wsId);
        await writeMeta(this.paths, {
          id,
          ws: wsId,
          ...(state ? { base: state.base } : {}),
          ...(label ? { label } : {}),
          at: new Date().toISOString(),
        });
        if (state) await writeWsState(this.paths, wsId, { ...state, base: id });
        return id;
      } catch (e) {
        throw diskFull(e, '打 snapshot');
      }
    });
  }

  /**
   * 把 workspace 现在的样子收进 store：工作区的树（不含被忽略的），agent 的 HEAD 和各个分支。
   * 读 agent 的 .git 失败不算错：只记工作区，HEAD 记成 unknown。
   */
  private async capture(
    path: string,
    wsId: string,
    tag: string,
  ): Promise<{ tree: string; head: HeadInfo; heads: boolean }> {
    let head = await readHead(path);
    let heads = false;
    if (head.state !== 'unknown') {
      const gitDir = join(path, '.git');
      const specs = [`+refs/heads/*:${snapHeadsPrefix(tag)}*`];
      if (head.state === 'commit') specs.unshift(`+${head.sha}:${tmpRef(tag)}`);
      const fetched = await this.store({
        args: ['fetch', '-q', '--no-tags', '--no-write-fetch-head', gitDir, ...specs],
        okCodes: [0, 1, 128],
        timeoutMs: WS_READ_TIMEOUT_MS * 5,
      });
      heads = fetched.code === 0;
      if (!heads && head.state === 'commit') {
        const only = await this.store({
          args: ['fetch', '-q', '--no-tags', '--no-write-fetch-head', gitDir, `+${head.sha}:${tmpRef(tag)}`],
          okCodes: [0, 1, 128],
          timeoutMs: WS_READ_TIMEOUT_MS * 5,
        });
        if (only.code !== 0) head = { state: 'unknown' };
      }
    }
    const index = this.paths.index(wsId);
    if (!(await exists(index))) {
      // Melina 的 index 丢了：从 workspace 对齐的那个 snapshot 起一份（没有 stat，这一次要把文件都算一遍）
      await mkdir(dirname(index), { recursive: true });
      const state = await readWsState(this.paths, wsId);
      const base = state ? await this.resolve(state.base).catch(() => undefined) : undefined;
      if (base) await this.store({ indexFile: index, args: ['read-tree', `${base}^{tree}`] });
    }
    const tree = await this.addAll(path, index, head);
    await this.refs([['update', indexRef(wsId), tree]]); // Melina 的 index 引用的对象都挂在 ref 上，store 清理时不会被删
    return { tree, head, heads };
  }

  /**
   * git add -A 收工作区：没被忽略的文件都收，被删的去掉。HEAD 里有、却被 .gitignore 盖住的文件（agent 用 add -f 提交过的）也补上。
   */
  private async addAll(worktree: string, index: string, head: HeadInfo): Promise<string> {
    const base: GitOptions = { args: [], workTree: worktree, indexFile: index, cwd: worktree };
    await this.addWithFallback(base, ['add', '-A']);
    if (head.state === 'commit') {
      const gone = splitZ(
        (
          await this.store({
            ...base,
            args: ['diff-index', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=D', head.sha],
          })
        ).stdout,
      );
      const present: string[] = [];
      for (const rel of gone) {
        const st = await lstatOrNull(join(worktree, ...rel.split('/')));
        if (st && (st.isFile() || st.isSymbolicLink())) present.push(rel);
      }
      if (present.length > 0) {
        await this.addWithFallback({ ...base, literalPathspecs: true, input: present.map((p) => `${p}\0`).join('') }, [
          'add',
          '-f',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ]);
      }
    }
    return (await this.store({ ...base, args: ['write-tree'] })).stdout.trim();
  }

  /**
   * 收工作区不能因为 agent 弄出来的东西整个失败：先照常 add；.gitattributes 被写坏（比如 working-tree-encoding 乱写）
   * 就不读它再来；还不行（有读不了的文件：容器里别的用户写的、权限 000 的）就跳过这些文件，它们留在上一次的样子。
   */
  private async addWithFallback(base: GitOptions, args: string[]): Promise<void> {
    const internal = (e: unknown) => e instanceof MelinaError && e.code === 'internal';
    try {
      await this.store({ ...base, args });
      return;
    } catch (e) {
      if (!internal(e)) throw e;
    }
    try {
      await this.store({ ...base, attrSource: EMPTY_TREE, args });
      return;
    } catch (e) {
      if (!internal(e)) throw e;
    }
    await this.store({ ...base, attrSource: EMPTY_TREE, args: [...args, '--ignore-errors'], okCodes: [0, 1] });
  }

  // ── restore（崩溃恢复） ──────────────────────────────────────────

  /**
   * 原地改回 snapshot：工作区里没被忽略的文件和它一致（多的删、少的补、改了的改回），被忽略的文件不动；
   * HEAD、当前分支和 agent 的各个分支改回 snapshot 时的样子。调之前要先停掉这个 workspace 的容器。
   */
  async restore(ws: WorkspaceRef, to: SnapshotId): Promise<void> {
    checkSnapshotId(to);
    const wsId = this.wsId(ws);
    await this.wsLock.run(wsId, () =>
      this.storeLock.shared(async () => {
        const commit = await this.resolve(to);
        const meta = await this.commitMeta(commit);
        const path = this.paths.ws(wsId);
        try {
          const st = await lstatOrNull(path);
          if (st && !st.isDirectory()) await this.rmTree(path);
          await mkdir(path, { recursive: true });
          const old = await this.moveAsideGitDir(path);
          try {
            await this.buildGitDir(path, to, meta);
          } catch (e) {
            if (old) {
              await this.rmTree(join(path, '.git'));
              await rename(old, join(path, '.git'));
            }
            throw e;
          }
          try {
            await this.checkoutTree(path, wsId, commit);
            await this.writeWsIndex(path, meta.head);
          } finally {
            // 后面这两步失败了也要做：新 .git 已经建好，旧的留在 tmp/ 里只会占地方
            if (old) {
              await carryOver(old, join(path, '.git')).catch(() => {});
              await this.rmTree(old).catch(() => {});
            }
          }
          const state = await readWsState(this.paths, wsId);
          await writeWsState(this.paths, wsId, {
            base: to,
            from: state?.from ?? to,
            createdAt: state?.createdAt ?? new Date().toISOString(),
          });
        } catch (e) {
          throw diskFull(e, '恢复 workspace');
        }
      }),
    );
  }

  /** 把 agent 的 .git 挪到 tmp/（挪走的是目录项本身，是符号链接也只挪链接） */
  private async moveAsideGitDir(path: string): Promise<string | undefined> {
    const gitDir = join(path, '.git');
    if (!(await lstatOrNull(gitDir))) return undefined;
    await this.ensureRunDirs();
    const aside = this.tmpPath('old-git');
    await rename(gitDir, aside);
    return aside;
  }

  // ── diff、apply ────────────────────────────────────────────────────────

  async diff(ws: WorkspaceRef, base: SnapshotId): Promise<Handle> {
    checkSnapshotId(base);
    const wsId = this.wsId(ws);
    return this.wsLock.run(wsId, () =>
      this.storeLock.shared(async () => {
        const from = await this.resolve(base);
        const tag = `diff-${this.ctx.newId()}`;
        await this.ensureRunDirs();
        const out = this.tmpPath('diff');
        try {
          const { tree } = await this.capture(this.paths.ws(wsId), wsId, tag);
          await this.writePatch(`${from}^{tree}`, tree, out);
          return await this.ctx.artifacts.putFile(this.run.id, out);
        } catch (e) {
          throw diskFull(e, '生成 patch');
        } finally {
          await this.refs([['delete', tmpRef(tag)]]).catch(() => {});
          await this.deletePrefix(snapHeadsPrefix(tag)).catch(() => {});
          await rm(out, { force: true });
        }
      }),
    );
  }

  async diffSnapshots(base: SnapshotId, target: SnapshotId): Promise<Handle> {
    checkSnapshotId(base);
    checkSnapshotId(target);
    return this.storeLock.shared(async () => {
      const from = await this.resolve(base);
      const to = await this.resolve(target);
      await this.ensureRunDirs();
      const out = this.tmpPath('diff');
      try {
        await this.writePatch(`${from}^{tree}`, `${to}^{tree}`, out);
        return await this.ctx.artifacts.putFile(this.run.id, out);
      } finally {
        await rm(out, { force: true });
      }
    });
  }

  /** 把 patch 打到工作区（不动暂存区）。要么全部打上，要么一点不动，冲突的文件列在 conflicts 里 */
  async apply(ws: WorkspaceRef, patch: Handle): Promise<{ ok: boolean; conflicts?: string[] }> {
    const wsId = this.wsId(ws);
    return this.wsLock.run(wsId, async () => {
      await this.ensureRunDirs();
      const file = this.tmpPath('apply');
      await writeFile(file, await this.ctx.artifacts.read(this.run.id, patch));
      try {
        return await applyPatch(this.paths.store, this.paths.ws(wsId), file);
      } finally {
        await rm(file, { force: true });
      }
    });
  }

  // ── prune ─────────────────────────────────────────────────────────────

  /** 删掉这个 workspace 打的、不在 keep 里的 snapshot 的内容（ref 删掉，对象等清理时回收）；lineage 记录照留 */
  async prune(ws: WorkspaceRef, keep: SnapshotId[]): Promise<void> {
    const wsId = this.wsId(ws);
    const keepSet = new Set(keep.map(checkSnapshotId));
    // 拿这个 workspace 的锁：不能和它正在打的 snapshot 同时跑，否则刚打好、还不在 keep 里的会被删掉；
    // store 独占：正在从这些 snapshot 建 workspace 的做完了才删
    const dropped = await this.wsLock.run(wsId, () =>
      this.storeLock.exclusive(async () => {
        const ids = (await this.listRefs(byWsPrefix(wsId))).map((r) => r.slice(byWsPrefix(wsId).length));
        const drop = ids.filter((id) => !keepSet.has(id));
        for (const id of drop) {
          await this.refs([
            ['delete', snapRef(id)],
            ['delete', `${byWsPrefix(wsId)}${id}`],
          ]);
          await this.deletePrefix(`refs/melina/snaprefs/${id}/`);
          const meta = await readMeta(this.paths, id);
          if (meta && !meta.pruned) await writeMeta(this.paths, { ...meta, pruned: new Date().toISOString() });
        }
        return drop.length;
      }),
    );
    if (dropped > 0) await this.maybeMaintain();
  }

  /** 松散对象多了就清理：先删 tmp 下的残留 ref，再 prune、repack（独占，不能和正在打的 snapshot 同时跑） */
  private async maybeMaintain(): Promise<void> {
    const stats = await this.store({ args: ['count-objects', '-v'] });
    const num = (k: string) => Number(new RegExp(`^${k}: (\\d+)$`, 'm').exec(stats.stdout)?.[1] ?? 0);
    if (num('count') < MAINTAIN_LOOSE_COUNT && num('size') < MAINTAIN_LOOSE_KIB) return;
    await this.storeLock.exclusive(async () => {
      await this.deletePrefix('refs/melina/tmp/');
      for (const ref of await this.listRefs('refs/melina/snaprefs/')) {
        const id = ref.split('/')[3] ?? '';
        if (!(await this.hasCommit(snapRef(id)))) await this.refs([['delete', ref]]);
      }
      await this.store({ args: ['prune', '--expire=now'] });
      await this.store({ args: ['repack', '-a', '-d', '-q'] });
    });
  }

  // ── deliver ────────────────────────────────────────────────

  /**
   * 交付：patch 是这个 snapshot 相对根 snapshot 的改动；分支是用户仓库里新建的 melina/<runId>（只是 fetch 进去一个 ref，
   * 不动用户当前的分支、暂存区和工作区）。agent 把改动都提交了，分支就指向它的 HEAD；否则在 HEAD 上补一个提交。
   * 推不进去（用户仓库没了、不是仓库了），或者用户仓库用了 filter（git-crypt、LFS），就只交 patch，不带 branch。
   */
  async deliver(_ws: WorkspaceRef, snapshot: SnapshotId): Promise<{ branch?: string; patch: Handle }> {
    checkSnapshotId(snapshot);
    return this.storeLock.shared(async () => {
      const commit = await this.resolve(snapshot);
      const meta = await this.commitMeta(commit);
      const root = await this.resolve(ROOT);
      const tree = await this.storeOut(['rev-parse', `${commit}^{tree}`]);
      await this.ensureRunDirs();
      const out = this.tmpPath('deliver');
      let patch: Handle;
      try {
        await this.writePatch(`${root}^{tree}`, tree, out);
        patch = await this.ctx.artifacts.putFile(this.run.id, out);
      } finally {
        await rm(out, { force: true });
      }
      let tip: string;
      if (meta.head.state === 'commit' && (await this.storeOut(['rev-parse', `${meta.head.sha}^{tree}`])) === tree) {
        tip = meta.head.sha;
      } else {
        const parents = meta.head.state === 'commit' ? ['-p', meta.head.sha] : [];
        tip = await this.storeOut(['commit-tree', tree, ...parents], deliverMessage(this.run));
      }
      await this.refs([['update', deliverRef(snapshot), tip]]);
      // 用户仓库用了 filter（git-crypt、LFS 这类）：Melina 的提交里是 workspace 里的原样内容，推过去会把该加密的明文、
      // 该走 LFS 的大文件直接写进用户仓库。这时不推分支，只交 patch（RunManager 在结束原因里写一句为什么）
      // 查不了（git 出错）按用了算：宁可只交 patch，不冒把明文推进去的险
      const filtered = await this.usesFilters([root, commit]).catch(() => true);
      const branch = filtered ? undefined : await this.fetchIntoUser(snapshot);
      return branch ? { branch, patch } : { patch };
    });
  }

  /**
   * 这些提交里的 .gitattributes（哪一层都算），或者用户仓库自己的 info/attributes，有没有给文件配 filter（filter=…）。
   * 只看属性不看配置：装过 LFS 的机器全局配置里都有 filter.lfs，没有属性用到它就不生效
   */
  private async usesFilters(commits: readonly string[]): Promise<boolean> {
    for (const c of new Set(commits)) {
      const r = await this.store({
        args: ['grep', '-q', '-I', '-E', FILTER_ATTR_GREP, c, '--', '.gitattributes', '*/.gitattributes'],
        okCodes: [0, 1],
      });
      if (r.code === 0) return true;
    }
    const root = this.run.workspace.root;
    const path = await git({
      cwd: root,
      trust: 'user',
      args: ['rev-parse', '--git-path', 'info/attributes'],
      okCodes: [0, 128],
    }).catch(() => undefined);
    if (path?.code !== 0) return false;
    const text = await readFile(resolve(root, path.stdout.trim()), 'utf8').catch(() => '');
    return FILTER_ATTR.test(text);
  }

  private async fetchIntoUser(snapshot: SnapshotId): Promise<string | undefined> {
    const root = this.run.workspace.root;
    if (!(await isRepoTop(root))) return undefined;
    // 用户仓库里已经有叫 melina 的分支时，melina/<runId> 会和它冲突（git 的 ref 不能既是文件又是目录）
    const plain = await git({
      cwd: root,
      trust: 'user',
      args: ['show-ref', '--verify', '-q', 'refs/heads/melina'],
      okCodes: [0, 1],
    });
    const name = plain.code === 0 ? `melina-${this.run.id}` : `melina/${this.run.id}`;
    const r = await git({
      cwd: root,
      trust: 'user',
      args: [
        'fetch',
        '-q',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-auto-maintenance',
        '--no-recurse-submodules',
        '--no-prune',
        this.paths.store,
        `+${deliverRef(snapshot)}:refs/heads/${name}`,
      ],
      okCodes: [0, 1, 128],
    });
    return r.code === 0 ? name : undefined;
  }

  // ── dispose ───────────────────────────────────────────────────────────

  /** 删掉 workspace 目录和 Melina 给它记的 index；它打过的 snapshot 不删（还要靠 prune 或删 Run） */
  async dispose(ws: WorkspaceRef): Promise<void> {
    const wsId = this.wsId(ws);
    await this.wsLock.run(wsId, async () => {
      await this.rmTree(this.paths.ws(wsId));
      await rm(this.paths.index(wsId), { force: true });
      await rm(this.paths.wsState(wsId), { force: true });
      if (await isRealDir(this.paths.store)) {
        await this.storeLock.shared(() => this.refs([['delete', indexRef(wsId)]]));
      }
    });
  }

  // ── 建 .git、写工作区和 index ─────────────────────────────────────────

  /**
   * 新建 workspace 的 .git：clone store（对象硬链接），改成非裸仓库，配上用户仓库的远端（去掉 URL 里的密码）和 upstream；
   * agent 的分支按 snapshot 记下的放回去，HEAD 指到 snapshot 时的位置。这个 .git 是 Melina 刚建的，往里写是安全的。
   */
  private async buildGitDir(path: string, from: SnapshotId, meta: CommitMeta): Promise<void> {
    const gitDir = join(path, '.git');
    await git({ args: ['clone', '--bare', '-q', this.paths.store, gitDir] });
    const ws = (o: Omit<GitOptions, 'gitDir'>) => git({ ...o, gitDir });
    await ws({ args: ['config', 'core.bare', 'false'] });
    await ws({ args: ['config', 'core.logAllRefUpdates', 'true'] });
    await ws({ args: ['config', '--remove-section', 'remote.origin'], okCodes: [0, 128] });
    await copyFile(join(this.paths.store, 'info', 'exclude'), join(gitDir, 'info', 'exclude')).catch(() => {});
    const info = (await readJson<RemotesInfo>(join(this.paths.dir, 'remotes.json'))) ?? { remotes: [], branches: [] };
    for (const r of info.remotes) {
      await ws({ args: ['config', `remote.${r.name}.url`, r.url] });
      for (const spec of r.fetch) await ws({ args: ['config', '--add', `remote.${r.name}.fetch`, spec] });
    }
    if (info.remotes.length > 0) {
      await ws({
        args: ['fetch', '-q', '--no-tags', '--no-write-fetch-head', this.paths.store, '+refs/remotes/*:refs/remotes/*'],
      });
    }
    for (const b of info.branches) {
      if (b.remote) await ws({ args: ['config', `branch.${b.name}.remote`, b.remote] });
      if (b.merge) await ws({ args: ['config', `branch.${b.name}.merge`, b.merge] });
    }
    if (meta.heads) {
      // agent 当时的分支整套换上（没有的删掉）
      await ws({
        args: [
          'fetch',
          '-q',
          '--no-tags',
          '--no-write-fetch-head',
          '--update-head-ok',
          '--prune',
          this.paths.store,
          `+${snapHeadsPrefix(from)}*:refs/heads/*`,
        ],
      });
    }
    await setHead(gitDir, meta.head);
  }

  /** 用 Melina 的 index 把工作区改成 snapshot 的树：多的删、少的补，被忽略的不动 */
  private async checkoutTree(path: string, wsId: string, commit: string): Promise<void> {
    const index = this.paths.index(wsId);
    await mkdir(dirname(index), { recursive: true });
    const base: GitOptions = { args: [], workTree: path, indexFile: index, cwd: path };
    await this.withAttrFallback((attrSource) =>
      this.store({ ...base, attrSource, args: ['read-tree', '-u', '--reset', `${commit}^{tree}`] }),
    );
    await this.store({ ...base, args: ['clean', '-ffdq'] });
    await this.refs([['update', indexRef(wsId), await this.storeOut(['rev-parse', `${commit}^{tree}`])]]);
  }

  /**
   * agent 的暂存区 = HEAD 的树（snapshot 不记暂存区，改动都显示成没暂存），顺手刷新 stat，
   * 免得容器里第一次 git status 把所有文件重算一遍。用 store 的配置写，不读 agent 的。
   */
  private async writeWsIndex(path: string, head: HeadInfo): Promise<void> {
    const index = join(path, '.git', 'index');
    await rm(index, { force: true });
    const base: GitOptions = { args: [], workTree: path, indexFile: index, cwd: path };
    let tree: string | undefined;
    if (head.state === 'commit') tree = head.sha;
    else if (head.state === 'unknown') {
      const h = await git({
        gitDir: join(path, '.git'),
        args: ['rev-parse', '-q', '--verify', 'HEAD^{commit}'],
        okCodes: [0, 1],
      });
      if (h.code === 0 && (await this.hasCommit(h.stdout.trim()))) tree = h.stdout.trim();
    }
    await this.store({ ...base, args: tree ? ['read-tree', tree] : ['read-tree', '--empty'] });
    await this.store({ ...base, args: ['update-index', '-q', '--refresh'], okCodes: [0, 1, 128] });
  }

  // ── store 上的小工具 ──────────────────────────────────────────────────

  private store(o: Omit<GitOptions, 'gitDir'>) {
    return git({ ...o, gitDir: this.paths.store });
  }

  private async storeOut(args: string[], input?: string): Promise<string> {
    return gitOut({ gitDir: this.paths.store, args, ...(input !== undefined ? { input } : {}) });
  }

  private async hasCommit(rev: string): Promise<boolean> {
    if (!(await isRealDir(this.paths.store))) return false;
    const r = await this.store({ args: ['rev-parse', '-q', '--verify', `${rev}^{commit}`], okCodes: [0, 1, 128] });
    return r.code === 0;
  }

  /** snapshot id → store 里的提交；内容清理过的报「已经清理了」 */
  private async resolve(id: SnapshotId): Promise<string> {
    const r = await git({
      gitDir: this.paths.store,
      args: ['rev-parse', '-q', '--verify', `${snapRef(id)}^{commit}`],
      okCodes: [0, 1, 128],
    });
    if (r.code === 0) return r.stdout.trim();
    if (id === ROOT) throw new MelinaError('not_found', '这个 Run 的 workspace 还没打根 snapshot（init 没跑）');
    const meta = await readMeta(this.paths, id);
    if (meta?.pruned) throw new MelinaError('not_found', `snapshot ${id} 的内容已经清理了：只留各分支的 lastSnapshot`);
    throw new MelinaError('not_found', `没有这个 snapshot：${id}`);
  }

  private async commitMeta(commit: string): Promise<CommitMeta> {
    const raw = await this.storeOut(['cat-file', 'commit', commit]);
    const body = raw.slice(raw.indexOf('\n\n') + 2);
    const json = body.slice(body.indexOf('\n') + 1).trim();
    try {
      const m = JSON.parse(json) as CommitMeta;
      if (m && m.v === 1 && m.head) return m;
    } catch {}
    return { v: 1, kind: 'snapshot', id: 'unknown', head: { state: 'unknown' }, heads: false };
  }

  private async commit(tree: string, head: HeadInfo, meta: CommitMeta): Promise<string> {
    const parents = head.state === 'commit' ? ['-p', head.sha] : [];
    const message = `melina snapshot ${meta.id}\n\n${JSON.stringify(meta)}\n`;
    return this.storeOut(['commit-tree', tree, ...parents], message);
  }

  /** 一个事务里改几个 ref：update（有就改）、create（不能已存在）、delete（没有也不报错） */
  private async refs(ops: (['update' | 'create', string, string] | ['delete', string])[]): Promise<void> {
    const lines: string[] = [];
    for (const op of ops) {
      if (op[0] === 'delete') {
        if (await this.refExists(op[1])) lines.push(`delete ${op[1]}`);
      } else if (op[0] === 'create') lines.push(`create ${op[1]} ${op[2]}`);
      else lines.push(`update ${op[1]} ${op[2]}`);
    }
    if (lines.length === 0) return;
    await this.store({ args: ['update-ref', '--stdin'], input: `${lines.join('\n')}\n` });
  }

  private async refExists(ref: string): Promise<boolean> {
    const r = await this.store({ args: ['show-ref', '--verify', '-q', ref], okCodes: [0, 1, 128] });
    return r.code === 0;
  }

  private async listRefs(prefix: string): Promise<string[]> {
    const out = await this.storeOut(['for-each-ref', '--format=%(refname)', prefix]);
    return out ? out.split('\n') : [];
  }

  private async deletePrefix(prefix: string): Promise<void> {
    const refs = await this.listRefs(prefix);
    if (refs.length === 0) return;
    await this.store({ args: ['update-ref', '--stdin'], input: `${refs.map((r) => `delete ${r}`).join('\n')}\n` });
  }

  private async writePatch(fromTree: string, toTree: string, out: string): Promise<void> {
    await this.store({
      args: [
        'diff-tree',
        '-p',
        '--binary',
        '--full-index',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        fromTree,
        toTree,
      ],
      stdoutFile: out,
    });
  }

  /** 先照常做；git 因为工作区里的 .gitattributes 出错（比如 working-tree-encoding 写坏了），就不读它再做一次 */
  private async withAttrFallback<T>(fn: (attrSource?: string) => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof MelinaError) || e.code !== 'internal') throw e;
      return fn(EMPTY_TREE);
    }
  }
}

// ── 读 agent 的 .git（只读， 的「不动 agent 的 HEAD 和暂存区」） ──────

/** agent 的 HEAD：只用不执行东西的底层命令读，读不出来就是 unknown */
export async function readHead(path: string): Promise<HeadInfo> {
  const gitDir = join(path, '.git');
  if (!(await isRealDir(gitDir))) return { state: 'unknown' };
  const read = (args: string[]) =>
    git({ gitDir, args, okCodes: [0, 1, 128], timeoutMs: WS_READ_TIMEOUT_MS }).catch(() => null);
  const sym = await read(['symbolic-ref', '-q', 'HEAD']);
  if (!sym || sym.code === 128) return { state: 'unknown' };
  let branch: string | undefined;
  if (sym.code === 0) {
    branch = sym.stdout.trim();
    if (!(await validBranch(branch))) return { state: 'unknown' };
  }
  const rev = await read(['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (!rev) return { state: 'unknown' };
  if (rev.code === 0) return { state: 'commit', sha: rev.stdout.trim(), ...(branch ? { branch } : {}) };
  if (rev.code === 1 && branch) {
    const ref = await read(['rev-parse', '-q', '--verify', branch]);
    if (ref && ref.code === 1) return { state: 'unborn', branch }; // 分支 ref 不存在：真没提交过
  }
  return { state: 'unknown' };
}

async function validBranch(ref: string): Promise<boolean> {
  if (!ref.startsWith('refs/heads/') || ref.length > 400) return false;
  const r = await git({ args: ['check-ref-format', ref], okCodes: [0, 1, 128] });
  return r.code === 0;
}

/** 在 Melina 刚建的 .git 里把 HEAD 指到 snapshot 时的位置；分支名和已有的 ref 冲突就退成 detached */
async function setHead(gitDir: string, head: HeadInfo): Promise<void> {
  const ws = (args: string[], okCodes?: number[]) => git({ gitDir, args, ...(okCodes ? { okCodes } : {}) });
  if (head.state === 'commit') {
    if (head.branch) {
      const set = await ws(['update-ref', head.branch, head.sha], [0, 1, 128]);
      if (set.code === 0) {
        await ws(['symbolic-ref', 'HEAD', head.branch]);
        return;
      }
    }
    await ws(['update-ref', '--no-deref', 'HEAD', head.sha]);
  } else if (head.state === 'unborn') {
    await ws(['update-ref', '-d', head.branch], [0, 1, 128]);
    await ws(['symbolic-ref', 'HEAD', head.branch]);
  }
  // unknown：留着 clone 出来的 HEAD
}

/** 恢复时把 agent 自己的设置抄回新的 .git：config（检查过能读）、info/exclude、hooks/ 下的普通文件 */
async function carryOver(oldGitDir: string, newGitDir: string): Promise<void> {
  if (!(await isRealDir(oldGitDir))) return;
  const config = join(oldGitDir, 'config');
  const st = await lstatOrNull(config);
  if (st?.isFile()) {
    const ok = await git({ args: ['config', '--file', config, '--list'], okCodes: [0, 1, 128] });
    if (ok.code === 0) await copyFile(config, join(newGitDir, 'config'));
  }
  const exclude = join(oldGitDir, 'info', 'exclude');
  if ((await lstatOrNull(exclude))?.isFile() && (await isRealDir(join(oldGitDir, 'info')))) {
    await copyFile(exclude, join(newGitDir, 'info', 'exclude'));
  }
  const hooks = join(oldGitDir, 'hooks');
  if (await isRealDir(hooks)) {
    await mkdir(join(newGitDir, 'hooks'), { recursive: true });
    for (const name of await readdir(hooks)) {
      const s = await lstatOrNull(join(hooks, name));
      if (!s?.isFile()) continue;
      const dst = join(newGitDir, 'hooks', name);
      await rm(dst, { force: true });
      await copyFile(join(hooks, name), dst);
      await chmod(dst, Number(s.mode & 0o777n));
    }
  }
}

// ── 读用户自己的仓库（trust: 'user'） ──────────────────────────────────────

/** root 是不是一个 git 仓库的顶层（工作区，不是裸仓库）。子目录不算：provider 自动选时当普通目录 */
export async function isRepoTop(root: string): Promise<boolean> {
  const real = await realpath(root).catch(() => undefined);
  if (!real || !(await isRealDir(real))) return false;
  const r = await git({
    cwd: real,
    trust: 'user',
    args: ['rev-parse', '--is-bare-repository', '--show-toplevel'],
    okCodes: [0, 128],
  }).catch(() => null);
  if (r?.code !== 0) return false;
  const [bare, top] = r.stdout.trim().split('\n');
  if (bare !== 'false' || !top) return false;
  return (await realpath(top).catch(() => top)) === real;
}

async function userHead(root: string): Promise<HeadInfo> {
  const read = (args: string[]) => git({ cwd: root, trust: 'user', args, okCodes: [0, 1, 128] });
  const sym = await read(['symbolic-ref', '-q', 'HEAD']);
  const branch = sym.code === 0 ? sym.stdout.trim() : undefined;
  const rev = await read(['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (rev.code === 0) return { state: 'commit', sha: rev.stdout.trim(), ...(branch ? { branch } : {}) };
  if (branch) return { state: 'unborn', branch };
  return { state: 'unknown' };
}

/** 用户仓库的 info/exclude 加上全局的 excludesFile：Melina 不读全局配置，忽略规则要自己带上 */
async function userExcludes(root: string): Promise<string> {
  const parts = ['# Melina：用户仓库的 info/exclude 和全局 core.excludesFile\n'];
  const local = await git({
    cwd: root,
    trust: 'user',
    args: ['rev-parse', '--git-path', 'info/exclude'],
    okCodes: [0, 128],
  });
  if (local.code === 0) parts.push(await readFile(resolve(root, local.stdout.trim()), 'utf8').catch(() => ''));
  const global = await git({
    cwd: root,
    trust: 'user',
    args: ['config', '--get', 'core.excludesFile'],
    okCodes: [0, 1],
  });
  let file =
    global.code === 0
      ? global.stdout.trim()
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'ignore');
  if (file.startsWith('~/')) file = join(homedir(), file.slice(2));
  if (isAbsolute(file)) parts.push(await readFile(file, 'utf8').catch(() => ''));
  return `${parts.join('\n')}\n`;
}

/** 用户仓库的远端和分支的 upstream，给 workspace 用：URL 里的用户名、密码去掉（http 的 token 常放在这里） */
async function readUserRemotes(root: string): Promise<RemotesInfo> {
  const r = await git({
    cwd: root,
    trust: 'user',
    args: ['config', '--local', '-z', '--get-regexp', '^(remote|branch)\\.'],
    okCodes: [0, 1],
  });
  const remotes = new Map<string, { name: string; url: string; fetch: string[] }>();
  const branches = new Map<string, { name: string; remote?: string; merge?: string }>();
  for (const item of splitZ(r.stdout)) {
    const nl = item.indexOf('\n');
    const key = nl < 0 ? item : item.slice(0, nl);
    const value = nl < 0 ? '' : item.slice(nl + 1);
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    if (first < 0 || last <= first) continue;
    const section = key.slice(0, first).toLowerCase();
    const name = key.slice(first + 1, last);
    const field = key.slice(last + 1).toLowerCase();
    if (section === 'remote') {
      const rem = remotes.get(name) ?? { name, url: '', fetch: [] };
      if (field === 'url') rem.url = sanitizeUrl(value);
      if (field === 'fetch') rem.fetch.push(value);
      remotes.set(name, rem);
    } else if (section === 'branch') {
      const b = branches.get(name) ?? { name };
      if (field === 'remote') b.remote = value;
      if (field === 'merge') b.merge = value;
      branches.set(name, b);
    }
  }
  return { remotes: [...remotes.values()].filter((x) => x.url), branches: [...branches.values()] };
}

/** http(s) 的 URL 去掉 userinfo（到 host 前最后一个 @ 为止，密码里可以有 @）；scp 式和 ssh 的用户名不是密钥，留着 */
export function sanitizeUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/?#]*@/i, '$1');
}

/** 让 git repack 别动这些 pack */
async function keepPacks(gitDir: string): Promise<void> {
  const dir = join(gitDir, 'objects', 'pack');
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith('.pack')) await writeFile(join(dir, `${name.slice(0, -'.pack'.length)}.keep`), 'melina\n');
  }
}

/** .gitattributes 里给文件配 filter 的写法（`*.bin filter=lfs`、`secret/** filter=git-crypt`） */
const FILTER_ATTR = /(^|\s)filter=\S/m;
const FILTER_ATTR_GREP = '(^|[[:space:]])filter=[^[:space:]]';

/** 交付的提交说明：目标的第一行 */
function deliverMessage(run: Run): string {
  const first = run.goal.statement.split('\n')[0]?.trim() ?? '';
  const subject = first.length > 60 ? `${first.slice(0, 60)}…` : first;
  return `Melina：${subject}\n\n任务 ${run.id} 的交付，由 Melina 自动生成，没有人工核对。\n`;
}
