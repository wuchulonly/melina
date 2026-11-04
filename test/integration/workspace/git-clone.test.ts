// GitCloneProvider 的集成测试：真 git，临时目录。

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MelinaError } from '../../../src/core/errors.ts';
import { ROOT } from '../../../src/core/ids.ts';
import type { WorkspaceProvider, WorkspaceProviders } from '../../../src/core/interfaces/workspace.ts';
import type { Run, WorkspaceRef } from '../../../src/core/types.ts';
import type { CreatedWorkspace, WorkspaceExec } from '../../../src/workspace/base.ts';
import type { GitCloneProvider } from '../../../src/workspace/git-clone.ts';
import * as localFiles from '../../../src/workspace/local-files.ts';
import * as meta from '../../../src/workspace/meta.ts';
import { createWorkspaceProviders } from '../../../src/workspace/provider.ts';
import { SETUP_CANCELLED } from '../../../src/workspace/setup.ts';
import { hostExecutor, makeRun, memoryArtifacts, newId, sandbox, sh, treeOf } from './helpers.ts';

let box: ReturnType<typeof sandbox>;
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };

beforeEach(() => {
  box = sandbox('git');
  process.env.HOME = box.home; // Melina 读用户仓库时会读全局配置：换成空的临时 HOME
  process.env.XDG_CONFIG_HOME = join(box.home, '.config');
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = saved.HOME;
  if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.XDG;
  box.cleanup();
});

/** 用户的仓库：两个分支、一个 tag、一个带 token 的远端；有没提交的改动、暂存的改动、删掉的文件、新文件和各种被忽略的东西 */
function userRepo(): string {
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  sh(
    repo,
    `git init -q -b main
printf 'node_modules/\\n.env\\n*.log\\ndist/\\n' > .gitignore
echo '# demo' > README.md
mkdir src && echo 'console.log(1)' > src/app.js
echo old > old.txt
mkdir dist && echo keep > dist/keep.txt
git add .gitignore README.md src old.txt && git add -f dist/keep.txt
git commit -qm init
git tag v1
git checkout -qb feature && echo f > f.txt && git add f.txt && git commit -qm feat && git checkout -q main
git remote add origin https://bot:s3cret@example.com/team/demo.git
git update-ref refs/remotes/origin/main HEAD
git config branch.main.remote origin
git config branch.main.merge refs/heads/main
echo more >> README.md
echo 'console.log(2)' > src/app.js && git add src/app.js
rm old.txt
echo notes > notes.md
echo SECRET=1 > .env
mkdir -p node_modules/x && echo dep > node_modules/x/index.js
echo log > debug.log
head -c 1100000 /dev/zero > big.log`,
  );
  return repo;
}

function git(dir: string | WorkspaceRef, args: string): string {
  return sh(typeof dir === 'string' ? dir : dir.path, `git ${args}`);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 用户仓库的全部状态：HEAD、分支和 tag、暂存区（index 文件逐字节）、配置、stash、工作区的文件 */
function repoState(repo: string) {
  return {
    index: sha256(join(repo, '.git', 'index')),
    head: git(repo, 'rev-parse HEAD'),
    branch: git(repo, 'symbolic-ref -q HEAD'),
    refs: git(repo, 'for-each-ref --format="%(refname) %(objectname)"'),
    config: readFileSync(join(repo, '.git', 'config'), 'utf8'),
    stash: git(repo, 'stash list'),
    status: git(repo, '--no-optional-locks status --porcelain=v2 --branch --untracked-files=all'),
    files: treeOf(repo),
  };
}

/** 目录下所有的普通文件（不跟符号链接） */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(path));
    else if (e.isFile()) out.push(path);
  }
  return out;
}

function status(ws: WorkspaceRef): string[] {
  return git(ws, '--no-optional-locks status --porcelain').split('\n').filter(Boolean).sort();
}

function providersWith(exec?: WorkspaceExec) {
  const artifacts = memoryArtifacts();
  const providers = createWorkspaceProviders({ dataDir: box.data, artifacts, ...(exec ? { exec } : {}) });
  return { providers, artifacts };
}

async function start(
  providers: WorkspaceProviders,
  repo: string,
  extra: Partial<Parameters<typeof makeRun>[0]> = {},
): Promise<{ run: Run; p: WorkspaceProvider }> {
  const kind = await providers.detect(repo);
  const run = makeRun({ root: repo, kind, ...extra });
  const p = providers.forRun(run);
  await p.init(run);
  return { run, p };
}

