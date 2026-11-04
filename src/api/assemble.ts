// 进程基础设施的装配和资源所有权：先拿锁再开库，关闭时先停运行时、关库，最后放锁。

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createSecretBox,
  loadOrCreateKeyFile,
  parseSecretKey,
  SECRET_KEY_ENV,
  type SecretBox,
} from '../config/secret-box.ts';
import { SqliteConfigStore } from '../config/store.ts';
import type { BranchDiffResponse, MelinaOptions } from '../core/api.ts';
import { DEFAULT_RUN_CONFIG } from '../core/config.ts';
import { isMelinaError, MelinaError, notFound } from '../core/errors.ts';
import type { SystemNotice } from '../core/events.ts';
import { type Handle, type Id, ROOT, type SnapshotId } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { ConfigStore } from '../core/interfaces/config-store.ts';
import { CONTAINER_PATHS, type ContainerRef, type ContainerRuntime } from '../core/interfaces/container.ts';
import type { Recovery, RecoveryReport, RunManager } from '../core/interfaces/runtime.ts';
import type { Scheduler } from '../core/interfaces/scheduler.ts';
import type { EventBus, RunStoreQueries, RunStoreWriter } from '../core/interfaces/store.ts';
import type { ExecResult, WorkspaceProvider, WorkspaceProviders } from '../core/interfaces/workspace.ts';
import { createBreaker } from '../models/breaker.ts';
import { builtinProviders } from '../models/builtin.ts';
import { createModelRegistry, type MelinaModelRegistry } from '../models/registry.ts';
import { domainOf, originOf } from '../runtime/branch-env.ts';
import { createUsageLedger, type MelinaUsageLedger } from '../runtime/ledger.ts';
import { openRunStore, type RunStore } from '../storage/state.ts';
import { SYSTEM_EVENTS_PRUNE_BATCH, SYSTEM_EVENTS_PRUNE_EVERY_MS } from '../storage/writer.ts';
import { type CliEngine, detectEngine, type EngineKind, PodmanRuntime, runEngine } from '../tools/container.ts';
import { DomainImages } from '../tools/container-images.ts';
import { SecretRedactor } from '../tools/redact.ts';
import { createWorkspaceProviders } from '../workspace/provider.ts';
import { acquireLock, type DataDirLock } from './data-lock.ts';
import { melinaRuntime } from './runtime.ts';
import {
  type ContainerCheck,
  containerNotices,
  type StatusReporter,
  startStatusReporter,
  systemStatus,
} from './status.ts';

/** 运行时：Melina 只用到这几样 */
export interface Runtime {
  runs: RunManager;
  /** 进程启动时先跑；没有就跳过 */
  recovery?: Recovery;
  /** 系统状态里的容量和排队；没有就按空闲算 */
  scheduler?: Pick<Scheduler, 'status'>;
  /** 恢复后启动所有运行时组件 */
  start(): Promise<void>;
  /** 停止所有运行时组件并等待收尾完成 */
  close(): Promise<void>;
}

/** 组装好、交给运行时的各模块 */
export interface InfraDeps {
  paths: MelinaPaths;
  writer: RunStoreWriter;
  queries: RunStoreQueries;
  bus: EventBus;
  artifacts: ArtifactStore;
  config: ConfigStore;
  registry: MelinaModelRegistry;
  ledger: MelinaUsageLedger;
  redactor: SecretRedactor;
  /** 找不到容器引擎时没有（系统状态和日志里会说） */
  containers?: MelinaContainers;
  workspaces: WorkspaceProviders;
  log: MelinaLog;
  /** 运行时的排队、容量变了：让系统状态马上推出去（不等每秒那一次） */
  statusChanged?: () => void;
}

export type RuntimeFactory = (deps: InfraDeps) => Runtime;

