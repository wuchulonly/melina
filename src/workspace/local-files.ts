// 工作目录里被 .gitignore 忽略的小文件（.env、本地配置这类），git-clone 的 snapshot 里没有它们。
//
//  说「工作目录里本来就有的密钥」AI 可以用，但 snapshot 不含被忽略的文件，agent 就看不到 .env，测试也跑不起来。
// 所以开跑时把被忽略的小文件抄一份到 local/，每次建 workspace 时放进去（那个位置已经有东西就不放）。
// 它们不进 snapshot、不进 patch、不进交付的分支；被忽略的目录（node_modules、dist、.venv）不抄，由 workspace.setup 重建。

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { entryOf, placeFile, under, writeAtomic } from './files.ts';
import { readJson } from './meta.ts';

export const LOCAL_FILE_MAX = 1024 * 1024;
export const LOCAL_TOTAL_MAX = 32 * 1024 * 1024;
export const LOCAL_COUNT_MAX = 1000;

export interface LocalManifest {
  files: string[];
  skipped: { rel: string; why: string }[];
}

/**
 * ignored 是 git ls-files --others --ignored --directory 的输出（目录以 / 结尾）。
 * 只抄普通文件，不跟随链接，单个不超过 1 MiB，合计不超过 32 MiB、1000 个。
 */
export async function captureLocal(root: string, ignored: string[], dest: string): Promise<LocalManifest> {
  const out: LocalManifest = { files: [], skipped: [] };
  let total = 0;
  for (const rel of [...ignored].sort()) {
    if (rel.endsWith('/') || rel.split('/').some((p) => p === '.git' || p === '' || p === '..')) continue;
    const st = await lstat(under(root, rel), { bigint: true }).catch(() => null);
    if (!st?.isFile()) continue;
    const e = entryOf(st);
    if (e.size > BigInt(LOCAL_FILE_MAX)) {
      out.skipped.push({ rel, why: '超过 1 MiB' });
      continue;
    }
    if (out.files.length >= LOCAL_COUNT_MAX || total + Number(e.size) > LOCAL_TOTAL_MAX) {
      out.skipped.push({ rel, why: '被忽略的小文件太多' });
      continue;
    }
    if (await placeFile(dest, rel, under(root, rel), e)) {
      out.files.push(rel);
      total += Number(e.size);
    }
  }
  return out;
}

/** 放进 workspace：那个位置已经有东西、或者父目录里有符号链接，就跳过 */
export async function placeLocal(src: string, files: readonly string[], ws: string): Promise<number> {
  let n = 0;
  for (const rel of files) {
    const st = await lstat(under(src, rel), { bigint: true }).catch(() => null);
    if (!st?.isFile()) continue;
    if (await placeFile(ws, rel, under(src, rel), entryOf(st))) n++;
  }
  return n;
}

export function manifestPath(runDir: string): string {
  return join(runDir, 'local.json');
}

export async function readManifest(runDir: string): Promise<LocalManifest> {
  return (await readJson<LocalManifest>(manifestPath(runDir))) ?? { files: [], skipped: [] };
}

export function writeManifest(runDir: string, m: LocalManifest): Promise<void> {
  return writeAtomic(manifestPath(runDir), `${JSON.stringify(m)}\n`);
}
