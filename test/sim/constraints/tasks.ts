// 部署校验器的三档任务：简单（门槛 1：只藏了保留端口，校验器把问题说得清清楚楚）、
// 中等（门槛 2：多了内存预留、不能同机、分可用区，校验器只说第一条违规的类别）、
// 难（门槛 3：校验器只说「不行」，台数卡在找到的最少台数上；每条规则都是一个能共享的事实）。
// 有主指标：用到的机器数，越少越好，目标是「最多用几台」。

import type { CompletionSpec } from '../../../src/core/types.ts';
import { machinesUsed } from '../kit/pack.ts';
import {
  type CheckResult,
  type Difficulty,
  type Gate,
  parseJson,
  readDeliverable,
  type SimTask,
  type SimWorld,
} from '../task.ts';
import { constraintsHandler } from './api.ts';
import { naiveConstraints } from './naive.ts';
import { solveConstraints } from './solve.ts';
import { type ConstraintParams, type ConstraintWorld, generateConstraints, type Placement, validate } from './world.ts';

export const CONSTRAINT_PRESETS: Record<Difficulty, ConstraintParams> = {
  easy: {
    services: 5,
    machines: 4,
    zones: 2,
    replicas: [1, 2],
    feedback: 'precise',
    reserve: null,
    reservedPorts: true,
    antiPairs: 0,
    zoneSpread: false,
    slack: 1,
  },
  medium: {
    services: 8,
    machines: 6,
    zones: 3,
    replicas: [1, 3],
    feedback: 'first',
    reserve: [2, 6],
    reservedPorts: true,
    antiPairs: 2,
    zoneSpread: true,
    slack: 1,
  },
  hard: {
    services: 12,
    machines: 9,
    zones: 3,
    replicas: [1, 3],
    feedback: 'opaque',
    reserve: [2, 8],
    reservedPorts: true,
    antiPairs: 4,
    zoneSpread: true,
    slack: 0,
  },
};

const GATE: Record<Difficulty, Gate> = { easy: 1, medium: 2, hard: 3 };
const LABEL: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '难' };

export function constraintTask(
  difficulty: Difficulty,
  params: ConstraintParams = CONSTRAINT_PRESETS[difficulty],
): SimTask {
  return {
    id: `constraints-${difficulty}`,
    env: 'constraints',
    difficulty,
    gate: GATE[difficulty],
    title: `部署清单（${LABEL[difficulty]}）`,
    domain: 'general',
    create: (seed) => constraintWorld(generateConstraints(params, seed), seed),
    solve: solveConstraints,
    naive: naiveConstraints,
  };
}

export function constraintTasks(): SimTask[] {
  return (['easy', 'medium', 'hard'] as const).map((d) => constraintTask(d));
}

function constraintWorld(world: ConstraintWorld, seed: string): SimWorld {
  return {
    seed,
    statement: (url) =>
      `给附件 services.json 里的服务写一份部署清单，存成工作目录里的 deploy.json，要让 ${url} 的校验器通过、` +
      `用到的机器不超过 ${world.budget} 台；清单格式和校验器接口见附件 deploy.md。`,
    completion: (url): CompletionSpec => ({
      interpretation: `清单要排下 services.json 里每个服务的每个副本，校验器的完整校验（不带 partial）通过，用到的机器不超过 ${world.budget} 台`,
      criteria: [
        '工作目录根下有 deploy.json，格式符合 deploy.md',
        `把 deploy.json 原样 POST 到 ${url}/validate（不带 partial），返回 {"ok": true, …}`,
        `deploy.json 用到的机器不超过 ${world.budget} 台`,
      ],
      metric: { name: '用到的机器数', unit: '台', better: 'lower', target: world.budget },
    }),
    materials: (url) => [
      { name: 'deploy.md', content: deployDoc(url) },
      {
        name: 'services.json',
        content: `${JSON.stringify(
          world.services.map((s) => ({ name: s.name, cpu: s.cpu, mem: s.mem, replicas: s.replicas, port: s.port })),
          null,
          2,
        )}\n`,
      },
    ],
    starter: () => ({ 'README.md': '# 部署清单\n\n这次任务的交付物 deploy.json 放在这个目录。\n' }),
    handler: () => constraintsHandler(world),
    deliverables: () => ['deploy.json'],
    check: (dir) => checkConstraints(world, dir),
    summary: () => ({
      budget: world.budget,
      reserve: world.reserve,
      reservedPorts: world.reservedFrom === undefined ? null : [world.reservedFrom, world.reservedFrom + 99],
      anti: world.anti,
      zoneSpread: world.params.zoneSpread,
      replicas: world.services.reduce((n, s) => n + s.replicas, 0),
      machines: world.machines.length,
    }),
  };
}

export function checkConstraints(world: ConstraintWorld, dir: string): CheckResult {
  const file = readDeliverable(dir, 'deploy.json');
  if ('error' in file) return { pass: false, summary: file.error };
  const parsed = parseJson(file.text, 'deploy.json');
  if ('error' in parsed) return { pass: false, summary: parsed.error };
  // 清单里写了 partial 也按完整校验
  const result = validate(world, parsed.value, false);
  if (!result.ok) {
    const first = result.documented[0] ?? result.hidden[0]?.message ?? '校验不过';
    const more = result.documented.length + result.hidden.length - 1;
    return { pass: false, summary: `校验器不接受：${first}${more > 0 ? `（还有 ${more} 处）` : ''}` };
  }
  const used = machinesUsed((parsed.value as { placements: Placement[] }).placements);
  if (used > world.budget) return { pass: false, summary: `用了 ${used} 台机器，最多 ${world.budget} 台` };
  return { pass: true, summary: `校验通过，用了 ${used} 台机器（最多 ${world.budget} 台）` };
}

function deployDoc(url: string): string {
  return `# 部署清单和校验器

地址：${url}

## 接口

- \`GET ${url}/machines\`：机器列表，\`[{"id": "m1", "zone": "z1", "cpu": 16, "mem": 64}, …]\`，cpu 是核数，mem 是内存（GiB），zone 是可用区
- \`GET ${url}/services\`：要部署的服务，和附件 services.json 一样
- \`POST ${url}/validate\`：校验一份清单，请求体就是清单，返回 \`{"ok": true, "machines_used": 3}\` 或 \`{"ok": false, …}\`
  - 请求体里加 \`"partial": true\` 时只检查给出的这些副本，不要求每个副本都排上，可以拿来试

## 清单 deploy.json

\`\`\`json
{"placements": [{"service": "api", "replica": 1, "machine": "m1", "port": 8080}, …]}
\`\`\`

- 每个服务的每个副本（replica 从 1 数到 services.json 里的 replicas）都要排到一台机器上，正好一次
- port 是这个副本监听的端口，1024 到 65535；同一台机器上端口不能重复
- 一台机器上排的副本，CPU 加起来不能超过机器的 cpu，内存加起来不能超过机器的 mem

## 服务

services.json 里每个服务：name、cpu（核）、mem（GiB）、replicas（副本数）、port（默认端口）。
`;
}
