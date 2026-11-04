// 灌装机控制器的标准解：只用 manual.md 写的接口和目标里的数字，每次新开一个会话做一个小实验，摸清规则，再规划按键顺序。
//
// 它知道规则大概是哪几类：键对屏幕加、乘（2 到 9）、置数或没反应；换状态的键可能顺带改屏幕、可能有联锁
// （偶数、奇数、小于 500、不小于 500、3 的倍数、5 的倍数之一）；可能有看不见的压力，有压力的话开机状态就有加压的键，
// 另有一个各状态通用、不改屏幕的泄压键；换状态的键不加压。具体是哪个键、什么数、哪条联锁，全靠试。
// 证明这道题只靠接口就做得出来。不 import world.ts 和 api.ts。
//
// 做法：按已经摸清的规则从开机做 BFS，凡是能到的（状态、屏幕）都能当实验的起点；挑能分清剩下候选的起点去试，
// 记样本用真机返回的屏幕值。

import { httpOk, writeJson } from '../client.ts';
import type { SolveContext } from '../task.ts';

type Op = { kind: 'add'; k: number } | { kind: 'mul'; k: number } | { kind: 'set'; k: number } | { kind: 'noop' };
type Guard = 'none' | 'even' | 'odd' | 'lt500' | 'ge500' | 'mod3' | 'mod5';
const GUARDS: Guard[] = ['none', 'even', 'odd', 'lt500', 'ge500', 'mod3', 'mod5'];
const MOD = 1000;
const LOCKOUT = 'LOCKOUT';
const MAX_ROUTE = 120; // 实验起点最多按几下才到

interface Panel {
  mode: string;
  display: string;
}

interface Cell {
  kind: 'stay' | 'move' | 'unknown';
  to?: string; // move：去哪个状态
  samples: [number, number][]; // stay：按之前、之后的屏幕；move：进入前、后的屏幕
  passedAt: number[]; // move：按下时的屏幕，没锁死
  lockedAt: number[]; // move：按下时的屏幕，锁死了
  pump?: 0 | 1 | 'vent';
}

export async function solveMachine(ctx: SolveContext): Promise<void> {
  const target = targetOf(ctx.statement);
  const explorer = new Explorer(ctx.url);
  await explorer.learn();
  const plan = explorer.plan(target);
  if (!plan) throw new Error(`按摸清的规则到不了 ${pad3(target)}`);
  const last = await explorer.tryPath(plan);
  if (last.mode !== explorer.goal || last.display !== pad3(target)) {
    throw new Error(`规划的按键顺序在真机上没成功：停在 ${last.mode} ${last.display}`);
  }
  writeJson(ctx.dir, 'procedure.json', plan);
}

/** 目标里写的「屏幕显示 437」 */
export function targetOf(statement: string): number {
  const m = /屏幕显示\s*(\d{1,3})/.exec(statement);
  if (!m) throw new Error('目标里没写屏幕要显示多少');
  return Number(m[1]);
}

/** 一次 BFS 的结果：每个（状态、屏幕、压力）怎么到 */
interface Reach {
  levels: number;
  prev: Int32Array;
  via: Int16Array;
  dist: Int32Array;
}

export class Explorer {
  readonly url: string;
  buttons: string[] = [];
  start = '';
  goal = '';
  readonly modes: string[] = [];
  readonly explored = new Set<string>();
  readonly cells = new Map<string, Cell>();
  max = Number.POSITIVE_INFINITY; // 压力上限；没有压力是无穷
  vent: string | undefined;
  bootX = 0;
  sessions = 0;

  constructor(url: string) {
    this.url = url;
  }

  async learn(): Promise<void> {
    const info = await httpOk<{ buttons: string[]; start_mode: string; goal_mode: string }>(`${this.url}/`);
    this.buttons = info.buttons;
    this.start = info.start_mode;
    this.goal = info.goal_mode;
    this.bootX = Number((await this.boot()).panel.display);
    this.modes.push(this.start);
    await this.exploreNew();
    // 后面摸清的规则可能让前面的状态里多出能到的屏幕值，回头把没分清的作用和联锁再分一分
    for (let round = 0; round < 4; round++) {
      const before = this.unresolved();
      for (const mode of [...this.modes]) {
        if (mode === this.goal) continue;
        for (const b of this.buttons) {
          const c = this.cell(mode, b);
          if (c.kind === 'stay' && c.pump !== 'vent' && !opOf(c)) await this.fitStay(mode, b);
          if (c.kind !== 'stay') await this.fitMove(mode, b);
        }
      }
      await this.exploreNew();
      if (this.unresolved() >= before) break;
    }
  }

  async exploreNew(): Promise<void> {
    for (let i = 0; i < this.modes.length; i++) {
      const mode = this.modes[i] as string;
      if (mode !== this.goal && !this.explored.has(mode)) await this.explore(mode);
    }
  }

