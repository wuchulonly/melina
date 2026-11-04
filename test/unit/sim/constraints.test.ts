// 部署校验器：pack() 排得对、排得少；世界的保证（单个、两个放得下，每个可用区两台）；校验器的规则和三种回话；检查。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { constraintsHandler } from '../../sim/constraints/api.ts';
import { CONSTRAINT_PRESETS, checkConstraints } from '../../sim/constraints/tasks.ts';
import {
  type ConstraintWorld,
  generateConstraints,
  type Placement,
  portFor,
  validate,
} from '../../sim/constraints/world.ts';
import { makeRequest } from '../../sim/kit/http.ts';
import { machinesUsed, pack } from '../../sim/kit/pack.ts';

describe('pack', () => {
  const machines = [
    { id: 'a', zone: 'z1', cpu: 8, mem: 16 },
    { id: 'b', zone: 'z1', cpu: 8, mem: 16 },
    { id: 'c', zone: 'z2', cpu: 8, mem: 16 },
  ];

  it('机器用得最少；不超 CPU 和内存', () => {
    const plan = pack(
      [
        { name: 'x', cpu: 4, mem: 8, replicas: 2 },
        { name: 'y', cpu: 4, mem: 8, replicas: 1 },
      ],
      machines,
      { anti: [], zoneSpread: false },
    );
    expect(plan && machinesUsed(plan)).toBe(2);
  });

  it('不能同机的分开；要分可用区的不在同一区；排不下返回 undefined', () => {
    const services = [
      { name: 'x', cpu: 1, mem: 1, replicas: 2 },
      { name: 'y', cpu: 1, mem: 1, replicas: 1 },
    ];
    const anti = pack(services, machines, { anti: [['x', 'y']], zoneSpread: false }) ?? [];
    const machineOf = (s: string, r: number) => anti.find((a) => a.service === s && a.replica === r)?.machine;
    expect(machineOf('y', 1)).not.toBe(machineOf('x', 1));
    expect(machineOf('y', 1)).not.toBe(machineOf('x', 2));
    const spread = pack(services, machines, { anti: [], zoneSpread: true }) ?? [];
    const zones = spread.filter((a) => a.service === 'x').map((a) => machines.find((m) => m.id === a.machine)?.zone);
    expect(new Set(zones).size).toBe(2);
    expect(
      pack([{ name: 'big', cpu: 9, mem: 1, replicas: 1 }], machines, { anti: [], zoneSpread: false }),
    ).toBeUndefined();
    expect(
      pack([{ name: 'x', cpu: 1, mem: 1, replicas: 3 }], machines, { anti: [], zoneSpread: true }),
    ).toBeUndefined();
  });
});

describe('generateConstraints', () => {
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    it(`${difficulty}：单个服务放得进任何一台，任意两个放得进最大的；每区至少两台；最多用几台比机器总数少`, () => {
      for (const seed of ['a', 'b', 'c']) {
        const w = generateConstraints(CONSTRAINT_PRESETS[difficulty], seed);
        const usable = (mem: number) => mem - w.reserve;
        const big = [...w.machines].sort((a, b) => b.mem - a.mem)[0];
        for (const s of w.services) {
          for (const m of w.machines) expect(s.cpu <= m.cpu && s.mem <= usable(m.mem)).toBe(true);
          for (const t of w.services) {
            if (t === s) continue;
            expect(s.cpu + t.cpu <= (big?.cpu ?? 0) && s.mem + t.mem <= usable(big?.mem ?? 0)).toBe(true);
          }
        }
        for (const zone of new Set(w.machines.map((m) => m.zone))) {
          expect(w.machines.filter((m) => m.zone === zone).length).toBeGreaterThanOrEqual(2);
        }
        expect(w.budget).toBeLessThan(w.machines.length);
        expect(machinesUsed(w.best) + w.params.slack).toBe(w.budget);
        const best = w.best.map((a) => ({ ...a, port: 30000 + w.best.indexOf(a) }));
        expect(validate(w, { placements: best }).ok).toBe(true);
      }
    }, 30_000); // 难档三个种子一共几秒，整套单测并行、机器忙时会超过 5 秒的默认上限
  }
});

