// DirCopyProvider 的集成测试：普通目录。diff、apply 用到 git。

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOT } from '../../../src/core/ids.ts';
import type { WorkspaceProvider, WorkspaceProviders } from '../../../src/core/interfaces/workspace.ts';
import type { Run } from '../../../src/core/types.ts';
import type { DirCopyProvider } from '../../../src/workspace/dir-copy.ts';
import * as files from '../../../src/workspace/files.ts';
import { createWorkspaceProviders } from '../../../src/workspace/provider.ts';
import { makeRun, memoryArtifacts, sandbox, sh, treeOf } from './helpers.ts';

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
  box = sandbox('dir');
});

afterEach(() => {
  vi.restoreAllMocks();
  // 只读目录先放开权限再删
  sh(box.dir, 'chmod -R u+rwX . 2>/dev/null || true');
  box.cleanup();
});

/** 普通目录：可执行文件、二进制、空目录、目录里外的符号链接、嵌套的 git 仓库、只读目录、FIFO */
function plainDir(): string {
  const root = join(box.dir, 'plain');
  mkdirSync(root);
  sh(
    root,
    `echo '# 笔记' > notes.md
mkdir data bin empty
printf 'a,b\\n1,2\\n' > data/a.csv
printf '#!/bin/sh\\necho hi\\n' > bin/run.sh && chmod +x bin/run.sh
printf '\\000\\377\\001' > img.bin
ln -s data/a.csv link-in
ln -s /etc link-out
mkdir -p nested && (cd nested && git init -q -b main && echo n > file.txt && git add . && git commit -qm n)
mkdir ro && echo r > ro/file.txt && chmod 444 ro/file.txt && chmod 555 ro
mkfifo pipe`,
  );
  return root;
}

function providersOf() {
  const artifacts = memoryArtifacts();
  return { providers: createWorkspaceProviders({ dataDir: box.data, artifacts }), artifacts };
}

async function start(
  providers: WorkspaceProviders,
  root: string,
  extra: Partial<Parameters<typeof makeRun>[0]> = {},
): Promise<{ run: Run; p: WorkspaceProvider }> {
  const run = makeRun({ root, kind: await providers.detect(root), ...extra });
  const p = providers.forRun(run);
  await p.init(run);
  return { run, p };
}

function nlink(path: string): number {
  return statSync(path).nlink;
}

