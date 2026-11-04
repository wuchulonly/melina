// 把服务的副本排到机器上，机器用得越少越好：深度优先搜索，按机器数从下界往上试，每个机器数限节点数。
// 部署校验器的世界用它定「最多用几台」（真规则下找到的最少台数，加上难度给的余量），
// 标准解按摸清的规则用它排。纯函数，同样的输入得到同样的结果。

export interface PackService {
  name: string;
  cpu: number;
  mem: number;
  replicas: number;
}

export interface PackMachine {
  id: string;
  zone: string;
  cpu: number;
  mem: number; // 能用的内存
}

export interface PackRules {
  anti: readonly (readonly [string, string])[]; // 不能在同一台机器上的服务对
  zoneSpread: boolean; // 同一个服务的副本要在不同的可用区
}

export interface Assignment {
  service: string;
  replica: number;
  machine: string;
}

interface Item {
  service: string;
  replica: number;
  cpu: number;
  mem: number;
}

export function pack(
  services: readonly PackService[],
  machines: readonly PackMachine[],
  rules: PackRules,
  options: { nodeLimit?: number; maxMachines?: number } = {},
): Assignment[] | undefined {
  const items: Item[] = services
    .flatMap((s) =>
      Array.from({ length: s.replicas }, (_, i) => ({ service: s.name, replica: i + 1, cpu: s.cpu, mem: s.mem })),
    )
    .sort((a, b) => b.mem - a.mem || b.cpu - a.cpu || a.service.localeCompare(b.service) || a.replica - b.replica);
  if (items.length === 0) return [];
  const order = [...machines].sort(
    (a, b) => b.mem - a.mem || b.cpu - a.cpu || a.zone.localeCompare(b.zone) || a.id.localeCompare(b.id),
  );
  const anti = new Map<string, Set<string>>();
  for (const [a, b] of rules.anti) {
    if (!anti.has(a)) anti.set(a, new Set());
    if (!anti.has(b)) anti.set(b, new Set());
    anti.get(a)?.add(b);
    anti.get(b)?.add(a);
  }
  const totalMem = items.reduce((s, i) => s + i.mem, 0);
  const totalCpu = items.reduce((s, i) => s + i.cpu, 0);
  const maxMem = Math.max(...order.map((m) => m.mem));
  const maxCpu = Math.max(...order.map((m) => m.cpu));
  const maxReplicas = Math.max(...services.map((s) => s.replicas));
  const lower = Math.max(
    1,
    Math.ceil(totalMem / maxMem),
    Math.ceil(totalCpu / maxCpu),
    rules.zoneSpread ? maxReplicas : 1,
  );
  const upper = Math.min(options.maxMachines ?? order.length, order.length);
  const nodeLimit = options.nodeLimit ?? 200_000;

  for (let k = lower; k <= upper; k++) {
    const result = search(items, order, anti, rules.zoneSpread, k, nodeLimit);
    if (result) return result;
  }
  return undefined;
}

