// 工作目录：新建任务时补全路径，建任务前检查工作目录。
//
// GET /dirs?prefix= 列出前缀所在目录下名字对得上的子目录，最多 50 个，标出哪些是 git 仓库。
// 只列目录名、看有没有 .git，不读文件内容；~ 展开成 home，不是绝对路径的按 home 下的算；
// 隐藏目录只在输入以「.」开头时列；Melina 的数据目录不列，数据目录里面的也不列。名字按前缀比，不分大小写。

import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { DirEntry, DirsResponse } from '../core/api.ts';
import { invalid } from '../core/errors.ts';

export const DIRS_LIMIT = 50;
export const RECENT_LIMIT = 10;

/** ~ 展开成 home；不是绝对路径的按 home 下的算（Melina 进程的当前目录对用户没有意义） */
export function expandPath(input: string, home: string = homedir()): string {
  const t = input.trim();
  if (t === '~') return home;
  if (t.startsWith('~/')) return join(home, t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(home, t);
}

/** a 就是 b，或者在 b 里面 */
export function isInside(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** 实际路径（解开符号链接）；不存在就原样返回 */
async function real(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

export interface DirsOptions {
  home?: string;
  /** Melina 的数据目录（Artifact store、workspace 等），不列、也不许当工作目录 */
  protectedDirs: readonly string[];
  /** 最近用过的工作目录，新的在前（从 RunStore 里的 Run 来），可以有重复和已经不在的 */
  recent: readonly string[];
}

export async function listDirs(prefix: string, options: DirsOptions): Promise<DirsResponse> {
  const home = options.home ?? homedir();
  const protectedReal = await Promise.all(options.protectedDirs.map(real));
  const recent = await recentDirs(options.recent, protectedReal);
  if (prefix.trim() === '') return { entries: [], truncated: false, recent };

  const expanded = expandPath(prefix, home);
  // 以 / 结尾（或者就是 ~）：列这个目录下的全部；否则列它的上一级里名字以最后一段开头的
  const listAll = /[\\/]$/.test(prefix.trim()) || prefix.trim() === '~';
  const dir = listAll ? expanded : dirname(expanded);
  const partial = listAll ? '' : basename(expanded);
  const showHidden = partial.startsWith('.');

  const dirReal = await real(dir);
  if (protectedReal.some((p) => isInside(dirReal, p))) return { dir, entries: [], truncated: false, recent };

  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return { dir, entries: [], truncated: false, recent }; // 不存在、不是目录、没权限：没有可补全的
  }
  const lower = partial.toLowerCase();
  const matched = names
    .filter((name) => (showHidden || !name.startsWith('.')) && name.toLowerCase().startsWith(lower))
    .sort((a, b) => a.localeCompare(b));

  const entries: DirEntry[] = [];
  let truncated = false;
  for (const name of matched) {
    const path = join(dir, name);
    const st = await stat(path).catch(() => undefined); // 符号链接要指向目录才算
    if (!st?.isDirectory()) continue;
    const pathReal = await real(path);
    // 数据目录本身和它里面的不列；包含它的（比如 home）照列，要往下找项目
    if (protectedReal.some((p) => isInside(pathReal, p))) continue;
    if (entries.length >= DIRS_LIMIT) {
      truncated = true;
      break;
    }
    entries.push({ name, path, git: await isGitTop(path) });
  }
  return { dir, entries, truncated, recent };
}

/** 有 .git（目录，或者 git worktree、子模块的 .git 文件）就算 git 仓库 */
async function isGitTop(path: string): Promise<boolean> {
  return stat(join(path, '.git')).then(
    () => true,
    () => false,
  );
}

async function recentDirs(roots: readonly string[], protectedReal: readonly string[]): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (out.length >= RECENT_LIMIT) break;
    if (seen.has(root)) continue;
    seen.add(root);
    const st = await stat(root).catch(() => undefined);
    if (!st?.isDirectory()) continue;
    const rootReal = await real(root);
    if (protectedReal.some((p) => isInside(rootReal, p))) continue; // 没选目录时 Melina 新建的空目录
    out.push({ name: basename(root) || root, path: root, git: await isGitTop(root) });
  }
  return out;
}

/**
 * POST /runs 的工作目录：不存在、不是目录、在 Melina 的数据目录里或包含数据目录就拒绝（invalid）。
 * 返回展开 ~ 之后的绝对路径。
 */
export async function checkWorkspaceRoot(
  input: string,
  protectedDirs: readonly string[],
  home?: string,
): Promise<string> {
  const path = expandPath(input, home);
  const st = await stat(path).catch(() => undefined);
  if (!st) throw invalid(`工作目录不存在：${path}`);
  if (!st.isDirectory()) throw invalid(`工作目录不是目录：${path}`);
  const pathReal = await real(path);
  for (const p of protectedDirs) {
    const pReal = await real(p);
    if (isInside(pathReal, pReal)) throw invalid(`工作目录在 Melina 的数据目录里：${path}`);
    if (isInside(pReal, pathReal)) throw invalid(`工作目录包含 Melina 的数据目录（${p}），换一个更小的目录`);
  }
  return path;
}
