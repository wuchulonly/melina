// 系统状态：各供应商的熔断与限流、容量占用、排队数、磁盘剩余、在跑和暂停的任务数，
// 和要人知道的事（notices：容器引擎、镜像、模型、磁盘）。
// 熔断和每个 API key 的状况来自模型层（registry.breakers()），容量、排队来自 Scheduler，磁盘看数据目录所在的盘，任务数从 RunStore 数。
// notices 里容器引擎和镜像由 assemble.ts 检查（启动后查一次，镜像没建、引擎用不了时每分钟再查），
// 模型可用性和磁盘容量每次现算。
//
// system.updated 按秒合并、只在变了的时候发（core/events.ts）：熔断变化、配置改动时马上 poke，
// Scheduler 没有变化通知，所以另外每秒看一眼，变了才发。

import { statfsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { GlobalConfig } from '../core/config.ts';
import type { ProviderStatus, SystemNotice, SystemStatus } from '../core/events.ts';
import type { ModelRegistry } from '../core/interfaces/models.ts';
import type { Scheduler, SchedulerStatus } from '../core/interfaces/scheduler.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import type { MelinaModelRegistry } from '../models/registry.ts';
import type { FreezeCheck } from '../tools/container.ts';

export interface StatusSources {
  registry: Pick<ModelRegistry, 'breakers' | 'providers'>;
  /** 运行时还没接上时没有 */
  scheduler?: Pick<Scheduler, 'status'>;
  queries: Pick<RunStoreQueries, 'listRuns'>;
  global(): GlobalConfig;
  /** 数据目录：看它所在的盘还剩多少 */
  dataDir: string;
  /** 模型那几条提示（某一档用不了、某家没 key 或 key 都用不了）要看模型页的配置；不给就不出这几条 */
  models?: Pick<MelinaModelRegistry, 'tier' | 'apiKey' | 'global'>;
  /** 容器引擎和镜像检查产生的提示。 */
  notices?: () => SystemNotice[];
  /** 测试用 */
  diskFree?: (path: string) => number;
  cpus?: number;
}

export function systemStatus(src: StatusSources): SystemStatus {
  const global = src.global();
  let sched: SchedulerStatus | undefined;
  try {
    sched = src.scheduler?.status();
  } catch {
    sched = undefined;
  }
  const breakers = new Map(src.registry.breakers().map((b) => [b.provider, b]));
  const capacity = new Map((sched?.providers ?? []).map((p) => [p.provider, p]));
  const names = [...new Set([...src.registry.providers(), ...capacity.keys(), ...breakers.keys()])];
  const providers: ProviderStatus[] = names.map((provider) => {
    const b = breakers.get(provider);
    const p = capacity.get(provider);
    const limit = p?.limit ?? null;
    return {
      provider,
      breaker: b?.breaker ?? 'ok',
      ...(b?.reason ? { reason: b.reason } : {}),
      limit: limit !== null && limit >= 1 ? limit : null,
      inFlight: p?.inFlight ?? 0,
      queued: p?.queued ?? 0,
      episodes: p?.episodes ?? { running: 0, queued: 0 },
      ...(p?.retryAt ? { retryAt: p.retryAt } : {}),
      ...(b?.fallbackTo ? { fallbackTo: b.fallbackTo } : {}),
      ...(b?.keys ? { keys: b.keys } : {}),
    };
  });
  const cpus = src.cpus ?? availableParallelism();
  const toolExec = sched?.toolExec ?? {
    limit: global.limits.toolExec === 'auto' ? cpus : global.limits.toolExec,
    running: 0,
    queued: 0,
    auto: global.limits.toolExec === 'auto',
  };
  let disk = sched?.disk;
  if (!disk) {
    const freeBytes = (src.diskFree ?? diskFree)(src.dataDir);
    disk = { freeBytes, minBytes: global.limits.diskFreeMin, ok: freeBytes >= global.limits.diskFreeMin };
  }
  const notices = sortNotices([
    ...(src.notices?.() ?? []),
    ...(src.models ? modelNotices(src.models, providers) : []),
    ...diskNotices(disk),
  ]);
  return {
    providers,
    toolExec: { ...toolExec, limit: Math.max(1, toolExec.limit) },
    disk,
    runs: {
      running: src.queries.listRuns({ status: ['running'] }).length,
      paused: src.queries.listRuns({ status: ['paused'] }).length,
    },
    ...(notices.length > 0 ? { notices } : {}),
  };
}

// ── 要人知道的事（SystemStatus.notices） ──────────────────────────────────

const NOTICE_ORDER: readonly SystemNotice['kind'][] = ['sandbox', 'images', 'models', 'disk'];

/** 按 kind 的固定顺序、同一类里 error 在前；去掉重复的 */
function sortNotices(list: readonly SystemNotice[]): SystemNotice[] {
  const seen = new Set<string>();
  const unique = list.filter((n) => {
    const key = `${n.kind}|${n.level}|${n.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .map((n, i) => ({ n, i }))
    .sort(
      (a, b) =>
        NOTICE_ORDER.indexOf(a.n.kind) - NOTICE_ORDER.indexOf(b.n.kind) ||
        (a.n.level === b.n.level ? 0 : a.n.level === 'error' ? -1 : 1) ||
        a.i - b.i,
    )
    .map(({ n }) => n);
}

/** 查容器引擎和镜像的结果（assemble.ts 的 #checkContainers：启动后查一次，镜像没建、引擎用不了、冻不住时每分钟再查） */
export type ContainerCheck =
  | { engine: 'missing' }
  | { engine: 'broken'; error: string }
  | {
      engine: 'ok';
      kind: string;
      rootless: boolean;
      memoryLimit: boolean;
      pidsLimit: boolean;
      /** 还没建镜像的领域 */
      missingImages: readonly string[];
      /** 真冻一次的结果；没有建好的镜像、或者运行时不真冻结时没有 */
      freeze?: FreezeCheck;
    };

/** 冻不住为什么要紧 */
const FREEZE_WHY = '路线收尾、存个阶段版都要先冻结容器再存 snapshot，冻不住就什么都交不上';

function freezeFix(kind: string): string {
  return `rootless ${kind === 'docker' ? 'Docker' : 'Podman'} 要用 cgroup v2，并由 systemd 管 cgroup，配法见 README 的「容器冻不住」`;
}

/** 冻不住容器时拒建任务的说法（api/runtime.ts），和系统状态那条提示同一个口径 */
export function freezeProblem(kind: string, error: string): string {
  return `${kind} 冻不住容器（${error}）：${FREEZE_WHY}。${freezeFix(kind)}`;
}

/**
 * 容器引擎和镜像：用不了、Linux 上不是 rootless、冻不住是 error，建任务会被拒（api/runtime.ts）；
 * 镜像没建也是 error，但不拒建任务：用到这个领域的分支起不来。
 * 资源上限不生效是 warning，冻不住时它是同一个原因（容器没有自己的 cgroup），并进那条 error 里说。
 */
export function containerNotices(check: ContainerCheck): SystemNotice[] {
  if (check.engine === 'missing') {
    return [
      {
        kind: 'sandbox',
        level: 'error',
        text: '没找到容器引擎（podman 或 docker）：分支跑不起来，建任务会被拒。装好 rootless Podman 后重启 Melina',
      },
    ];
  }
  if (check.engine === 'broken') {
    return [
      {
        kind: 'sandbox',
        level: 'error',
        text: `容器引擎现在用不了（${check.error}）：分支起不来。修好以后不用重启，Melina 每分钟会再看一次`,
      },
    ];
  }
  const out: SystemNotice[] = [];
  if (!check.rootless) {
    out.push({
      kind: 'sandbox',
      level: process.platform === 'linux' ? 'error' : 'warning',
      text:
        process.platform === 'linux'
          ? `${check.kind} 不是 rootless 的：建任务会被拒，请配置 rootless 容器引擎`
          : `${check.kind} 不是 rootless 的：请核实容器与宿主机的隔离`,
    });
  }
  const limits = [check.memoryLimit ? '' : '内存', check.pidsLimit ? '' : '进程数'].filter(Boolean);
  if (check.freeze && !check.freeze.ok) {
    out.push({
      kind: 'sandbox',
      level: 'error',
      text:
        `${check.kind} 冻不住容器（${check.freeze.error}）：${FREEZE_WHY}，建任务会被拒。` +
        `${limits.length > 0 ? `${limits.join('和')}上限不生效也是这个原因。` : ''}` +
        `${freezeFix(check.kind)}；修好以后不用重启，Melina 每分钟会再试一次`,
    });
  } else if (limits.length > 0) {
    out.push({
      kind: 'sandbox',
      level: 'warning',
      text: `${check.kind} 的${limits.join('和')}上限不生效：容器不限${limits.join('、')}（rootless Podman 要 cgroup v2，并把对应的控制器委派给当前用户）`,
    });
  }
  if (check.missingImages.length > 0) {
    const names = check.missingImages.join(' ');
    out.push({
      kind: 'images',
      level: 'error',
      text: `还没建这些领域的镜像：${check.missingImages.join('、')}。用到它们的分支起不来，先在 Melina 的仓库里跑 pnpm images ${names}`,
    });
  }
  return out;
}

/**
 * 模型：某一档一个能用的模型都没有是 error——没 key 时建任务会被拒（和 missingKeys 同一个口径），key 都用不了、
 * 熔断了的时候调用一直排队；某一档里个别供应商没 key、key 都用不了是 warning（同一档里有别家顶着）。
 * 熔断的供应商不单独说：系统状态里各家的状况本来就写着，好了会自己恢复
 */
export function modelNotices(
  registry: Pick<MelinaModelRegistry, 'tier' | 'apiKey' | 'global'>,
  providers: readonly ProviderStatus[],
): SystemNotice[] {
  const status = new Map(providers.map((p) => [p.provider, p]));
  const hasKey = (p: string) => registry.apiKey(p) !== undefined;
  const keysDown = (p: string) => {
    const keys = status.get(p)?.keys;
    return keys !== undefined && keys.length > 0 && keys.every((k) => k.state === 'down');
  };
  /** 有 key，而且不是每个 key 都用不了：没有要人去模型页弄的事 */
  const keyed = (p: string) => hasKey(p) && !keysDown(p);
  const tripped = (p: string) => (status.get(p)?.breaker ?? 'ok') !== 'ok';
  const why = (p: string) => {
    if (!hasKey(p)) return `${p} 没有 API key`;
    const s = status.get(p);
    if (keysDown(p)) {
      const reason = s?.keys?.find((k) => k.reason)?.reason;
      return `${p} 的 API key 都用不了${reason ? `（${reason}）` : ''}`;
    }
    return `${p} 暂时连不上${s?.reason ? `（${s.reason}）` : ''}`;
  };
  const noFallback = registry.global().models.fallback === 'none';
  const out: SystemNotice[] = [];
  const told = new Set<string>();
  for (const tier of ['strong', 'fast'] as const) {
    const models = registry.tier(tier);
    if (models.length === 0) {
      out.push({
        kind: 'models',
        level: 'error',
        text: `${tier} 档还没有模型：用到这一档的角色调不了模型，先去模型页加一个`,
      });
      continue;
    }
    const candidates = noFallback ? models.slice(0, 1) : models;
    if (candidates.some((m) => keyed(m.provider) && !tripped(m.provider))) continue;
    const names = [...new Set(candidates.map((m) => m.provider))];
    for (const p of names) told.add(p);
    const what = names.every((p) => !hasKey(p))
      ? '建任务会被拒，先去模型页填上 key'
      : names.every(keyed)
        ? '调用先排着，Melina 每分钟试一次，好了自己接着跑'
        : '调用会一直排队，到模型页换个 key，或者加一家别的';
    out.push({
      kind: 'models',
      level: 'error',
      text: `${tier} 档${noFallback ? '的首选模型（又不许换备用模型）' : '的模型'}现在都用不了：${names.map(why).join('；')}。${what}`,
    });
  }
  // 不许换备用模型时，排在后面的模型本来就用不上，不用说
  if (noFallback) return out;
  const inTiers = [...new Set([...registry.tier('strong'), ...registry.tier('fast')].map((m) => m.provider))];
  for (const p of inTiers) {
    if (told.has(p) || keyed(p)) continue;
    out.push({
      kind: 'models',
      level: 'warning',
      text: `${why(p)}：用到它的模型先换同一档里别家的，${hasKey(p) ? '到模型页换个 key 就恢复' : '到模型页填上 key 就能用'}`,
    });
  }
  return out;
}

/** 剩余磁盘低于 limits.diskFreeMin：不再启动新分支，在跑的照跑 */
function diskNotices(disk: SystemStatus['disk']): SystemNotice[] {
  if (disk.ok) return [];
  return [
    {
      kind: 'disk',
      level: 'error',
      text: `数据目录所在的盘只剩 ${gib(disk.freeBytes)}，不到下限 ${gib(disk.minBytes)}：新的路线先不开，清出空间后自己接着跑`,
    },
  ];
}

/** 「5.3 GB」「12 GB」：十 GB 以上不带小数 */
function gib(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB`;
}

/**
 * 建任务前查（api/runtime.ts）、系统状态里也说的：每一档都要用得上，至少有一个有 key 的模型（备用模型有 key 也行，熔断时
 * melinaStream 会换过去）；不许换备用模型（models.fallback 为 none）时，首选就得有 key，不然首选熔断后调用会一直排队
 */
export function missingKeys(registry: Pick<MelinaModelRegistry, 'tier' | 'apiKey' | 'global'>): string[] {
  const noFallback = registry.global().models.fallback === 'none';
  const out: string[] = [];
  for (const tier of ['strong', 'fast'] as const) {
    const models = registry.tier(tier);
    const usable = noFallback ? models.slice(0, 1) : models;
    if (models.length === 0 || usable.some((m) => registry.apiKey(m.provider))) continue;
    const providers = [...new Set(usable.map((m) => m.provider))].join('、');
    out.push(
      noFallback
        ? `${tier} 档的首选模型没有 API key（${providers}），又不许换备用模型`
        : `${tier} 档的模型都没有 API key（${providers}）`,
    );
  }
  return out;
}

/** 数据目录所在的盘还剩多少字节（非 root 用户能用的）；目录还没建就看上一级 */
export function diskFree(path: string): number {
  let p = path;
  for (;;) {
    try {
      const s = statfsSync(p);
      return Math.max(0, Number(s.bavail) * Number(s.bsize));
    } catch {
      const parent = p.replace(/\/[^/]*\/?$/, '') || '/';
      if (parent === p) return 0;
      p = parent;
    }
  }
}

/**
 * 比较用：剩余磁盘按 256 MiB 取整，不然每秒都在变（日志、数据库在长），每秒都会发一条；
 * 磁盘那条提示里写着剩多少，比较时也不看这个数
 */
function fingerprint(status: SystemStatus): string {
  const step = 256 * 1024 ** 2;
  return JSON.stringify({
    ...status,
    disk: { ...status.disk, freeBytes: Math.round(status.disk.freeBytes / step) },
    ...(status.notices ? { notices: status.notices.map((n) => (n.kind === 'disk' ? { ...n, text: '' } : n)) } : {}),
  });
}

/** 按秒合并、变了才发 system.updated */
export interface StatusReporter {
  /** 有东西变了（熔断、配置）：一秒内发一次 */
  poke(): void;
  /** 现在的状态（GET /status） */
  current(): SystemStatus;
  stop(): void;
}

export function startStatusReporter(options: {
  compute: () => SystemStatus;
  emit: (status: SystemStatus) => void;
  /** 合并窗口，也是没人 poke 时多久看一眼，默认 1000 毫秒 */
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): StatusReporter {
  const intervalMs = options.intervalMs ?? 1000;
  let last = '';
  let pending: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    pending = undefined;
    try {
      const status = options.compute();
      const text = fingerprint(status);
      if (text === last) return;
      last = text;
      options.emit(status);
    } catch (error) {
      options.onError?.(error);
    }
  };
  const poll = setInterval(tick, intervalMs);
  poll.unref?.();
  return {
    poke() {
      if (pending !== undefined) return;
      pending = setTimeout(tick, Math.min(intervalMs, 200));
      pending.unref?.();
    },
    current: options.compute,
    stop() {
      clearInterval(poll);
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
    },
  };
}
