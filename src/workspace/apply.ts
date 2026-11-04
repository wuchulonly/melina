// WorkspaceProvider.apply：把 patch 打到 workspace 的工作区。两种 provider 共用。

import { git } from './git.ts';

/**
 * git apply 到工作区（不碰暂存区，原子的：失败就一点不动）。gitDir 是 Melina 自己的（store 或临时的空仓库），
 * 不读 workspace 里的 .git；git 自己会拒绝往符号链接里面写、拒绝 .. 和 .git 路径。失败时从报错里摘出冲突的文件。
 * 不像收工作区那样有「不读 .gitattributes 再试」的退路：git 2.43 的 `git --attr-source=… apply` 会段错误（10-02 试过）。
 */
export async function applyPatch(
  gitDir: string,
  worktree: string,
  patchFile: string,
): Promise<{ ok: boolean; conflicts?: string[] }> {
  const r = await git({
    gitDir,
    workTree: worktree,
    cwd: worktree,
    args: ['apply', '--whitespace=nowarn', patchFile],
    okCodes: [0, 1, 128],
  });
  if (r.code === 0) return { ok: true };
  return { ok: false, conflicts: parseApplyConflicts(r.stderr) };
}

const OTHER_ERRORS = [
  'patch does not apply',
  'No such file or directory',
  'already exists in working directory',
  'does not exist in index',
  'does not match index',
  'wrong type',
  'is beyond a symbolic link',
];

/** 从 git apply 的报错里摘出出问题的文件（LC_ALL=C 下的英文报错） */
export function parseApplyConflicts(stderr: string): string[] {
  const out = new Set<string>();
  for (const line of stderr.split('\n')) {
    const failed = /^error: patch failed: (.+):\d+$/.exec(line);
    if (failed?.[1]) {
      out.add(failed[1]);
      continue;
    }
    for (const tail of OTHER_ERRORS) {
      const suffix = `: ${tail}`;
      if (line.startsWith('error: ') && line.endsWith(suffix)) {
        out.add(line.slice('error: '.length, -suffix.length));
        break;
      }
    }
  }
  if (out.size === 0 && stderr.trim()) out.add(stderr.trim().split('\n')[0] ?? 'patch 打不上');
  return [...out];
}