export interface MelinaLog {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

const consoleLog: MelinaLog = {
  warn: (message) => console.warn(`[Melina] ${message}`),
  error: (message, error) => console.error(`[Melina] ${message}`, error ?? ''),
};

/** 第二个参数：进程入口和测试用，SDK 的一般用法不用管 */
export interface MelinaInternals {
  /** 默认 melinaRuntime()（runtime.ts）；notConnectedRuntime 表示不接运行时 */
  runtime?: RuntimeFactory;
  /** 另外不许当工作目录的目录（melina serve 把整个数据目录 ~/.melina 加进来） */
  protectedDirs?: readonly string[];
  /** 环境变量，默认 process.env（MELINA_SECRET_KEY、MELINA_CONTAINER_ENGINE） */
  env?: NodeJS.ProcessEnv;
  /** 容器运行时；默认按 PATH 找 podman 或 docker，找不到就没有。传 null 表示不要容器 */
  containers?: MelinaContainers | null;
  /** 模型供应商；默认仅 DeepSeek，测试可注入假传输 */
  modelProviders?: Parameters<typeof createModelRegistry>[0]['providers'];
  log?: MelinaLog;
  /** system.updated 的合并窗口（毫秒），默认 1000 */
  statusIntervalMs?: number;
  /** 镜像没建、容器引擎用不了时多久再查一次（毫秒），默认 60 秒 */
  containerRecheckMs?: number;
}

/** 在跑路线的改动（GET /runs/:id/branches/:branchId/diff）最多记住多少版：同一版重复请求不重算，老的版本没人再看 */
const BRANCH_DIFF_CACHE = 256;

export function notConnectedRuntime(): Runtime {
  const fail = async (): Promise<never> => {
    throw new MelinaError('unavailable', '运行时还没接上：现在只能查看和改配置，不能新建或操作任务');
  };
  return {
    start: async () => {},
    close: async () => {},
    runs: {
      create: fail,
      pause: fail,
      interrupt: fail,
      resume: fail,
      cancel: fail,
      input: fail,
      delete: fail,
      result: fail,
      start: async () => {},
      stop: async () => {},
    },
  };
}

// ── 路径 ──────────────────────────────────────────────────────────────────

export interface MelinaPaths {
  /** SQLite 文件。:memory: 换成临时目录里的文件（RunStore 和配置存储要开两条连接，better-sqlite3 不认共享内存库的 URI） */
  db: string;
  /** :memory: 时的临时目录，Melina.close() 时删掉 */
  scratch?: string;
  artifacts: string;
  /** 放 workspace 的目录 */
  dataDir: string;
  /** 数据目录的文件锁：Melina 打开 RunStore 之前拿，关完库再放 */
  lock: string;
  /** 上传附件的临时目录 */
  uploads: string;
  /** API key 和凭证的密钥文件；内存库没有（用一次性的密钥） */
  keyFile?: string;
  /** 不许当工作目录、GET /dirs 不列的 */
  protectedDirs: string[];
}

export function resolvePaths(options: MelinaOptions, extra: readonly string[] = []): MelinaPaths {
  const scratch = options.db === ':memory:' ? join(tmpdir(), `melina-${randomUUID()}`) : undefined;
  const db = scratch ? join(scratch, 'melina.db') : resolve(options.db);
  const artifacts = resolve(options.artifacts);
  const dataDir = resolve(options.dataDir ?? join(dirname(db), 'workspaces'));
  const keyFile = scratch ? undefined : join(dirname(db), 'melina.key');
  const protectedDirs = [artifacts, dataDir, db, ...extra.map((p) => resolve(p))];
  if (keyFile) protectedDirs.push(keyFile);
  return {
    db,
    artifacts,
    dataDir,
    lock: join(dataDir, 'melina.lock'),
    uploads: join(dataDir, '.uploads'),
    ...(keyFile ? { keyFile } : {}),
    ...(scratch ? { scratch } : {}),
    protectedDirs,
  };
}

function secretBoxFor(paths: MelinaPaths, env: NodeJS.ProcessEnv): SecretBox {
  const fromEnv = env[SECRET_KEY_ENV];
  if (fromEnv) return createSecretBox(parseSecretKey(fromEnv));
  // 内存库：密钥跟着进程走，进程结束数据也没了
  if (!paths.keyFile) return createSecretBox(randomBytes(32));
  return createSecretBox(loadOrCreateKeyFile(paths.keyFile));
}

export class MelinaInfrastructure {
  readonly paths: MelinaPaths;
  /** 接了运行时（不是 notConnectedRuntime） */
  readonly runtimeConnected: boolean;
  readonly #store: RunStore;
  readonly queries: RunStoreQueries;
  readonly bus: EventBus;
  readonly #lock: DataDirLock;
  readonly artifacts: ArtifactStore;
  readonly config: SqliteConfigStore;
  readonly registry: MelinaModelRegistry;
  readonly #ledger: MelinaUsageLedger;
  readonly #redactor: SecretRedactor;
  readonly #containers: MelinaContainers | undefined;
  readonly #workspaces: WorkspaceProviders;
  readonly runtime: Runtime;
  readonly status: StatusReporter;
  readonly log: MelinaLog;
  readonly ready: Promise<RecoveryReport | undefined>;
  readonly #unsubscribe: (() => void)[] = [];
  readonly #shutdown = new AbortController();
  readonly signal = this.#shutdown.signal;
  /** 每小时清一次旧的 system.updated */
  readonly #pruning: ReturnType<typeof setInterval>;
  #closing: Promise<void> | undefined;
  // 容器引擎、镜像与冻结能力的系统提示由 #checkContainers 更新。
  #containerNotices: SystemNotice[] = [];
  readonly #containerRecheckMs: number;
  #containerCheck: Promise<void> | undefined;
  #containerTimer: ReturnType<typeof setTimeout> | undefined;
  /** 在跑路线的改动：（Run，snapshot）→ patch 的句柄，没有改动是 undefined；在算的也在里面，同一版并发请求等同一次 */
  readonly #branchDiffs = new Map<string, Promise<Handle | undefined>>();

