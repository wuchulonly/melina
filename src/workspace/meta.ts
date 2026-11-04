// provider 自己的小账本：每个 snapshot 一个 JSON（lineage 和是否清理过），每个 workspace 一个 JSON（现在和哪个 snapshot 对齐）。
// RunStore 的 Snapshot 记录才是 lineage 的正本；这里留一份是为了 prune 时知道哪些 snapshot 是这个 workspace 打的，
// 以及内容清掉以后再要它时报「已经清理了」而不是「不存在」。

import { readdir, readFile } from 'node:fs/promises';
import type { SnapshotId } from '../core/ids.ts';
import { isCode, writeAtomic } from './files.ts';
import type { RunPaths } from './layout.ts';

export interface SnapshotMeta {
  id: SnapshotId;
  /** 打它的 workspace；根 snapshot 没有 */
  ws?: string;
  /** 打的时候 workspace 和哪个 snapshot 对齐，即 lineage 上的父节点 */
  base?: SnapshotId;
  label?: string;
  at: string;
  /** 内容清理掉的时间；记录本身一直留着 */
  pruned?: string;
}

export interface WsState {
  /** workspace 现在和哪个 snapshot 对齐：建出来时是来源，之后是最近一次 snapshot 或 restore 的目标 */
  base: SnapshotId;
  /** 建它用的 snapshot */
  from: SnapshotId;
  createdAt: string;
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    if (isCode(e, 'ENOENT')) return undefined;
    throw e;
  }
}

export function writeMeta(paths: RunPaths, meta: SnapshotMeta): Promise<void> {
  return writeAtomic(paths.meta(meta.id), `${JSON.stringify(meta)}\n`);
}

export function readMeta(paths: RunPaths, id: SnapshotId): Promise<SnapshotMeta | undefined> {
  return readJson<SnapshotMeta>(paths.meta(id));
}

export async function listMeta(paths: RunPaths): Promise<SnapshotMeta[]> {
  let names: string[];
  try {
    names = await readdir(paths.metaDir);
  } catch (e) {
    if (isCode(e, 'ENOENT')) return [];
    throw e;
  }
  const out: SnapshotMeta[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const m = await readMeta(paths, name.slice(0, -'.json'.length));
    if (m) out.push(m);
  }
  return out;
}

export function writeWsState(paths: RunPaths, wsId: string, state: WsState): Promise<void> {
  return writeAtomic(paths.wsState(wsId), `${JSON.stringify(state)}\n`);
}

export function readWsState(paths: RunPaths, wsId: string): Promise<WsState | undefined> {
  return readJson<WsState>(paths.wsState(wsId));
}
