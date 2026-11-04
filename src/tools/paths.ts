// 容器里的路径：read、edit、write 只能操作本 workspace 里的文件，read 也能读 /melina 下的只读目录。
// 路径一律在容器里解析（文件工具都在调用方的容器里执行），这里只做字面上的规范化和范围检查：
// 符号链接在容器的挂载命名空间里解析，碰不到宿主机上的东西。

import { posix } from 'node:path';
import { type Handle, handlePath } from '../core/ids.ts';
import { CONTAINER_PATHS } from '../core/interfaces/container.ts';

export const WORKSPACE = CONTAINER_PATHS.workspace;
export const MELINA_DIR = '/melina';

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * 模型给的路径换成容器里的绝对路径：相对路径按 workspace 算。
 * allowMelina：read 也能读 /melina 下的只读目录（附件、原始输出）。file：要的是文件，不能是 workspace 根目录本身。
 */
export function containerPath(input: string, opts: { allowMelina: boolean; file: boolean }): PathCheck {
  const raw = input.trim();
  if (raw === '') return { ok: false, reason: '路径是空的' };
  if (raw.includes('\0')) return { ok: false, reason: '路径里不能有 NUL 字符' };
  const absolute = raw.startsWith('/') ? raw : posix.join(WORKSPACE, raw);
  let path = posix.normalize(absolute);
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const inWorkspace = path === WORKSPACE || path.startsWith(`${WORKSPACE}/`);
  const inMelina = path === MELINA_DIR || path.startsWith(`${MELINA_DIR}/`);
  if (!inWorkspace && !(opts.allowMelina && inMelina)) {
    const where = opts.allowMelina ? `workspace（${WORKSPACE}）和 ${MELINA_DIR} 下` : `workspace（${WORKSPACE}）里`;
    return { ok: false, reason: `只能操作${where}的文件，${raw} 不在范围内；别的位置用 sh 看` };
  }
  if (opts.file && path === WORKSPACE) return { ok: false, reason: '要给一个文件，不是 workspace 根目录' };
  return { ok: true, path };
}

/** 给模型和人看的路径：workspace 里的写成相对路径 */
export function displayPath(path: string): string {
  if (path === WORKSPACE) return '.';
  return path.startsWith(`${WORKSPACE}/`) ? path.slice(WORKSPACE.length + 1) : path;
}

/** 原始输出在沙箱里的只读路径：/melina/artifacts/<sha256 前两位>/<sha256> */
export function artifactPath(handle: Handle): string {
  return `${CONTAINER_PATHS.artifacts}/${handlePath(handle)}`;
}

/** bash 的单引号转义 */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** base64，每 76 个字符一行（heredoc 里放得下，base64 -d 认换行） */
export function base64Lines(content: string | Uint8Array): string {
  const b64 = Buffer.from(content).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\n');
}
