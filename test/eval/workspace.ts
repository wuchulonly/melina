// 每次试验的起点 workspace，和从 Melina 的交付里取出文件（交给 Run 外面的检查）。
// 起点是一个新建的 git 仓库，Melina 用 GitCloneProvider，交付时推成 melina/<runId> 分支；
// 取文件只读 git 的对象（ls-tree、cat-file），不检出、不跑 filter 和 hook；没有分支时退回用 patch。
// 单 agent 基线的交付照同样的样子取（snapshotDelivery），两边被检查的东西一样。

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { RunResultResponse } from '../../src/core/api.ts';
import type { MelinaRun } from './melina.ts';

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * 跑 git：不读系统和全局配置、不跑 hook、作者和时间固定（起点仓库每次都一样）；input 给了就从 stdin 喂进去，
 * extraEnv 是另加的环境变量（GIT_INDEX_FILE 这类）
 */
export function git(cwd: string, args: readonly string[], input?: string, extraEnv?: Record<string, string>): Buffer {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Melina 评估',
    GIT_AUTHOR_EMAIL: 'eval@melina.local',
    GIT_COMMITTER_NAME: 'Melina 评估',
    GIT_COMMITTER_EMAIL: 'eval@melina.local',
    GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z',
    ...extraEnv,
  });
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env,
    maxBuffer: 512 * 1024 * 1024,
    ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : { input }),
  });
}

export function writeFiles(dir: string, files: Record<string, string | Uint8Array>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, safeRelative(name));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** 起点 workspace：写好起点文件；要 git 的话建仓库、提交一次 */
export function prepareWorkspace(
  dir: string,
  files: Record<string, string | Uint8Array>,
  options: { git: boolean },
): void {
  mkdirSync(dir, { recursive: true });
  writeFiles(dir, files);
  if (!options.git) return;
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', '起点']);
}

/**
 * 把交付的 workspace 取到 into：有 melina/<runId> 分支就从分支读，读不出来或者没有分支就在起点文件上打 patch。
 * files 给了就只取这几个文件（检查要读的），agent 在 workspace 里装了一堆依赖也不影响。返回用的是哪种
 */
export async function extractDelivery(options: {
  repo: string; // 起点仓库（Melina 把分支推回这里）
  result: RunResultResponse;
  run: MelinaRun;
  starter: Record<string, string | Uint8Array>;
  into: string;
  files?: readonly string[];
}): Promise<'branch' | 'patch'> {
  const { repo, result, run, starter, into, files } = options;
  let branchError: unknown;
  if (result.branch) {
    try {
      rmSync(into, { recursive: true, force: true });
      mkdirSync(into, { recursive: true });
      exportTree(repo, result.branch, into, files);
      return 'branch';
    } catch (e) {
      branchError = gitRejected(e, MISSING_REV)
        ? new MelinaDeliveryError(`Melina 交的分支 ${result.branch} 在起点仓库里读不出：${gitMessage(e)}`)
        : e;
    }
  }
  if (result.patch && run.artifact) {
    // 取 patch 时 Melina 回的错（MelinaHttpError）照样抛：跑分把它算成 Melina 那边的
    const patch = await run.artifact(result.patch);
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    try {
      applyPatch(into, starter, patch, files);
    } catch (e) {
      if (gitRejected(e, BAD_PATCH)) throw new MelinaDeliveryError(`Melina 交的 patch 打不上起点：${gitMessage(e)}`);
      throw e;
    }
    return 'patch';
  }
  if (branchError) throw branchError;
  throw new NoDeliveryError('交付里既没有分支也没有 patch');
}

/**
 * Melina 说做完了，交付却取不到：
 * 交付指的分支在起点仓库里没有、patch 打不上起点。本机的问题（git 起不来、磁盘满）照原样抛，跑分记成出错
 */
export class MelinaDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MelinaDeliveryError';
  }
}

/** Melina 说做完了，交付里却什么都没有 */
export class NoDeliveryError extends MelinaDeliveryError {
  constructor(message: string) {
    super(message);
    this.name = 'NoDeliveryError';
  }
}

/** 引用的提交、分支不存在（ls-tree、cat-file 的报错） */
const MISSING_REV =
  /not a valid object name|not a tree object|unknown revision|bad revision|invalid object name|bad object/i;
/**
 * patch 打不上、不是 patch（git apply 的报错）：内容对不上、改的文件起点里没有（「error: x: No such file or directory」）、
 * 要新建的文件已经有了
 */
const BAD_PATCH =
  /patch does not apply|patch failed|corrupt patch|no valid patches|while searching for|unrecognized input|without header|^error: .+: (?:no such file or directory|already exists in working directory|does not exist in index)$/im;

/** git 跑起来了、退出码不是 0、报错对得上 pattern；git 根本没跑起来的（找不到 git、进程数到顶）不算 */
function gitRejected(e: unknown, pattern: RegExp): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { status, stderr } = e as { status?: unknown; stderr?: unknown };
  return typeof status === 'number' && status !== 0 && pattern.test(String(stderr ?? ''));
}

