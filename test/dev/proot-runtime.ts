// 开发机上的「容器」：用 proot（ptrace 实现的路径重映射，不要 user namespace）在宿主机上跑 agent 的命令。
// 这台开发机本身是容器，起不了 Podman，门槛 1 的真模型联调用它顶替 的 PodmanRuntime。
//
// 每个「容器」是数据目录下的一个目录：rootfs/（空的根，只放 bin、lib 这几个指向 usr 的链接）、tmp/、home/（/root）、logs/（/melina/logs）、
// run/（命令文件）。跑命令时 proot 以 rootfs 为根，绑上宿主机的 /usr、/etc、/dev、/proc、/sys，和 /workspace、/melina/artifacts、
// /melina/materials 三个挂载点；看不到 /opt、宿主机的 home 和别的分支。环境变量从零开始，不带 Melina 进程里的任何东西。
//
// 这不是沙箱：同一个用户、同一个网络、同一份 /proc，proot 不拦有意的逃逸，也做不到只读挂载（只读的 workspace 挂的是开容器时
// 复制、去掉写权限的一份），没有内存和进程数上限。人选的工作目录（ContainerSpec.originDir，真容器只读挂到 /melina/origin）
// 不挂：挂的是人自己的目录，复制一份又可能很大，挂进来 agent 就写得进去。agent 的 `pkill -f node`、`kill -9 -1` 这类命令会杀到 Melina 自己和本机同一个用户的
// 其他进程。只给开发机跑联调和看前端用，放在 test/ 下，不进 src/。
//
// 补了一层 Landlock：每条命令先由 perl 进一个 Landlock 域再 exec bash。
// 域里的进程读不了域外进程的 /proc/<pid>/environ、cwd、root、fd，也 ptrace 不了它们——门槛 1 时 agent 读过宿主机进程的
// environ，把 Claude Code 的令牌带进了发给模型的工具结果。文件系统只管跨目录 rename、link（REFER），每个挂载点底下都放行，
// 实际什么都不限，只为建域。给了 netAllow 就只许连这些 TCP 端口（跑分时放行仿真环境的端口，Melina 的 API 和本机别的服务就连不到了）。
// 杀进程（kill、pkill）Landlock 到内核 6.12 才管，这里还拦不住。内核不支持 Landlock 时照旧跑，构造时打一条警告。
// 进程数、内存的上限是整台机器（这台开发机的 cgroup）共用的，几条路线、别的会话、同时跑的别的实验臂一起占： 的对照里
// 路线把整机撞满时的 can't start new thread 记成了「这个容器只能开两个线程」。所以每条前台命令前后读一次这个 cgroup 的计数，
// 撞了上限就随结果交出去，scope 是 host；这台机器的 cgroup 不可写，给不了每条路线自己的上限。

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { conflict, invalid } from '../../src/core/errors.ts';
import type {
  ContainerExecRequest,
  ContainerExecResult,
  ContainerRef,
  ContainerRuntime,
  ContainerSpec,
  Redactor,
} from '../../src/core/interfaces/container.ts';
import { type CgroupDeltas, contentionOf, OutputCollector } from '../../src/tools/container-output.ts';

/** proot 的位置：环境变量 MELINA_PROOT，否则 ~/.cache/melina/proot（test/dev/fetch-proot.ts 下载） */
export function prootPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MELINA_PROOT ?? join(homedir(), '.cache', 'melina', 'proot');
}

const SYSTEM_BINDS = ['/usr', '/etc', '/dev', '/proc', '/sys'];
const ROOT_LINKS: [string, string][] = [
  ['bin', 'usr/bin'],
  ['lib', 'usr/lib'],
  ['lib64', 'usr/lib64'],
  ['sbin', 'usr/sbin'],
];
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 3 * 1024 * 1024;
const MAX_BACKGROUND = 4;
/** 超时、取消杀完进程后最多再等这么久：有子进程逃出进程组、又占着输出时，不等它（PodmanRuntime 也有这道兜底） */
const KILL_GRACE_MS = 3000;

