// 灌装机控制器：世界的生成（能到、步数、踩坑）、远程面板的接口、检查。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realClock, VirtualClock } from '../../sim/kit/clock.ts';
import { makeRequest, type SimHandler, type SimResponse } from '../../sim/kit/http.ts';
import { BOOT_LANES, machineHandler } from '../../sim/machine/api.ts';
import { checkMachine, MACHINE_PRESETS } from '../../sim/machine/tasks.ts';
import { generateMachine, type MachineWorld, replay, shortestPath } from '../../sim/machine/world.ts';

const SEEDS = ['a', 'b', 'c', 'd'];

describe('generateMachine', () => {
  it('同一个种子生成同一台机器，不同种子不同', () => {
    const a = generateMachine(MACHINE_PRESETS.hard, 'same');
    const b = generateMachine(MACHINE_PRESETS.hard, 'same');
    const c = generateMachine(MACHINE_PRESETS.hard, 'other');
    expect(b).toEqual(a);
    expect(c.table).not.toEqual(a.table);
  });

  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    it(`${difficulty}：目标能到，最短步数在范围里，最短解走得通${difficulty === 'easy' ? '' : '；忽略联锁和压力的走法更短'}`, () => {
      const params = MACHINE_PRESETS[difficulty];
      for (const seed of SEEDS) {
        const w = generateMachine(params, seed);
        const path = shortestPath(w, w.target);
        expect(path).toBeDefined();
        expect(path?.length).toBe(w.shortest.length);
        expect(w.shortest.length).toBeGreaterThanOrEqual(params.depth[0]);
        expect(w.shortest.length).toBeLessThanOrEqual(params.depth[1]);
        const end = replay(w, w.shortest);
        expect(end).toMatchObject({ mode: w.modes.length - 1, x: w.target, locked: false });
        if (params.trap) expect(w.relaxedDepth).toBeLessThan(w.shortest.length);
      }
    });
  }

  it('难的有看不见的压力：一个泄压键各状态通用，开机状态有加压的键，换状态的键不加压', () => {
    for (const seed of SEEDS) {
      const w = generateMachine(MACHINE_PRESETS.hard, seed);
      expect(w.params.pressure?.visible).toBe(false);
      expect(w.vent).toBeDefined();
      for (let m = 0; m < w.modes.length - 1; m++) {
        const row = w.table[m] ?? [];
        expect(row[w.vent as number]).toMatchObject({ to: m, op: { kind: 'noop' }, pump: 'vent' });
        for (const cell of row) if (cell.to !== m) expect(cell.pump).toBe(0);
      }
      expect(w.table[0]?.some((c) => c.pump === 1)).toBe(true);
    }
  });
});