  constructor(options: MelinaOptions, internals: MelinaInternals = {}) {
    const env = internals.env ?? process.env;
    this.log = internals.log ?? consoleLog;
    const factory = internals.runtime ?? melinaRuntime();
    this.runtimeConnected = factory !== notConnectedRuntime;
    this.#containerRecheckMs = internals.containerRecheckMs ?? 60_000;
    this.paths = resolvePaths(options, internals.protectedDirs);
    const paths = this.paths;
    // 初始化数据库、清理上传目录和写系统状态前先拿锁；数据目录已被占用时立即停止。
    this.#lock = acquireLock(paths.lock);
    try {
      for (const dir of [paths.artifacts, paths.dataDir, ...(paths.scratch ? [paths.scratch] : [])]) {
        mkdirSync(dir, { recursive: true });
      }
      cleanUploads(paths.uploads);
      this.#store = openRunStore({ db: paths.db, artifacts: paths.artifacts });
      this.queries = this.#store.queries;
      this.bus = this.#store.bus;
    } catch (error) {
      this.#lock.release();
      if (paths.scratch) rmSync(paths.scratch, { recursive: true, force: true });
      throw error;
    }
    // 中途出错时要关掉的
    let config: SqliteConfigStore | undefined;
    let status: StatusReporter | undefined;
    try {
      const artifacts = this.#store.artifacts;
      if (!artifacts) throw new MelinaError('internal', 'RunStore 没有 Artifact store');
      this.artifacts = artifacts;
      config = new SqliteConfigStore({
        db: paths.db,
        secrets: secretBoxFor(paths, env),
        onWarn: (m) => this.log.warn(m),
      });
      this.config = config;
      this.config.seed(
        JSON.parse(
          JSON.stringify({
            ...(options.models ? { models: options.models } : {}),
            ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          }),
        ),
      );
      this.#redactor = new SecretRedactor({ onWarn: (m) => this.log.warn(m) });
      const credentials = this.config.credentials();
      this.#redactor.update(credentials);
      this.registry = createModelRegistry({
        source: this.config,
        providers: internals.modelProviders ?? builtinProviders(),
        breaker: createBreaker(),
      });
      this.#ledger = createUsageLedger({
        writer: this.#store.writer,
        queries: this.#store.queries,
        onError: (e) => this.log.error('记账出错', e),
      });
      this.#containers =
        internals.containers === null
          ? undefined
          : (internals.containers ??
            containerRuntimeFor({
              env,
              redactor: this.#redactor,
              config: this.config,
              queries: this.#store.queries,
              onFreezeFailed: () => this.#recheckContainers(),
            }));
      if (!this.#containers) {
        this.log.warn('没找到容器引擎（podman 或 docker）：分支跑不起来。装好 rootless Podman 后重启 Melina');
        this.#containerNotices = containerNotices({ engine: 'missing' });
      }
      const queries = this.#store.queries;
      const workspaces = createWorkspaceProvidersFor(paths, artifacts, this.#containers, queries, this.config);
      this.#workspaces = workspaces;
      this.runtime = factory({
        paths,
        writer: this.#store.writer,
        queries,
        bus: this.#store.bus,
        artifacts,
        config: this.config,
        registry: this.registry,
        ledger: this.#ledger,
        redactor: this.#redactor,
        ...(this.#containers ? { containers: this.#containers } : {}),
        workspaces,
        log: this.log,
        // 关闭时 runners.stop 还回名额也会触发；那时状态推送已经停了，别再排一次（数据库已经关了）
        statusChanged: () => {
          if (!this.signal.aborted) this.status?.poke();
        },
      });

      // 联动：模型页改了清熔断和 key 的状况（换了 key 马上重试），设置改了换脱敏的值，熔断、key 和配置变了刷新系统状态
      const runtime = this.runtime;
      status = startStatusReporter({
        compute: () =>
          systemStatus({
            registry: this.registry,
            ...(runtime.scheduler ? { scheduler: runtime.scheduler } : {}),
            queries,
            global: () => this.config.global(),
            dataDir: paths.dataDir,
            models: this.registry,
            notices: () => this.#containerNotices,
          }),
        emit: (status) => this.#store.writer.emitSystem(status),
        ...(internals.statusIntervalMs !== undefined ? { intervalMs: internals.statusIntervalMs } : {}),
        onError: (e) => this.log.error('系统状态出错', e),
      });
      this.status = status;
      this.#unsubscribe.push(
        this.config.onChange((what) => {
          if (what === 'models') {
            this.registry.breaker.reset();
            this.registry.keys.reset();
          } else {
            const credentials = this.config.credentials();
            this.#redactor.update(credentials);
            // 领域可能改了：镜像再查一次
            this.#recheckContainers();
          }
          this.status.poke();
        }),
        this.registry.breaker.onChange(() => this.status.poke()),
        this.registry.keys.onChange(() => this.status.poke()),
        this.#store.bus.subscribe(() => this.status.poke(), { types: ['run.created', 'run.updated'] }),
      );
    } catch (error) {
      status?.stop();
      for (const off of this.#unsubscribe.splice(0)) off();
      config?.close();
      this.#store.close();
      if (paths.scratch) rmSync(paths.scratch, { recursive: true, force: true });
      this.#lock.release();
      throw error;
    }
    // system.updated 只留最近 24 小时，始终保留最新一条；启动时清理一次，之后每小时清理。
    this.#pruneSystemEvents();
    this.#pruning = setInterval(() => this.#pruneSystemEvents(), SYSTEM_EVENTS_PRUNE_EVERY_MS);
    this.#pruning.unref?.();
    this.ready = this.#start();
    this.ready.catch((e) => this.log.error('启动失败', e));
  }

