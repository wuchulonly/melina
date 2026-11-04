// workspace 集成测试的小工具：临时目录、跑 shell、假的 Artifact store、在宿主机上跑的执行器（只给测试用，
// 真的 setup 在容器里跑，见 src/workspace/exec.ts）、造 Run。

import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RUN_CONFIG } from '../../../src/core/config.ts';
import { type Handle, handleOf, newId, type SnapshotId } from '../../../src/core/ids.ts';
import type { ArtifactStore } from '../../../src/core/interfaces/artifacts.ts';
import type { Run, WorkspaceKind } from '../../../src/core/types.ts';
import type { WorkspaceExec } from '../../../src/workspace/base.ts';

/** 测试用的 git 环境：不读系统配置，作者固定；HOME 用当时的（测试里换成了临时目录） */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
  };
}

/** 在 cwd 里跑一段 bash，返回 stdout（去掉末尾换行）；失败就抛错，带上 stderr */
export function sh(cwd: string, script: string, env: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd,
      env: { ...gitEnv(), ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\n$/, '');
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error(`命令失败：${script}\n${err.stderr ?? ''}${err.stdout ?? ''}`);
  }
}

/** 一个测试的临时目录：home（假的 HOME，没有全局 git 配置）、data（Melina 的数据目录） */
export function sandbox(prefix: string): { dir: string; home: string; data: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `melina-${prefix}-`));
  const home = join(dir, 'home');
  const data = join(dir, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  return { dir, home, data, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 内存里的 Artifact store，按内容寻址。 */
export function memoryArtifacts(): ArtifactStore & { text(handle: Handle): string } {
  const blobs = new Map<string, Uint8Array>();
  const key = (runId: string, h: Handle) => `${runId}/${h}`;
  const store: ArtifactStore & { text(handle: Handle): string } = {
    async put(runId, content) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const h = handleOf(bytes);
      blobs.set(key(runId, h), bytes);
      return h;
    },
    async putFile(runId, path) {
      return store.put(runId, new Uint8Array(readFileSync(path)));
    },
    async has(runId, h) {
      return blobs.has(key(runId, h));
    },
    async read(runId, h) {
      const b = blobs.get(key(runId, h));
      if (!b) throw new Error(`没有这个产物：${h}`);
      return b;
    },
    async readLines(runId, h) {
      const text = new TextDecoder().decode(await store.read(runId, h));
      return { text, totalLines: text.split('\n').length };
    },
    async stat(runId, h) {
      const b = blobs.get(key(runId, h));
      return b ? { size: b.length } : undefined;
    },
    path(runId, h) {
      return `/memory/${runId}/${h}`;
    },
    async copy(from, h, to) {
      blobs.set(key(to, h), await store.read(from, h));
      return h;
    },
    async deleteRun(runId) {
      for (const k of [...blobs.keys()]) if (k.startsWith(`${runId}/`)) blobs.delete(k);
    },
    text(h) {
      for (const [k, v] of blobs) if (k.endsWith(`/${h}`)) return new TextDecoder().decode(v);
      throw new Error(`没有这个产物：${h}`);
    },
  };
  return store;
}

/** 只给测试用：直接在宿主机上、在 workspace 目录里跑命令（真的执行器起容器） */
export function hostExecutor(log: { cmd: string[]; cwd: string }[] = []): WorkspaceExec {
  return (ws, cmd, opts) =>
    new Promise((resolve) => {
      const cwd = opts.cwd ? join(ws.path, opts.cwd) : ws.path;
      log.push({ cmd, cwd });
      const started = Date.now();
      const child = spawn(cmd[0] ?? 'true', cmd.slice(1), { cwd, env: { ...gitEnv(), ...opts.env } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString();
      });
      child.on('close', (code) =>
        resolve({
          exitCode: code,
          stdout,
          stderr,
          timedOut: false,
          cancelled: false,
          durationMs: Date.now() - started,
        }),
      );
    });
}

export function makeRun(o: {
  root: string;
  kind: WorkspaceKind;
  id?: string;
  from?: { runId: string; snapshot: SnapshotId };
  setup?: string;
  statement?: string;
}): Run {
  return {
    id: o.id ?? newId(),
    seq: 1,
    goal: { statement: o.statement ?? '把搜索结果的高亮修好', constraints: [], materials: [] },
    workspace: {
      root: o.root,
      kind: o.kind,
      ...(o.from ? { from: o.from } : {}),
      ...(o.setup ? { setup: o.setup } : {}),
    },
    mode: 'direct',
    status: 'running',
    config: DEFAULT_RUN_CONFIG,
    createdAt: new Date().toISOString(),
  };
}

/** 目录树的文字快照：路径 → 'dir'、'link -> 目标'、文件内容（可执行的前面加 'x '）。默认不含顶层的 .git */
export function treeOf(root: string, opts: { withGit?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (rel: string) => {
    for (const name of readdirSync(rel ? join(root, rel) : root).sort()) {
      if (!opts.withGit && rel === '' && name === '.git') continue;
      const r = rel ? `${rel}/${name}` : name;
      const p = join(root, r);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link -> ${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[r] = 'dir';
        visit(r);
      } else if (st.isFile()) out[r] = `${st.mode & 0o111 ? 'x ' : ''}${readFileSync(p, 'utf8')}`;
    }
  };
  visit('');
  return out;
}

export { newId };
