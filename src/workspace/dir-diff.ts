// 两棵目录树之间的 patch（DirCopyProvider 的 diff、deliver 用）。
//
// 只比文件和符号链接（空目录 patch 表达不了）；任何一级叫 .git 的都跳过：嵌套仓库的内部文件不是内容，git apply 也不收。
// 变了的文件写进一个临时的裸仓库（只装变了的那些），拼成两棵小树，再让 git diff-tree 出 patch，二进制也能 apply。

import { mkdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type Entry, isCode, removeTree, sameContent, sameFile, under, walk } from './files.ts';
import { EMPTY_TREE, git, gitOut } from './git.ts';

export interface TreeChange {
  rel: string;
  old?: Entry;
  new?: Entry;
}

const skipDotGit = (_rel: string, name: string) => name === '.git';

/** a 到 b 变了哪些文件和链接；a 不给就当空树 */
export async function treeChanges(a: string | undefined, b: string): Promise<TreeChange[]> {
  const left = a ? await walk(a, { skip: skipDotGit }) : new Map<string, Entry>();
  const right = await walk(b, { skip: skipDotGit });
  const leaf = (e: Entry | undefined) => (e && (e.kind === 'file' || e.kind === 'symlink') ? e : undefined);
  const rels = new Set<string>();
  for (const [rel, e] of left) if (leaf(e)) rels.add(rel);
  for (const [rel, e] of right) if (leaf(e)) rels.add(rel);
  const out: TreeChange[] = [];
  for (const rel of [...rels].sort()) {
    const o = leaf(left.get(rel));
    const n = leaf(right.get(rel));
    if (o && n && a && (await same(under(a, rel), o, under(b, rel), n))) continue;
    out.push({ rel, ...(o ? { old: o } : {}), ...(n ? { new: n } : {}) });
  }
  return out;
}

async function same(pa: string, a: Entry, pb: string, b: Entry): Promise<boolean> {
  if (a.kind !== b.kind) return false;
  try {
    if (a.kind === 'symlink') return (await readlink(pa)) === (await readlink(pb));
    if (sameFile(a, b)) return true;
    if (a.size !== b.size || (a.mode & 0o111 ? 1 : 0) !== (b.mode & 0o111 ? 1 : 0)) return false;
    return await sameContent(pa, pb); // 只是时间变了（touch 过）的不算改动
  } catch (e) {
    if (isCode(e, 'ENOENT') || isCode(e, 'ENOTDIR')) return false; // 比的时候被后台进程删了：算变了，后面重来
    throw e;
  }
}

/**
 * 把 a → b 的改动写成 git 格式的 patch（--binary --full-index，路径相对树根）到 out。
 * scratch 是一个还不存在的临时目录，用完删掉。返回变了几个文件。
 */
export async function writeTreePatch(opts: {
  a: string | undefined;
  b: string;
  out: string;
  scratch: string;
  signal?: AbortSignal;
}): Promise<number> {
  const changes = await treeChanges(opts.a, opts.b);
  await mkdir(opts.scratch, { recursive: true });
  const gitDir = join(opts.scratch, 'diff.git');
  try {
    await git({ args: ['init', '-q', '--bare', gitDir], signal: opts.signal });
    const oldTree = await buildTree(gitDir, join(opts.scratch, 'old.index'), opts.a, changes, 'old', opts.signal);
    const newTree = await buildTree(gitDir, join(opts.scratch, 'new.index'), opts.b, changes, 'new', opts.signal);
    await git({
      gitDir,
      args: [
        'diff-tree',
        '-p',
        '--binary',
        '--full-index',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        oldTree,
        newTree,
      ],
      stdoutFile: opts.out,
      signal: opts.signal,
    });
    return changes.length;
  } finally {
    await removeTree(opts.scratch);
  }
}

async function buildTree(
  gitDir: string,
  indexFile: string,
  root: string | undefined,
  changes: TreeChange[],
  side: 'old' | 'new',
  signal?: AbortSignal,
): Promise<string> {
  const items = root ? changes.filter((c) => c[side]) : [];
  if (items.length === 0) return EMPTY_TREE;
  const lines: string[] = [];
  const files = items.filter((c) => c[side]?.kind === 'file');
  // 普通文件按路径批量算 hash（--stdin-paths 一行一个，路径里有换行的单独算）
  const batch = files.filter((c) => !c.rel.includes('\n'));
  if (batch.length > 0) {
    const shas = (
      await gitOut({
        gitDir,
        args: ['hash-object', '-w', '--no-filters', '--stdin-paths'],
        input: `${batch.map((c) => under(root as string, c.rel)).join('\n')}\n`,
        signal,
      })
    ).split('\n');
    batch.forEach((c, i) => {
      lines.push(`${fileMode(c[side] as Entry)} ${shas[i]}\t${c.rel}`);
    });
  }
  for (const c of files.filter((f) => f.rel.includes('\n'))) {
    const sha = await gitOut({
      gitDir,
      args: ['hash-object', '-w', '--no-filters', '--stdin'],
      inputFile: under(root as string, c.rel),
      signal,
    });
    lines.push(`${fileMode(c[side] as Entry)} ${sha}\t${c.rel}`);
  }
  for (const c of items.filter((i) => i[side]?.kind === 'symlink')) {
    const target = await readlink(under(root as string, c.rel));
    const sha = await gitOut({ gitDir, args: ['hash-object', '-w', '--stdin'], input: target, signal });
    lines.push(`120000 ${sha}\t${c.rel}`);
  }
  await git({
    gitDir,
    indexFile,
    args: ['update-index', '--add', '-z', '--index-info'],
    input: lines.map((l) => `${l}\0`).join(''),
    signal,
  });
  return gitOut({ gitDir, indexFile, args: ['write-tree'], signal });
}

function fileMode(e: Entry): string {
  return e.mode & 0o111 ? '100755' : '100644';
}