/**
 * 进 Landlock 域再 exec（容器里的 perl 跑，宿主机的 /usr 绑进去了）。系统调用号是 x86_64 的：landlock_create_ruleset 444、
 * landlock_add_rule 445、landlock_restrict_self 446、prctl 157（PR_SET_NO_NEW_PRIVS 38）。
 * handled_access_fs 只有 REFER（1 << 13），MELINA_LANDLOCK_PATHS 列的目录底下都放行（O_PATH | O_CLOEXEC 打开）；
 * MELINA_NET_ALLOW 给了就加管 CONNECT_TCP（2），只放行列出的端口。两个变量 exec 之前删掉。
 */
const LANDLOCK_PL = String.raw`use strict;
my @paths = grep { length } split(/\n/, $ENV{MELINA_LANDLOCK_PATHS} // '/');
my $allow = $ENV{MELINA_NET_ALLOW};
my @ports = defined $allow ? grep { /^\d+$/ } split(/,/, $allow) : ();
my $refer = 1 << 13;
my $attr = pack('QQ', $refer, defined $allow ? 2 : 0);
my $fd = syscall(444, $attr, length($attr), 0);
die "landlock_create_ruleset: $!\n" if $fd < 0;
for my $p (@paths) {
  sysopen(my $h, $p, 0x200000 | 0x80000) or next;
  my $rule = pack('Ql', $refer, fileno($h));
  syscall(445, $fd, 1, $rule, 0) == 0 or die "landlock_add_rule $p: $!\n";
  close($h);
}
for my $port (@ports) {
  my $rule = pack('QQ', 2, $port);
  syscall(445, $fd, 2, $rule, 0) == 0 or die "landlock_add_rule $port: $!\n";
}
syscall(157, 38, 1, 0, 0, 0) == 0 or die "prctl: $!\n";
syscall(446, $fd, 0) == 0 or die "landlock_restrict_self: $!\n";
delete @ENV{qw(MELINA_NET_ALLOW MELINA_LANDLOCK_PATHS)};
exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\n";`;

/** 宿主机内核的 Landlock ABI 版本（0：用不了）。用宿主机的 perl 问一次 */
export function landlockAbi(): number {
  const r = spawnSync('perl', ['-e', 'print syscall(444, 0, 0, 1)'], { encoding: 'utf8', timeout: 10_000 });
  const abi = Number(r.stdout?.trim());
  return Number.isInteger(abi) && abi > 0 ? abi : 0;
}

interface Box {
  ref: ContainerRef;
  spec: ContainerSpec;
  dir: string;
  /** 只读挂载时复制出来的那份 workspace（宿主机上的路径） */
  workspaceCopy?: string;
  running: boolean;
  ephemeral: boolean;
  background: { pid: number; start: string; cmd: string; log: string }[];
}

export interface ProotRuntimeOptions {
  /** 放各个「容器」的目录 */
  root: string;
  redactor?: Pick<Redactor, 'redact'>;
  proot?: string;
  maxBackground?: number;
  log?: (text: string) => void;
  /** 每条命令进 Landlock 域（默认开；内核不支持时自动关、打警告） */
  landlock?: boolean;
  /** 只许连这些 TCP 端口（要 Landlock ABI 4）；不给就不限 */
  netAllow?: readonly number[];
  /** cgroup 挂在哪（默认 /sys/fs/cgroup，测试用） */
  cgroupMount?: string;
  /** 显式指定可信工具目录，可覆盖默认系统挂载；不传整个宿主根目录或运行数据目录。 */
  systemBinds?: readonly { host: string; container: string }[];
  /** 明确列出的工具环境变量；调用方不能把宿主 process.env 整体传进来。 */
  toolEnvironment?: Readonly<Record<string, string>>;
  /** 默认读取登录 profile；环境已由调用方完整配置时可禁用，避免 profile 重置 PATH。 */
  loginShell?: boolean;
}

