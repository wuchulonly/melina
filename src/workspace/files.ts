// 文件系统的小工具：走目录树、复制、同步、删除。都不跟随符号链接。
//
// workspace 里的符号链接是 agent 放的，可能指向宿主机上任何地方（容器里看是悬空的，宿主机上却是真的）。
// 所以这里只用 lstat，复制、写入前先删掉目标位置原有的东西，父目录一级级确认是真目录，绝不往链接里面写。

import { type BigIntStats, constants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { MelinaError } from '../core/errors.ts';

export type EntryKind = 'dir' | 'file' | 'symlink' | 'other';

export interface Entry {
  kind: EntryKind;
  size: bigint;
  mode: number; // 权限位（含 setuid 这类），不含类型
  mtimeNs: bigint;
  atimeNs: bigint;
}

export function kindOf(st: BigIntStats): EntryKind {
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  if (st.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function entryOf(st: BigIntStats): Entry {
  return {
    kind: kindOf(st),
    size: st.size,
    mode: Number(st.mode & 0o7777n),
    mtimeNs: st.mtimeNs,
    atimeNs: st.atimeNs,
  };
}

export async function lstatOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (e) {
    if (isCode(e, 'ENOENT') || isCode(e, 'ENOTDIR')) return null;
    throw e;
  }
}

/** 是真目录（不是指向目录的符号链接） */
export async function isRealDir(path: string): Promise<boolean> {
  return (await lstatOrNull(path))?.isDirectory() ?? false;
}

export async function exists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}

/**
 * 两个文件看起来没变：大小、权限一样，修改时间差不到 2 微秒。
 * 复制时用 utimes 把修改时间抄过去，但 Node 只能按秒的浮点数设，纳秒位会有零点几微秒的误差。
 */
export function sameFile(a: Entry, b: Entry): boolean {
  if (a.kind !== 'file' || b.kind !== 'file') return false;
  if (a.size !== b.size || a.mode !== b.mode) return false;
  const d = a.mtimeNs - b.mtimeNs;
  return d < 2000n && d > -2000n;
}

/** 按名字排序列出目录（不跟随链接），每项带 lstat */
export async function list(dir: string): Promise<{ name: string; entry: Entry }[]> {
  const names = (await readdir(dir)).sort();
  const out: { name: string; entry: Entry }[] = [];
  for (const name of names) {
    const st = await lstatOrNull(join(dir, name));
    if (st) out.push({ name, entry: entryOf(st) });
  }
  return out;
}

export interface WalkOptions {
  /** 返回 true 就跳过这一项（目录就不往下走） */
  skip?: (rel: string, name: string, entry: Entry) => boolean;
}

/** 走整棵树，返回 rel → Entry（rel 用 / 分隔，不含根本身）。不跟随符号链接 */
export async function walk(root: string, opts: WalkOptions = {}): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  const visit = async (relDir: string) => {
    for (const { name, entry } of await list(relDir ? join(root, ...relDir.split('/')) : root)) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (opts.skip?.(rel, name, entry)) continue;
      out.set(rel, entry);
      if (entry.kind === 'dir') await visit(rel);
    }
  };
  await visit('');
  return out;
}

/** rel 路径转成某个根下的绝对路径 */
export function under(root: string, rel: string): string {
  return rel ? join(root, ...rel.split('/')) : root;
}

const removeTreeWith = (path: string, force?: (path: string) => Promise<void>) => removeTree(path, force);

/**
 * 删掉一棵树，不跟随符号链接；碰到没有写权限的目录就先补上权限再删。
 * 还删不掉（容器里非 root 用户写的，宿主机上属于 subuid，改不了权限）就交给 force（比如 podman unshare rm -rf）。
 */
export async function removeTree(path: string, force?: (path: string) => Promise<void>): Promise<void> {
  const denied = (e: unknown) => isCode(e, 'EACCES') || isCode(e, 'EPERM') || isCode(e, 'ENOTEMPTY');
  try {
    await rm(path, { recursive: true, force: true });
  } catch (e) {
    if (!denied(e)) throw e;
    await makeWritable(path);
    try {
      await rm(path, { recursive: true, force: true });
    } catch (e2) {
      if (!force || !denied(e2)) throw e2;
      await force(path);
    }
  }
}