function gitMessage(e: unknown): string {
  const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim();
  return (stderr.split('\n')[0] ?? '').slice(0, 300);
}

/**
 * 只读 git 对象：把某个提交里的普通文件写出来（files 给了就只要这几个）；符号链接、子模块、太大的不要，太多的只取前面的。
 * 大小从 ls-tree -l 拿，内容用一个 cat-file --batch 进程一次读完，几千个文件也快
 */
export function exportTree(repo: string, rev: string, into: string, files?: readonly string[]): void {
  const args = ['ls-tree', '-r', '-z', '-l', '--full-tree', rev];
  if (files && files.length > 0) args.push('--', ...files);
  const wanted: { sha: string; path: string }[] = [];
  for (const entry of git(repo, args).toString('utf8').split('\0')) {
    if (wanted.length >= MAX_FILES) break;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha, size] = entry.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !sha) continue;
    if (Number(size) > MAX_FILE_BYTES) continue;
    try {
      wanted.push({ sha, path: join(into, safeRelative(entry.slice(tab + 1))) });
    } catch {}
  }
  if (wanted.length === 0) return;
  // --batch 的输出：每个对象「<sha> blob <大小>\n<内容>\n」，按输入的顺序
  const out = git(repo, ['cat-file', '--batch'], `${wanted.map((w) => w.sha).join('\n')}\n`);
  let at = 0;
  for (const w of wanted) {
    const eol = out.indexOf(0x0a, at);
    const [, kind, size] = out.subarray(at, eol).toString('utf8').split(' ');
    const length = Number(size);
    if (kind !== 'blob' || !Number.isInteger(length)) throw new Error(`读不出 ${w.sha}`);
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, out.subarray(eol + 1, eol + 1 + length));
    at = eol + 1 + length + 1;
  }
}

/**
 * 不经过 Melina 的交付（单 agent 基线）照 Melina 交付成分支的样子取到 into：
 * 像 Melina 的 snapshot 那样 git add -A（.gitignore 盖住的新文件不收，FIFO 这类收不了的跳过），起点里有、还在的文件照收
 * （Melina 照 HEAD 补收被后写的 .gitignore 盖住的文件），再用 exportTree 取普通文件（符号链接、太大的、太多的不要）。
 * workspace 里的 .git 整个是 agent 写得动的（配置、hook、指到别处的 gitdir），所以不碰它：在跑分自己的临时仓库里收，
 * 工作树指到 workspace，git 本来就不收名叫 .git 的路径
 */
export function snapshotDelivery(
  workspace: string,
  starter: readonly string[],
  into: string,
  files?: readonly string[],
): void {
  const scratch = mkdtempSync(join(tmpdir(), 'melina-eval-snapshot-'));
  try {
    git(scratch, ['init', '-q']);
    const base = [`--git-dir=${join(scratch, '.git')}`, `--work-tree=${workspace}`];
    try {
      git(scratch, [...base, 'add', '-A']);
    } catch {
      // 有收不了的文件（FIFO、socket）：和 Melina 一样跳过它们接着收；退出码 1 是有文件没收成
      try {
        git(scratch, [...base, 'add', '-A', '--ignore-errors']);
      } catch (e) {
        if ((e as { status?: unknown }).status !== 1) throw e;
      }
    }
    const kept = starter.filter((p) => {
      const st = lstatSync(join(workspace, safeRelative(p)), { throwIfNoEntry: false });
      return st?.isFile() || st?.isSymbolicLink();
    });
    if (kept.length > 0) {
      const input = kept.map((p) => `${p}\0`).join('');
      git(scratch, [...base, 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], input, {
        GIT_LITERAL_PATHSPECS: '1',
      });
    }
    const tree = git(scratch, [...base, 'write-tree'])
      .toString('utf8')
      .trim();
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    exportTree(scratch, tree, into, files);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * 起点文件写进 into，在一个临时的空仓库里 git apply（不读 workspace 里的配置；files 给了就只打这几个文件），
 * 打完删掉仓库，也删掉 patch 建出来的符号链接（检查不能顺着它读到宿主机上的东西）
 */
export function applyPatch(
  into: string,
  starter: Record<string, string | Uint8Array>,
  patch: Uint8Array,
  files?: readonly string[],
): void {
  writeFiles(into, starter);
  const scratch = mkdtempSync(join(tmpdir(), 'melina-eval-patch-'));
  try {
    const file = join(scratch, 'delivery.patch');
    writeFileSync(file, patch);
    git(into, ['init', '-q']);
    git(into, ['apply', '--whitespace=nowarn', ...(files ?? []).map((f) => `--include=${f}`), file]);
  } finally {
    rmSync(join(into, '.git'), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const entry of readdirSync(into, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) rmSync(join(entry.parentPath, entry.name), { force: true });
  }
}

function safeRelative(name: string): string {
  const n = normalize(name);
  if (isAbsolute(n) || n === '..' || n.startsWith('../') || n.split('/').includes('.git')) {
    throw new Error(`路径不安全：${name}`);
  }
  return n;
}
