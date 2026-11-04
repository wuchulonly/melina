// 第三类：只有探测才能发现的约束。给一组服务写部署清单，交给校验器；文档只写了格式、端口不重复、
// CPU 和内存不超过机器的标称值。藏起来的规则：每台机器给系统留了几 GiB 内存、有一段保留端口、有几对服务不能在同一台机器、
// 同一个服务的副本要分在不同的可用区。校验器的回话按难度给：每条违规都说清（precise）、只说第一条违规的类别（first）、
// 只说「不行」（opaque）。允许 partial 校验，拿来做小实验。
//
// 世界由种子生成；「最多用几台」= 真规则下 pack() 找到的最少台数加余量。生成时保证：单个服务放得进任何一台机器，
// 任意两个服务放得进最大的那台（标准解拿它试哪两个不能同机），每个可用区至少两台机器；中等和难的，照文档直接排的清单过不了。

import { type Assignment, machinesUsed, type PackMachine, type PackService, pack } from '../kit/pack.ts';
import { Rng } from '../kit/rng.ts';

export interface ConstraintParams {
  services: number;
  machines: number;
  zones: number;
  replicas: readonly [number, number];
  feedback: 'precise' | 'first' | 'opaque';
  reserve: readonly [number, number] | null; // 每台机器给系统留的内存（GiB）的范围；null 是不留
  reservedPorts: boolean;
  antiPairs: number;
  zoneSpread: boolean;
  slack: number; // 「最多用几台」比找到的最少台数多几台
}

export interface Service extends PackService {
  port: number; // 默认端口
}

export interface Machine {
  id: string;
  zone: string;
  cpu: number;
  mem: number; // 标称内存
}

export interface ConstraintWorld {
  params: ConstraintParams;
  services: Service[];
  machines: Machine[];
  reserve: number;
  reservedFrom?: number; // 保留端口 [reservedFrom, reservedFrom + 99]
  anti: [string, string][];
  budget: number;
  best: Assignment[]; // 真规则下找到的排法
}

export interface Placement {
  service: string;
  replica: number;
  machine: string;
  port: number;
}

const NAMES = [
  'api',
  'web',
  'auth',
  'billing',
  'search',
  'cache',
  'db',
  'queue',
  'mailer',
  'report',
  'gateway',
  'worker',
  'media',
  'notify',
];
const PORTS = [
  3000, 4222, 5000, 5432, 5672, 6379, 7000, 8000, 8080, 8081, 8443, 8500, 9000, 9090, 9200, 9300, 11211, 15672, 27017,
];
const MACHINE_TYPES = [
  { cpu: 8, mem: 32 },
  { cpu: 16, mem: 64 },
  { cpu: 32, mem: 128 },
] as const;

export function generateConstraints(params: ConstraintParams, seed: string): ConstraintWorld {
  const root = new Rng(`constraints/${seed}`);
  for (let attempt = 0; attempt < 300; attempt++) {
    const world = tryGenerate(params, root.fork(attempt));
    if (world) return world;
  }
  throw new Error(`种子 ${seed} 生成不出合格的部署任务，难度参数可能太苛刻`);
}