  /** 分批清理超过保留期的系统状态事件，每批一个事务。 */
  #pruneSystemEvents(): void {
    try {
      let deleted: number;
      do {
        deleted = this.#store.writer.pruneSystemEvents();
      } while (deleted >= SYSTEM_EVENTS_PRUNE_BATCH);
    } catch (error) {
      this.log.error('清理旧的系统状态事件出错', error);
    }
  }

  async #start(): Promise<RecoveryReport | undefined> {
    const report = await this.runtime.recovery?.run();
    await this.runtime.start();
    void this.#checkContainers();
    return report;
  }

  /**
   * 后台看一眼容器引擎和各领域的镜像， 起再真冻一次容器（checkFreeze），不挡启动；
   * 结果进系统状态的提示（C03），新出现的照旧记日志。镜像没建、引擎用不了、冻不住时每分钟再看一次：建好镜像、修好引擎和
   * cgroup 不用重启 Melina。正在查就等那一次
   */
  #checkContainers(): Promise<void> {
    this.#containerCheck ??= this.#doCheckContainers()
      .catch((e) => this.log.error('查容器引擎和镜像出错', e))
      .finally(() => {
        this.#containerCheck = undefined;
      });
    return this.#containerCheck;
  }

  /** 情况变了（配置改了、之前冻得住的容器这回冻不住了）马上再查；正在查的那次看的是变之前的，等它查完再查 */
  #recheckContainers(): void {
    if (this.#containers) void (this.#containerCheck ?? Promise.resolve()).then(() => this.#checkContainers());
  }

  async #doCheckContainers(): Promise<void> {
    const containers = this.#containers;
    if (!containers || this.signal.aborted) return;
    let check: ContainerCheck;
    try {
      const domains = this.config.global().domains;
      // 冻得住是开工条件：测试容器用建好的镜像起，一个都没建时先不测，建好以后每分钟的重查会测到。
      // 先测它再 probe：真试过以后 probe 会重新看 info，修好 cgroup 后上限那条提示跟着没了
      const freeze = await containers.checkFreeze?.(domains);
      const info = await containers.probe();
      const images = await containers.checkImages(domains);
      check = {
        engine: 'ok',
        kind: info.kind,
        rootless: info.rootless,
        memoryLimit: info.memoryLimit,
        pidsLimit: info.pidsLimit,
        missingImages: images.filter((i) => !i.present).map((i) => i.domain),
        ...(freeze ? { freeze } : {}),
      };
    } catch (error) {
      check = { engine: 'broken', error: error instanceof Error ? error.message : String(error) };
    }
    if (this.signal.aborted) return;
    const notices = containerNotices(check);
    const before = new Set(this.#containerNotices.map((n) => n.text));
    for (const n of notices) if (!before.has(n.text)) this.log.warn(n.text);
    this.#containerNotices = notices;
    this.status.poke();
    if (this.#containerTimer !== undefined) clearTimeout(this.#containerTimer);
    this.#containerTimer = undefined;
    if (
      check.engine === 'broken' ||
      (check.engine === 'ok' && (check.missingImages.length > 0 || check.freeze?.ok === false))
    ) {
      this.#containerTimer = setTimeout(() => void this.#checkContainers(), this.#containerRecheckMs);
      this.#containerTimer.unref?.();
    }
  }

  /**
   * GET /runs/:id/branches/:branchId/diff（C07）：这条路线到上次收尾为止（lastSnapshot）相对起点的改动。
   * 还没收过尾（lastSnapshot 还是起点）、或者没改文件时不带 patch。路线又收了一次尾、读到的那版刚被清理
   * 时按新的那版再算一次
   */
  async branchDiff(runId: Id, branchId: Id): Promise<BranchDiffResponse> {
    const queries = this.#store.queries;
    if (!queries.getRun(runId)) throw notFound(`没有这个任务：${runId}`);
    for (let attempt = 0; ; attempt++) {
      const branch = queries.getBranch(branchId);
      if (!branch || branch.runId !== runId) throw notFound(`这个任务里没有这条路线：${branchId}`);
      const snapshot = branch.lastSnapshot;
      if (snapshot === ROOT) return { snapshot };
      try {
        const patch = await this.#diffFromRoot(runId, snapshot);
        return patch ? { snapshot, patch } : { snapshot };
      } catch (error) {
        const now = queries.getBranch(branchId)?.lastSnapshot;
        const moved = now !== undefined && now !== snapshot;
        if (attempt === 0 && moved && isMelinaError(error) && error.code === 'not_found') continue;
        throw error;
      }
    }
  }

  /** 某个 snapshot 相对起点的 patch：内容寻址，同一版只算一次；在算的时候来的请求等同一次，算错了不留着 */
  #diffFromRoot(runId: Id, snapshot: SnapshotId): Promise<Handle | undefined> {
    const key = `${runId}/${snapshot}`;
    const cached = this.#branchDiffs.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const run = this.#store.queries.getRun(runId);
      if (!run) throw notFound(`没有这个任务：${runId}`);
      // 和运行时用同一个 WorkspaceProviders：同一个 Run 的 provider 共用锁，不会和 prune 撞上
      const handle = await this.#workspaces.forRun(run).diffSnapshots(ROOT, snapshot);
      const st = await this.artifacts.stat(runId, handle);
      return st && st.size > 0 ? handle : undefined;
    })();
    this.#branchDiffs.set(key, pending);
    pending.catch(() => {
      if (this.#branchDiffs.get(key) === pending) this.#branchDiffs.delete(key);
    });
    if (this.#branchDiffs.size > BRANCH_DIFF_CACHE) {
      const oldest = this.#branchDiffs.keys().next().value;
      if (oldest !== undefined) this.#branchDiffs.delete(oldest);
    }
    return pending;
  }

  // ── 退出 ────────────────────────────────────────────────────────────────

  /** 停下调度、把攒着的账写掉、关数据库。可以重复调 */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#shutdown.abort(new MelinaError('unavailable', 'Melina 已经关了'));
    this.status.stop();
    if (this.#containerTimer !== undefined) clearTimeout(this.#containerTimer);
    this.#containerTimer = undefined;
    clearInterval(this.#pruning);
    for (const off of this.#unsubscribe.splice(0)) off();
    try {
      await this.ready;
    } catch {
      // 启动失败也要关干净
    }
    try {
      await this.runtime.close();
    } finally {
      this.#ledger.close();
      this.config.close();
      this.#store.close();
      if (this.paths.scratch) rmSync(this.paths.scratch, { recursive: true, force: true });
      // 库关完才放锁：放早了，下一个 Melina 可能赶在这里的最后几笔写（攒着的账）之前打开同一份数据
      this.#lock.release();
    }
  }
}

function createWorkspaceProvidersFor(
  paths: MelinaPaths,
  artifacts: ArtifactStore,
  containers: MelinaContainers | undefined,
  queries: RunStoreQueries,
  config: ConfigStore,
): WorkspaceProviders {
  return createWorkspaceProviders({
    dataDir: paths.dataDir,
    artifacts,
    ...(containers ? { exec: workspaceExec({ containers, queries, config }) } : {}),
    ...(containers ? { freeze: containers.withWorkspaceFrozen.bind(containers) } : {}),
    ...(containers?.forceRemove ? { forceRemove: containers.forceRemove } : {}),
  });
}

/** 上次崩溃时没删掉的上传临时文件 */
function cleanUploads(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
}

// 工作区与容器运行时的适配。
// - 容器运行时：按 PATH 找 podman 或 docker，配置取 GlobalConfig.sandbox（改了要重启 Melina 才生效）和各 Run 的 sh.maxBackground；
// - workspace 的 exec（workspace.setup 用）：先找可写挂着这个 workspace、正在跑的容器，没有就按这个 Run 的领域和凭证起一个临时容器，跑完删掉；
// - 删不掉的目录（容器里非 root 用户写的文件，在宿主机上属于 subuid）：rootless Podman 用 `podman unshare rm -rf`。

/** Melina 用到的容器运行时：ContainerRuntime 加上 给进程入口和恢复留的几个方法 */
export type MelinaContainers = ContainerRuntime &
  Pick<PodmanRuntime, 'forWorkspace' | 'removeEphemeral' | 'probe' | 'managed' | 'withWorkspaceFrozen'> & {
    readonly engine: EngineKind;
    /** 删不掉的目录交给它（rootless Podman 的 unshare）；docker 没有 */
    forceRemove?: (path: string) => Promise<void>;
    /** 真冻一次。只有真冻结容器的运行时有；测试和开发机上的替身冻结是空操作，不用查 */
    checkFreeze?: PodmanRuntime['checkFreeze'];
  };

/** workspace.setup 这类命令的超时，和 的 SETUP_TIMEOUT_MS 一样 */
const EXEC_TIMEOUT_MS = 20 * 60_000;

export function containerRuntimeFor(input: {
  env: NodeJS.ProcessEnv;
  redactor: SecretRedactor;
  config: Pick<ConfigStore, 'global'>;
  queries?: Pick<RunStoreQueries, 'getRun'>;
  /** 之前测过冻得住、真冻结却失败了 */
  onFreezeFailed?: () => void;
}): MelinaContainers | undefined {
  const engine = detectEngine(input.env);
  if (!engine) return undefined;
  const sandbox = input.config.global().sandbox;
  const runtime = new PodmanRuntime({
    engine,
    images: new DomainImages(),
    redactor: input.redactor,
    memoryMax: sandbox.memoryMax,
    pidsMax: sandbox.pidsMax,
    maxBackground: (ref) =>
      (ref.runId ? input.queries?.getRun(ref.runId)?.config.sh.maxBackground : undefined) ??
      DEFAULT_RUN_CONFIG.sh.maxBackground,
    ...(input.onFreezeFailed ? { onFreezeFailed: input.onFreezeFailed } : {}),
  });
  const forceRemove = engine.kind === 'podman' ? podmanUnshareRemove(engine) : undefined;
  return Object.assign(runtime, forceRemove ? { forceRemove } : {}) as MelinaContainers;
}

function podmanUnshareRemove(engine: CliEngine): (path: string) => Promise<void> {
  return async (path) => {
    const r = await runEngine(engine, ['unshare', 'rm', '-rf', '--', path], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new MelinaError('internal', `删不掉 ${path}：${r.stderr.trim().split('\n')[0] ?? ''}`);
  };
}

/** WorkspaceProvider.exec 的实现：在 workspace 所属的容器里跑，宿主机上不跑 agent 的东西 */
export function workspaceExec(deps: {
  containers: Pick<MelinaContainers, 'forWorkspace' | 'ephemeral' | 'exec' | 'remove'>;
  queries: Pick<RunStoreQueries, 'getRun'>;
  config: Pick<ConfigStore, 'credentials' | 'global'>;
}): WorkspaceProvider['exec'] {
  return async (ws, cmd, opts) => {
    let target = deps.containers.forWorkspace(ws.path, { writable: true });
    let temporary: ContainerRef | undefined;
    if (!target) {
      // provider 建的 workspace 带着 runId（契约 WorkspaceRef.runId）：按它找这个 Run 的领域和凭证
      const run = ws.runId ? deps.queries.getRun(ws.runId) : undefined;
      if (!run) throw new MelinaError('internal', `找不到 workspace ${ws.path} 是哪个任务的`);
      temporary = await deps.containers.ephemeral({
        name: `melina-${run.id.toLowerCase()}-exec-${randomUUID().slice(0, 8)}`,
        domain: domainOf(run, deps.config.global().domains),
        workspace: { host: ws.path, container: CONTAINER_PATHS.workspace, readOnly: false },
        // setup 可能要从人选的工作目录里拿被忽略、没抄进 workspace 的东西
        ...originOf(run),
        credentials: deps.config.credentials(),
        labels: { 'melina.run': run.id },
      });
      target = temporary;
    }
    try {
      const r = await deps.containers.exec(target, {
        cmd: shellCommand(cmd),
        timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      // 容器那边 stdout 和 stderr 按到达顺序合在一起了，都放进 stdout
      return {
        exitCode: r.exitCode,
        stdout: r.output,
        stderr: '',
        timedOut: r.timedOut,
        cancelled: r.cancelled,
        durationMs: r.durationMs,
      } satisfies ExecResult;
    } finally {
      if (temporary) await deps.containers.remove(temporary).catch(() => {});
    }
  };
}

/** argv 变成交给 bash -lc 的一行：本来就是 bash -lc / sh -c 加一条命令的直接取那条命令，其余逐个加单引号 */
export function shellCommand(argv: readonly string[]): string {
  const [bin, flag, script, ...rest] = argv;
  if (
    rest.length === 0 &&
    script !== undefined &&
    (bin === 'bash' || bin === 'sh') &&
    (flag === '-c' || flag === '-lc')
  ) {
    return script;
  }
  return argv.map(shellQuote).join(' ');
}

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
