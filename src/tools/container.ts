// 容器运行时，ContainerRuntime 的实现：走 podman 的命令行，docker 的命令行也能用。
//
// - 每条分支一个常驻容器（start），用领域镜像起，主进程是镜像里的 tini 加 sleep infinity；停掉再起是同一个容器，装过的东西还在。
// - 只挂这几样：workspace（按角色只读或可写）、/melina/artifacts（只读）、/melina/materials（只读），和人选的工作目录原样挂的
//   /melina/origin（只读，被忽略、没抄进 workspace 的大目录在这里读）。看不到宿主机的其他目录和别的分支。
// - 内存和进程数有上限（sandbox.memoryMax、sandbox.pidsMax，auto 时按本机内存和在跑的容器数分），超了只杀这个容器里的进程。
// - 前台命令带超时执行，取消或超时时杀掉整个进程组，连自己 setsid 出去的子孙一起（脚本见 container-scripts.ts）。
// - 后台命令立即返回 pid 和日志文件，进程跨调用存活，最多 sh.maxBackground 个；停容器时随之结束。
// - 凭证：环境变量形式的在建容器时用 `--env 名字`、值放在引擎进程自己的环境变量里给进去（不出现在命令行和文件里），
//   文件形式的建好后写进容器自己的文件系统；输出返回前把凭证值换掉（redact.ts）。
// - 临时容器（ephemeral，Scoper、setup 用）：用完调 remove，和分支容器一样使用独立网络。
// - snapshot 前冻结挂着这个 workspace 的容器（pause），读完再恢复；冻不住就不读。冻结要求容器有自己的 cgroup，
//   所以「冻得住」和 rootless 一样是开工条件：checkFreeze 起一个测试容器真冻一次。
// Linux 上用 rootless podman：容器里的 root 对应宿主机上运行 Melina 的用户。

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { totalmem } from 'node:os';
import { basename, delimiter, isAbsolute, join, posix } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { credentialProblem } from '../core/config.ts';
import { conflict, invalid, MelinaError } from '../core/errors.ts';
import {
  CONTAINER_PATHS,
  type ContainerExecRequest,
  type ContainerExecResult,
  type ContainerRef,
  type ContainerRuntime,
  type ContainerSpec,
} from '../core/interfaces/container.ts';
import { contentionOf, OutputCollector } from './container-output.ts';
import {
  BG_SCRIPT,
  displayCommand,
  EXEC_SCRIPT,
  KILL_SCRIPT,
  parseBackgroundOutput,
  WRITE_FILE_SCRIPT,
} from './container-scripts.ts';
import type { Secret, SecretRedactor } from './redact.ts';

// ── 引擎命令行 ────────────────────────────────────────────────────────────

export type EngineKind = 'podman' | 'docker';

/** 引擎命令行的一个进程 */
export interface EngineProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable | null;
  /** 进程退出、输出流都关了；值是退出码，被信号杀掉或没起来是 null */
  readonly closed: Promise<number | null>;
  kill(): void;
}

export interface SpawnOptions {
  /** 要往 stdin 写东西 */
  stdin?: boolean;
  /** 额外的环境变量（凭证的值走这里，`--env 名字` 从引擎进程的环境里取值，不出现在命令行上） */
  env?: Record<string, string>;
}

/** 跑引擎命令行的一层，测试里换成假的 */
export interface Engine {
  readonly kind: EngineKind;
  spawn(args: readonly string[], options?: SpawnOptions): EngineProcess;
}

export class CliEngine implements Engine {
  readonly kind: EngineKind;
  readonly bin: string;

  constructor(kind: EngineKind, bin: string = kind) {
    this.kind = kind;
    this.bin = bin;
  }

  spawn(args: readonly string[], options: SpawnOptions = {}): EngineProcess {
    const child = spawn(this.bin, args, {
      stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    const closed = new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        child.stderr?.emit('data', Buffer.from(`${this.bin}：${error.message}\n`));
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });
    if (!child.stdout || !child.stderr) throw new MelinaError('internal', `没拿到 ${this.bin} 的输出管道`);
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: child.stdin,
      closed,
      // 先 SIGTERM 让引擎客户端自己收尾（podman 在 exec 前后拿着容器锁），两秒还在再 SIGKILL
      kill: () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2000).unref();
      },
    };
  }
}

/** 找容器引擎：环境变量 MELINA_CONTAINER_ENGINE（podman、docker 或可执行文件的路径），否则 PATH 里先找 podman 再找 docker */
export function detectEngine(env: NodeJS.ProcessEnv = process.env): CliEngine | undefined {
  const wanted = env.MELINA_CONTAINER_ENGINE?.trim();
  if (wanted) return new CliEngine(basename(wanted).includes('docker') ? 'docker' : 'podman', wanted);
  for (const kind of ['podman', 'docker'] as const) if (onPath(kind, env.PATH ?? '')) return new CliEngine(kind);
  return undefined;
}