function tryGenerate(params: ConstraintParams, rng: Rng): ConstraintWorld | undefined {
  const zones = Array.from({ length: params.zones }, (_, i) => `z${i + 1}`);
  const zoneOrder = rng.shuffle(Array.from({ length: params.machines }, (_, i) => zones[i % zones.length] as string));
  const machines: Machine[] = zoneOrder.map((zone, i) => {
    const type = i === 0 ? (MACHINE_TYPES[2] as { cpu: number; mem: number }) : rng.weighted(MACHINE_TYPES, [3, 4, 2]);
    return { id: `m${i + 1}`, zone, cpu: type.cpu, mem: type.mem };
  });
  for (const z of zones) if (machines.filter((m) => m.zone === z).length < 2) return undefined;
  const reserve = params.reserve ? rng.int(params.reserve[0], params.reserve[1]) : 0;
  const ports = rng.sample(PORTS, params.services);
  const services: Service[] = rng.sample(NAMES, params.services).map((name, i) => ({
    name,
    cpu: rng.int(1, 6),
    mem: rng.weighted([1, 2, 3, 4, 6, 8, 12, 16], [2, 3, 2, 3, 3, 3, 2, 1]),
    replicas: rng.int(params.replicas[0], Math.min(params.replicas[1], params.zoneSpread ? params.zones : 9)),
    port: ports[i] as number,
  }));
  const minCpu = Math.min(...machines.map((m) => m.cpu));
  const minMem = Math.min(...machines.map((m) => m.mem)) - reserve;
  if (services.some((s) => s.cpu > minCpu || s.mem > minMem)) return undefined;
  if (!services.some((s) => s.replicas > 1)) return undefined;

  let reservedFrom: number | undefined;
  if (params.reservedPorts) {
    const victim = rng.pick(services);
    reservedFrom = Math.floor(victim.port / 100) * 100;
  }
  const names = services.map((s) => s.name);
  const pairs: [string, string][] = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) pairs.push([names[i] as string, names[j] as string]);
  const anti = rng.sample(pairs, params.antiPairs);

  const usable: PackMachine[] = machines.map((m) => ({ id: m.id, zone: m.zone, cpu: m.cpu, mem: m.mem - reserve }));
  const best = pack(services, usable, { anti, zoneSpread: params.zoneSpread });
  if (!best) return undefined;
  const used = machinesUsed(best);
  const budget = used + params.slack;
  if (budget >= machines.length || used < 2) return undefined;

  const world: ConstraintWorld = { params, services, machines, reserve, anti, budget, best };
  if (reservedFrom !== undefined) world.reservedFrom = reservedFrom;
  if (params.feedback !== 'precise' && directWorks(world)) return undefined;
  return world;
}

/** 照文档直接排：标称内存、默认端口，不管藏起来的规则。中等和难的要求这样过不了 */
export function directManifest(world: ConstraintWorld): { placements: Placement[] } {
  const documented: PackMachine[] = world.machines.map((m) => ({ id: m.id, zone: m.zone, cpu: m.cpu, mem: m.mem }));
  const plan = pack(world.services, documented, { anti: [], zoneSpread: false }) ?? [];
  return { placements: plan.map((a) => ({ ...a, port: portFor(world, a.service, a.replica) })) };
}

/** 默认端口加副本号减一：同一服务的几个副本端口不同 */
export function portFor(world: ConstraintWorld, service: string, replica: number): number {
  const s = world.services.find((x) => x.name === service) as Service;
  return s.port + replica - 1;
}

function directWorks(world: ConstraintWorld): boolean {
  const manifest = directManifest(world);
  const result = validate(world, manifest);
  return result.ok && machinesUsed(manifest.placements) <= world.budget;
}

// ── 校验器 ────────────────────────────────────────────────────────────────

export interface Violation {
  rule: 'mem' | 'port' | 'affinity' | 'zone';
  message: string;
  machine?: string;
  service?: string;
  replica?: number;
}

export type ValidateResult =
  | { ok: true; machinesUsed: number; partial: boolean }
  | { ok: false; documented: string[]; hidden: Violation[] };

/** 校验一份清单。documented 是文档写了的规则（格式、端口不重复、CPU、标称内存），hidden 是藏起来的 */
/** 一条排布：合格就返回它，不合格返回原因 */
function parsePlacement(world: ConstraintWorld, raw: unknown, where: string): Placement | string {
  const p = raw as Partial<Placement> | null;
  if (!p || typeof p !== 'object') return `${where}不是对象`;
  const service = world.services.find((s) => s.name === p.service);
  if (!service) return `${where}：没有服务「${String(p.service)}」`;
  if (!Number.isInteger(p.replica) || (p.replica as number) < 1 || (p.replica as number) > service.replicas) {
    return `${where}：${service.name} 的 replica 要是 1 到 ${service.replicas}`;
  }
  const machine = world.machines.find((m) => m.id === p.machine);
  if (!machine) return `${where}：没有机器「${String(p.machine)}」`;
  if (!Number.isInteger(p.port) || (p.port as number) < 1024 || (p.port as number) > 65535) {
    return `${where}：port 要是 1024 到 65535 的整数`;
  }
  return { service: service.name, replica: p.replica as number, machine: machine.id, port: p.port as number };
}