/**
 * 跑命令的那个 cgroup 的三个计数：proot 里的命令都是 Melina 的子进程，
 * 和 Melina、本机别的进程（别的会话、同时跑的别的实验臂）在同一个 cgroup 里，没有每条路线自己的上限，所以记成 host。
 * 和容器里包装脚本读的同样三项（src/tools/container-scripts.ts 的 COUNTS），在 Melina 这边读：超时、取消时整组进程被杀，
 * 包装脚本等不到打结束标记。读不到的那项没有
 */
export function cgroupCounts(mount = '/sys/fs/cgroup', self = '/proc/self/cgroup'): CgroupDeltas {
  const out: CgroupDeltas = {};
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  };
  const line = read(self)
    ?.split('\n')
    .find((l) => l.startsWith('0::'));
  if (line === undefined) return out;
  const dir = join(mount, line.slice(3));
  const field = (text: string | undefined, key: string): number | undefined => {
    for (const l of text?.split('\n') ?? []) {
      const [k, v] = l.split(' ');
      if (k === key && v !== undefined && /^\d+$/.test(v)) return Number(v);
    }
    return undefined;
  };
  const pidsMax = field(read(join(dir, 'pids.events')), 'max');
  const oomKills = field(read(join(dir, 'memory.events')), 'oom_kill');
  const some = read(join(dir, 'cpu.pressure'))
    ?.split('\n')
    .find((l) => l.startsWith('some '));
  const total = /\btotal=(\d+)/.exec(some ?? '')?.[1];
  if (pidsMax !== undefined) out.pidsMax = pidsMax;
  if (oomKills !== undefined) out.oomKills = oomKills;
  if (total !== undefined) out.cpuUs = Number(total);
  return out;
}

/** 两次计数的增量：两次都读到、而且没变小的才算 */
export function countsDelta(before: CgroupDeltas, after: CgroupDeltas): CgroupDeltas {
  const out: CgroupDeltas = {};
  for (const key of ['pidsMax', 'oomKills', 'cpuUs'] as const) {
    const a = before[key];
    const b = after[key];
    if (a !== undefined && b !== undefined && b >= a) out[key] = b - a;
  }
  return out;
}

export class ProotRuntime implements ContainerRuntime {
  /** 开发执行器没有容器冻结，只能用于可信输入；生产入口使用 PodmanRuntime */
  async withWorkspaceFrozen<T>(_path: string, work: () => Promise<T>): Promise<T> {
    return work();
  }
  readonly engine = 'podman' as const;
  readonly #root: string;
  readonly #proot: string;
  readonly #redactor: Pick<Redactor, 'redact'> | undefined;
  readonly #maxBackground: number;
  readonly #log: (text: string) => void;
  readonly #boxes = new Map<string, Box>();
  /** 这个实例起的进程都带着它：Melina 崩溃重启后，新实例按它认出哪些是上一个实例留下的 */
  readonly #instance = randomBytes(6).toString('hex');
  readonly #landlock: boolean;
  readonly #netAllow: readonly number[] | undefined;
  readonly #cgroupMount: string | undefined;
  readonly #systemBinds: readonly { host: string; container: string }[];
  readonly #toolEnvironment: Readonly<Record<string, string>>;
  readonly #shell: string;
  #warnedOrigin = false;

