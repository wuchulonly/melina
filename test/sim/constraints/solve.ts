// 部署校验器的标准解：只用 deploy.md、services.json 和校验器接口，拿 partial 校验做小实验：
// 单个副本单独放上去被拒，只能是端口的问题，就换一个端口；两个服务放同一台被拒，就是不能同机；
// 同一服务的两个副本放同一个可用区的两台被拒，就是要分可用区。内存留多少不单独试：从「不留」开始，按假设排一份完整的清单交上去，
// 被拒就多留 1 GiB 再排，直到通过。知道规则大概是这几类，具体是什么全靠试。不 import world.ts 和 api.ts。

import { httpOk, writeJson } from '../client.ts';
import { machinesUsed, type PackMachine, pack } from '../kit/pack.ts';
import type { SolveContext } from '../task.ts';

export interface ServiceSpec {
  name: string;
  cpu: number;
  mem: number;
  replicas: number;
  port: number;
}

export interface MachineSpec {
  id: string;
  zone: string;
  cpu: number;
  mem: number;
}

interface Placement {
  service: string;
  replica: number;
  machine: string;
  port: number;
}

export async function solveConstraints(ctx: SolveContext): Promise<void> {
  const budget = budgetOf(ctx.statement);
  const services = JSON.parse(ctx.materials['services.json'] ?? '[]') as ServiceSpec[];
  const machines = await httpOk<MachineSpec[]>(`${ctx.url}/machines`);
  const check = async (placements: Placement[], partial: boolean): Promise<boolean> =>
    (await httpOk<{ ok: boolean }>(`${ctx.url}/validate`, { method: 'POST', body: { placements, partial } })).ok;
  const big = [...machines].sort((a, b) => b.mem - a.mem || b.cpu - a.cpu)[0] as MachineSpec;

  // 1. 端口：每个副本一个不重复的端口，单独放到最大的机器上试
  const ports = new Map<string, number>();
  const taken = new Set<number>();
  let spare = 20000;
  for (const s of services) {
    for (let r = 1; r <= s.replicas; r++) {
      let port = s.port + r - 1;
      while (taken.has(port) || !(await check([{ service: s.name, replica: r, machine: big.id, port }], true))) {
        port = spare++;
      }
      taken.add(port);
      ports.set(`${s.name}#${r}`, port);
    }
  }
  const portOf = (service: string, replica: number) => ports.get(`${service}#${replica}`) as number;

  // 2. 哪两个服务不能同机
  const anti: [string, string][] = [];
  for (let i = 0; i < services.length; i++) {
    for (let j = i + 1; j < services.length; j++) {
      const a = services[i] as ServiceSpec;
      const b = services[j] as ServiceSpec;
      const ok = await check(
        [
          { service: a.name, replica: 1, machine: big.id, port: portOf(a.name, 1) },
          { service: b.name, replica: 1, machine: big.id, port: portOf(b.name, 1) },
        ],
        true,
      );
      if (!ok) anti.push([a.name, b.name]);
    }
  }

  // 3. 同一服务的副本要不要分可用区
  let zoneSpread = false;
  const multi = services.find((s) => s.replicas > 1);
  const zone = machines.find((m) => machines.filter((x) => x.zone === m.zone).length >= 2)?.zone;
  if (multi && zone) {
    const [m1, m2] = machines.filter((m) => m.zone === zone) as [MachineSpec, MachineSpec];
    zoneSpread = !(await check(
      [
        { service: multi.name, replica: 1, machine: m1.id, port: portOf(multi.name, 1) },
        { service: multi.name, replica: 2, machine: m2.id, port: portOf(multi.name, 2) },
      ],
      true,
    ));
  }

  // 4. 内存留多少：从不留开始，排一份完整的交上去，被拒就多留一点
  for (let reserve = 0; reserve <= 16; reserve++) {
    const usable: PackMachine[] = machines.map((m) => ({ id: m.id, zone: m.zone, cpu: m.cpu, mem: m.mem - reserve }));
    const plan = pack(services, usable, { anti, zoneSpread });
    if (!plan) continue;
    const placements = plan.map((a) => ({ ...a, port: portOf(a.service, a.replica) }));
    if (machinesUsed(placements) > budget) continue;
    if (await check(placements, false)) {
      writeJson(ctx.dir, 'deploy.json', { placements });
      return;
    }
  }
  throw new Error('排不出校验器接受、又不超台数的清单');
}

/** 目标里写的「不超过 5 台」 */
export function budgetOf(statement: string): number {
  const m = /不超过\s*(\d+)\s*台/.exec(statement);
  if (!m) throw new Error('目标里没写最多用几台机器');
  return Number(m[1]);
}
