// 部署校验器的直接做法：照 deploy.md 写的规则（CPU、标称内存）和默认端口排一份，用的机器尽量少，不去试藏起来的规则，
// 也不交给校验器看一眼。中等和难的这样过不了。

import { httpOk, writeJson } from '../client.ts';
import { pack } from '../kit/pack.ts';
import type { SolveContext } from '../task.ts';
import type { MachineSpec, ServiceSpec } from './solve.ts';

export async function naiveConstraints(ctx: SolveContext): Promise<void> {
  const services = JSON.parse(ctx.materials['services.json'] ?? '[]') as ServiceSpec[];
  const machines = await httpOk<MachineSpec[]>(`${ctx.url}/machines`);
  const plan = pack(services, machines, { anti: [], zoneSpread: false }) ?? [];
  const port = (name: string, replica: number) =>
    (services.find((s) => s.name === name) as ServiceSpec).port + replica - 1;
  writeJson(ctx.dir, 'deploy.json', { placements: plan.map((a) => ({ ...a, port: port(a.service, a.replica) })) });
}