function search(
  items: readonly Item[],
  machines: readonly PackMachine[],
  anti: Map<string, Set<string>>,
  zoneSpread: boolean,
  k: number,
  nodeLimit: number,
): Assignment[] | undefined {
  const n = machines.length;
  const cpu = new Array<number>(n).fill(0);
  const mem = new Array<number>(n).fill(0);
  const onMachine: Set<string>[] = machines.map(() => new Set());
  const zoneOf = machines.map((m) => m.zone);
  const zonesUsed = new Map<string, Set<string>>(); // 服务 → 用过的可用区
  const opened: number[] = [];
  const isOpen = new Array<boolean>(n).fill(false);
  const assignment = new Array<number>(items.length).fill(-1);
  const remainingMem = new Array<number>(items.length + 1).fill(0);
  const remainingCpu = new Array<number>(items.length + 1).fill(0);
  for (let i = items.length - 1; i >= 0; i--) {
    remainingMem[i] = (remainingMem[i + 1] as number) + (items[i] as Item).mem;
    remainingCpu[i] = (remainingCpu[i + 1] as number) + (items[i] as Item).cpu;
  }
  let nodes = 0;

  const fits = (m: number, item: Item): boolean => {
    const machine = machines[m] as PackMachine;
    if ((cpu[m] as number) + item.cpu > machine.cpu || (mem[m] as number) + item.mem > machine.mem) return false;
    const enemies = anti.get(item.service);
    if (enemies) for (const s of onMachine[m] as Set<string>) if (enemies.has(s)) return false;
    if (zoneSpread && zonesUsed.get(item.service)?.has(zoneOf[m] as string)) return false;
    return true;
  };

  /** 剩下的放得下吗：开着的机器剩的，加上还能开的里最大的那几台 */
  const roomFor = (i: number): boolean => {
    let freeMem = 0;
    let freeCpu = 0;
    for (const m of opened) {
      freeMem += (machines[m] as PackMachine).mem - (mem[m] as number);
      freeCpu += (machines[m] as PackMachine).cpu - (cpu[m] as number);
    }
    const slots = k - opened.length;
    if (slots > 0) {
      const closed = machines.map((_, m) => m).filter((m) => !isOpen[m]);
      freeMem += closed
        .map((m) => (machines[m] as PackMachine).mem)
        .sort((a, b) => b - a)
        .slice(0, slots)
        .reduce((s, v) => s + v, 0);
      freeCpu += closed
        .map((m) => (machines[m] as PackMachine).cpu)
        .sort((a, b) => b - a)
        .slice(0, slots)
        .reduce((s, v) => s + v, 0);
    }
    return freeMem >= (remainingMem[i] as number) && freeCpu >= (remainingCpu[i] as number);
  };

  const place = (m: number, item: Item, i: number, on: boolean): void => {
    const sign = on ? 1 : -1;
    cpu[m] = (cpu[m] as number) + sign * item.cpu;
    mem[m] = (mem[m] as number) + sign * item.mem;
    const set = onMachine[m] as Set<string>;
    let zones = zonesUsed.get(item.service);
    if (!zones) {
      zones = new Set();
      zonesUsed.set(item.service, zones);
    }
    if (on) {
      set.add(item.service);
      zones.add(zoneOf[m] as string);
      assignment[i] = m;
    } else {
      // 同一台机器上可能有同一个服务的别的副本（不要求分可用区时）
      if (!items.some((other, j) => j !== i && assignment[j] === m && other.service === item.service))
        set.delete(item.service);
      if (
        !items.some(
          (other, j) =>
            j !== i &&
            assignment[j] !== -1 &&
            other.service === item.service &&
            zoneOf[assignment[j] as number] === zoneOf[m],
        )
      ) {
        zones.delete(zoneOf[m] as string);
      }
      assignment[i] = -1;
    }
  };

  const dfs = (i: number): boolean => {
    if (i === items.length) return true;
    if (++nodes > nodeLimit) return false;
    if (!roomFor(i)) return false;
    const item = items[i] as Item;
    for (const m of [...opened]) {
      if (!fits(m, item)) continue;
      place(m, item, i, true);
      if (dfs(i + 1)) return true;
      place(m, item, i, false);
    }
    if (opened.length < k) {
      // 没开的机器里，可用区、cpu、内存都一样的只试一台
      const tried = new Set<string>();
      for (let m = 0; m < n; m++) {
        if (isOpen[m]) continue;
        const machine = machines[m] as PackMachine;
        const signature = `${machine.zone}|${machine.cpu}|${machine.mem}`;
        if (tried.has(signature)) continue;
        tried.add(signature);
        if (!fits(m, item)) continue;
        isOpen[m] = true;
        opened.push(m);
        place(m, item, i, true);
        if (dfs(i + 1)) return true;
        place(m, item, i, false);
        opened.pop();
        isOpen[m] = false;
      }
    }
    return false;
  };

  if (!dfs(0)) return undefined;
  return items.map((item, i) => ({
    service: item.service,
    replica: item.replica,
    machine: (machines[assignment[i] as number] as PackMachine).id,
  }));
}

/** 用到的机器数 */
export function machinesUsed(assignments: readonly { machine: string }[]): number {
  return new Set(assignments.map((a) => a.machine)).size;
}
