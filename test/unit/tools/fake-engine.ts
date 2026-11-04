// 假的容器引擎：在内存里模拟 podman 的命令行（建、启、停、删、查、镜像），记下每次调用的参数、stdin 和额外的环境变量。
// hostExec 打开时，exec 在宿主机上真跑那段 sh（容器里的路径由 PodmanRuntime 的 paths 换成临时目录），
// 用来测前台命令的超时、取消、结束标记和后台进程。

import { spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Engine, EngineKind, EngineProcess, SpawnOptions } from '../../../src/tools/container.ts';

export interface FakeContainer {
  id: string;
  name: string;
  running: boolean;
  paused: boolean;
  labels: Record<string, string>;
  env: string[];
  /** 建它时 run 的完整参数 */
  args: string[];
  /** 用 melina-write 写进去的文件 */
  files: Map<string, string>;
}

export interface Reply {
  code: number;
  stdout?: string;
  stderr?: string;
}

export interface FakeCall {
  args: string[];
  input?: string;
  env?: Record<string, string>;
}

export class FakeEngine implements Engine {
  readonly kind: EngineKind;
  readonly calls: FakeCall[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Set<string>();
  /** info 里报的能力 */
  info: {
    memoryLimit: boolean;
    pidsLimit: boolean;
    rootless: boolean;
    cgroupManager?: string;
    serverErrors?: string[];
  } = { memoryLimit: true, pidsLimit: true, rootless: true, cgroupManager: 'systemd' };
  /** exec 在宿主机上真跑 */
  hostExec = false;
  /**
   * 不是 hostExec 时 melina-exec 的结果（cmd 是从 stdin 传进来的命令）。counters 是结束标记里退出码后面的三个 cgroup 计数增量
   * ，不给就是老样子只有退出码
   */
  execReply: (container: FakeContainer, cmd: string) => { output: string; code: number; counters?: string } = () => ({
    output: '',
    code: 0,
  });
  /** melina-exec 一直不结束，直到客户端被杀 */
  execHang = false;
  /** melina-kill 的结果；默认成功 */
  killReply: Reply = { code: 0 };
  /** 写凭证文件时失败 */
  failWrite = false;
  /** run 把容器建出来了，启动却失败（容器留在 Created 状态） */
  failStartAfterCreate = false;
  failPause?: string;
  failUnpause?: string;
  /** 容器建出来没有自己的 cgroup（rootless 没让 systemd 管 cgroup）：哪个容器都 pause 不了 */
  noCgroup = false;
  /** 没装 slirp4netns（Podman 5 默认用 pasta）：要 slirp4netns 网络的容器建得出来、起不来 */
  noSlirp4netns = false;
  #next = 1;

  constructor(kind: EngineKind = 'podman') {
    this.kind = kind;
  }

  /** 引擎里已有的容器（模拟上次运行留下的） */
  add(name: string, partial: Partial<FakeContainer> = {}): FakeContainer {
    const c: FakeContainer = {
      id: this.#newId(),
      name,
      running: true,
      paused: false,
      labels: {},
      env: ['PATH=/usr/bin:/bin'],
      args: [],
      files: new Map(),
      ...partial,
    };
    this.containers.set(name, c);
    return c;
  }

  callsOf(command: string): string[][] {
    return this.calls.filter((c) => c.args[0] === command).map((c) => c.args);
  }

  spawn(args: readonly string[], options: SpawnOptions = {}): EngineProcess {
    const argv = [...args];
    const call: FakeCall = { args: argv, env: options.env };
    this.calls.push(call);
    if (argv[0] === 'exec' && this.hostExec) {
      const target = this.#execTarget(argv);
      const c = this.#find(target.name);
      if (c?.running) return hostProcess(target.rest, target.env, options.stdin === true);
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = options.stdin ? new PassThrough() : null;
    let release: () => void = () => {};
    const killed = new Promise<void>((r) => {
      release = r;
    });
    const closed = (async () => {
      if (stdin) call.input = await readAll(stdin);
      await new Promise((r) => setImmediate(r));
      if (this.execHang && argv[0] === 'exec' && argv.includes('melina-exec')) {
        await killed;
        stdout.end();
        stderr.end();
        return null;
      }
      const reply = this.#handle(argv, call);
      stdout.end(reply.stdout ?? '');
      stderr.end(reply.stderr ?? '');
      await Promise.all([finished(stdout), finished(stderr)]).catch(() => undefined);
      return reply.code;
    })();
    return { stdout, stderr, stdin, closed, kill: () => release() };
  }

  #handle(argv: string[], call: FakeCall): Reply {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case 'info':
        return { code: 0, stdout: JSON.stringify(this.#infoJson()) };
      case 'image': {
        const image = rest[rest.length - 1] ?? '';
        if (!this.images.has(image)) return { code: 1, stderr: `Error: ${image}: image not known` };
        return { code: 0, stdout: rest.includes('{{.Size}}') ? '1073741824\n' : 'sha256:abc\n' };
      }
      case 'images':
        return { code: 0, stdout: [...this.images].map((i) => `${i}\n`).join('') };
      case 'rmi':
        this.images.delete(rest[0] ?? '');
        return { code: 0 };
      case 'build': {
        const tag = rest[rest.indexOf('-t') + 1] ?? '';
        this.images.add(tag);
        return { code: 0, stdout: `built ${tag}\n` };
      }
      case 'container': {
        const found = rest.slice(1).map((n) => this.#find(n));
        if (found.some((c) => !c)) return { code: 125, stderr: `Error: no such container ${rest.slice(1).join(' ')}` };
        return { code: 0, stdout: JSON.stringify(found.map((c) => this.#inspectJson(c as FakeContainer))) };
      }
      case 'run':
        return this.#run(argv, call);
      case 'start':
      case 'stop':
      case 'restart': {
        const c = this.#find(rest[rest.length - 1] ?? '');
        if (!c) return noSuch(rest[rest.length - 1]);
        c.running = cmd !== 'stop';
        return { code: 0, stdout: `${c.name}\n` };
      }
      case 'pause':
      case 'unpause': {
        const name = rest[0] ?? '';
        const c = this.#find(name);
        if (!c) return noSuch(name);
        if ((cmd === 'pause' ? this.failPause : this.failUnpause) === name) {
          return { code: 125, stderr: `Error: ${cmd} failed for ${name}` };
        }
        if (cmd === 'pause' && this.noCgroup) {
          return {
            code: 125,
            stderr: 'Error: crun: cannot pause the container without a cgroup: OCI runtime error\n',
          };
        }
        c.paused = cmd === 'pause';
        return { code: 0, stdout: `${c.name}\n` };
      }
      case 'rm': {
        const c = this.#find(rest[rest.length - 1] ?? '');
        if (!c) return { ...noSuch(rest[rest.length - 1]), code: 1 };
        this.containers.delete(c.name);
        return { code: 0, stdout: `${c.name}\n` };
      }
      case 'ps': {
        const filter = rest[rest.indexOf('--filter') + 1] ?? '';
        const [key, value] = filter.replace(/^label=/, '').split('=');
        const ids = [...this.containers.values()]
          .filter((c) => c.labels[key ?? ''] === value)
          .map((c) => c.id.slice(0, 12));
        return { code: 0, stdout: ids.map((i) => `${i}\n`).join('') };
      }
      case 'exec':
        return this.#exec(argv, call.input);
      default:
        return { code: 125, stderr: `Error: unknown command ${cmd}` };
    }
  }

  #run(argv: string[], call: FakeCall): Reply {
    const name = argv[argv.indexOf('--name') + 1] ?? '';
    if (this.containers.has(name))
      return { code: 125, stderr: `Error: the container name "${name}" is already in use` };
    const image = argv[argv.length - 3] ?? '';
    if (!this.images.has(image)) return { code: 125, stderr: `Error: ${image}: image not known` };
    const labels: Record<string, string> = {};
    const env = ['PATH=/usr/bin:/bin'];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--label') {
        const [k, ...v] = (argv[i + 1] ?? '').split('=');
        labels[k ?? ''] = v.join('=');
      }
      if (argv[i] === '--env') {
        const item = argv[i + 1] ?? '';
        // 不带值的 --env 名字：从引擎进程自己的环境里取值
        if (item.includes('=')) env.push(item);
        else if (call.env?.[item] !== undefined) env.push(`${item}=${call.env[item]}`);
      }
    }
    const c = this.add(name, { labels, env, args: argv });
    if (this.failStartAfterCreate) {
      c.running = false;
      return { code: 126, stderr: 'Error: OCI runtime error: unable to start container: netns setup failed' };
    }
    if (this.noSlirp4netns && argv[argv.indexOf('--network') + 1]?.startsWith('slirp4netns')) {
      c.running = false;
      return {
        code: 126,
        stderr:
          'Error: could not find slirp4netns, the network namespace can\'t be configured: exec: "slirp4netns": executable file not found in $PATH\n',
      };
    }
    return { code: 0, stdout: `${c.id}\n` };
  }

  #exec(argv: string[], input: string | undefined): Reply {
    const { name, rest } = this.#execTarget(argv);
    const c = this.#find(name);
    if (!c) return noSuch(name);
    // podman 对冻结（paused）的容器也这样报
    if (!c.running || c.paused) {
      return {
        code: 125,
        stderr: 'Error: can only create exec sessions on running containers: container state improper',
      };
    }
    if (rest[0] === 'cat') {
      const content = c.files.get(rest[1] ?? '');
      return content === undefined ? { code: 1, stderr: 'cat: no such file' } : { code: 0, stdout: content };
    }
    const script = rest[3];
    if (script === 'melina-write') {
      if (this.failWrite) return { code: 1, stderr: 'sh: read-only file system' };
      c.files.set(rest[4] ?? '', input ?? '');
      return { code: 0 };
    }
    if (script === 'melina-exec') {
      const id = rest[4] ?? '';
      const r = this.execReply(c, input ?? '');
      return {
        code: r.code,
        stdout: `${r.output}\nMELINA-EXIT-${id} ${r.code}${r.counters ? ` ${r.counters}` : ''}\n`,
      };
    }
    if (script === 'melina-kill') return this.killReply;
    if (script === 'melina-list') return { code: 0 };
    return { code: 127, stderr: `unknown exec ${rest.join(' ')}` };
  }

  #execTarget(argv: string[]): { name: string; rest: string[]; env: Record<string, string> } {
    const env: Record<string, string> = {};
    let i = 1;
    while (i < argv.length && (argv[i] ?? '').startsWith('-')) {
      if (argv[i] === '--env') {
        const [k, ...v] = (argv[i + 1] ?? '').split('=');
        env[k ?? ''] = v.join('=');
        i += 2;
      } else i += 1;
    }
    const name = argv[i] ?? '';
    const c = this.#find(name);
    for (const e of c?.env ?? []) {
      const [k, ...v] = e.split('=');
      if (k && !(k in env)) env[k] = v.join('=');
    }
    return { name, rest: argv.slice(i + 1), env };
  }

  #find(nameOrId: string): FakeContainer | undefined {
    return (
      this.containers.get(nameOrId) ?? [...this.containers.values()].find((c) => c.id.startsWith(nameOrId) && nameOrId)
    );
  }