describe('DirCopyProvider', () => {
  it('复制完成后才发布 workspace，进度写入不会抢先占用 snapshot 中的文件', async () => {
    const root = join(box.dir, 'plain');
    mkdirSync(root);
    writeFileSync(join(root, 'BENCHMARK_PROGRESS.json'), '{"accepted":2}');
    const { providers } = providersOf();
    const { run, p } = await start(providers, root);
    const wsDir = join(box.data, run.id, 'ws');
    const copyTree = files.copyTree;
    let scanned = false;
    vi.spyOn(files, 'copyTree').mockImplementationOnce((src, dst, opts) =>
      copyTree(src, dst, {
        ...opts,
        skip: () => {
          scanned = true;
          // 与 orchestrator 一样，在复制途中扫描 ws/* 并写入进度。
          for (const name of readdirSync(wsDir)) {
            writeFileSync(join(wsDir, name, 'BENCHMARK_PROGRESS.json'), '{"accepted":3}');
          }
          return false;
        },
      }),
    );

    const ws = await p.create(ROOT);
    expect(scanned).toBe(true);
    expect(readFileSync(join(ws.path, 'BENCHMARK_PROGRESS.json'), 'utf8')).toBe('{"accepted":2}');
    expect(readdirSync(wsDir)).toEqual([basename(ws.path)]);
    expect(readdirSync(join(box.data, run.id, 'tmp'))).toEqual([]);
  });

  it('复制失败时不发布 workspace，也不留下临时目录', async () => {
    const root = join(box.dir, 'plain');
    mkdirSync(root);
    writeFileSync(join(root, 'file.txt'), 'content');
    const { providers } = providersOf();
    const { run, p } = await start(providers, root);
    const copyTree = files.copyTree;
    vi.spyOn(files, 'copyTree').mockImplementationOnce(async (...args) => {
      await copyTree(...args);
      throw new Error('copy failed');
    });

    await expect(p.create(ROOT)).rejects.toThrow('copy failed');
    expect(readdirSync(join(box.data, run.id, 'ws'))).toEqual([]);
    expect(readdirSync(join(box.data, run.id, 'tmp'))).toEqual([]);
  });

  it('init 不动工作目录；workspace 是原样的副本：权限、空目录、符号链接（不跟随）、嵌套仓库都在，FIFO 跳过', async () => {
    const root = plainDir();
    const before = treeOf(root, { withGit: true });
    const { providers } = providersOf();
    const { run, p } = await start(providers, root);
    expect(run.workspace.kind).toBe('dir-copy');
    expect(treeOf(root, { withGit: true })).toEqual(before);

    const ws = await p.create(ROOT);
    const t = treeOf(ws.path, { withGit: true });
    const expected = { ...before };
    delete expected.pipe;
    expect(t).toEqual(expected);
    expect(t['link-out']).toBe('link -> /etc');
    expect(t['bin/run.sh']).toMatch(/^x /);
    expect(t.empty).toBe('dir');
    expect(statSync(join(ws.path, 'ro')).mode & 0o777).toBe(0o555);
    expect(sh(join(ws.path, 'nested'), 'git log --format=%s')).toBe('n');
  });

  it('snapshot 里没变的文件和上一份硬链接，变了的才复制；workspace 从不和 snapshot 共用 inode', async () => {
    const root = plainDir();
    const { providers } = providersOf();
    const { run, p } = await start(providers, root);
    const ws = await p.create(ROOT);
    const s1 = await p.snapshot(ws);
    sh(ws.path, "echo '3,4' >> data/a.csv");
    const s2 = await p.snapshot(ws);
    const snap = (id: string, rel: string) => join(box.data, run.id, 'snap', id, rel);
    expect(nlink(snap(s2, 'notes.md'))).toBeGreaterThanOrEqual(2);
    expect(nlink(snap(s2, 'data/a.csv'))).toBe(1);
    expect(nlink(join(ws.path, 'notes.md'))).toBe(1);
    // 原地改 workspace 的文件，snapshot 里的不变
    sh(ws.path, 'echo changed >> notes.md');
    expect(readFileSync(snap(s1, 'notes.md'), 'utf8')).toBe('# 笔记\n');
    expect(readFileSync(snap(s2, 'notes.md'), 'utf8')).toBe('# 笔记\n');
  });

  it('restore 改回 snapshot，不穿过 agent 放的符号链接往外写', async () => {
    const root = plainDir();
    const { providers } = providersOf();
    const { p } = await start(providers, root);
    const ws = await p.create(ROOT);
    sh(ws.path, 'echo v1 > notes.md');
    const s1 = await p.snapshot(ws);
    const atSnapshot = treeOf(ws.path, { withGit: true });

    const outside = join(box.dir, 'outside');
    mkdirSync(outside);
    rmSync(join(ws.path, 'data'), { recursive: true });
    symlinkSync(outside, join(ws.path, 'data')); // data/ 换成指向外面的链接
    sh(ws.path, 'rm notes.md && echo junk > junk.txt && mkdir -p deep/er && echo x > deep/er/x && chmod -x bin/run.sh');
    rmSync(join(ws.path, 'link-in'));
    writeFileSync(join(ws.path, 'link-in'), 'not a link any more');

    await p.restore(ws, s1);
    expect(treeOf(ws.path, { withGit: true })).toEqual(atSnapshot);
    expect(sh(outside, 'ls -A')).toBe(''); // 没往外面写东西
  });

  it('diff、apply、deliver：二进制、权限、符号链接、删除都在 patch 里，嵌套仓库的 .git 不在；交付只有 patch', async () => {
    const root = plainDir();
    const { providers, artifacts } = providersOf();
    const { p } = await start(providers, root);
    const a = await p.create(ROOT);
    sh(
      a.path,
      `echo more >> notes.md && printf '\\001\\002' > img.bin && chmod -x bin/run.sh && rm -r data
ln -sfn notes.md link-in && echo new > new.txt && (cd nested && echo m >> file.txt && git commit -qam m)`,
    );
    const patch = await p.diff(a, ROOT);
    const text = artifacts.text(patch);
    expect(text).toContain('GIT binary patch');
    expect(text).toContain('old mode 100755');
    expect(text).toContain('deleted file mode 100644');
    expect(text).toContain('b/nested/file.txt');
    expect(text).not.toContain('nested/.git');

    const b = await p.create(ROOT);
    expect(await p.apply(b, patch)).toEqual({ ok: true });
    const ta = treeOf(a.path);
    const tb = treeOf(b.path);
    for (const t of [ta, tb]) for (const k of Object.keys(t)) if (k.startsWith('nested/.git')) delete t[k];
    expect(tb).toEqual(ta);

    const s = await p.snapshot(a);
    const out = await p.deliver(a, s);
    expect(out.branch).toBeUndefined();
    expect(artifacts.text(out.patch)).toBe(text);
  });

  it('prune 只清这个 workspace 打的；清掉的再要报已经清理了，根 snapshot 一直在', async () => {
    const root = plainDir();
    const { providers } = providersOf();
    const { run, p } = await start(providers, root);
    const ws = await p.create(ROOT);
    const s1 = await p.snapshot(ws);
    sh(ws.path, 'echo 2 > two.txt');
    const s2 = await p.snapshot(ws);
    const other = await p.create(ROOT);
    const o1 = await p.snapshot(other);
    await p.prune(ws, [s2]);
    await expect(p.create(s1)).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('清理') });
    expect(existsSync(join(box.data, run.id, 'snap', s1))).toBe(false);
    expect(JSON.parse(readFileSync(join(box.data, run.id, 'snapshots', `${s1}.json`), 'utf8')).pruned).toBeTruthy();
    expect(treeOf((await p.create(s2)).path)['two.txt']).toBe('2\n');
    await expect(p.create(o1)).resolves.toBeTruthy();
    await expect(p.create(ROOT)).resolves.toBeTruthy();
  });

  it('diffSnapshots：两个 snapshot 之间的 patch，不碰 workspace', async () => {
    const root = plainDir();
    const { providers, artifacts } = providersOf();
    const { p } = await start(providers, root);
    const ws = await p.create(ROOT);
    sh(ws.path, 'echo a > a.txt');
    const s1 = await p.snapshot(ws);
    sh(ws.path, 'echo b > b.txt');
    const text = artifacts.text(await (p as DirCopyProvider).diffSnapshots(ROOT, s1));
    expect(text).toContain('b/a.txt');
    expect(text).not.toContain('b.txt');
  });

  it('接着做：从上个 Run 的 snapshot 起', async () => {
    const root = plainDir();
    const { providers } = providersOf();
    const first = await start(providers, root);
    const ws = await first.p.create(ROOT);
    sh(ws.path, 'echo done > done.txt');
    const s = await first.p.snapshot(ws);
    const second = await start(providers, root, { from: { runId: first.run.id, snapshot: s } });
    const w = await second.p.create(ROOT);
    expect(treeOf(w.path, { withGit: true })).toEqual(treeOf(ws.path, { withGit: true }));
  });

  it('dispose 删得掉只读目录', async () => {
    const root = plainDir();
    const { providers } = providersOf();
    const { p } = await start(providers, root);
    const ws = await p.create(ROOT);
    chmodSync(join(ws.path, 'data'), 0o555);
    await p.dispose(ws);
    expect(existsSync(ws.path)).toBe(false);
  });
});