async function makeWritable(path: string): Promise<void> {
  const st = await lstatOrNull(path);
  if (!st?.isDirectory()) return;
  await chmod(path, Number(st.mode & 0o7777n) | 0o700).catch(() => {});
  for (const name of await readdir(path).catch(() => [] as string[])) await makeWritable(join(path, name));
}

/** 复制一个普通文件：先试写时复制（reflink），不支持就完整复制；目标位置不能已有东西。抄权限和时间 */
export async function copyRegular(src: string, dst: string, e: Entry): Promise<void> {
  await copyFile(src, dst, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  await chmod(dst, e.mode);
  await setTimes(dst, e);
}

export async function setTimes(path: string, e: Entry, isLink = false): Promise<void> {
  const at = Number(e.atimeNs) / 1e9;
  const mt = Number(e.mtimeNs) / 1e9;
  if (isLink) await lutimes(path, at, mt).catch(() => {});
  else await utimes(path, at, mt);
}

export interface CopyTreeOptions extends WalkOptions {
  /**
   * 可选的「上一份」：dst 是 snapshot 时，src 里没变的文件（和 linkFrom 里同路径的文件 sameFile）直接硬链接过去，省空间。
   * snapshot 建好后再也不改，所以 snapshot 之间共用 inode 是安全的；workspace 绝不和 snapshot 共用 inode。
   */
  linkFrom?: string;
  /** 跳过的项（读不了、FIFO 这类），给调用方记一笔 */
  onSkip?: (rel: string, reason: string) => void;
  /**
   * 复制途中消失的文件跳过而不是报错：从 workspace 或用户目录复制时用（后台进程、用户自己在删临时文件）；
   * 从 snapshot 复制时不能用，snapshot 不会变，少了东西就是出错了
   */
  skipVanished?: boolean;
}

/**
 * 把 src 整棵复制到 dst（dst 不能已存在）。目录先建成 0700 往里写，最后再改回原来的权限（只读目录也能复制）。
 * 符号链接照原样复制，不跟随；FIFO、socket、设备文件跳过。
 */
export async function copyTree(src: string, dst: string, opts: CopyTreeOptions = {}): Promise<{ files: number }> {
  let files = 0;
  const rootSt = await lstat(src, { bigint: true });
  if (!rootSt.isDirectory()) throw new MelinaError('invalid', `不是目录：${src}`);
  const copyDir = async (rel: string, dirEntry: Entry) => {
    const to = under(dst, rel);
    await mkdir(to, { mode: 0o700 });
    let items: { name: string; entry: Entry }[];
    try {
      items = await list(under(src, rel));
    } catch (e) {
      if (!isCode(e, 'EACCES') && !(opts.skipVanished && (isCode(e, 'ENOENT') || isCode(e, 'ENOTDIR')))) throw e;
      opts.onSkip?.(rel, isCode(e, 'EACCES') ? '没有读权限' : '复制时没了');
      items = [];
    }
    for (const { name, entry } of items) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (opts.skip?.(childRel, name, entry)) continue;
      const from = under(src, childRel);
      const target = under(dst, childRel);
      if (entry.kind === 'dir') {
        await copyDir(childRel, entry);
      } else if (entry.kind === 'symlink') {
        const linkTarget = await readlink(from).catch((e: unknown) => {
          if (opts.skipVanished && isCode(e, 'ENOENT')) return undefined;
          throw e;
        });
        if (linkTarget === undefined) continue;
        await symlink(linkTarget, target);
        await setTimes(target, entry, true);
      } else if (entry.kind === 'file') {
        files++;
        if (opts.linkFrom && (await tryLink(under(opts.linkFrom, childRel), target, entry))) continue;
        try {
          await copyRegular(from, target, entry);
        } catch (e) {
          if (!isCode(e, 'EACCES') && !(opts.skipVanished && isCode(e, 'ENOENT'))) throw e;
          opts.onSkip?.(childRel, isCode(e, 'EACCES') ? '没有读权限' : '复制时没了');
        }
      } else {
        opts.onSkip?.(childRel, '不是普通文件、目录或符号链接');
      }
    }
    await chmod(to, dirEntry.mode);
    await setTimes(to, dirEntry);
  };
  await copyDir('', entryOf(rootSt));
  return { files };
}

