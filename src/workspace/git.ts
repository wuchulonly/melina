// 在宿主机上跑 git。
//
// workspace 归 agent 管：它在容器里能改 workspace/.git/config、hooks、.gitattributes，能放符号链接。
// Melina 在宿主机上跑 git 时不能执行这些东西，否则容器就白隔离了。所以每次调用：
// - 用 -c 关掉 hook、fsmonitor、签名、自动 gc 和 reflog，只许本地路径的传输；
// - 默认不读系统和全局配置（trust 'isolated'），clean、smudge 这类 filter 一个都没有；只有读用户自己的仓库时用 'user'；
// - 环境变量去掉所有 GIT_*，换成固定的作者、LC_ALL=C（报错好解析），不弹提示，不认 replace ref；
// - 都有超时，到点杀掉整个进程组：工作区里有 FIFO、配置 include 了奇怪的文件也卡不住 Melina。

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { MelinaError } from '../core/errors.ts';

/** git 的空树，--attr-source 用它表示「不读工作区里的 .gitattributes」 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const GIT_TIMEOUT_MS = 10 * 60_000;

/** 提交用的作者：snapshot 的提交只在 Melina 自己的 store 里，交付的提交写进用户仓库的 melina/<runId> 分支 */
export const MELINA_AUTHOR = { name: 'Melina', email: 'melina@localhost' } as const;

const HARDEN = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.logAllRefUpdates=false',
  'core.quotePath=false',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'log.showSignature=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'fetch.writeCommitGraph=false',
  'fetch.recurseSubmodules=false',
  'submodule.recurse=false',
  'protocol.allow=never',
  'protocol.file.allow=always',
  'advice.detachedHead=false',
];

export interface GitOptions {
  args: readonly string[];
  /** --git-dir */
  gitDir?: string;
  /** --work-tree */
  workTree?: string;
  /** 子进程的工作目录（git clean、apply 按它算路径） */
  cwd?: string;
  /** GIT_INDEX_FILE */
  indexFile?: string;
  /** 'isolated'（默认）：不读系统、全局配置；'user'：读，只给用户自己的仓库用 */
  trust?: 'isolated' | 'user';
  /** --attr-source：不读工作区里的 .gitattributes（agent 把它写坏了时的退路） */
  attrSource?: string;
  /** 额外的 -c */
  config?: readonly string[];
  /** pathspec 一律按字面算（文件名里的 * ? [ : 不当通配） */
  literalPathspecs?: boolean;
  input?: string | Uint8Array;
  /** 从这个文件读 stdin */
  inputFile?: string;
  /** stdout 写进这个文件，不进内存（大 patch、pack） */
  stdoutFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 这些退出码不算错；默认只有 0 */
  okCodes?: readonly number[];
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const STDERR_KEEP = 64 * 1024;

export function git(o: GitOptions): Promise<GitResult> {
  const argv: string[] = [];
  for (const c of [...HARDEN, ...(o.config ?? [])]) argv.push('-c', c);
  if (o.attrSource) argv.push(`--attr-source=${o.attrSource}`);
  if (o.gitDir) argv.push(`--git-dir=${o.gitDir}`);
  if (o.workTree) argv.push(`--work-tree=${o.workTree}`);
  argv.push(...o.args);
  const sub = o.args[0] ?? 'git';
  const timeoutMs = o.timeoutMs ?? GIT_TIMEOUT_MS;

  return new Promise<GitResult>((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(abortError(o.signal));
      return;
    }
    const child = spawn('git', argv, {
      cwd: o.cwd,
      env: gitEnv(o),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // 自己一个进程组：超时、取消时连 git 起的子进程（upload-pack 等）一起杀
    });
    const out: Buffer[] = [];
    let err = '';
    let settled = false;
    let killedBy: 'timeout' | 'abort' | undefined;

    const kill = (why: 'timeout' | 'abort') => {
      killedBy = why;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = () => kill('abort');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const fileOut = o.stdoutFile ? createWriteStream(o.stdoutFile) : undefined;
    const stdoutClosed = fileOut
      ? new Promise<void>((res, rej) => {
          fileOut.on('finish', () => res());
          fileOut.on('error', rej);
        })
      : Promise.resolve();
    if (fileOut) child.stdout.pipe(fileOut);
    else child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8');
      if (err.length > STDERR_KEEP * 2) err = err.slice(-STDERR_KEEP);
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      done(() =>
        reject(
          e.code === 'ENOENT'
            ? new MelinaError('unavailable', '这台机器上没有 git：Melina 的 workspace 要用它')
            : new MelinaError('internal', `git ${sub} 起不来：${e.message}`),
        ),
      );
    });
    child.on('close', (code) => {
      stdoutClosed.then(
        () =>
          done(() => {
            if (killedBy === 'abort' && o.signal) return reject(abortError(o.signal));
            if (killedBy === 'timeout') {
              return reject(new MelinaError('internal', `git ${sub} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
            }
            const exit = code ?? -1;
            const result = { code: exit, stdout: Buffer.concat(out).toString('utf8'), stderr: err };
            if ((o.okCodes ?? [0]).includes(exit)) return resolve(result);
            reject(gitFailure(sub, result, o.args));
          }),
        (e: unknown) => done(() => reject(new MelinaError('internal', `写 git ${sub} 的输出失败：${String(e)}`))),
      );
    });

    child.stdin.on('error', () => {}); // git 不读 stdin 就退出时，写入会 EPIPE，不算错
    if (o.inputFile) {
      createReadStream(o.inputFile)
        .on('error', (e) => done(() => reject(new MelinaError('internal', `读 ${o.inputFile} 失败：${e.message}`))))
        .pipe(child.stdin);
    } else {
      child.stdin.end(o.input ?? '');
    }
  });
}

/** 只要 stdout，去掉末尾换行 */
export async function gitOut(o: GitOptions): Promise<string> {
  return (await git(o)).stdout.replace(/\n$/, '');
}

/** git 报的「磁盘满了」统一换成 unavailable，调度那边按磁盘不足处理 */
function gitFailure(sub: string, r: GitResult, args: readonly string[]): MelinaError {
  const tail = r.stderr.trim().split('\n').slice(-6).join('\n');
  if (/No space left on device|ENOSPC/i.test(r.stderr)) {
    return new MelinaError('unavailable', `磁盘满了，git ${sub} 没做完`, { args, code: r.code, stderr: tail });
  }
  return new MelinaError('internal', `git ${sub} 失败（退出码 ${r.code}）：${tail || '没有输出'}`, {
    args,
    code: r.code,
    stderr: tail,
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new MelinaError('conflict', '操作被取消了');
}

function gitEnv(o: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  Object.assign(env, {
    LC_ALL: 'C',
    LANGUAGE: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_AUTHOR_NAME: MELINA_AUTHOR.name,
    GIT_AUTHOR_EMAIL: MELINA_AUTHOR.email,
    GIT_COMMITTER_NAME: MELINA_AUTHOR.name,
    GIT_COMMITTER_EMAIL: MELINA_AUTHOR.email,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
  });
  if (o.trust !== 'user') {
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = '/dev/null';
  }
  if (o.indexFile) env.GIT_INDEX_FILE = o.indexFile;
  if (o.literalPathspecs) env.GIT_LITERAL_PATHSPECS = '1';
  return env;
}

/** -z 输出按 NUL 拆开，去掉空项 */
export function splitZ(text: string): string[] {
  return text.split('\0').filter((s) => s.length > 0);
}