export function validate(world: ConstraintWorld, manifest: unknown, partial = false): ValidateResult {
  const documented: string[] = [];
  const shape = manifest as { placements?: unknown } | null;
  if (!shape || typeof shape !== 'object' || !Array.isArray(shape.placements)) {
    return { ok: false, documented: ['清单要是 {"placements": [...]}'], hidden: [] };
  }
  if (shape.placements.length > 500) return { ok: false, documented: ['placements 最多 500 条'], hidden: [] };
  const placements: Placement[] = [];
  for (const [i, raw] of shape.placements.entries()) {
    const p = parsePlacement(world, raw, `第 ${i + 1} 条`);
    if (typeof p === 'string') documented.push(p);
    else placements.push(p);
  }
  if (documented.length > 0) return { ok: false, documented, hidden: [] };
  const seen = new Set<string>();
  for (const p of placements) {
    const key = `${p.service}#${p.replica}`;
    if (seen.has(key)) documented.push(`${p.service} 的副本 ${p.replica} 排了不止一次`);
    seen.add(key);
  }
  if (!partial) {
    for (const s of world.services) {
      for (let r = 1; r <= s.replicas; r++)
        if (!seen.has(`${s.name}#${r}`)) documented.push(`${s.name} 的副本 ${r} 没有排`);
    }
  }
  for (const m of world.machines) {
    const here = placements.filter((p) => p.machine === m.id);
    const ports = new Set<number>();
    for (const p of here) {
      if (ports.has(p.port)) documented.push(`${m.id} 上端口 ${p.port} 重复了`);
      ports.add(p.port);
    }
    const cpu = here.reduce((sum, p) => sum + (world.services.find((s) => s.name === p.service) as Service).cpu, 0);
    const mem = here.reduce((sum, p) => sum + (world.services.find((s) => s.name === p.service) as Service).mem, 0);
    if (cpu > m.cpu) documented.push(`${m.id} 上 CPU 用了 ${cpu} 核，机器只有 ${m.cpu} 核`);
    if (mem > m.mem) documented.push(`${m.id} 上内存用了 ${mem} GiB，机器只有 ${m.mem} GiB`);
  }
  if (documented.length > 0) return { ok: false, documented, hidden: [] };

  const hidden: Violation[] = [];
  for (const m of world.machines) {
    const here = placements.filter((p) => p.machine === m.id);
    const mem = here.reduce((sum, p) => sum + (world.services.find((s) => s.name === p.service) as Service).mem, 0);
    if (mem > m.mem - world.reserve) {
      hidden.push({
        rule: 'mem',
        machine: m.id,
        message: `${m.id} 上内存用了 ${mem} GiB，超过了能用的 ${m.mem - world.reserve} GiB（标称 ${m.mem} GiB，系统留了 ${world.reserve} GiB）`,
      });
    }
  }
  if (world.reservedFrom !== undefined) {
    const lo = world.reservedFrom;
    for (const p of placements) {
      if (p.port >= lo && p.port <= lo + 99) {
        hidden.push({
          rule: 'port',
          service: p.service,
          replica: p.replica,
          message: `${p.service} 的副本 ${p.replica} 用的端口 ${p.port} 在保留区间 ${lo}–${lo + 99} 里`,
        });
      }
    }
  }
  for (const [a, b] of world.anti) {
    for (const m of world.machines) {
      const here = new Set(placements.filter((p) => p.machine === m.id).map((p) => p.service));
      if (here.has(a) && here.has(b)) {
        hidden.push({ rule: 'affinity', machine: m.id, message: `${a} 和 ${b} 不能在同一台机器上（${m.id}）` });
      }
    }
  }
  if (world.params.zoneSpread) {
    for (const s of world.services) {
      const zones = new Map<string, number>();
      for (const p of placements.filter((x) => x.service === s.name)) {
        const zone = (world.machines.find((m) => m.id === p.machine) as Machine).zone;
        zones.set(zone, (zones.get(zone) ?? 0) + 1);
      }
      for (const [zone, n] of zones) {
        if (n > 1)
          hidden.push({ rule: 'zone', service: s.name, message: `${s.name} 有 ${n} 个副本在同一个可用区 ${zone}` });
      }
    }
  }
  if (hidden.length > 0) return { ok: false, documented: [], hidden };
  return { ok: true, machinesUsed: machinesUsed(placements), partial };
}