async function tryLink(prev: string, target: string, e: Entry): Promise<boolean> {
  const st = await lstatOrNull(prev);
  if (!st || !sameFile(entryOf(st), e)) return false;
  try {
    await link(prev, target);
    return true;
  } catch {
    return false; // 跨设备、链接数满了：退回复制
  }
}

/**
 * 让 dst 和 src 一模一样（restore 用）：多的删掉，变了的先删再复制，没变的（sameFile、链接目标相同）不动。
 * dst 必须是真目录。往下走的每一级都先确认是真目录，所以 dst 里的符号链接不会被穿过去。
 */
export async function syncTree(
  src: string,
  dst: string,
  opts: WalkOptions & { force?: (path: string) => Promise<void> } = {},
): Promise<void> {
  const removeTree = (p: string) => removeTreeWith(p, opts.force);
  const syncDir = async (rel: string) => {
    const from = under(src, rel);
    const to = under(dst, rel);
    const dirSt = entryOf(await lstat(from, { bigint: true }));
    const toSt = await lstat(to, { bigint: true });
    if (!toSt.isDirectory()) throw new MelinaError('internal', `不是目录：${to}`);
    await chmod(to, Number(toSt.mode & 0o7777n) | 0o700);
    const want = new Map((await list(from)).map((i) => [i.name, i.entry]));
    for (const { name, entry } of await list(to)) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (opts.skip?.(childRel, name, entry)) continue;
      if (!want.has(name)) await removeTree(join(to, name));
    }
    for (const [name, entry] of want) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (opts.skip?.(childRel, name, entry)) continue;
      const s = join(from, name);
      const d = join(to, name);
      const cur = await lstatOrNull(d);
      const curE = cur ? entryOf(cur) : null;
      if (entry.kind === 'dir') {
        if (curE && curE.kind !== 'dir') await removeTree(d);
        if (curE?.kind !== 'dir') await mkdir(d, { mode: 0o700 });
        await syncDir(childRel);
      } else if (entry.kind === 'symlink') {
        const target = await readlink(s);
        if (curE?.kind === 'symlink' && (await readlink(d)) === target) continue;
        if (curE) await removeTree(d);
        await symlink(target, d);
        await setTimes(d, entry, true);
      } else if (entry.kind === 'file') {
        if (curE && sameFile(curE, entry)) continue;
        if (curE) await removeTree(d);
        await copyRegular(s, d, entry);
      }
    }
    await chmod(to, dirSt.mode);
    await setTimes(to, dirSt);
  };
  await syncDir('');
}

/** 两个普通文件的内容是否相同（大小已知相同时才调） */
export async function sameContent(a: string, b: string): Promise<boolean> {
  const fa = await open(a, 'r');
  const fb = await open(b, 'r');
  try {
    const ba = Buffer.alloc(64 * 1024);
    const bb = Buffer.alloc(64 * 1024);
    for (;;) {
      const [ra, rb] = await Promise.all([fa.read(ba, 0, ba.length, null), fb.read(bb, 0, bb.length, null)]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false;
    }
  } finally {
    await fa.close();
    await fb.close();
  }
}

/**
 * 往 root 下的 rel 放一个文件（被忽略的小文件用）：rel 已经有东西就不放；
 * 父目录一级级确认是真目录，没有就建；碰到符号链接或别的东西就放弃这个文件，返回 false。
 */
export async function placeFile(root: string, rel: string, src: string, e: Entry): Promise<boolean> {
  const parts = rel.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    if (part === '' || part === '.' || part === '..') return false;
    dir = join(dir, part);
    const st = await lstatOrNull(dir);
    if (!st) await mkdir(dir, { mode: 0o755 });
    else if (!st.isDirectory()) return false;
  }
  const last = parts.at(-1);
  if (!last || last === '.' || last === '..') return false;
  try {
    await copyRegular(src, join(dir, last), e);
    return true;
  } catch (e2) {
    if (isCode(e2, 'EEXIST')) return false;
    throw e2;
  }
}

let tmpCounter = 0;

/** 原子地写一个小文件：先写临时文件再改名 */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

/** path 在 dir 里面（或就是 dir） */
export function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

export function isCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

/** 文件系统错误里的「磁盘满了」统一换成 unavailable */
export function diskFull(e: unknown, what: string): unknown {
  if (isCode(e, 'ENOSPC') || isCode(e, 'EDQUOT')) return new MelinaError('unavailable', `磁盘满了，${what}没做完`);
  return e;
}