  /** 还没分清的：作用有几种可能的键，联锁有几种可能的换状态键，没走通过的换状态键 */
  unresolved(): number {
    let n = 0;
    for (const c of this.cells.values()) {
      if (c.pump === 'vent') continue;
      if (opsOf(c).length !== 1) n++;
      if (c.kind !== 'stay' && consistentGuards(c).length !== 1) n++;
      if (c.kind !== 'stay' && !c.to) n++;
    }
    return n;
  }

  // ── 实验：每次新开一个会话 ─────────────────────────────────────────────

  async boot(): Promise<{ session: string; panel: Panel }> {
    this.sessions++;
    return httpOk(`${this.url}/sessions`, { method: 'POST' });
  }

  /** 新开一个会话按一串键，返回开机面板加每按一下以后的面板；锁死的那一下是 LOCKOUT，后面的不按 */
  async run(path: string[]): Promise<Panel[]> {
    const { session, panel } = await this.boot();
    if (path.length === 0) return [panel];
    const res = await httpOk<{ steps: { panel: Panel }[] }>(`${this.url}/sessions/${session}/press`, {
      method: 'POST',
      body: { buttons: path },
    });
    return [panel, ...res.steps.map((s) => s.panel)];
  }

  async tryPath(path: string[]): Promise<Panel> {
    const panels = await this.run(path);
    return panels[panels.length - 1] as Panel;
  }

  /** 走到起点（真机上确认到了这个状态），按 times 下 b：返回按之前的屏幕和每按一下以后的面板 */
  async experiment(
    mode: string,
    path: string[],
    b: string,
    times: number,
  ): Promise<{ x: number; after: Panel[] } | undefined> {
    const panels = await this.run([...path, ...Array<string>(times).fill(b)]);
    const before = panels[path.length];
    if (!before || before.mode !== mode) return undefined; // 规则摸错了，没走到起点；不记
    return { x: Number(before.display), after: panels.slice(path.length + 1) };
  }

  cell(mode: string, b: string): Cell {
    const key = `${mode}|${b}`;
    let c = this.cells.get(key);
    if (!c) {
      c = { kind: 'unknown', samples: [], passedAt: [], lockedAt: [] };
      this.cells.set(key, c);
    }
    return c;
  }

  withVent(path: string[]): string[] {
    return this.vent ? [...path, this.vent] : path;
  }

  async explore(mode: string): Promise<void> {
    this.explored.add(mode);
    const routes = this.routes(mode);
    const startX = [...routes.keys()].find((x) => x !== 0) ?? [...routes.keys()][0];
    if (startX === undefined) return;
    const base = this.withVent(routes.get(startX) as string[]);
    // 1. 每个键单按一下：换不换状态、屏幕怎么变；从压力为零的地方单按就锁死的，只能是换状态的联锁
    for (const b of this.buttons) {
      if (b === this.vent) {
        const c = this.cell(mode, b);
        c.kind = 'stay';
        c.pump = 'vent';
        continue;
      }
      const e = await this.experiment(mode, base, b, 1);
      if (e) this.record(mode, b, e.x, e.after[0] as Panel);
    }
    // 2. 不换状态的键连按几下：多几组屏幕前后的值；有压力的话，加压的键按到上限加一下就锁死
    const stays = this.buttons.filter((b) => b !== this.vent && this.cell(mode, b).kind === 'stay');
    for (const b of stays) {
      const times = Number.isFinite(this.max) ? this.max + 1 : 7;
      const e = await this.experiment(mode, base, b, times);
      if (!e) continue;
      const c = this.cell(mode, b);
      let x = e.x;
      let lockedAfter: number | undefined;
      for (const [i, p] of e.after.entries()) {
        if (p.mode === LOCKOUT) {
          lockedAfter = i + 1;
          break;
        }
        c.samples.push([x, Number(p.display)]);
        x = Number(p.display);
      }
      if (lockedAfter !== undefined) {
        c.pump = 1;
        if (!Number.isFinite(this.max)) this.max = lockedAfter - 1;
      } else if (mode !== this.start) {
        c.pump = 0;
      }
    }
    if (mode === this.start) {
      if (Number.isFinite(this.max)) {
        // 压力打满，按一下要试的键，再按一下加压的键：没锁死，说明要试的键把压力泄了
        const pumping = stays.find((b) => this.cell(mode, b).pump === 1) as string;
        for (const b of stays) {
          const c = this.cell(mode, b);
          if (c.pump !== undefined) continue;
          const last = await this.tryPath([...base, ...Array<string>(this.max).fill(pumping), b, pumping]);
          if (last.mode === LOCKOUT) c.pump = 0;
          else {
            c.pump = 'vent';
            this.vent = b;
          }
        }
      } else {
        for (const b of stays) this.cell(mode, b).pump = 0;
      }
    }
    // 3. 屏幕的作用还看不出来的（比如在 000 上乘），换个屏幕值再试
    for (const b of stays) await this.fitStay(mode, b);
    // 4. 换状态的键：试出联锁，和进入新状态时对屏幕的作用
    for (const b of this.buttons) {
      const c = this.cell(mode, b);
      if (c.kind === 'move' || c.kind === 'unknown') await this.fitMove(mode, b);
    }
  }