  #inspectJson(c: FakeContainer) {
    return {
      Id: c.id,
      Name: c.name,
      State: { Running: c.running, Paused: c.paused },
      Config: { Labels: c.labels, Env: c.env },
    };
  }

  #infoJson() {
    if (this.kind === 'docker') {
      return {
        ServerVersion: this.info.serverErrors ? '' : '27.0.0',
        ServerErrors: this.info.serverErrors,
        MemoryLimit: this.info.memoryLimit,
        PidsLimit: this.info.pidsLimit,
        SecurityOptions: this.info.rootless ? ['name=seccomp,profile=builtin', 'name=rootless'] : [],
      };
    }
    const controllers = [
      'cpu',
      'io',
      ...(this.info.memoryLimit ? ['memory'] : []),
      ...(this.info.pidsLimit ? ['pids'] : []),
    ];
    return {
      host: {
        cgroupVersion: 'v2',
        cgroupManager: this.info.cgroupManager,
        cgroupControllers: controllers,
        security: { rootless: this.info.rootless },
      },
      version: { Version: '5.4.0' },
    };
  }

  #newId(): string {
    return `${String(this.#next++).padStart(4, '0')}${'f'.repeat(60)}`;
  }
}

function noSuch(name: string | undefined): Reply {
  return { code: 125, stderr: `Error: no container with name or ID "${name}" found: no such container` };
}

/** 在宿主机上跑 exec 的那段命令（sh -c 脚本 …），stdin 照传 */
function hostProcess(rest: string[], env: Record<string, string>, withStdin: boolean): EngineProcess {
  const child = spawn(rest[0] ?? 'sh', rest.slice(1), {
    env: { ...process.env, ...env },
    stdio: [withStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return {
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    stdin: child.stdin,
    closed,
    kill: () => child.kill('SIGKILL'),
  };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