describe('GitCloneProvider', () => {
  it.each([false, true])('完整检出与状态写入前不发布 workspace，失败清理临时目录（失败：%s）', async (fail) => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { run, p } = await start(providers, repo);
    const wsDir = join(box.data, run.id, 'ws');
    const tmpDir = join(box.data, run.id, 'tmp');
    const placeLocal = localFiles.placeLocal;
    vi.spyOn(localFiles, 'placeLocal').mockImplementationOnce(async (...args) => {
      expect(readdirSync(wsDir)).toEqual([]);
      expect(readFileSync(join(args[2], 'README.md'), 'utf8')).toContain('# demo');
      const count = await placeLocal(...args);
      if (fail) throw new Error('placeLocal failed');
      return count;
    });
    const writeWsState = meta.writeWsState;
    const state = vi.spyOn(meta, 'writeWsState').mockImplementationOnce(async (...args) => {
      expect(readdirSync(wsDir)).toEqual([]);
      await writeWsState(...args);
    });
    if (fail) {
      await expect(p.create(ROOT)).rejects.toThrow('placeLocal failed');
      expect(readdirSync(wsDir)).toEqual([]);
      expect(state).not.toHaveBeenCalled();
      expect(git(join(box.data, run.id, 'store.git'), 'for-each-ref refs/melina/ws')).toBe('');
    } else {
      const ws = await p.create(ROOT);
      expect(state).toHaveBeenCalledOnce();
      expect(readFileSync(join(ws.path, '.env'), 'utf8')).toBe('SECRET=1\n');
      expect(git(ws, 'rev-parse --is-inside-work-tree')).toBe('true');
    }
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('init 不动用户仓库；从根 snapshot 建的 workspace 和用户目录一样，分支、tag、远端都在', async () => {
    const repo = userRepo();
    const before = repoState(repo);
    const { providers } = providersWith();
    const { run, p } = await start(providers, repo);
    expect(run.workspace.kind).toBe('git-clone');
    expect(repoState(repo)).toEqual(before);

    const ws = await p.create(ROOT);
    const t = treeOf(ws.path);
    expect(t['README.md']).toBe('# demo\nmore\n'); // 没提交的改动
    expect(t['src/app.js']).toBe('console.log(2)\n'); // 暂存过的改动
    expect(t['old.txt']).toBeUndefined(); // 删掉的
    expect(t['notes.md']).toBe('notes\n'); // 没跟踪的新文件
    expect(t['dist/keep.txt']).toBe('keep\n'); // 被忽略、但用 add -f 提交过的
    expect(t['.env']).toBe('SECRET=1\n'); // 被忽略的小文件照样放进来
    expect(t['debug.log']).toBe('log\n');
    expect(t['big.log']).toBeUndefined(); // 太大的被忽略文件不抄
    expect(t.node_modules).toBeUndefined(); // 被忽略的目录交给 workspace.setup

    expect(git(ws, 'rev-parse HEAD')).toBe(before.head);
    expect(git(ws, 'symbolic-ref --short HEAD')).toBe('main');
    expect(status(ws)).toEqual([' D old.txt', ' M README.md', ' M src/app.js', '?? notes.md']);
    expect(git(ws, 'remote get-url origin')).toBe('https://example.com/team/demo.git'); // token 去掉了
    expect(git(ws, 'rev-parse origin/main')).toBe(before.head);
    expect(git(ws, 'config branch.main.merge')).toBe('refs/heads/main');
    expect(git(ws, 'tag')).toBe('v1');
    expect(git(ws, 'branch --format="%(refname:short)"').split('\n').sort()).toEqual(['feature', 'main']);
    expect(repoState(repo)).toEqual(before);
  });

  it('Melina 的 store 不和用户仓库共用 inode：容器里 chmod -R、原地改写 .git 里的文件改不到用户仓库', async () => {
    const repo = userRepo();
    sh(repo, 'git repack -adq'); // 对象打成 pack：硬链接最容易出事的就是它
    const userInodes = new Set(filesUnder(join(repo, '.git', 'objects')).map((f) => statSync(f).ino));
    expect(userInodes.size).toBeGreaterThan(0);
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    const melinaInodes = filesUnder(box.data).map((f) => statSync(f).ino);
    expect(melinaInodes.filter((i) => userInodes.has(i))).toEqual([]);
    const before = repoState(repo);
    // agent 在 workspace 里能做的最坏的那类：放开权限、原地改写 pack 文件
    sh(
      ws.path,
      'chmod -R u+w .git && for f in .git/objects/pack/*.pack; do printf X | dd of="$f" bs=1 seek=20 conv=notrunc 2>/dev/null; done',
    );
    expect(repoState(repo)).toEqual(before);
    sh(repo, 'git fsck --no-progress --no-dangling');
  });

  it('snapshot 不动 agent 的 HEAD、当前分支和暂存区', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    sh(
      ws.path,
      'git checkout -qb work && git commit -qam wip && echo staged > staged.txt && git add staged.txt && echo unstaged >> README.md',
    );
    const head = git(ws, 'rev-parse HEAD');
    const index = sha256(join(ws.path, '.git', 'index'));
    const cached = git(ws, 'diff --cached --name-only');

    const s1 = await p.snapshot(ws, 'ep1');
    expect(s1).toMatch(/^[0-9A-Z]{26}$/);
    expect(git(ws, 'rev-parse HEAD')).toBe(head);
    expect(git(ws, 'symbolic-ref --short HEAD')).toBe('work');
    expect(sha256(join(ws.path, '.git', 'index'))).toBe(index);
    expect(git(ws, 'diff --cached --name-only')).toBe(cached);
  });

  it('restore 改回 snapshot：工作区、HEAD、当前分支和别的分支都回去，被忽略的文件不动', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    sh(
      ws.path,
      'git checkout -qb work && git commit -qam wip && git branch backup && echo staged > staged.txt && git add staged.txt && echo unstaged >> README.md',
    );
    const head = git(ws, 'rev-parse HEAD');
    const s1 = await p.snapshot(ws);
    const atSnapshot = treeOf(ws.path);

    // 在途的 episode 乱改一通，然后进程崩了
    sh(
      ws.path,
      `git add -A && git commit -qm more && git checkout -q main && git branch -D backup
rm README.md && echo junk > junk.txt && mkdir newdir && echo n > newdir/n.txt
echo CHANGED > .env && mkdir -p node_modules/y && echo y > node_modules/y/i.js`,
    );
    await p.restore(ws, s1);

    const after = treeOf(ws.path);
    expect(after['.env']).toBe('CHANGED\n'); // 被忽略的文件不动
    expect(after['node_modules/y/i.js']).toBe('y\n');
    for (const k of ['.env', 'node_modules', 'node_modules/y', 'node_modules/y/i.js']) delete after[k];
    const expected = { ...atSnapshot };
    delete expected['.env'];
    expect(after).toEqual(expected);
    expect(git(ws, 'symbolic-ref --short HEAD')).toBe('work');
    expect(git(ws, 'rev-parse HEAD')).toBe(head);
    expect(git(ws, 'rev-parse backup')).toBe(head);
    // 暂存区不记：snapshot 时暂存的 staged.txt 恢复后显示成没跟踪；notes.md 本来就没提交
    expect(status(ws)).toEqual([' M README.md', '?? notes.md', '?? staged.txt']);
  });

  it('agent 埋在 .git 和 .gitattributes 里的 filter、hook、fsmonitor 都不会在宿主机上执行', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    const marker = join(box.dir, 'pwned');
    const hook = join(box.dir, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\necho ran >> ${marker}\ncat\n`, { mode: 0o755 });
    sh(
      ws.path,
      `git config filter.evil.clean ${hook}
git config filter.evil.smudge ${hook}
git config filter.evil.required true
git config core.fsmonitor ${hook}
git config core.hooksPath .git/hooks
git config url.ssh://evil.example/.insteadOf ${box.data}
for h in reference-transaction post-checkout post-index-change pre-push pre-commit; do cp ${hook} .git/hooks/$h; done
echo '* filter=evil' > .gitattributes
echo changed >> README.md`,
    );
    const s1 = await p.snapshot(ws);
    const patch = await p.diff(ws, ROOT);
    const fork = await p.create(s1);
    expect(await p.apply(fork, patch)).toMatchObject({ ok: false }); // fork 已经有这些改动了
    await p.restore(ws, s1);
    await p.deliver(ws, s1);
    expect(existsSync(marker)).toBe(false);
    // 对照：在 workspace 里直接跑 git 会执行它们（容器里随它去）
    sh(ws.path, 'git status --porcelain > /dev/null');
    expect(existsSync(marker)).toBe(true);
  });

  it('.git 被换成指向用户仓库的文件、refs 和 logs 被换成符号链接，snapshot、restore 都不会写到外面', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    const s1 = await p.snapshot(ws);
    const before = repoState(repo);
    const victim = join(box.dir, 'victim.txt');
    writeFileSync(victim, 'original\n');

    rmSync(join(ws.path, '.git'), { recursive: true });
    writeFileSync(join(ws.path, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    const s2 = await p.snapshot(ws); // 读不出 HEAD 也照样收工作区
    await p.restore(ws, s1);
    expect(repoState(repo)).toEqual(before);
    expect(lstatSync(join(ws.path, '.git')).isDirectory()).toBe(true);
    expect(git(ws, 'symbolic-ref --short HEAD')).toBe('main');

    rmSync(join(ws.path, '.git', 'refs', 'heads'), { recursive: true });
    symlinkSync(join(repo, '.git', 'refs', 'heads'), join(ws.path, '.git', 'refs', 'heads'));
    mkdirSync(join(ws.path, '.git', 'logs'), { recursive: true });
    rmSync(join(ws.path, '.git', 'logs', 'HEAD'), { force: true });
    symlinkSync(victim, join(ws.path, '.git', 'logs', 'HEAD'));
    await p.snapshot(ws);
    await p.restore(ws, s2);
    await p.restore(ws, s1);
    expect(repoState(repo)).toEqual(before);
    expect(readFileSync(victim, 'utf8')).toBe('original\n');
  });

  it('fork：从另一个 workspace 的 snapshot 建，内容、HEAD、分支都一样', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const a = await p.create(ROOT);
    sh(
      a.path,
      'git checkout -qb try-x && echo x > x.txt && git add x.txt && git commit -qm x && git branch keep-me && echo y > y.txt',
    );
    const s = await p.snapshot(a);
    const b = await p.create(s);
    expect(b.path).not.toBe(a.path);
    expect(treeOf(b.path)).toEqual(treeOf(a.path));
    expect(git(b, 'rev-parse HEAD')).toBe(git(a, 'rev-parse HEAD'));
    expect(git(b, 'symbolic-ref --short HEAD')).toBe('try-x');
    expect(git(b, 'rev-parse keep-me')).toBe(git(a, 'rev-parse keep-me'));
    expect(status(b)).toEqual(status(a));
  });

  it('diff 生成 patch，apply 打到另一个 workspace；冲突时一点不动，列出冲突的文件', async () => {
    const repo = userRepo();
    const { providers, artifacts } = providersWith();
    const { p } = await start(providers, repo);
    const a = await p.create(ROOT);
    sh(
      a.path,
      `echo hello > hello.txt && echo x >> README.md && rm notes.md && printf '\\000\\001\\002' > bin.dat && chmod +x src/app.js`,
    );
    const patch = await p.diff(a, ROOT);
    const text = artifacts.text(patch);
    expect(text).toContain('diff --git a/hello.txt b/hello.txt');
    expect(text).toContain('GIT binary patch');
    expect(text).not.toContain('.env');

    const b = await p.create(ROOT);
    expect(await p.apply(b, patch)).toEqual({ ok: true });
    expect(treeOf(b.path)).toEqual(treeOf(a.path));

    const broken = await p.create(ROOT);
    sh(broken.path, "echo '* working-tree-encoding=no-such-encoding' > .gitattributes");
    expect(await p.apply(broken, patch)).toEqual({ ok: true });
    expect(treeOf(broken.path)['hello.txt']).toBe('hello\n');

    const c = await p.create(ROOT);
    sh(c.path, 'echo different > README.md');
    const before = treeOf(c.path);
    const r = await p.apply(c, patch);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContain('README.md');
    expect(treeOf(c.path)).toEqual(before);
  });

  it('prune 只清这个 workspace 打的、不在 keep 里的 snapshot；lineage 记录还在；再要清掉的报已经清理了', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { run, p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    const s1 = await p.snapshot(ws);
    sh(ws.path, 'echo 2 > two.txt');
    const s2 = await p.snapshot(ws);
    sh(ws.path, 'echo 3 > three.txt');
    const s3 = await p.snapshot(ws);
    const other = await p.create(ROOT);
    const o1 = await p.snapshot(other);

    await p.prune(ws, [s3]);
    for (const gone of [s1, s2]) {
      await expect(p.create(gone)).rejects.toMatchObject({
        code: 'not_found',
        message: expect.stringContaining('清理'),
      });
      const meta = JSON.parse(readFileSync(join(box.data, run.id, 'snapshots', `${gone}.json`), 'utf8'));
      expect(meta).toMatchObject({ id: gone, ws: (ws as CreatedWorkspace).id });
      expect(meta.pruned).toBeTruthy();
    }
    expect(treeOf((await p.create(s3)).path)['three.txt']).toBe('3\n');
    await expect(p.create(o1)).resolves.toBeTruthy();
    await expect(p.create(ROOT)).resolves.toBeTruthy();
    const s1Meta = JSON.parse(readFileSync(join(box.data, run.id, 'snapshots', `${s2}.json`), 'utf8'));
    expect(s1Meta.base).toBe(s1); // lineage：s2 的父是 s1
  });

  it('prune 后松散对象多了就清理 store；留下的 snapshot、根、别的 workspace 和它们记的 index 都还能用', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { run, p } = await start(providers, repo);
    const store = join(box.data, run.id, 'store.git');
    const loose = () => Number(/^count: (\d+)$/m.exec(sh(box.dir, `git --git-dir=${store} count-objects -v`))?.[1]);
    const other = await p.create(ROOT);
    sh(other.path, 'echo other > other.txt');
    const o1 = await p.snapshot(other);
    const ws = await p.create(ROOT);
    sh(ws.path, 'mkdir many && for i in $(seq 1 5100); do echo "file $i" > many/$i.txt; done');
    const s1 = await p.snapshot(ws);
    sh(ws.path, 'rm -r many && echo keep > keep.txt');
    const s2 = await p.snapshot(ws);
    expect(loose()).toBeGreaterThan(5000);
    await p.prune(ws, [s2]);
    expect(loose()).toBeLessThan(100);
    await expect(p.create(s1)).rejects.toMatchObject({ code: 'not_found' });
    expect(treeOf((await p.create(s2)).path)['keep.txt']).toBe('keep\n');
    expect(treeOf((await p.create(o1)).path)['other.txt']).toBe('other\n');
    expect(treeOf((await p.create(ROOT)).path)['notes.md']).toBe('notes\n');
    // Melina 给两个 workspace 记的 index 引用的对象还在：接着打 snapshot 不出错
    sh(ws.path, 'echo more >> keep.txt');
    sh(other.path, 'echo more >> other.txt');
    expect(treeOf((await p.create(await p.snapshot(ws))).path)['keep.txt']).toBe('keep\nmore\n');
    expect(treeOf((await p.create(await p.snapshot(other))).path)['other.txt']).toBe('other\nmore\n');
    sh(box.dir, `git --git-dir=${store} fsck --connectivity-only --no-dangling`);
  });

  it('deliver 在用户仓库建 melina/<runId> 分支，不动用户的当前分支、暂存区和工作区；patch 相对起点', async () => {
    const repo = userRepo();
    const { providers, artifacts } = providersWith();
    const { run, p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    sh(ws.path, 'echo feature > feature.txt && git add feature.txt && git commit -qm "加功能" && echo wip > wip.txt');
    const agentHead = git(ws, 'rev-parse HEAD');
    const s = await p.snapshot(ws);
    const before = repoState(repo);

    const out = await p.deliver(ws, s);
    expect(out.branch).toBe(`melina/${run.id}`);
    const after = repoState(repo);
    expect({ ...after, refs: '' }).toEqual({ ...before, refs: '' });
    expect(after.refs).toContain(`refs/heads/melina/${run.id}`);
    expect(git(repo, `show melina/${run.id}:feature.txt`)).toBe('feature');
    expect(git(repo, `show melina/${run.id}:wip.txt`)).toBe('wip'); // 没提交的改动在 Melina 补的提交里
    expect(git(repo, `log -1 --format=%s melina/${run.id}`)).toMatch(/^Melina：/);
    expect(git(repo, `rev-parse melina/${run.id}^`)).toBe(agentHead);

    const text = artifacts.text(out.patch);
    expect(text).toContain('b/feature.txt');
    expect(text).toContain('b/wip.txt');
    expect(text).not.toContain('notes.md'); // 用户开跑前就有的改动不算交付的改动

    // agent 都提交了：分支直接指向它的 HEAD
    const ws2 = await p.create(ROOT);
    sh(ws2.path, 'git add -A && git commit -qm all');
    const s2 = await p.snapshot(ws2);
    const out2 = await p.deliver(ws2, s2);
    expect(git(repo, `rev-parse ${out2.branch}`)).toBe(git(ws2, 'rev-parse HEAD'));
  });

  it('diffSnapshots：两个 snapshot 之间的 patch，不碰 workspace（没做完时主路线的改动，§4）', async () => {
    const repo = userRepo();
    const { providers, artifacts } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    sh(ws.path, 'echo a > a.txt');
    const s1 = await p.snapshot(ws);
    sh(ws.path, 'echo b > b.txt'); // 在途 episode 留下的，没进 snapshot
    const provider = p as GitCloneProvider;
    const text = artifacts.text(await provider.diffSnapshots(ROOT, s1));
    expect(text).toContain('b/a.txt');
    expect(text).not.toContain('b.txt');
    expect(treeOf(ws.path)['b.txt']).toBe('b\n');
  });

  it('接着做：从上个 Run 的 snapshot 起，带着它的 HEAD 和分支', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const first = await start(providers, repo);
    const ws = await first.p.create(ROOT);
    sh(
      ws.path,
      'git checkout -qb work && echo done > done.txt && git add done.txt && git commit -qm done && git branch side',
    );
    const s = await first.p.snapshot(ws);

    const second = await start(providers, repo, { from: { runId: first.run.id, snapshot: s } });
    const w = await second.p.create(ROOT);
    expect(treeOf(w.path)).toEqual(treeOf(ws.path));
    expect(git(w, 'symbolic-ref --short HEAD')).toBe('work');
    expect(git(w, 'rev-parse HEAD')).toBe(git(ws, 'rev-parse HEAD'));
    expect(git(w, 'rev-parse side')).toBe(git(ws, 'rev-parse side'));

    // 没做完的从上个任务的起点起
    const third = await start(providers, repo, { from: { runId: first.run.id, snapshot: ROOT } });
    expect(treeOf((await third.p.create(ROOT)).path)['done.txt']).toBeUndefined();
  });

  it('还没有提交的空仓库也能用，交付后用户仓库多一个分支', async () => {
    const repo = join(box.dir, 'empty');
    mkdirSync(repo);
    sh(repo, 'git init -q -b main && echo a > a.txt');
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    expect(treeOf(ws.path)['a.txt']).toBe('a\n');
    expect(git(ws, 'symbolic-ref HEAD')).toBe('refs/heads/main');
    expect(sh(ws.path, 'git rev-parse -q --verify HEAD || echo unborn')).toBe('unborn');
    sh(ws.path, 'git add -A && git commit -qm first');
    const s = await p.snapshot(ws);
    const w2 = await p.create(s);
    expect(git(w2, 'log --format=%s')).toBe('first');
    const out = await p.deliver(ws, s);
    expect(git(repo, `show ${out.branch}:a.txt`)).toBe('a');
    expect(sh(repo, 'git rev-parse -q --verify HEAD || echo unborn')).toBe('unborn');
  });

  it('工作目录是 git worktree 建的链接工作区也能用：根 snapshot 是那个工作区的样子，交付进同一个仓库', async () => {
    const repo = userRepo();
    const wt = join(box.dir, 'wt');
    sh(repo, `git stash -q -u && git worktree add -q -b side ${wt} && git stash pop -q`);
    sh(wt, 'echo wt > wt.txt');
    const { providers } = providersWith();
    const { run, p } = await start(providers, wt);
    expect(run.workspace.kind).toBe('git-clone');
    const ws = await p.create(ROOT);
    expect(git(ws, 'symbolic-ref --short HEAD')).toBe('side');
    expect(treeOf(ws.path)['wt.txt']).toBe('wt\n');
    expect(treeOf(ws.path)['notes.md']).toBeUndefined(); // 主工作区没提交的东西不在这个工作区里
    const s = await p.snapshot(ws);
    const out = await p.deliver(ws, s);
    expect(git(repo, `show ${out.branch}:wt.txt`)).toBe('wt');
    expect(git(wt, 'symbolic-ref --short HEAD')).toBe('side');
  });

  it('用户仓库 detached HEAD 时 workspace 也是 detached', async () => {
    const repo = userRepo();
    sh(repo, 'git checkout -q --detach feature');
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    expect(sh(ws.path, 'git symbolic-ref -q HEAD || echo detached')).toBe('detached');
    expect(git(ws, 'rev-parse HEAD')).toBe(git(repo, 'rev-parse feature'));
  });

  it('workspace.setup 在 workspace 里跑；失败不影响 create，结果记在 setup 上；没配执行器就记成没跑', async () => {
    const repo = userRepo();
    const log: { cmd: string[]; cwd: string }[] = [];
    const { providers } = providersWith(hostExecutor(log));
    const { p } = await start(providers, repo, {
      setup: 'mkdir -p node_modules && echo ok > node_modules/marker && echo installed',
    });
    const ws = (await p.create(ROOT)) as CreatedWorkspace;
    expect(ws.setup).toMatchObject({ ok: true, exitCode: 0 });
    expect(ws.setup?.tail).toContain('installed');
    expect(readFileSync(join(ws.path, 'node_modules', 'marker'), 'utf8')).toBe('ok\n');
    expect(log[0]?.cwd).toBe(ws.path);
    expect((await p.exec(ws, ['pwd'], {})).stdout.trim()).toBe(ws.path);
    // snapshot 不收被忽略的依赖，fork 出来的再跑一遍 setup
    const s = await p.snapshot(ws);
    const fork = (await p.create(s)) as CreatedWorkspace;
    expect(fork.setup?.ok).toBe(true);
    expect(log).toHaveLength(3);

    const failing = makeRun({ root: repo, kind: 'git-clone', setup: 'echo boom >&2; exit 3' });
    const pf = providers.forRun(failing);
    await pf.init(failing);
    const wf = (await pf.create(ROOT)) as CreatedWorkspace;
    expect(wf.setup).toMatchObject({ ok: false, exitCode: 3 });
    expect(wf.setup?.tail).toContain('boom');
    expect(existsSync(wf.path)).toBe(true);

    const bare = providersWith();
    const { p: pn } = await start(bare.providers, repo, { setup: 'npm ci' });
    const wn = (await pn.create(ROOT)) as CreatedWorkspace;
    expect(wn.setup?.skipped).toBeTruthy();
    await expect(pn.exec(wn, ['true'], {})).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('workspace.setup 跑到一半取消了（叫停、暂停、取消任务）：停下来，记成没跑完，workspace 照样交回', async () => {
    const repo = userRepo();
    const started: string[] = [];
    // 收取消信号的执行器（真的执行器在容器里跑，见 api/assemble.ts 的 workspaceExec）
    const exec: WorkspaceExec = (ws, cmd, opts) =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(cmd[0] ?? 'true', cmd.slice(1), { cwd: ws.path });
        started.push(ws.path);
        const kill = () => child.kill('SIGKILL');
        opts.signal?.addEventListener('abort', kill, { once: true });
        child.on('close', (code) => {
          opts.signal?.removeEventListener('abort', kill);
          resolve({
            exitCode: code,
            stdout: '',
            stderr: '',
            timedOut: false,
            cancelled: opts.signal?.aborted ?? false,
            durationMs: Date.now() - t0,
          });
        });
      });
    const { providers } = providersWith(exec);
    const { p } = await start(providers, repo, { setup: 'sleep 30' });
    const stop = new AbortController();
    const creating = p.create(ROOT, { signal: stop.signal });
    for (let i = 0; i < 200 && started.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(started).toHaveLength(1);
    const t0 = Date.now();
    stop.abort();
    const ws = (await creating) as CreatedWorkspace;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(ws.setup).toMatchObject({ ok: false, skipped: SETUP_CANCELLED, cmd: 'sleep 30' });
    expect(existsSync(ws.path)).toBe(true);
    // 一开始就取消了的：setup 不跑
    const again = (await p.create(ROOT, { signal: AbortSignal.abort() })) as CreatedWorkspace;
    expect(again.setup).toMatchObject({ ok: false, skipped: SETUP_CANCELLED });
    expect(started).toHaveLength(1);
  });

  it('用户仓库用了 filter（git-crypt、LFS：.gitattributes 里有 filter=）：只交 patch，不推 melina/<runId> 分支', async () => {
    const repo = userRepo();
    sh(
      repo,
      "printf 'secret/** filter=git-crypt diff=git-crypt\\n' > .gitattributes && git add .gitattributes && git commit -qm attrs",
    );
    const { providers, artifacts } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    sh(ws.path, 'mkdir -p secret && echo token-123 > secret/key.txt');
    const s = await p.snapshot(ws);
    const before = repoState(repo);
    const out = await p.deliver(ws, s);
    expect(out.branch).toBeUndefined();
    expect(repoState(repo)).toEqual(before); // 用户仓库一点没动：没推分支
    expect(artifacts.text(out.patch)).toContain('b/secret/key.txt');
  });

  it('用户仓库自己的 info/attributes 里配了 filter：同样只交 patch；装过 LFS 只是全局配置里有 filter.lfs 的照常推分支', async () => {
    const repo = userRepo();
    // 全局配置里有 filter.lfs（装过 LFS 的机器都这样），但没有属性用到它：不影响交付
    writeFileSync(
      join(box.home, '.gitconfig'),
      '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\trequired = true\n',
    );
    const { providers } = providersWith();
    const { run, p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    sh(ws.path, 'echo more > more.txt');
    const s = await p.snapshot(ws);
    expect((await p.deliver(ws, s)).branch).toBe(`melina/${run.id}`);

    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    const second = await start(providersWith().providers, repo);
    const ws2 = await second.p.create(ROOT);
    sh(ws2.path, 'echo again > again.txt');
    const s2 = await second.p.snapshot(ws2);
    expect((await second.p.deliver(ws2, s2)).branch).toBeUndefined();
  });

  it('伪造的 WorkspaceRef 一律拒绝，什么都不删', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const victim = join(box.dir, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    for (const ref of [{ path: victim }, { path: victim, id: newId() }, { path: repo, id: newId() }]) {
      await expect(p.restore(ref, ROOT)).rejects.toBeInstanceOf(MelinaError);
      await expect(p.dispose(ref)).rejects.toMatchObject({ code: 'invalid' });
      await expect(p.snapshot(ref)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep');
    await expect(p.create('../../etc')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('agent 把 .gitattributes 写坏了也能打 snapshot、fork', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    sh(ws.path, "echo '* working-tree-encoding=no-such-encoding' > .gitattributes && echo y > y.txt");
    const s = await p.snapshot(ws);
    const fork = await p.create(s);
    expect(treeOf(fork.path)['y.txt']).toBe('y\n');
  });

  it('workspace 里有 Melina 读不了的文件（容器里别的用户写的）也能打 snapshot，那些文件跳过', () => {
    // root 能读 chmod 000 的文件；子进程先降权，再验证真实的 EACCES 和 snapshot 回退。
    const env = { ...process.env };
    delete env.HOME;
    delete env.XDG_CONFIG_HOME;
    const output = execFileSync(process.execPath, [new URL('./unreadable-child.ts', import.meta.url).pathname], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const t = JSON.parse(output) as Record<string, string>;
    expect(t['fine.txt']).toBe('ok\n');
    expect(t['locked.txt']).toBeUndefined();
  });

  it('几个 workspace 同时打 snapshot', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const wss = await Promise.all([p.create(ROOT), p.create(ROOT), p.create(ROOT)]);
    wss.forEach((ws, i) => {
      sh(ws.path, `echo ${i} > mine.txt`);
    });
    const ids = await Promise.all(wss.map((ws) => p.snapshot(ws)));
    expect(new Set(ids).size).toBe(3);
    for (const [i, id] of ids.entries()) expect(treeOf((await p.create(id)).path)['mine.txt']).toBe(`${i}\n`);
  });

  it('dispose 删掉 workspace，它打的 snapshot 还能用', async () => {
    const repo = userRepo();
    const { providers } = providersWith();
    const { p } = await start(providers, repo);
    const ws = await p.create(ROOT);
    sh(ws.path, 'echo z > z.txt');
    const s = await p.snapshot(ws);
    await p.dispose(ws);
    expect(existsSync(ws.path)).toBe(false);
    expect(treeOf((await p.create(s)).path)['z.txt']).toBe('z\n');
  });
});