describe('validate 和校验器的回话', () => {
  const w: ConstraintWorld = generateConstraints(CONSTRAINT_PRESETS.medium, 'rules');
  const safe = (service: string, replica: number, machine: string, port: number): Placement => ({
    service,
    replica,
    machine,
    port,
  });
  const big = [...w.machines].sort((a, b) => b.mem - a.mem)[0]?.id as string;

  it('文档里写了的规则说清楚：格式、缺副本、端口重复、超 CPU', () => {
    expect(validate(w, { nope: 1 })).toMatchObject({ ok: false, documented: ['清单要是 {"placements": [...]}'] });
    const s = w.services[0]?.name as string;
    const missing = validate(w, { placements: [safe(s, 1, big, 30000)] });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.documented.some((d) => d.includes('没有排'))).toBe(true);
    expect(validate(w, { placements: [safe(s, 1, big, 30000)] }, true).ok).toBe(true);
    const t = w.services[1]?.name as string;
    const dup = validate(w, { placements: [safe(s, 1, big, 30000), safe(t, 1, big, 30000)] }, true);
    expect(!dup.ok && dup.documented[0]).toContain('端口 30000 重复');
  });

  it('藏起来的规则：保留端口、不能同机、分可用区、系统预留内存', () => {
    const lo = w.reservedFrom as number;
    const s = w.services[0]?.name as string;
    const port = validate(w, { placements: [safe(s, 1, big, lo + 5)] }, true);
    expect(!port.ok && port.hidden[0]?.rule).toBe('port');
    const [a, b] = w.anti[0] as [string, string];
    const pair = validate(w, { placements: [safe(a, 1, big, 30001), safe(b, 1, big, 30002)] }, true);
    expect(!pair.ok && pair.hidden[0]?.rule).toBe('affinity');
    const multi = w.services.find((x) => x.replicas > 1);
    if (multi) {
      const zone = w.machines[0]?.zone;
      const [m1, m2] = w.machines.filter((m) => m.zone === zone);
      const spread = validate(
        w,
        { placements: [safe(multi.name, 1, m1?.id as string, 30003), safe(multi.name, 2, m2?.id as string, 30004)] },
        true,
      );
      expect(!spread.ok && spread.hidden[0]?.rule).toBe('zone');
    }
    expect(w.reserve).toBeGreaterThan(0);
  });

  it('三种回话：precise 说清每一条，first 只给类别，opaque 只说不行', async () => {
    const lo = w.reservedFrom as number;
    const s = w.services[0]?.name as string;
    const body = { placements: [safe(s, 1, big, lo)], partial: true };
    const reply = async (feedback: 'precise' | 'first' | 'opaque') =>
      (
        await constraintsHandler({ ...w, params: { ...w.params, feedback } }).handle(
          makeRequest('POST', '/validate', { body }),
        )
      ).body;
    expect(await reply('precise')).toMatchObject({ ok: false, errors: [expect.stringContaining('保留区间')] });
    expect(await reply('first')).toEqual({ ok: false, error: 'E_PORT', service: s, replica: 1 });
    expect(await reply('opaque')).toEqual({ ok: false, error: 'rejected' });
  });

  it('checkConstraints：照文档排的不过；真规则下的排法过，partial 写在文件里也按完整校验', () => {
    const dir = mkdtempSync(join(tmpdir(), 'melina-sim-deploy-'));
    try {
      const write = (v: unknown) => writeFileSync(join(dir, 'deploy.json'), JSON.stringify(v));
      write({ placements: w.best.map((a) => ({ ...a, port: portFor(w, a.service, a.replica) + 20000 })) });
      expect(checkConstraints(w, dir).pass).toBe(true);
      write({
        placements: w.best.slice(1).map((a) => ({ ...a, port: portFor(w, a.service, a.replica) + 20000 })),
        partial: true,
      });
      expect(checkConstraints(w, dir).pass).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