describe('machineHandler', () => {
  let world: MachineWorld;
  let clock: VirtualClock;
  let api: SimHandler;
  const call = async (method: string, path: string, body?: unknown): Promise<SimResponse> =>
    api.handle(makeRequest(method, path, body === undefined ? {} : { body }));
  const boot = async () => ((await call('POST', '/sessions')).body as { session: string }).session;

  beforeEach(() => {
    world = generateMachine(MACHINE_PRESETS.hard, 'api');
    clock = new VirtualClock();
    api = machineHandler(world, clock);
  });

  it('GET / 只给型号、按键、开机和目标状态，不给规则', async () => {
    const res = await call('GET', '/');
    expect(res.body).toEqual({
      model: 'FC-3',
      buttons: world.buttons,
      display: '000–999',
      start_mode: 'STANDBY',
      goal_mode: 'RUN',
      docs: '接口见附件 manual.md',
    });
  });

  it('会话互不影响；一次按一串返回每一步，按完的面板和单按一样', async () => {
    const s1 = await boot();
    const s2 = await boot();
    const path = world.shortest.slice(0, 3).map((b) => world.buttons[b] as string);
    const batch = (await call('POST', `/sessions/${s1}/press`, { buttons: path })).body as {
      steps: unknown[];
      panel: { mode: string; display: string; presses: number };
    };
    expect(batch.steps).toHaveLength(3);
    let last: unknown;
    for (const b of path)
      last = ((await call('POST', `/sessions/${s2}/press`, { button: b })).body as { panel: unknown }).panel;
    expect(last).toEqual(batch.panel);
    const s3 = await boot();
    const fresh = (await call('GET', `/sessions/${s3}`)).body as { panel: { presses: number }; history: string[] };
    expect(fresh.panel.presses).toBe(0);
    expect(fresh.history).toEqual([]);
  });

  it('锁死以后再按返回 409，只说锁死了；换个会话照常', async () => {
    const s = await boot();
    // 加压的键连按到超过上限
    const pump = world.buttons[(world.table[0] ?? []).findIndex((c) => c.pump === 1)] as string;
    const max = world.params.pressure?.max ?? 0;
    const res = await call('POST', `/sessions/${s}/press`, { buttons: Array(max + 2).fill(pump) });
    const body = res.body as { panel: { mode: string; note: string }; steps: unknown[]; stopped: string };
    expect(body.panel.mode).toBe('LOCKOUT');
    expect(body.steps).toHaveLength(max + 1);
    expect(body.stopped).toContain('锁死');
    expect(JSON.stringify(body)).not.toMatch(/压力|pressure/);
    const again = await call('POST', `/sessions/${s}/press`, { button: pump });
    expect(again.status).toBe(409);
    const other = await boot();
    expect((await call('POST', `/sessions/${other}/press`, { button: pump })).status).toBe(200);
  });

  it('没有的键返回 400 带按键列表；请求体不对说清楚；未知会话返回 404', async () => {
    const s = await boot();
    const bad = await call('POST', `/sessions/${s}/press`, { button: 'Z' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ buttons: world.buttons });
    const empty = await call('POST', `/sessions/${s}/press`, {});
    expect(empty.status).toBe(400);
    expect((await call('GET', '/sessions/nope')).status).toBe(404);
    expect((await call('GET', '/whatever')).status).toBe(404);
  });

  it(`开机要 bootMs：最多同时开 ${BOOT_LANES} 台，再多的排队（真时钟）`, async () => {
    const quick = machineHandler({ ...world, params: { ...world.params, bootMs: 200 } }, realClock);
    const bootQuick = () => quick.handle(makeRequest('POST', '/sessions'));
    let t0 = Date.now();
    await Promise.all([bootQuick(), bootQuick(), bootQuick()]);
    const three = Date.now() - t0;
    expect(three).toBeGreaterThanOrEqual(190);
    expect(three).toBeLessThan(500); // 三台一起开，不是一台台排
    t0 = Date.now();
    await Promise.all(Array.from({ length: BOOT_LANES + 2 }, bootQuick));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390); // 多出来的两台等下一轮
  });

  it('会话太多时丢最久没用的：刚用过的留着', async () => {
    const keep = await boot();
    const fast = machineHandler({ ...world, params: { ...world.params, bootMs: 0 } }, clock);
    const kept = ((await fast.handle(makeRequest('POST', '/sessions'))).body as { session: string }).session;
    for (let i = 0; i < 5000; i++) {
      if (i % 1000 === 0) await fast.handle(makeRequest('GET', `/sessions/${kept}`));
      await fast.handle(makeRequest('POST', '/sessions'));
    }
    expect((await fast.handle(makeRequest('GET', `/sessions/${kept}`))).status).toBe(200);
    expect(keep).toBeTruthy();
  });

  it(`一个会话最多按 ${MACHINE_PRESETS.hard.maxPresses} 次`, async () => {
    const s = await boot();
    const vent = world.buttons[world.vent as number] as string;
    const res = await call('POST', `/sessions/${s}/press`, { buttons: Array(world.params.maxPresses + 5).fill(vent) });
    const body = res.body as { steps: unknown[]; stopped: string };
    expect(body.steps).toHaveLength(world.params.maxPresses);
    expect(body.stopped).toContain('用完');
    expect((await call('POST', `/sessions/${s}/press`, { button: vent })).status).toBe(409);
  });
});

describe('checkMachine', () => {
  let dir: string;
  const world = generateMachine(MACHINE_PRESETS.medium, 'check');
  const names = world.shortest.map((b) => world.buttons[b] as string);
  const write = (content: string) => writeFileSync(join(dir, 'procedure.json'), content);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'melina-sim-check-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('最短解过（小写也认）', () => {
    write(JSON.stringify(names.map((n) => n.toLowerCase())));
    expect(checkMachine(world, dir).pass).toBe(true);
  });

  it('没有文件、不是 JSON、不是字符串数组、有不存在的键、少一步的都不过', () => {
    expect(checkMachine(world, dir)).toMatchObject({ pass: false, summary: '工作目录里没有 procedure.json' });
    write('not json');
    expect(checkMachine(world, dir).pass).toBe(false);
    write('{"buttons": []}');
    expect(checkMachine(world, dir).pass).toBe(false);
    write(JSON.stringify([...names, 'Q']));
    expect(checkMachine(world, dir).summary).toContain('不存在');
    write(JSON.stringify(names.slice(0, -1)));
    expect(checkMachine(world, dir).pass).toBe(false);
  });
});