  record(mode: string, b: string, x: number, after: Panel): void {
    const c = this.cell(mode, b);
    if (after.mode === LOCKOUT) {
      c.kind = 'move';
      c.lockedAt.push(x);
      return;
    }
    const y = Number(after.display);
    if (after.mode === mode) {
      c.kind = 'stay';
      c.samples.push([x, y]);
      return;
    }
    c.kind = 'move';
    c.to = after.mode;
    c.passedAt.push(x);
    c.samples.push([x, y]);
    if (!this.modes.includes(after.mode)) this.modes.push(after.mode);
  }

  async fitStay(mode: string, b: string): Promise<void> {
    const c = this.cell(mode, b);
    for (let round = 0; round < 8 && !opOf(c); round++) {
      const tried = new Set(c.samples.map((s) => s[0]));
      const routes = this.routes(mode);
      const xs = [...routes.keys()];
      const next = xs.find((x) => !tried.has(x) && x !== 0) ?? xs.find((x) => !tried.has(x));
      if (next === undefined) return;
      const times = c.pump === 1 ? Math.min(2, this.max) : 2;
      const e = await this.experiment(mode, this.withVent(routes.get(next) as string[]), b, times);
      if (!e) return;
      let x = e.x;
      for (const p of e.after) {
        if (p.mode === LOCKOUT) break;
        c.samples.push([x, Number(p.display)]);
        x = Number(p.display);
      }
    }
  }

  async fitMove(mode: string, b: string): Promise<void> {
    const c = this.cell(mode, b);
    for (let round = 0; round < 12; round++) {
      if (c.to && opOf(c) && consistentGuards(c).length === 1) return;
      const guards = consistentGuards(c);
      const routes = this.routes(mode);
      const tested = new Set([...c.passedAt, ...c.lockedAt]);
      let pick: number | undefined;
      if (guards.length > 1) {
        // 挑一个能把剩下的联锁候选分得最开的屏幕值
        let best = 0;
        for (const x of routes.keys()) {
          if (tested.has(x)) continue;
          const score = splitScore(guards, x);
          if (score > best) {
            best = score;
            pick = x;
          }
        }
      }
      if (pick === undefined && (!c.to || !opOf(c))) {
        // 联锁分不出来了，进入时的作用还看不出来：再找一个所有候选都放行的屏幕值
        pick = [...routes.keys()].find((x) => !tested.has(x) && x !== 0 && guards.every((g) => guardOk(g, x)));
      }
      if (pick === undefined) return;
      const e = await this.experiment(mode, routes.get(pick) as string[], b, 1);
      if (!e) return;
      this.record(mode, b, e.x, e.after[0] as Panel);
    }
  }

  /**
   * 按摸清的规则，从开机能到这个状态的哪些屏幕值，和最短的走法；按走法从短到长排，太长的不要
   * （一个会话最多按 300 次，实验还要在后面再按几下）
   */
  routes(mode: string, limit = MAX_ROUTE): Map<number, string[]> {
    const search = this.search();
    const m = this.modes.indexOf(mode);
    const found: [number, number][] = []; // [屏幕, 状态下标]
    if (m < 0) return new Map();
    for (let x = 0; x < MOD; x++) {
      let best = -1;
      for (let p = 0; p < search.levels; p++) {
        const i = (m * MOD + x) * search.levels + p;
        const d = search.dist[i] as number;
        if (d >= 0 && (best < 0 || d < (search.dist[best] as number))) best = i;
      }
      if (best >= 0 && (search.dist[best] as number) <= limit) found.push([x, best]);
    }
    found.sort((a, b) => (search.dist[a[1]] as number) - (search.dist[b[1]] as number) || a[0] - b[0]);
    return new Map(found.map(([x, i]) => [x, this.pathOf(search, i)]));
  }

  /** 按摸清的规则：从开机到 (goal, target) 的最短按键顺序 */
  plan(target: number): string[] | undefined {
    return this.routes(this.goal, 300).get(target);
  }

  pathOf(search: Reach, index: number): string[] {
    const path: string[] = [];
    for (let i = index; (search.prev[i] as number) >= 0; i = search.prev[i] as number) {
      path.push(this.buttons[search.via[i] as number] as string);
    }
    return path.reverse();
  }

