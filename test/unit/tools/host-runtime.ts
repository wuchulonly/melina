// 测试用的容器运行时：命令在宿主机上用 bash 真跑，容器里的路径（/workspace、/melina/artifacts、/melina/materials、/melina/logs）
// 按每个容器的挂载换成宿主机上的目录。只用来测 ToolGateway：它不管只读挂载、内存上限这些。
// 凭证以环境变量给进去，输出返回前过一遍 redactor，和 PodmanRuntime 一样。

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { conflict } from '../../../src/core/errors.ts';
import type {
  ContainerExecRequest,
  ContainerExecResult,
  ContainerRef,
  ContainerRuntime,
  ContainerSpec,
  Redactor,
} from '../../../src/core/interfaces/container.ts';

interface Hosted {
  ref: ContainerRef;
  spec: ContainerSpec;
  running: boolean;
  /** 容器里的路径 → 宿主机上的目录，长的在前 */
  mounts: [string, string][];
  logs: string;
  /** 起过的后台进程：停容器时一起杀掉 */
  background: { pid: number; cmd: string; log: string }[];
}

export class HostRuntime implements ContainerRuntime {
  readonly containers = new Map<string, Hosted>();
  readonly execs: { name: string; cmd: string }[] = [];
  readonly #redactor: Redactor | undefined;
  readonly #root: string;

  constructor(options: { root: string; redactor?: Redactor }) {
    this.#root = options.root;
    this.#redactor = options.redactor;
  }

  async checkImages(domains: readonly string[]) {
    return domains.map((domain) => ({ domain, image: `localhost/melina-${domain}:test`, present: true }));
  }

  /** 只执行测试自己写的命令；真实冻结由 Podman 集成测试验证 */
  async withWorkspaceFrozen<T>(_path: string, work: () => Promise<T>): Promise<T> {
    return work();
  }

  async start(spec: ContainerSpec): Promise<ContainerRef> {
    const existing = this.containers.get(spec.name);
    if (existing) {
      existing.running = true;
      return existing.ref;
    }
    const logs = join(this.#root, 'logs', spec.name);
    mkdirSync(logs, { recursive: true });
    const mounts: [string, string][] = [
      ['/workspace', spec.workspace.host],
      ['/melina/logs', logs],
    ];
    if (spec.artifactsDir) mounts.push(['/melina/artifacts', spec.artifactsDir]);
    if (spec.materialsDir) mounts.push(['/melina/materials', spec.materialsDir]);
    mounts.sort((a, b) => b[0].length - a[0].length);
    const ref = { id: spec.name, name: spec.name };
    this.containers.set(spec.name, { ref, spec, running: true, mounts, logs, background: [] });
    return ref;
  }

  async ephemeral(spec: ContainerSpec): Promise<ContainerRef> {
    this.containers.delete(spec.name);
    return this.start(spec);
  }

  async stop(ref: ContainerRef): Promise<void> {
    const c = this.containers.get(ref.name);
    if (!c) return;
    c.running = false;
    for (const p of c.background) killGroup(p.pid);
    c.background = [];
  }

  async remove(ref: ContainerRef): Promise<void> {
    await this.stop(ref);
    this.containers.delete(ref.name);
  }

  async find(name: string): Promise<ContainerRef | undefined> {
    return this.containers.get(name)?.ref;
  }

  /** 容器里的路径换成宿主机上的 */
  hostPath(ref: ContainerRef, path: string): string {
    const c = this.#must(ref);
    return rewrite(path, c.mounts);
  }

  async exec(ref: ContainerRef, req: ContainerExecRequest): Promise<ContainerExecResult> {
    if ((req.capturePrivate || req.inspectPrivate) && req.background) throw new Error('私有输出处理只支持前台调用');
    if (req.capturePrivate && req.inspectPrivate) throw new Error('私有捕获和被动检查不能同时使用');
    const c = this.#must(ref);
    if (!c.running) throw conflict(`容器 ${ref.name} 没在运行`);
    this.execs.push({ name: ref.name, cmd: req.cmd });
    const started = Date.now();
    if (req.signal?.aborted) return { exitCode: null, output: '', timedOut: false, cancelled: true, durationMs: 0 };
    const cmd = rewrite(req.cmd, c.mounts);
    const cwd = req.cwd ? join(c.spec.workspace.host, req.cwd) : c.spec.workspace.host;
    const env: NodeJS.ProcessEnv = { ...process.env, ...(req.env ?? {}) };
    for (const cred of c.spec.credentials) if ('env' in cred.as) env[cred.as.env] = cred.value;

    if (req.background) {
      const temp = join(c.logs, `starting-${Date.now()}.log`);
      const fd = openSync(temp, 'a');
      const child = spawn('bash', ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
      child.on('error', () => {}); // 起不来时 pid 是 undefined，下面当失败的命令交回；没人接的 error 事件会让整个进程退出
      child.unref();
      closeSync(fd);
      if (child.pid === undefined) return spawnFailed(started);
      const pid = child.pid;
      renameSync(temp, join(c.logs, `bg-${pid}.log`));
      const containerLog = `/melina/logs/bg-${pid}.log`;
      c.background.push({ pid, cmd: req.cmd, log: containerLog });
      return {
        exitCode: 0,
        output: '',
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - started,
        background: { pid, log: containerLog },
      };
    }

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false;
      const finish = (result: ContainerExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      // 起不来（这台开发机 cgroup 只许 1024 个进程，几个会话一起跑时 spawn 会 EAGAIN）：当成一次失败的命令交回，
      // 不然没人接的 error 事件让整个测试进程退出
      child.on('error', (error) => finish(spawnFailed(started, error)));
      const chunks: Buffer[] = [];
      child.stdout?.on('data', (b: Buffer) => chunks.push(b));
      child.stderr?.on('data', (b: Buffer) => chunks.push(b));
      let timedOut = false;
      let cancelled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, req.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        killGroup(child.pid);
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('close', (code) => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let inspected: string | undefined;
        if (code === 0 && !timedOut && !cancelled) {
          try {
            req.capturePrivate?.(raw);
            inspected = req.inspectPrivate?.(raw);
          } catch {
            finish({ exitCode: 1, output: '私有来源提取失败', timedOut, cancelled, durationMs: Date.now() - started });
            return;
          }
        }
        const output = req.capturePrivate
          ? '私有来源输出未回传，请通过受控引用登记'
          : this.#redactor
            ? this.#redactor.redact(inspected ?? raw)
            : (inspected ?? raw);
        finish({
          exitCode: timedOut || cancelled ? null : code,
          output,
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
        });
      });
    });
  }

  #must(ref: ContainerRef): Hosted {
    const c = this.containers.get(ref.name);
    if (!c) throw conflict(`容器 ${ref.name} 不存在`);
    return c;
  }
}

/** 命令起不来：像 shell 找不到能执行的东西那样交回 126 */
function spawnFailed(started: number, error?: Error): ContainerExecResult {
  return {
    exitCode: 126,
    output: `命令起不来：${error?.message ?? '没拿到进程号'}\n`,
    timedOut: false,
    cancelled: false,
    durationMs: Date.now() - started,
  };
}

/** 一遍换完（换进去的宿主机路径不会再被换一次）；长的挂载点优先 */
function rewrite(text: string, mounts: readonly [string, string][]): string {
  const map = new Map(mounts);
  const pattern = new RegExp(`(${mounts.map(([inside]) => escapeRe(inside)).join('|')})(?=$|[/'"\\s;|&)])`, 'g');
  return text.replace(pattern, (inside) => map.get(inside) ?? inside);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 已经没了
  }
}