  constructor(options: ProotRuntimeOptions) {
    this.#root = options.root;
    this.#cgroupMount = options.cgroupMount;
    const systemBinds = new Map(SYSTEM_BINDS.map((path) => [path, { host: path, container: path }]));
    for (const bind of options.systemBinds ?? []) systemBinds.set(bind.container, bind);
    this.#systemBinds = [...systemBinds.values()];
    this.#toolEnvironment = options.toolEnvironment ?? {};
    this.#shell = options.loginShell === false ? 'bash --noprofile --norc -o pipefail' : 'bash -l -o pipefail';
    this.#proot = options.proot ?? prootPath();
    this.#redactor = options.redactor;
    this.#maxBackground = options.maxBackground ?? MAX_BACKGROUND;
    this.#log = options.log ?? ((t) => console.warn(`[proot] ${t}`));
    if (!existsSync(this.#proot)) {
      throw invalid(`找不到 proot：${this.#proot}（先跑 node test/dev/fetch-proot.ts，或者设 MELINA_PROOT）`);
    }
    mkdirSync(this.#root, { recursive: true });
    const abi = options.landlock === false ? 0 : landlockAbi();
    this.#landlock = abi > 0;
    if (options.landlock !== false && !this.#landlock) {
      this.#log('内核用不了 Landlock：agent 读得到本机同一个用户的进程的环境变量（令牌、key），别和别的会话同时跑');
    }
    this.#netAllow = this.#landlock && abi >= 4 ? options.netAllow : undefined;
    if (options.netAllow && !this.#netAllow) this.#log('Landlock ABI 低于 4，管不了端口：netAllow 没生效');
  }

  /** 每条命令是不是进了 Landlock 域、只许连哪些端口（给 serve.ts 打出来） */
  get isolation(): { landlock: boolean; netAllow?: readonly number[] } {
    return { landlock: this.#landlock, ...(this.#netAllow ? { netAllow: this.#netAllow } : {}) };
  }

  async checkImages(domains: readonly string[]) {
    return domains.map((domain) => ({ domain, image: 'proot', present: true }));
  }

  async start(spec: ContainerSpec): Promise<ContainerRef> {
    const existing = this.#boxes.get(spec.name);
    if (existing) {
      existing.running = true;
      return existing.ref;
    }
    return this.#create(spec, false);
  }

  async ephemeral(spec: ContainerSpec): Promise<ContainerRef> {
    const existing = this.#boxes.get(spec.name);
    if (existing) await this.remove(existing.ref);
    return this.#create(spec, true);
  }

  async stop(ref: ContainerRef): Promise<void> {
    this.#kill(`MELINA_CONTAINER=${ref.name}`);
    const box = this.#boxes.get(ref.name);
    if (!box) return;
    box.running = false;
    box.background = [];
  }

  async remove(ref: ContainerRef): Promise<void> {
    this.#kill(`MELINA_CONTAINER=${ref.name}`);
    const box = this.#boxes.get(ref.name);
    if (box) box.running = false;
    removeBoxDir(join(this.#root, ref.name)); // 删不掉就抛错，表里还留着，下次 remove 再删
    this.#boxes.delete(ref.name);
  }

  async find(name: string): Promise<ContainerRef | undefined> {
    return this.#boxes.get(name)?.ref;
  }

  // ── Melina 另外要的几个（src/api/assemble.ts 的 MelinaContainers） ─────────

  forWorkspace(path: string, options: { writable?: boolean } = {}): ContainerRef | undefined {
    for (const box of this.#boxes.values()) {
      if (!box.running || box.spec.workspace.host !== path) continue;
      if (options.writable && box.spec.workspace.readOnly) continue;
      return box.ref;
    }
    return undefined;
  }

  async managed() {
    return [...this.#boxes.values()].map((b) => ({
      ref: b.ref,
      running: b.running,
      paused: false,
      ephemeral: b.ephemeral,
      labels: b.spec.labels ?? {},
    }));
  }

  async probe() {
    return { kind: 'podman' as const, version: 'proot', rootless: true, memoryLimit: false, pidsLimit: false };
  }

  async removeEphemeral(): Promise<string[]> {
    // 上一个 Melina 进程（崩溃了）在这些「容器」里起的命令：真容器会被恢复流程停掉，这里只能按标记找出来杀掉。
    // 放在这里不放在构造函数里：恢复流程拿到数据目录的锁以后才调它，误开的第二个 Melina 拿不到锁，不会杀掉正在跑的那个的命令
    killWhere(
      (env) =>
        env.includes(`MELINA_PROOT_ROOT=${this.#root}`) && !env.includes(`MELINA_PROOT_INSTANCE=${this.#instance}`),
    );
    const removed: string[] = [];
    for (const box of [...this.#boxes.values()]) {
      if (!box.ephemeral) continue;
      await this.remove(box.ref);
      removed.push(box.ref.name);
    }
    return removed;
  }

  // ── 跑命令 ──────────────────────────────────────────────────────────────

  async exec(ref: ContainerRef, req: ContainerExecRequest): Promise<ContainerExecResult> {
    if ((req.capturePrivate || req.inspectPrivate) && req.background) throw conflict('私有输出处理只支持前台调用');
    if (req.capturePrivate && req.inspectPrivate) throw conflict('私有捕获和被动检查不能同时使用');
    const box = this.#must(ref);
    if (!box.running) throw conflict(`容器 ${ref.name} 没在运行`);
    const started = Date.now();
    if (req.signal?.aborted) return { exitCode: null, output: '', timedOut: false, cancelled: true, durationMs: 0 };
    const id = randomBytes(8).toString('hex');
    writeFileSync(join(box.dir, 'run', `${id}.sh`), req.cmd, { mode: 0o600 });
    const cwd = req.cwd ? join('/workspace', req.cwd) : '/workspace';
    if (req.background) return this.#background(box, id, cwd, req, started);

    const sentinel = `\nMELINA-EXIT-${id} `;
    // 默认在登录 shell 里跑；显式配置完整环境的调用方可禁用 profile。stderr 并进 stdout；结束后打结束标记：
    // 命令留下的后台子进程占着输出管道时，看到标记就算结束，不等 proot 退出
    const wrapper = `cd ${shq(cwd)} 2>/dev/null || { printf '工作目录不存在：%s\\n' ${shq(cwd)}; printf '\\nMELINA-EXIT-${id} 2\\n'; exit 2; }
${this.#shell} /run/melina/${id}.sh </dev/null 2>&1
rc=$?
printf '\\nMELINA-EXIT-${id} %s\\n' "$rc"`;
    const counts = cgroupCounts(this.#cgroupMount);
    const child = this.#spawn(box, id, ['/bin/bash', '-c', wrapper], req.env, ['ignore', 'pipe', 'pipe']);
    const collector = new OutputCollector({ headBytes: HEAD_BYTES, tailBytes: TAIL_BYTES, sentinel });

    return new Promise((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        req.signal?.removeEventListener('abort', onAbort);
        rmSync(join(box.dir, 'run', `${id}.sh`), { force: true });
        let captureFailed = false;
        if (req.capturePrivate && exitCode === 0 && !timedOut && !cancelled) {
          const output = collector.result();
          if (output.omitted === 0) {
            try {
              req.capturePrivate(output.head);
            } catch {
              captureFailed = true;
            }
          }
        }
        let inspected: string | undefined;
        if (req.inspectPrivate && exitCode === 0 && !timedOut && !cancelled) {
          const output = collector.result();
          if (output.omitted === 0) {
            try {
              inspected = req.inspectPrivate(output.head);
            } catch {
              inspected = '私有输出检查失败；原输出未回传';
              captureFailed = true;
            }
          }
        }
        const durationMs = Date.now() - started;
        const contention = contentionOf(countsDelta(counts, cgroupCounts(this.#cgroupMount)), durationMs, 'host');
        resolve({
          exitCode: timedOut || cancelled ? null : captureFailed ? 1 : exitCode,
          output: req.capturePrivate
            ? '私有来源输出未回传，请通过受控引用登记'
            : inspected === undefined
              ? this.#render(collector)
              : this.#redact(inspected),
          timedOut,
          cancelled,
          durationMs,
          ...(contention ? { contention } : {}),
        });
      };
      const kill = () => {
        killGroup(child.pid);
        this.#kill(`MELINA_EXEC=${id}`);
        // 逃出进程组、又把环境变量换掉的子进程（setsid env -i …、改了进程标题的 postgres）还占着输出时，close 不会来：到点就不等了
        grace ??= setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          collector.end();
          finish(null);
        }, KILL_GRACE_MS);
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          kill();
        },
        Math.min(req.timeoutMs, 2 ** 31 - 1),
      );
      const onAbort = () => {
        cancelled = true;
        kill();
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const onData = (chunk: Buffer) => {
        collector.push(chunk);
        if (collector.done) finish(collector.exitCode ?? null);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData); // proot 自己的报错
      child.on('close', (code) => {
        collector.end();
        finish(collector.exitCode ?? code);
      });
      child.on('error', (error) => {
        collector.push(Buffer.from(`proot 起不来：${error.message}\n`));
        finish(127);
      });
    });
  }

  #background(
    box: Box,
    id: string,
    cwd: string,
    req: ContainerExecRequest,
    started: number,
  ): ContainerExecResult | Promise<ContainerExecResult> {
    box.background = box.background.filter((p) => startTime(p.pid) === p.start);
    if (box.background.length >= this.#maxBackground) {
      throw conflict(`后台进程已经有 ${box.background.length} 个了，先用 kill 停掉不用的再起新的`);
    }
    const pidFile = join(box.dir, 'run', `${id}.pid`);
    const temp = join(box.dir, 'logs', `.bg-${id}.log`);
    // 记下真正跑命令的那个 bash 的 pid（容器里 kill 它就能停掉），不是 proot 的
    const wrapper = `cd ${shq(cwd)} 2>/dev/null || { printf '工作目录不存在：%s\n' ${shq(cwd)}; exit 2; }
echo $$ > /run/melina/${id}.pid
exec ${this.#shell} /run/melina/${id}.sh </dev/null`;
    const fd = openSync(temp, 'a');
    const child = this.#spawn(box, id, ['/bin/bash', '-c', wrapper], req.env, ['ignore', fd, fd]);
    closeSync(fd);
    let exited: number | null | undefined;
    let spawnError: string | undefined;
    child.on('exit', (code) => {
      exited = code;
    });
    // 起不来（进程数满了 EAGAIN、proot 没有执行权限）：Node 只发 error 事件，不接住会让整个 Melina 退出
    child.on('error', (error) => {
      spawnError = `proot 起不来：${error.message}`;
      exited = 127;
    });
    child.unref();
    return (async () => {
      let pid = 0;
      for (let i = 0; i < 500 && !pid; i++) {
        try {
          pid = Number(readFileSync(pidFile, 'utf8').trim());
        } catch {
          // 还没写 pid 就退出了：命令根本没起来（工作目录不在、proot 起不来），把原因交回去，不当成起了后台进程
          if (exited !== undefined) {
            const output = this.#redact(readFileSync(temp, 'utf8')) || spawnError;
            rmSync(temp, { force: true });
            rmSync(join(box.dir, 'run', `${id}.sh`), { force: true });
            return {
              exitCode: exited ?? 2,
              output: output || '后台命令没起来',
              timedOut: false,
              cancelled: false,
              durationMs: Date.now() - started,
            };
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      if (!pid) pid = child.pid ?? 0;
      const log = `/melina/logs/bg-${pid}.log`;
      renameSync(temp, join(box.dir, 'logs', `bg-${pid}.log`));
      box.background.push({ pid, start: startTime(pid) ?? '', cmd: req.cmd.split('\n')[0] ?? '', log });
      return {
        exitCode: 0,
        output: '',
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - started,
        background: { pid, log },
      };
    })();
  }

  #spawn(
    box: Box,
    id: string,
    argv: string[],
    extraEnv: Record<string, string> | undefined,
    stdio: ['ignore', 'pipe' | number, 'pipe' | number],
  ): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      PATH,
      HOME: '/root',
      USER: 'root',
      LANG: 'C.UTF-8',
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      DEBIAN_FRONTEND: 'noninteractive',
      ...this.#toolEnvironment,
      ...(extraEnv ?? {}),
      MELINA_EXEC: id,
      MELINA_CONTAINER: box.ref.name,
      MELINA_PROOT_ROOT: this.#root,
      MELINA_PROOT_INSTANCE: this.#instance,
    };
    for (const cred of box.spec.credentials) if ('env' in cred.as) env[cred.as.env] = cred.value;
    const mounts = [
      ...this.#systemBinds.map((bind) => bind.container),
      '/tmp',
      '/root',
      '/melina/logs',
      '/run/melina',
      '/workspace',
      ...(box.spec.artifactsDir ? ['/melina/artifacts'] : []),
      ...(box.spec.materialsDir ? ['/melina/materials'] : []),
    ];
    if (this.#landlock) {
      env.MELINA_LANDLOCK_PATHS = ['/', ...mounts].join('\n');
      if (this.#netAllow) env.MELINA_NET_ALLOW = this.#netAllow.join(',');
    }
    const binds = [
      ...this.#systemBinds.map((bind) => ['-b', `${bind.host}:${bind.container}`]),
      ['-b', `${join(box.dir, 'tmp')}:/tmp`],
      ['-b', `${join(box.dir, 'home')}:/root`],
      ['-b', `${join(box.dir, 'logs')}:/melina/logs`],
      ['-b', `${join(box.dir, 'run')}:/run/melina`],
      ['-b', `${box.workspaceCopy ?? box.spec.workspace.host}:/workspace`],
      ...(box.spec.artifactsDir ? [['-b', `${box.spec.artifactsDir}:/melina/artifacts`]] : []),
      ...(box.spec.materialsDir ? [['-b', `${box.spec.materialsDir}:/melina/materials`]] : []),
    ].flat();
    const command = this.#landlock ? ['/usr/bin/perl', '-e', LANDLOCK_PL, '--', ...argv] : argv;
    return spawn(this.#proot, ['-v', '-1', '-r', join(box.dir, 'rootfs'), ...binds, '-w', '/', ...command], {
      env,
      detached: true,
      stdio,
    });
  }

  #render(collector: OutputCollector): string {
    const out = collector.result();
    return this.#redact(
      out.omitted === 0 ? out.head : `${out.head}\n…（中间省略了 ${out.omitted} 字节）…\n${out.tail}`,
    );
  }

  #redact(text: string): string {
    return this.#redactor ? this.#redactor.redact(text) : text;
  }

  /** 杀掉这个目录下（不管哪个实例起的）带着这个标记的进程：别的数据目录、别的测试的进程不碰 */
  #kill(marker: string): void {
    killWhere((env) => env.includes(marker) && env.includes(`MELINA_PROOT_ROOT=${this.#root}`));
  }

  #create(spec: ContainerSpec, ephemeral: boolean): ContainerRef {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(spec.name)) throw invalid(`容器名不合规：${spec.name}`);
    if (spec.originDir && !this.#warnedOrigin) {
      this.#warnedOrigin = true;
      this.#log(
        'proot 做不到只读挂载：人选的工作目录不挂到 /melina/origin（挂进来 agent 就写得进去），被忽略的大目录开发机上看不到',
      );
    }
    const dir = join(this.#root, spec.name);
    removeBoxDir(dir); // 上一个 Melina 进程留下的（只读副本去掉了写权限，要先加回来才删得掉）
    const rootfs = join(dir, 'rootfs');
    for (const p of [
      ...this.#systemBinds.map((bind) => bind.container),
      '/tmp',
      '/root',
      '/workspace',
      '/var/tmp',
      '/run/melina',
      '/melina/logs',
    ]) {
      mkdirSync(join(rootfs, p), { recursive: true });
    }
    mkdirSync(join(rootfs, 'melina', 'artifacts'), { recursive: true });
    mkdirSync(join(rootfs, 'melina', 'materials'), { recursive: true });
    for (const [link, target] of ROOT_LINKS) symlinkSync(target, join(rootfs, link));
    for (const sub of ['tmp', 'home', 'logs', 'run']) mkdirSync(join(dir, sub), { recursive: true });
    chmodSync(join(dir, 'tmp'), 0o1777);
    chmodSync(join(rootfs, 'var/tmp'), 0o1777);
    // 基础镜像里设的 git 身份，agent 自己 commit 时用
    writeFileSync(
      join(dir, 'home', '.gitconfig'),
      '[user]\n\tname = Melina\n\temail = melina@localhost\n[safe]\n\tdirectory = *\n[init]\n\tdefaultBranch = main\n',
    );
    for (const cred of spec.credentials) {
      if (!('file' in cred.as)) continue;
      const path = cred.as.file;
      if (!path.startsWith('/root/')) {
        this.#log(`凭证 ${cred.name} 的文件路径 ${path} 不在 /root 下，proot 里放不进去，跳过`);
        continue;
      }
      const host = join(dir, 'home', path.slice('/root/'.length));
      mkdirSync(join(host, '..'), { recursive: true });
      writeFileSync(host, cred.value, { mode: 0o600 });
    }
    let workspaceCopy: string | undefined;
    if (spec.workspace.readOnly) {
      // proot 做不到只读挂载：挂一份复制的，再去掉写权限（不是 root，权限位管用），写的时候报 Permission denied，
      // 和真容器的 Read-only file system 一样写不进去
      workspaceCopy = join(dir, 'workspace-ro');
      cpSync(spec.workspace.host, workspaceCopy, { recursive: true, verbatimSymlinks: true, force: true });
      chmodTree(workspaceCopy, false);
    }
    const ref = { id: spec.name, name: spec.name };
    this.#boxes.set(spec.name, {
      ref,
      spec,
      dir,
      ...(workspaceCopy ? { workspaceCopy } : {}),
      running: true,
      ephemeral,
      background: [],
    });
    return ref;
  }

  #must(ref: ContainerRef): Box {
    const box = this.#boxes.get(ref.name);
    if (!box) throw conflict(`容器 ${ref.name} 不存在`);
    return box;
  }
}

function removeBoxDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES' && (error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw error;
    }
    chmodTree(dir, true);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 整棵目录去掉（或加回）写权限；符号链接不管 */
function chmodTree(root: string, writable: boolean): void {
  const walk = (path: string) => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (writable) chmodSync(path, st.mode | 0o200);
      for (const name of readdirSync(path)) walk(join(path, name));
      if (!writable) chmodSync(path, st.mode & ~0o222);
      return;
    }
    chmodSync(path, writable ? st.mode | 0o200 : st.mode & ~0o222);
  };
  if (existsSync(root)) walk(root);
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {}
  }
}

/** 环境变量合条件的进程都杀掉（自己 setsid 出去的也跑不掉，除非把环境变量换了）；只看得到同一个用户的 */
function killWhere(match: (env: string[]) => boolean): void {
  for (let round = 0; round < 2; round++) {
    for (const p of readdirSync('/proc')) {
      if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
      let environ: string;
      try {
        environ = readFileSync(`/proc/${p}/environ`, 'latin1');
      } catch {
        continue;
      }
      if (!match(environ.split('\0'))) continue;
      try {
        process.kill(Number(p), 'SIGKILL');
      } catch {}
    }
  }
}

/** 进程的启动时间（/proc/<pid>/stat 第 22 项），pid 复用时认得出 */
function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch {
    return undefined;
  }
}