  /**
   * 从开机出发的 BFS，只走摸清了的：不换状态的键要知道作用（几种候选在这个屏幕值上结果一样也行）和加不加压；
   * 换状态的键要知道去哪、进去以后屏幕是多少，而且剩下的联锁候选都放行。到了 goal 就不再往下走
   */
  search(): Reach {
    const levels = Number.isFinite(this.max) ? this.max + 1 : 1;
    const size = this.modes.length * MOD * levels;
    const dist = new Int32Array(size).fill(-1);
    const prev = new Int32Array(size).fill(-1);
    const via = new Int16Array(size).fill(-1);
    const startIndex = this.bootX * levels;
    dist[startIndex] = 0;
    const queue = [startIndex];
    const goal = this.modes.indexOf(this.goal);
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head] as number;
      const p = i % levels;
      const x = Math.floor(i / levels) % MOD;
      const m = Math.floor(i / levels / MOD);
      if (m === goal) continue;
      const mode = this.modes[m] as string;
      for (const [bi, b] of this.buttons.entries()) {
        const c = this.cell(mode, b);
        const y = applyAll(c, x);
        if (y === undefined) continue;
        let next: number;
        if (c.kind === 'stay') {
          if (c.pump === undefined) continue;
          const q = c.pump === 'vent' ? 0 : p + c.pump;
          if (q > this.max) continue;
          next = (m * MOD + y) * levels + Math.min(q, levels - 1);
        } else if (c.kind === 'move' && c.to) {
          const guards = consistentGuards(c);
          const to = this.modes.indexOf(c.to);
          if (to < 0 || guards.length === 0 || !guards.every((g) => guardOk(g, x))) continue;
          next = (to * MOD + y) * levels + p;
        } else {
          continue;
        }
        if ((dist[next] as number) >= 0) continue;
        dist[next] = (dist[i] as number) + 1;
        prev[next] = i;
        via[next] = bi;
        queue.push(next);
      }
    }
    return { levels, prev, via, dist };
  }
}

/** 一个键对屏幕的作用：泄压键不改屏幕；其余按样本拟合，样本还分不清就是 undefined */
function opOf(c: Cell): Op | undefined {
  const ops = opsOf(c);
  return ops.length === 1 ? ops[0] : undefined;
}

/** 和样本对得上的所有作用 */
function opsOf(c: Cell): Op[] {
  if (c.pump === 'vent') return [{ kind: 'noop' }];
  const first = c.samples[0];
  if (!first) return [];
  const candidates: Op[] = [];
  if (c.samples.every(([x, y]) => x === y)) candidates.push({ kind: 'noop' });
  if (c.samples.every(([, y]) => y === first[1])) candidates.push({ kind: 'set', k: first[1] });
  const k = (((first[1] - first[0]) % MOD) + MOD) % MOD;
  if (k !== 0 && c.samples.every(([x, y]) => (x + k) % MOD === y)) candidates.push({ kind: 'add', k });
  for (let m = 2; m <= 9; m++) {
    if (c.samples.every(([x, y]) => (x * m) % MOD === y)) candidates.push({ kind: 'mul', k: m });
  }
  return candidates;
}

/** 在屏幕 x 上按这个键：所有可能的作用结果一样才算数（比如「置为 240」和「加 240」在 000 上一样） */
function applyAll(c: Cell, x: number): number | undefined {
  const ys = new Set(opsOf(c).map((op) => applyOp(op, x)));
  return ys.size === 1 ? (ys.values().next().value as number) : undefined;
}

function applyOp(op: Op, x: number): number {
  switch (op.kind) {
    case 'add':
      return (x + op.k) % MOD;
    case 'mul':
      return (x * op.k) % MOD;
    case 'set':
      return op.k;
    case 'noop':
      return x;
  }
}

function guardOk(g: Guard, x: number): boolean {
  switch (g) {
    case 'none':
      return true;
    case 'even':
      return x % 2 === 0;
    case 'odd':
      return x % 2 === 1;
    case 'lt500':
      return x < 500;
    case 'ge500':
      return x >= 500;
    case 'mod3':
      return x % 3 === 0;
    case 'mod5':
      return x % 5 === 0;
  }
}

/** 在屏幕 x 上试一次能把联锁候选分成两拨的话，小的那拨有几个 */
function splitScore(guards: readonly Guard[], x: number): number {
  const pass = guards.filter((g) => guardOk(g, x)).length;
  return Math.min(pass, guards.length - pass);
}

function consistentGuards(c: Cell): Guard[] {
  return GUARDS.filter((g) => c.passedAt.every((x) => guardOk(g, x)) && c.lockedAt.every((x) => !guardOk(g, x)));
}

function pad3(x: number): string {
  return String(x).padStart(3, '0');
}