function onPath(bin: string, path: string): boolean {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一条短的引擎命令，收全输出；超时杀掉，抛 unavailable */
export async function runEngine(
  engine: Engine,
  args: readonly string[],
  options: { input?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const proc = engine.spawn(args, { stdin: options.input !== undefined, env: options.env });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  if (options.input !== undefined && proc.stdin) {
    proc.stdin.on('error', () => {}); // 进程没读完就退出时写入会 EPIPE，结果看退出码
    proc.stdin.end(options.input);
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const code = await Promise.race([proc.closed, timeout]);
  clearTimeout(timer);
  if (code === 'timeout') {
    proc.kill();
    throw new MelinaError(
      'unavailable',
      `容器引擎没有响应：${engine.kind} ${args[0] ?? ''} 超过 ${Math.round(timeoutMs / 1000)} 秒`,
    );
  }
  return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

// ── 运行时 ────────────────────────────────────────────────────────────────

/** 容器里的几个位置 */
export interface ContainerPaths {
  workspace: string;
  artifacts: string;
  materials: string;
  origin: string;
  /** 每次启动容器时新挂的 tmpfs：前台命令的进程组、后台进程的记录 */
  state: string;
  /** 后台进程的日志，在容器自己的文件系统里 */
  logs: string;
}

export const DEFAULT_PATHS: ContainerPaths = { ...CONTAINER_PATHS, state: '/run/melina', logs: '/melina/logs' };

/** sandbox.pidsMax 为 auto 时每个容器的进程数上限：挡住 fork 炸弹，正常的并行编译、浏览器、数据库都够用 */
export const AUTO_PIDS_MAX = 4096;

/** setTimeout 能等的最长时间（约 24.8 天）；再长 Node 会当成 1 毫秒，命令一起来就超时 */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * 冻结闸门：打 snapshot 时冻结挂这个 workspace 的容器（podman pause），冻结期间在它上面起命令，引擎报
 * 「container state improper」（docker 报 is paused），以前当成「容器没在运行」、记成没跑起来。现在 exec、起后台、杀进程
 * 碰上正在冻结的 workspace 先等它解冻，最多等这么久；起命令时没赶上闸门、被冻结挡了的，解冻后重来一次
 */
const THAW_WAIT_MS = 30_000;
/**
 * 冻不住的结论多久以后再真试一次：挡住连着建任务时每次都起测试容器；系统状态每分钟重查一次，
 * 修好环境后马上建任务也会重新试
 */
const FREEZE_RETRY_MS = 10_000;
/** 测试冻结的容器里 sleep 多久：测到一半 Melina 崩了，它到点自己退出、被 --rm 删掉，不会一直留着 */
const FREEZE_PROBE_SLEEP_S = 120;
/** 测试容器的内存和进程数上限：只跑 tini 和 sleep，用不着分支容器那么多，上限的参数照样带上、照样要生效 */
const FREEZE_PROBE_LIMITS = { memory: 256 * 1024 ** 2, pids: 64 };

const GiB = 1024 ** 3;

/**
 * sandbox.memoryMax 为 auto 时一个新容器的内存上限：本机内存的八成按在跑的容器数（含这个）分，
 * 最少 1 GiB、最多本机内存的一半。建容器时算一次，之后不随在跑的容器数变（改上限可能当场杀掉里面的进程）。
 */
export function autoMemoryMax(totalBytes: number, running: number): number {
  const share = Math.floor((totalBytes * 0.8) / Math.max(1, running));
  return Math.min(Math.max(share, GiB), Math.floor(totalBytes * 0.5));
}

export interface EngineInfo {
  kind: EngineKind;
  version: string;
  rootless: boolean;
  /** 内存、进程数上限能不能生效（cgroup v2 且这两个控制器委派给了当前用户） */
  memoryLimit: boolean;
  pidsLimit: boolean;
}

/** 真冻一次的结果：冻不住时 error 是引擎的原话 */
export type FreezeCheck = { ok: true } | { ok: false; error: string };

export interface PodmanRuntimeOptions {
  engine: Engine;
  /** 领域到镜像名（container-images.ts 的 DomainImages） */
  images: { imageFor(domain: string): string };
  redactor: SecretRedactor;
  /** sandbox.memoryMax（字节）；容器自己的 ContainerSpec.memoryMax 优先 */
  memoryMax?: number | 'auto';
  /** sandbox.pidsMax */
  pidsMax?: number | 'auto';
  /** sh.maxBackground：每个容器同时存活的后台进程数；按 Run 覆盖时传函数，通过 ref.runId 查 */
  maxBackground?: number | ((ref: ContainerRef) => number);
  /** 一次前台命令的输出最多留多少字节：开头四分之一，结尾四分之三，中间省略 */
  outputMaxBytes?: number;
  /** Podman 默认显式禁用 slirp4netns 的宿主机回环映射；只允许这个模式或 none。Docker 使用 bridge 或 none */
  network?: string;
  /** 系统提醒（内存上限不生效、凭证太短等），不进模型上下文 */
  onWarn?: (message: string) => void;
  /** 之前测过冻得住、这回真冻结却失败了：进程入口据此马上再测一次，系统状态跟着变 */
  onFreezeFailed?: () => void;
  /** 以下测试用 */
  paths?: Partial<ContainerPaths>;
  totalMemory?: () => number;
  /** 杀进程以后等多久还不结束就放弃等待 */
  killGraceMs?: number;
  /** 引擎的短命令（建、停、删、查）多久没返回算卡死 */
  engineTimeoutMs?: number;
  /** 冻不住的结论多久以后再真试一次，默认 FREEZE_RETRY_MS */
  freezeRetryMs?: number;
  /** 冻结检查缓存的时钟，默认 Date.now */
  now?: () => number;
}

interface Tracked {
  ref: ContainerRef;
  workspace: string;
  readOnly: boolean;
  ephemeral: boolean;
  running: boolean;
}

interface Inspected {
  id: string;
  running: boolean;
  paused: boolean;
  labels: Record<string, string>;
  env: string[];
}

/** 新建和找回容器都从显式标签读取所属 Run，容器名只负责定位。 */
function containerRef(id: string, name: string, labels: Record<string, string> = {}): ContainerRef {
  const runId = labels['melina.run'];
  return { id, name, ...(runId ? { runId } : {}) };
}

/** 记在容器标签里的凭证位置（只有名字和位置，没有值），Melina 重启后据此找回老容器手里的值 */
interface CredentialPlace {
  name: string;
  env?: string;
  file?: string;
}

const LABEL = {
  managed: 'melina.managed',
  domain: 'melina.domain',
  ephemeral: 'melina.ephemeral',
  workspace: 'melina.workspace',
  credentials: 'melina.credentials',
  network: 'melina.network',
} as const;

export class PodmanRuntime implements ContainerRuntime {
  readonly #engine: Engine;
  readonly #images: { imageFor(domain: string): string };
  readonly #redactor: SecretRedactor;
  readonly #memoryMax: number | 'auto';
  readonly #pidsMax: number | 'auto';
  readonly #maxBackground: number | ((ref: ContainerRef) => number);
  readonly #headBytes: number;
  readonly #tailBytes: number;
  readonly #network: string;
  readonly #onWarn: (message: string) => void;
  readonly #onFreezeFailed: (() => void) | undefined;
  readonly #paths: ContainerPaths;
  readonly #totalMemory: () => number;
  readonly #killGraceMs: number;
  readonly #engineTimeoutMs: number;
  readonly #freezeRetryMs: number;
  readonly #now: () => number;
  readonly #tracked = new Map<string, Tracked>();
  /** 正在冻结的 workspace → 解冻时 resolve（冻结闸门） */
  readonly #freezing = new Map<string, Promise<void>>();
  /** 每冻结一次加 1：起命令前记下，失败时看这期间有没有冻结过 */
  #freezes = 0;
  /** 这个进程里已经登记过手里凭证值的容器 */
  readonly #held = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #warned = new Set<string>();
  #info: Promise<EngineInfo> | undefined;
  /** 最近一次真冻一次的结论；冻得住的结论在真冻结失败时清掉 */
  #freezeCheck: { at: number; result: FreezeCheck } | undefined;
  #freezeChecking: Promise<FreezeCheck | undefined> | undefined;

  constructor(options: PodmanRuntimeOptions) {
    this.#engine = options.engine;
    this.#images = options.images;
    this.#redactor = options.redactor;
    this.#memoryMax = options.memoryMax ?? 'auto';
    this.#pidsMax = options.pidsMax ?? 'auto';
    this.#maxBackground = options.maxBackground ?? 4;
    const max = options.outputMaxBytes ?? 4 * 1024 * 1024;
    this.#headBytes = Math.floor(max / 4);
    this.#tailBytes = max - this.#headBytes;
    const network =
      options.network ?? (options.engine.kind === 'podman' ? 'slirp4netns:allow_host_loopback=false' : 'bridge');
    if (
      network !== 'none' &&
      network !== (options.engine.kind === 'podman' ? 'slirp4netns:allow_host_loopback=false' : 'bridge')
    ) {
      throw invalid(`沙箱不允许网络模式 ${network}：必须隔离宿主机的回环地址`);
    }
    this.#network = network;
    this.#onWarn = options.onWarn ?? ((message) => console.warn(`[容器] ${message}`));
    this.#onFreezeFailed = options.onFreezeFailed;
    this.#paths = { ...DEFAULT_PATHS, ...options.paths };
    this.#totalMemory = options.totalMemory ?? totalmem;
    this.#killGraceMs = options.killGraceMs ?? 5000;
    this.#engineTimeoutMs = options.engineTimeoutMs ?? 120_000;
    this.#freezeRetryMs = options.freezeRetryMs ?? FREEZE_RETRY_MS;
    this.#now = options.now ?? Date.now;
  }

  get engine(): EngineKind {
    return this.#engine.kind;
  }

  /** 引擎能不能用、是不是 rootless、内存和进程数上限能不能生效；结果缓存，引擎用不了抛 unavailable */
  probe(): Promise<EngineInfo> {
    if (!this.#info) {
      this.#info = this.#probe();
      this.#info.catch(() => {
        this.#info = undefined;
      });
    }
    return this.#info;
  }

  async checkImages(domains: readonly string[]): Promise<{ domain: string; image: string; present: boolean }[]> {
    return Promise.all(
      domains.map(async (domain) => {
        const image = this.#images.imageFor(domain);
        const r = await this.#run(['image', 'inspect', '--format', '{{.Id}}', image]);
        return { domain, image, present: r.code === 0 };
      }),
    );
  }

  start(input: ContainerSpec): Promise<ContainerRef> {
    return this.#lifecycle(() =>
      this.#locked(input.name, async () => {
        await this.#requireRootless();
        const spec = this.#checkSpec(input);
        const found = await this.#inspect(spec.name);
        if (!found) return this.#create(spec, false);
        this.#checkNetwork(found, spec.name);
        // 求解分支先用 general 开跑，Scoper 随后定领域。ensure 在 episode 之间调用：这里才换镜像，
        // 不打断正在做的一步。工作区是宿主机挂载，保留文件；容器自己的依赖和后台进程随旧容器结束。
        if (found.labels[LABEL.domain] !== spec.domain) {
          const [image] = await this.checkImages([spec.domain]);
          if (!image?.present) {
            throw new MelinaError('unavailable', `领域 ${spec.domain} 的镜像还没构建：先跑 pnpm images`);
          }
          await this.#remove(spec.name);
          return this.#create(spec, false);
        }
        if (!found.running) await this.#must(['start', spec.name], `启动容器 ${spec.name}`);
        if (found.paused) await this.#must(['unpause', spec.name], `恢复容器 ${spec.name}`);
        const ref = containerRef(found.id, spec.name, found.labels);
        if (!this.#held.has(spec.name)) await this.#recoverHeld(ref, found);
        this.#track(ref, spec, found.labels[LABEL.ephemeral] === '1');
        return ref;
      }),
    );
  }

  stop(ref: ContainerRef): Promise<void> {
    return this.#lifecycle(() =>
      this.#locked(ref.name, async () => {
        const r = await this.#run(['stop', '-t', '3', ref.name]);
        if (r.code !== 0 && !isNoSuchContainer(r.stderr)) {
          throw new MelinaError('internal', `停容器 ${ref.name} 失败：${this.#firstLines(r.stderr)}`);
        }
        const tracked = this.#tracked.get(ref.name);
        if (tracked) tracked.running = false;
      }),
    );
  }

  remove(ref: ContainerRef): Promise<void> {
    return this.#lifecycle(() => this.#locked(ref.name, () => this.#remove(ref.name)));
  }

  async find(name: string): Promise<ContainerRef | undefined> {
    const found = await this.#inspect(name);
    return found ? containerRef(found.id, name, found.labels) : undefined;
  }

  async exec(ref: ContainerRef, req: ContainerExecRequest): Promise<ContainerExecResult> {
    return this.#exec(ref, req, false);
  }

  async #exec(ref: ContainerRef, req: ContainerExecRequest, retried: boolean): Promise<ContainerExecResult> {
    if ((req.capturePrivate || req.inspectPrivate) && req.background)
      throw new MelinaError('invalid', '私有输出处理只支持前台调用');
    if (req.capturePrivate && req.inspectPrivate) throw new MelinaError('invalid', '私有捕获和被动检查不能同时使用');
    if (req.background) return this.#execBackground(ref, req, retried);
    const started = Date.now();
    if (req.signal?.aborted) return { exitCode: null, output: '', timedOut: false, cancelled: true, durationMs: 0 };
    await this.#ensureHeld(ref);
    await this.#thawed(ref);
    const freezes = this.#freezes;
    const id = randomBytes(8).toString('hex');
    // 命令原文从 stdin 传：单个参数最长 128 KiB，长命令（比如带 heredoc 的）放不进参数
    const args = [
      'exec',
      '-i',
      ...envFlags(req.env),
      ref.name,
      'sh',
      '-c',
      EXEC_SCRIPT,
      'melina-exec',
      id,
      this.#paths.state,
      this.#cwd(req.cwd),
    ];
    const collector = new OutputCollector({
      headBytes: this.#headBytes,
      tailBytes: this.#tailBytes,
      sentinel: `\nMELINA-EXIT-${id} `,
    });
    const proc = this.#engine.spawn(args, { stdin: true });
    proc.stdin?.on('error', () => {}); // 容器没在跑时引擎不读 stdin，写入会 EPIPE，结果看退出码
    proc.stdin?.end(req.cmd);
    const watched = await this.#watch(proc, collector, req, () => this.#killAll(ref, id));
    const durationMs = Date.now() - started;

    if (!collector.done && !watched.timedOut && !watched.cancelled) {
      // 没等到结束标记：包装脚本没跑起来（容器没在跑、引擎出错），或者命令把包装脚本、容器自己弄停了。
      // 后一种照常返回（退出码是引擎报的，被信号杀掉时一般是 137），让 agent 看到
      if (isNotRunning(watched.stderr)) {
        // 起命令时撞上了冻结：命令没起来，解冻后重来一次
        if (!retried && this.#frozeSince(ref, freezes)) {
          await this.#thawed(ref);
          return this.#exec(ref, req, true);
        }
        throw conflict(`容器 ${ref.name} 没在运行`);
      }
      if (watched.code === 125 || (watched.code === null && watched.stderr.trim() !== '')) {
        throw new MelinaError('internal', `在容器 ${ref.name} 里执行失败：${this.#firstLines(watched.stderr)}`);
      }
    }
    const exitCode =
      watched.timedOut || watched.cancelled
        ? null
        : collector.done
          ? (collector.exitCode ?? null)
          : (watched.code ?? null);
    if (req.capturePrivate && exitCode === 0 && !watched.cancelled && !watched.timedOut) {
      const privateOutput = collector.result();
      if (privateOutput.omitted === 0) {
        try {
          req.capturePrivate(privateOutput.head);
        } catch {
          throw new MelinaError('invalid', '私有来源提取失败；原输出没有交给模型');
        }
      }
    }
    let inspected: string | undefined;
    if (req.inspectPrivate && exitCode === 0 && !watched.cancelled && !watched.timedOut) {
      const privateOutput = collector.result();
      if (privateOutput.omitted === 0) {
        try {
          inspected = req.inspectPrivate(privateOutput.head);
        } catch {
          throw new MelinaError('invalid', '私有输出检查失败；原输出没有交给模型');
        }
      }
    }
    // 包装脚本在容器里读的 cgroup 计数：容器有自己的 cgroup namespace，读到的是这个容器自己的
    const contention = contentionOf(collector.counters, durationMs, 'container');
    return {
      exitCode,
      output: req.capturePrivate
        ? '私有来源输出未回传，请通过受控引用登记'
        : inspected === undefined
          ? this.#assemble(collector)
          : this.#redactor.redact(inspected),
      timedOut: watched.timedOut,
      cancelled: watched.cancelled,
      durationMs,
      ...(contention ? { contention } : {}),
    };
  }

  ephemeral(input: ContainerSpec): Promise<ContainerRef> {
    return this.#lifecycle(() =>
      this.#locked(input.name, async () => {
        await this.#requireRootless();
        const spec = this.#checkSpec(input);
        // 同名的是上次崩溃留下的，删掉重建
        if (await this.#inspect(spec.name)) await this.#must(['rm', '-f', spec.name], `删掉旧的临时容器 ${spec.name}`);
        return this.#create(spec, true);
      }),
    );
  }

  // ── ContainerRuntime 之外的几个方法（进程入口和恢复用） ──────────────────

  /** 这个进程启动过、正在跑、挂着这个 workspace 的容器；writable 时只要可写挂载的 */
  forWorkspace(path: string, options: { writable?: boolean } = {}): ContainerRef | undefined {
    for (const t of this.#tracked.values()) {
      if (t.running && t.workspace === path && !(options.writable && t.readOnly)) return t.ref;
    }
    return undefined;
  }

  /**
   * 分支容器起得来、冻得住吗。snapshot 前要冻结挂着 workspace 的容器（下面的 withWorkspaceFrozen），冻不住时路线收尾、
   * 存个阶段版、停下时拍现场都存不下来。冻结要求容器有自己的 cgroup：rootless 引擎没让 systemd 管 cgroup 时，建出来的容器没有，
   * pause 报「cannot pause the container without a cgroup」。从 info 推断不准，所以真试一次：用这几个领域里第一个建好的镜像，
   * 按分支容器的沙箱参数（#sandboxArgs：网络、tmpfs、cap、上限）起一个不挂目录的测试容器，pause、unpause，再删掉。
   * 冻得住的结论一直用，直到真冻结失败；冻不住的过 FREEZE_RETRY_MS 再试。镜像一个都没建时试不了，返回 undefined；
   * 测试容器起不来抛 unavailable：分支容器一样起不来（没装 slirp4netns、上限的控制器用不了这类），开工前就说
   */
  checkFreeze(domains: readonly string[]): Promise<FreezeCheck | undefined> {
    const known = this.#freezeCheck;
    if (known && (known.result.ok || this.#now() - known.at < this.#freezeRetryMs))
      return Promise.resolve(known.result);
    if (!this.#freezeChecking) {
      const checking = this.#probeFreeze(domains);
      this.#freezeChecking = checking;
      const done = () => {
        if (this.#freezeChecking === checking) this.#freezeChecking = undefined;
      };
      checking.then(done, done);
    }
    return this.#freezeChecking;
  }

  async #probeFreeze(domains: readonly string[]): Promise<FreezeCheck | undefined> {
    const image = (await this.checkImages(domains)).find((i) => i.present)?.image;
    if (!image) return undefined;
    const info = await this.probe();
    const name = `melina-freeze-check-${randomBytes(4).toString('hex')}`;
    try {
      const started = await this.#run([
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        ...this.#sandboxArgs(info, FREEZE_PROBE_LIMITS),
        image,
        'sleep',
        String(FREEZE_PROBE_SLEEP_S),
      ]);
      if (started.code !== 0) {
        const why = this.#firstLines(started.stderr) || `退出码 ${started.code}`;
        throw new MelinaError('unavailable', `按分支容器的参数起不来容器：${why}${startHint(why)}`);
      }
      let result: FreezeCheck = { ok: true };
      for (const step of ['pause', 'unpause']) {
        const r = await this.#run([step, name]);
        if (r.code === 0) continue;
        result = { ok: false, error: `${step}：${this.#firstLines(r.stderr) || `退出码 ${r.code}`}` };
        break;
      }
      this.#freezeCheck = { at: this.#now(), result };
      // 要真试，多半是 cgroup 的配置变了或者可能变了（刚启动、修环境、真冻结失败）：上限能不能生效也重新看
      this.#info = undefined;
      return result;
    } finally {
      // run 起不来时可能留下 Created 状态的半成品，冻住了没解开的也在这里删
      await this.#run(['rm', '-f', name]).catch(() => undefined);
    }
  }

  /** 真冻结失败：之前「冻得住」的结论作废，下次 checkFreeze 重新真试，并告诉进程入口马上再测 */
  #freezeFailed(): void {
    if (this.#freezeCheck?.result.ok === false) return; // 已经知道冻不住：系统状态里写着，照原来的节奏再试
    this.#freezeCheck = undefined;
    this.#onFreezeFailed?.();
  }

  /**
   * 冻结所有挂着这个 workspace 的容器（含上次进程留下的）；冻结失败就不读，结束后恢复本次冻结的容器。
   * 冻结期间在这个 workspace 上起命令、杀进程的先等解冻（冻结闸门）
   */
  withWorkspaceFrozen<T>(path: string, work: () => Promise<T>): Promise<T> {
    return this.#lifecycle(async () => {
      let thaw: () => void = () => {};
      this.#freezing.set(
        path,
        new Promise<void>((resolve) => {
          thaw = resolve;
        }),
      );
      this.#freezes++;
      try {
        return await this.#frozen(path, work);
      } finally {
        this.#freezing.delete(path);
        thaw();
      }
    });
  }

  async #frozen<T>(path: string, work: () => Promise<T>): Promise<T> {
    const paused: ContainerRef[] = [];
    let result: T | undefined;
    let captureFailure: { error: unknown } | undefined;
    try {
      for (const c of await this.managed()) {
        if (!c.running || c.paused || c.labels[LABEL.workspace] !== path) continue;
        try {
          await this.#must(['pause', c.ref.name], `冻结容器 ${c.ref.name}`);
        } catch (error) {
          this.#freezeFailed();
          throw error;
        }
        paused.push(c.ref);
      }
      result = await work();
    } catch (error) {
      captureFailure = { error };
    }
    const failures: unknown[] = [];
    for (const ref of paused.reverse()) {
      try {
        await this.#must(['unpause', ref.name], `恢复容器 ${ref.name}`);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      if (captureFailure) failures.unshift(captureFailure.error);
      throw new AggregateError(failures, 'snapshot 后恢复容器失败');
    }
    if (captureFailure) throw captureFailure.error;
    return result as T;
  }

  /** 这个容器挂的 workspace 正在冻结：等它解冻，最多等 THAW_WAIT_MS */
  async #thawed(ref: ContainerRef): Promise<void> {
    const ws = this.#tracked.get(ref.name)?.workspace;
    const gate = ws === undefined ? undefined : this.#freezing.get(ws);
    if (!gate) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      gate,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, THAW_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** 从记下 freezes 那一刻起，这个容器挂的 workspace 冻结过（或正在冻结） */
  #frozeSince(ref: ContainerRef, freezes: number): boolean {
    const ws = this.#tracked.get(ref.name)?.workspace;
    return this.#freezes !== freezes || (ws !== undefined && this.#freezing.has(ws));
  }

  /** Melina 管的全部容器（按 melina.managed 标签找，含停着的） */
  async managed(): Promise<
    { ref: ContainerRef; running: boolean; paused: boolean; ephemeral: boolean; labels: Record<string, string> }[]
  > {
    const r = await this.#run(['ps', '-a', '-q', '--filter', `label=${LABEL.managed}=1`]);
    if (r.code !== 0) throw new MelinaError('internal', `列容器失败：${this.#firstLines(r.stderr)}`);
    const ids = r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await this.#run(['container', 'inspect', ...ids]);
    if (inspected.code !== 0) throw new MelinaError('internal', `查容器失败：${this.#firstLines(inspected.stderr)}`);
    return parseInspect(inspected.stdout).map((c) => ({
      ref: containerRef(c.id, c.name, c.labels),
      running: c.running,
      paused: c.paused,
      ephemeral: c.labels[LABEL.ephemeral] === '1',
      labels: c.labels,
    }));
  }

  /** 删掉上次崩溃留下的临时容器（Scoper、setup 用），恢复流程开头调 */
  async removeEphemeral(): Promise<string[]> {
    const removed: string[] = [];
    for (const c of await this.managed()) {
      if (!c.ephemeral) continue;
      await this.remove(c.ref);
      removed.push(c.ref.name);
    }
    return removed;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /** 冻结时不能建、启、停、删容器；和这些短操作共用队列，避免读到一半出现新的写入者 */
  #lifecycle<T>(work: () => Promise<T>): Promise<T> {
    return this.#locked(':lifecycle', work);
  }

  async #requireRootless(): Promise<void> {
    const info = await this.probe();
    if (process.platform === 'linux' && !info.rootless) {
      throw new MelinaError('unavailable', `${info.kind} 不是 rootless 模式：先配置 rootless 容器引擎，才能运行任务`);
    }
  }

  async #probe(): Promise<EngineInfo> {
    const kind = this.#engine.kind;
    const r = await this.#run(kind === 'podman' ? ['info', '--format', 'json'] : ['info', '--format', '{{json .}}'], {
      timeoutMs: 60_000,
    });
    if (r.code !== 0)
      throw new MelinaError('unavailable', `${kind} 用不了：${this.#firstLines(r.stderr) || `退出码 ${r.code}`}`);
    const info = JSON.parse(r.stdout) as Record<string, unknown>;
    if (kind === 'podman') {
      const host = (info.host ?? {}) as Record<string, unknown>;
      const rootless = Boolean((host.security as Record<string, unknown> | undefined)?.rootless);
      const v2 = host.cgroupVersion === 'v2';
      const controllers = Array.isArray(host.cgroupControllers) ? (host.cgroupControllers as string[]) : undefined;
      // rootless 时只有 systemd 管 cgroup 才设得了上限（没有用户级 systemd 会话时 podman 退回 cgroupfs）
      const canLimit = v2 && (!rootless || host.cgroupManager === undefined || host.cgroupManager === 'systemd');
      return {
        kind,
        version: String((info.version as Record<string, unknown> | undefined)?.Version ?? ''),
        rootless,
        // 控制器列表不在（老版本）时只看上面那条
        memoryLimit: canLimit && (controllers ? controllers.includes('memory') : true),
        pidsLimit: canLimit && (controllers ? controllers.includes('pids') : true),
      };
    }
    // docker 连不上守护进程时 info 可能照样退出 0，只是带着 ServerErrors
    const errors = Array.isArray(info.ServerErrors) ? (info.ServerErrors as string[]) : [];
    if (errors.length > 0 || !info.ServerVersion) {
      throw new MelinaError('unavailable', `docker 用不了：${errors.join('；') || '连不上 docker 守护进程'}`);
    }
    const options = Array.isArray(info.SecurityOptions) ? (info.SecurityOptions as string[]) : [];
    return {
      kind,
      version: String(info.ServerVersion ?? ''),
      rootless: options.some((o) => o.includes('rootless')),
      memoryLimit: info.MemoryLimit !== false,
      pidsLimit: info.PidsLimit !== false,
    };
  }

  async #create(spec: ContainerSpec, ephemeral: boolean): Promise<ContainerRef> {
    const image = this.#images.imageFor(spec.domain);
    const info = await this.probe();
    const places: CredentialPlace[] = spec.credentials.map((c) =>
      'env' in c.as ? { name: c.name, env: c.as.env } : { name: c.name, file: c.as.file },
    );
    const memory = this.#memoryFor(spec);
    if (!info.memoryLimit)
      this.#warnOnce(
        'memory',
        `${info.kind} 的内存上限不生效（cgroup v2 的 memory 控制器没委派给当前用户），容器不限内存`,
      );
    const pids = spec.pidsMax ?? (this.#pidsMax === 'auto' ? AUTO_PIDS_MAX : this.#pidsMax);
    if (!info.pidsLimit)
      this.#warnOnce('pids', `${info.kind} 的进程数上限不生效（pids 控制器没委派给当前用户），容器不限进程数`);
    const args = [
      'run',
      '-d',
      '--name',
      spec.name,
      ...this.#sandboxArgs(info, { memory, pids }),
      '--label',
      `${LABEL.managed}=1`,
      '--label',
      `${LABEL.domain}=${spec.domain}`,
      '--label',
      `${LABEL.ephemeral}=${ephemeral ? '1' : '0'}`,
      '--label',
      `${LABEL.workspace}=${spec.workspace.host}`,
      '--label',
      `${LABEL.network}=${this.#network}`,
      '--label',
      `${LABEL.credentials}=${JSON.stringify(places)}`,
    ];
    for (const [key, value] of Object.entries(spec.labels ?? {})) args.push('--label', `${key}=${value}`);
    args.push('-v', `${spec.workspace.host}:${this.#paths.workspace}:${spec.workspace.readOnly ? 'ro' : 'rw'}`);
    if (spec.artifactsDir) args.push('-v', `${spec.artifactsDir}:${this.#paths.artifacts}:ro`);
    if (spec.materialsDir) args.push('-v', `${spec.materialsDir}:${this.#paths.materials}:ro`);
    if (spec.originDir) args.push('-v', `${spec.originDir}:${this.#paths.origin}:ro`);

    // 环境变量形式的凭证：命令行上只有名字，值从引擎进程自己的环境里取（podman、docker 都这样处理不带值的 --env）
    const env: Record<string, string> = {};
    for (const c of spec.credentials) {
      if (!('env' in c.as)) continue;
      args.push('--env', c.as.env);
      env[c.as.env] = c.value;
    }
    args.push(image, 'sleep', 'infinity');

    const r = await this.#run(args, { env });
    if (r.code !== 0) {
      // run 是先建再启，启动失败会留下一个 Created 状态的容器；不删的话下次 start 会直接启动它，文件形式的凭证就没写进去
      await this.#run(['rm', '-f', spec.name]).catch(() => undefined);
      if (
        /image not known|no such image|unable to find image|image .* not found|repository .* not found/i.test(r.stderr)
      ) {
        throw new MelinaError('unavailable', `领域 ${spec.domain} 的镜像 ${image} 还没构建：先跑 pnpm images`);
      }
      const why = this.#firstLines(r.stderr);
      throw new MelinaError('internal', `建容器 ${spec.name} 失败：${why}${startHint(why)}`);
    }
    const id = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    const ref = containerRef(id, spec.name, spec.labels);

    for (const c of spec.credentials) {
      if (!('file' in c.as)) continue;
      const w = await this.#run(['exec', '-i', spec.name, 'sh', '-c', WRITE_FILE_SCRIPT, 'melina-write', c.as.file], {
        input: c.value,
      });
      if (w.code !== 0) {
        await this.#run(['rm', '-f', spec.name]).catch(() => undefined);
        throw new MelinaError('internal', `把凭证「${c.name}」写进容器失败：${this.#firstLines(w.stderr)}`);
      }
    }
    this.#redactor.hold(
      spec.name,
      spec.credentials.map((c) => ({ name: c.name, value: c.value })),
    );
    this.#held.add(spec.name);
    this.#track(ref, spec, ephemeral);
    return ref;
  }

  /**
   * 每个容器都带的沙箱参数：不拉镜像、不做标签隔离、SYS_PTRACE、状态目录的 tmpfs、这台机器上生效的内存和进程数上限、网络。
   * 分支容器、临时容器和测冻结的测试容器用同一份：测的就是分支容器起得来、冻得住
   */
  #sandboxArgs(info: EngineInfo, limits: { memory: number; pids: number }): string[] {
    const args = [
      '--pull=never',
      // SELinux 下不给挂载目录重新打标签（会改到用户仓库），改成不做标签隔离
      '--security-opt',
      'label=disable',
      // 只在容器自己的 user namespace 里生效：gdb、strace 能用，取消时也读得到别的用户进程的环境变量
      '--cap-add=SYS_PTRACE',
      '--tmpfs',
      `${this.#paths.state}:rw,size=64m,mode=755`,
    ];
    if (info.memoryLimit) args.push('--memory', String(limits.memory), '--memory-swap', String(limits.memory));
    if (info.pidsLimit) args.push('--pids-limit', String(limits.pids));
    args.push('--network', this.#network);
    return args;
  }

  #memoryFor(spec: ContainerSpec): number {
    if (spec.memoryMax) return spec.memoryMax;
    if (this.#memoryMax !== 'auto') return this.#memoryMax;
    const running = [...this.#tracked.values()].filter((t) => t.running).length + 1;
    return autoMemoryMax(this.#totalMemory(), running);
  }

  /** Melina 重启后再启动老容器：按标签里记的位置，找回它手里的凭证值，照样替换（凭证可能已经改过） */
  async #recoverHeld(ref: ContainerRef, found: Inspected): Promise<void> {
    const secrets: Secret[] = [];
    for (const place of parseCredentialPlaces(found.labels[LABEL.credentials])) {
      if (place.env) {
        const entry = found.env.find((e) => e.startsWith(`${place.env}=`));
        if (entry) secrets.push({ name: place.name, value: entry.slice(place.env.length + 1) });
      } else if (place.file) {
        const r = await this.#run(['exec', ref.name, 'cat', place.file]);
        if (r.code === 0) secrets.push({ name: place.name, value: r.stdout });
      }
    }
    this.#redactor.hold(ref.name, secrets);
    this.#held.add(ref.name);
  }

  #track(ref: ContainerRef, spec: ContainerSpec, ephemeral: boolean): void {
    this.#tracked.set(ref.name, {
      ref,
      workspace: spec.workspace.host,
      readOnly: spec.workspace.readOnly,
      ephemeral,
      running: true,
    });
  }

  async #execBackground(ref: ContainerRef, req: ContainerExecRequest, retried: boolean): Promise<ContainerExecResult> {
    const started = Date.now();
    const max = typeof this.#maxBackground === 'function' ? this.#maxBackground(ref) : this.#maxBackground;
    const cwd = this.#cwd(req.cwd);
    await this.#ensureHeld(ref);
    await this.#thawed(ref);
    const freezes = this.#freezes;
    const r = await this.#run(
      [
        'exec',
        '-i',
        ...envFlags(req.env),
        ref.name,
        'sh',
        '-c',
        BG_SCRIPT,
        'melina-bg',
        randomBytes(8).toString('hex'),
        this.#paths.state,
        this.#paths.logs,
        cwd,
        String(max),
        displayCommand(req.cmd),
      ],
      { input: req.cmd },
    );
    const parsed = parseBackgroundOutput(r.stdout);
    if (!parsed) {
      if (isNotRunning(r.stderr)) {
        if (!retried && this.#frozeSince(ref, freezes)) {
          await this.#thawed(ref);
          return this.#execBackground(ref, req, true);
        }
        throw conflict(`容器 ${ref.name} 没在运行`);
      }
      throw new MelinaError('internal', `起后台进程失败：${this.#firstLines(r.stderr) || `退出码 ${r.code}`}`);
    }
    const durationMs = Date.now() - started;
    if (parsed.kind === 'full') {
      throw conflict(`后台进程已经有 ${parsed.count} 个了（上限 ${max} 个），先用 kill 停掉不用的再起新的`);
    }
    if (parsed.kind === 'nodir') {
      return { exitCode: 2, output: `工作目录不存在：${cwd}`, timedOut: false, cancelled: false, durationMs };
    }
    return {
      exitCode: 0,
      output: '',
      timedOut: false,
      cancelled: false,
      durationMs,
      background: { pid: parsed.pid ?? 0, log: parsed.log ?? '' },
    };
  }

  /** 盯着一次前台命令：结束标记、超时、取消、引擎客户端退出，哪个先到算哪个 */
  #watch(
    proc: EngineProcess,
    collector: OutputCollector,
    req: ContainerExecRequest,
    kill: () => Promise<void>,
  ): Promise<{ code: number | null | undefined; timedOut: boolean; cancelled: boolean; stderr: string }> {
    return new Promise((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let sentinelSeen = false;
      let killing: Promise<void> | undefined;
      const timers: NodeJS.Timeout[] = [];
      const stderr: Buffer[] = [];
      let stderrLen = 0;
      const settle = (code: number | null | undefined) => {
        if (settled) return;
        settled = true;
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          for (const t of timers) clearTimeout(t);
          req.signal?.removeEventListener('abort', onAbort);
          resolve({ code, timedOut, cancelled, stderr: Buffer.concat(stderr).toString('utf8') });
        };
        // 超时或取消时等杀完再返回：返回时这次命令的进程都已经没了（最多等 killGraceMs）
        if (!killing) return done();
        const cap = setTimeout(done, this.#killGraceMs);
        void killing.then(() => {
          clearTimeout(cap);
          done();
        });
      };
      const stop = (reason: 'timeout' | 'cancel') => {
        if (settled || timedOut || cancelled || sentinelSeen) return;
        if (reason === 'timeout') timedOut = true;
        else cancelled = true;
        killing = kill(); // 杀两遍、杀不动就重启容器，见 #killAll
        timers.push(
          setTimeout(() => {
            proc.kill();
            settle(undefined);
          }, this.#killGraceMs),
        );
      };
      const onAbort = () => stop('cancel');
      proc.stdout.on('data', (chunk: Buffer) => {
        collector.push(chunk);
        if (collector.done && !sentinelSeen) {
          sentinelSeen = true;
          // 命令已经结束；它留下的子进程可能还占着输出管道，引擎客户端一秒内不退就杀掉它（容器里的进程不受影响）
          timers.push(
            setTimeout(() => {
              proc.kill();
              settle(undefined);
            }, 1000),
          );
        }
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        if (stderrLen < 64 * 1024) {
          stderr.push(chunk);
          stderrLen += chunk.length;
        }
      });
      void proc.closed.then((code) => {
        collector.end();
        settle(code);
      });
      timers.push(setTimeout(() => stop('timeout'), Math.min(Math.max(req.timeoutMs, 0), MAX_TIMER_MS)));
      req.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 取消或超时：杀两遍（第一遍时命令可能刚 fork 还没带上标记；取消标记挡住还没起来的）。
   * 两遍都没能在容器里跑起来（进程数满了这类），容器已经失控：重启它，里面的进程全部结束，装过的东西还在。
   */
  async #killAll(ref: ContainerRef, id: string): Promise<void> {
    // 冻结期间杀不了（exec 起不来，命令解冻后还会接着跑）：先等解冻（冻结闸门）
    await this.#thawed(ref);
    const first = await this.#killExec(ref, id);
    await new Promise((r) => setTimeout(r, 300));
    const second = await this.#killExec(ref, id);
    if (first === 'failed' && second === 'failed') {
      this.#onWarn(`容器 ${ref.name} 里连杀进程的命令都起不来，重启这个容器`);
      await this.#run(['restart', '-t', '0', ref.name]).catch(() => undefined);
    }
  }

  async #killExec(ref: ContainerRef, id: string): Promise<'ok' | 'not-running' | 'failed'> {
    const r = await this.#run(['exec', ref.name, 'sh', '-c', KILL_SCRIPT, 'melina-kill', id, this.#paths.state], {
      timeoutMs: 15_000,
    }).catch((error: unknown) => ({ code: null, stdout: '', stderr: String(error) }));
    if (r.code === 0) return 'ok';
    return isNotRunning(r.stderr) ? 'not-running' : 'failed';
  }

  /** 删除容器与它持有的状态；调用方已经持有生命周期闸门和同名锁 */
  async #remove(name: string): Promise<void> {
    const r = await this.#run(['rm', '-f', name]);
    if (r.code !== 0 && !isNoSuchContainer(r.stderr)) {
      throw new MelinaError('internal', `删容器 ${name} 失败：${this.#firstLines(r.stderr)}`);
    }
    this.#tracked.delete(name);
    this.#held.delete(name);
    this.#redactor.release(name);
  }

  /** 这个进程没启动过的容器（比如恢复时 find 找回来的）：第一次用之前找回它手里的凭证值 */
  async #ensureHeld(ref: ContainerRef): Promise<void> {
    if (this.#held.has(ref.name)) return;
    await this.#requireRootless();
    const found = await this.#inspect(ref.name).catch(() => undefined);
    if (found?.running) {
      this.#checkNetwork(found, ref.name);
      await this.#recoverHeld(ref, found);
    }
  }

  #checkNetwork(found: Inspected, name: string): void {
    if (found.labels[LABEL.managed] !== '1' || found.labels[LABEL.network] !== this.#network) {
      throw new MelinaError('unavailable', `容器 ${name} 的网络隔离配置无法确认：需要重建容器后再运行任务`);
    }
  }

  #assemble(collector: OutputCollector): string {
    const out = collector.result();
    if (out.omitted === 0) return this.#redactor.redact(out.head);
    const { head, tail } = this.#redactor.redactCut(out.head, out.tail);
    return `${head}\n…（中间省略了 ${out.omitted} 字节）…\n${tail}`;
  }

  #cwd(cwd: string | undefined): string {
    return posix.join(this.#paths.workspace, cwd ?? '.');
  }

  async #inspect(name: string): Promise<Inspected | undefined> {
    const r = await this.#run(['container', 'inspect', name]);
    if (r.code !== 0) {
      if (isNoSuchContainer(r.stderr) || r.stdout.trim() === '[]') return undefined;
      throw new MelinaError('internal', `查容器 ${name} 失败：${this.#firstLines(r.stderr)}`);
    }
    return parseInspect(r.stdout)[0];
  }

  async #must(args: string[], what: string): Promise<CommandResult> {
    const r = await this.#run(args);
    if (r.code !== 0)
      throw new MelinaError('internal', `${what}失败：${this.#firstLines(r.stderr) || `退出码 ${r.code}`}`);
    return r;
  }

  #run(
    args: readonly string[],
    options: { input?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<CommandResult> {
    return runEngine(this.#engine, args, { timeoutMs: this.#engineTimeoutMs, ...options });
  }

  async #locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.#locks.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  /** 校验容器配置和凭证；不合当前约束时拒绝创建，不静默丢弃配置。 */
  #checkSpec(spec: ContainerSpec): ContainerSpec {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(spec.name)) throw invalid(`容器名不合法：${spec.name}`);
    if (spec.workspace.container !== this.#paths.workspace) {
      throw invalid(`workspace 要挂到 ${this.#paths.workspace}，不是 ${spec.workspace.container}`);
    }
    for (const key of Object.keys(spec.labels ?? {})) {
      if (Object.values(LABEL).some((reserved) => reserved === key)) {
        throw invalid(`容器标签 ${key} 由 Melina 管理，不能覆盖沙箱配置`);
      }
    }
    for (const [what, path] of [
      ['workspace', spec.workspace.host],
      ['artifactsDir', spec.artifactsDir],
      ['materialsDir', spec.materialsDir],
      ['originDir', spec.originDir],
    ] as const) {
      if (path === undefined) continue;
      if (!isAbsolute(path) || /[:\n\0]/.test(path)) throw invalid(`${what} 要是不含冒号的绝对路径：${path}`);
    }
    for (const c of spec.credentials) {
      const problem = credentialProblem(c) ?? this.#placeProblem(c);
      if (problem) throw invalid(problem);
    }
    return spec;
  }

  /** 这个运行时自己的挂载点（测试里可以换）：文件形式的凭证也不能放在下面 */
  #placeProblem(c: ContainerSpec['credentials'][number]): string | undefined {
    if (!('file' in c.as)) return undefined;
    const file = posix.normalize(c.as.file);
    const reserved = [this.#paths.workspace, this.#paths.state];
    if (reserved.some((r) => file === r || file.startsWith(`${r}/`))) {
      return `凭证「${c.name}」的文件不能放在 ${reserved.join('、')} 下面：${c.as.file}`;
    }
    return undefined;
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#onWarn(message);
  }

  #firstLines(text: string): string {
    return this.#redactor.redact(text.trim().split('\n').slice(0, 5).join('；'));
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/**
 * 容器起不来时补一句怎么修，认得出的才说。容器网络只用 slirp4netns:allow_host_loopback=false：Melina 的 API 只听
 * 127.0.0.1、不设令牌，靠它挡住容器里的 agent；Podman 5 默认换成了 pasta，还没在真机上验证过连不到宿主机的回环地址，先不放开
 */
function startHint(message: string): string {
  if (/slirp4netns/i.test(message)) {
    return '。Melina 的容器网络用 slirp4netns（隔开宿主机的回环地址），Podman 5 默认换成了 pasta、不一定装了它：装上 slirp4netns 这个包';
  }
  return '';
}

function envFlags(env: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw invalid(`环境变量名不合法：${key}`);
    out.push('--env', `${key}=${value}`);
  }
  return out;
}

function parseInspect(stdout: string): (Inspected & { name: string })[] {
  const data = JSON.parse(stdout) as Record<string, unknown>[];
  return data.map((c) => {
    const state = (c.State ?? {}) as Record<string, unknown>;
    const config = (c.Config ?? {}) as Record<string, unknown>;
    return {
      id: String(c.Id ?? c.ID ?? ''),
      name: String(c.Name ?? '').replace(/^\//, ''),
      running: state.Running === true,
      paused: state.Paused === true,
      labels: (config.Labels ?? {}) as Record<string, string>,
      env: Array.isArray(config.Env) ? (config.Env as string[]) : [],
    };
  });
}

function parseCredentialPlaces(label: string | undefined): CredentialPlace[] {
  if (!label) return [];
  try {
    const parsed = JSON.parse(label) as unknown;
    return Array.isArray(parsed) ? (parsed as CredentialPlace[]) : [];
  } catch {
    return [];
  }
}

function isNoSuchContainer(stderr: string): boolean {
  return /no such container|no container with name or id/i.test(stderr);
}

function isNotRunning(stderr: string): boolean {
  return /not running|state improper|no such container|no container with name or id|is paused|is restarting/i.test(
    stderr,
  );
}
