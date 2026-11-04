// 第一类：隐藏规则的状态机。一台按键控制器，几个状态排成一条线（STANDBY → … → RUN）。
// 每个键在每个状态下作用不同：对屏幕加、乘、置数或没反应，或者换到下一个状态、退回开机状态；
// 换状态时可能顺带改屏幕，可能有联锁（屏幕不满足条件就锁死）；难的还有看不见的压力：有的键按一次加一格，
// 超过上限就锁死，泄压键归零。
//
// 规则全由种子生成。目标用 BFS 选：保证能到，最短步数在难度规定的范围里；要求踩坑的，
// 忽略联锁和压力算出的最短步数比真实的短（照着「看起来最快」的走一定锁死或到不了），
// 而且「先在开机状态把屏幕调好再一路换状态」这种直接的做法到不了。

import { Rng } from '../kit/rng.ts';

export const DISPLAY_MOD = 1000;

export type Op =
  | { kind: 'add'; k: number }
  | { kind: 'mul'; k: number }
  | { kind: 'set'; k: number }
  | { kind: 'noop' };

export const GUARDS = ['even', 'odd', 'lt500', 'ge500', 'mod3', 'mod5'] as const;
export type Guard = (typeof GUARDS)[number];

export interface Cell {
  to: number; // 按完以后的状态；等于当前状态就是没换
  op: Op; // 对屏幕的作用；换状态时是进入新状态时对屏幕的作用
  guard?: Guard; // 换状态的联锁：按下时屏幕不满足就锁死
  pump: 0 | 1 | 'vent'; // 压力 +1，或泄压（归零）
}

export interface TransitionSpec {
  entry: boolean; // 进入下一个状态时改屏幕
  guard: boolean; // 有联锁
}

export interface MachineParams {
  buttons: number;
  modes: readonly string[]; // 从开机状态到 RUN，最后一个是 RUN
  transitions: readonly TransitionSpec[]; // 每次往下一个状态走的规则，长度 = modes.length - 1
  back: boolean; // 中间状态有一个退回开机状态的键
  ops: 'add' | 'mixed'; // add：只有加法；mixed：加、乘、置数、没反应
  pressure?: { max: number; visible: boolean }; // visible：面板上有压力灯
  depth: readonly [number, number]; // 最短解的步数范围（含最后换到 RUN 那一下）
  trap: boolean; // 要求忽略联锁和压力的最短解比真实的短
  bootMs: number; // 开一次机要多久；同时开的排队。挡住靠穷举会话的做法
  maxPresses: number; // 一个会话最多按几次
}

export interface MachineWorld {
  params: MachineParams;
  buttons: string[];
  modes: string[];
  table: Cell[][]; // [状态][键]；RUN 那一行全是没反应
  vent?: number; // 泄压键
  target: number;
  shortest: number[]; // 一条最短解
  relaxedDepth: number; // 忽略联锁和压力时的最短步数
}

export interface MachineState {
  mode: number;
  x: number;
  p: number;
  locked: boolean;
}

export const START: MachineState = { mode: 0, x: 0, p: 0, locked: false };

export function applyOp(op: Op, x: number): number {
  switch (op.kind) {
    case 'add':
      return (x + op.k) % DISPLAY_MOD;
    case 'mul':
      return (x * op.k) % DISPLAY_MOD;
    case 'set':
      return op.k;
    case 'noop':
      return x;
  }
}

export function guardOk(guard: Guard, x: number): boolean {
  switch (guard) {
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

/** 按一下。relaxed：不管联锁和压力（选目标时算「看起来最快」的走法用） */
export function press(world: MachineWorld, s: MachineState, button: number, relaxed = false): MachineState {
  const run = world.modes.length - 1;
  if (s.locked || s.mode === run) return s;
  const cell = world.table[s.mode]?.[button];
  if (!cell) throw new Error(`没有这个键：${button}`);
  let p = s.p;
  if (!relaxed && world.params.pressure) {
    p = cell.pump === 'vent' ? 0 : p + cell.pump;
    if (p > world.params.pressure.max) return { ...s, p, locked: true };
  }
  if (!relaxed && cell.to !== s.mode && cell.guard && !guardOk(cell.guard, s.x)) return { ...s, locked: true };
  return { mode: cell.to, x: applyOp(cell.op, s.x), p, locked: false };
}

export function replay(world: MachineWorld, buttons: readonly number[], relaxed = false): MachineState {
  let s = START;
  for (const b of buttons) s = press(world, s, b, relaxed);
  return s;
}

interface Search {
  dist: Int32Array;
  prev: Int32Array; // 上一个状态的下标
  via: Int8Array; // 从上一个状态按的哪个键
  pressureLevels: number;
}

function stateIndex(s: MachineState, levels: number): number {
  return (s.mode * DISPLAY_MOD + s.x) * levels + s.p;
}

/** 从开机状态出发的 BFS：每个（状态、屏幕、压力）最少按几下能到 */
function search(world: MachineWorld, relaxed: boolean): Search {
  const levels = !relaxed && world.params.pressure ? world.params.pressure.max + 1 : 1;
  const size = world.modes.length * DISPLAY_MOD * levels;
  const dist = new Int32Array(size).fill(-1);
  const prev = new Int32Array(size).fill(-1);
  const via = new Int8Array(size).fill(-1);
  const queue: MachineState[] = [START];
  dist[stateIndex(START, levels)] = 0;
  for (let head = 0; head < queue.length; head++) {
    const s = queue[head] as MachineState;
    const si = stateIndex(s, levels);
    for (let b = 0; b < world.buttons.length; b++) {
      const t = press(world, s, b, relaxed);
      if (t.locked) continue;
      const ti = stateIndex(t, levels);
      if (dist[ti] !== -1) continue;
      dist[ti] = (dist[si] as number) + 1;
      prev[ti] = si;
      via[ti] = b;
      queue.push(t);
    }
  }
  return { dist, prev, via, pressureLevels: levels };
}

/** 到 (RUN, x) 的最短步数，到不了是 -1 */
function runDistances(world: MachineWorld, s: Search): Int32Array {
  const run = world.modes.length - 1;
  const out = new Int32Array(DISPLAY_MOD).fill(-1);
  for (let x = 0; x < DISPLAY_MOD; x++) {
    for (let p = 0; p < s.pressureLevels; p++) {
      const d = s.dist[(run * DISPLAY_MOD + x) * s.pressureLevels + p] as number;
      if (d >= 0 && (out[x] === -1 || d < (out[x] as number))) out[x] = d;
    }
  }
  return out;
}

function pathTo(world: MachineWorld, s: Search, x: number): number[] | undefined {
  const run = world.modes.length - 1;
  let best = -1;
  for (let p = 0; p < s.pressureLevels; p++) {
    const i = (run * DISPLAY_MOD + x) * s.pressureLevels + p;
    const d = s.dist[i] as number;
    if (d >= 0 && (best === -1 || d < (s.dist[best] as number))) best = i;
  }
  if (best === -1) return undefined;
  const path: number[] = [];
  for (let i = best; (s.prev[i] as number) !== -1; i = s.prev[i] as number) path.push(s.via[i] as number);
  return path.reverse();
}

/** 最短解（按键下标）；到不了是 undefined */
export function shortestPath(world: MachineWorld, target: number): number[] | undefined {
  return pathTo(world, search(world, false), target);
}

const LETTERS = 'ABCDEFGH';

export function generateMachine(params: MachineParams, seed: string): MachineWorld {
  if (params.transitions.length !== params.modes.length - 1) throw new Error('transitions 的长度要等于状态数减一');
  if (params.buttons > LETTERS.length) throw new Error(`最多 ${LETTERS.length} 个键`);
  const root = new Rng(`machine/${seed}`);
  for (let attempt = 0; attempt < 500; attempt++) {
    const world = tryGenerate(params, root.fork(attempt));
    if (world) return world;
  }
  throw new Error(`种子 ${seed} 生成不出合格的控制器，难度参数可能太苛刻`);
}

function tryGenerate(params: MachineParams, rng: Rng): MachineWorld | undefined {
  const nButtons = params.buttons;
  const run = params.modes.length - 1;
  const buttons = LETTERS.slice(0, nButtons).split('');
  const vent = params.pressure ? rng.int(0, nButtons - 1) : undefined;
  const table: Cell[][] = [];
  for (let m = 0; m < run; m++) {
    const free = rng.shuffle([...Array(nButtons).keys()].filter((b) => b !== vent));
    const row: Cell[] = new Array(nButtons);
    const spec = params.transitions[m] as TransitionSpec;
    const advance: Cell = { to: m + 1, op: spec.entry ? entryOp(rng) : { kind: 'noop' }, pump: 0 };
    if (spec.guard) advance.guard = rng.pick(GUARDS);
    row[free[0] as number] = advance;
    let next = 1;
    if (params.back && m > 0) row[free[next++] as number] = { to: 0, op: { kind: 'noop' }, pump: 0 };
    for (; next < free.length; next++) {
      const pump = params.pressure && rng.chance(0.5) ? 1 : 0;
      row[free[next] as number] = { to: m, op: params.ops === 'add' ? addOp(rng) : mixedOp(rng), pump };
    }
    if (vent !== undefined) row[vent] = { to: m, op: { kind: 'noop' }, pump: 'vent' };
    table.push(row);
  }
  table.push(buttons.map(() => ({ to: run, op: { kind: 'noop' }, pump: 0 })));

  // 每个中间状态至少两个真改屏幕的键；有压力时开机状态至少一个加压的键（标准解从那儿开始摸压力）
  for (let m = 0; m < run; m++) {
    const changing = (table[m] as Cell[]).filter((c) => c.to === m && c.op.kind !== 'noop').length;
    if (changing < 2) return undefined;
  }
  if (params.pressure && !(table[0] as Cell[]).some((c) => c.pump === 1)) return undefined;
  // 有的键要两个不同的作用：只有加法时两个加数不同
  if (params.ops === 'add') {
    const ks = (table[0] as Cell[]).flatMap((c) => (c.op.kind === 'add' && c.to === 0 ? [c.op.k] : []));
    if (new Set(ks).size !== ks.length) return undefined;
  }

  const world: MachineWorld = {
    params,
    buttons,
    modes: [...params.modes],
    table,
    target: 0,
    shortest: [],
    relaxedDepth: 0,
  };
  if (vent !== undefined) world.vent = vent;

  const real = runDistances(world, search(world, false));
  const relaxed = runDistances(world, search(world, true));
  const [lo, hi] = params.depth;
  const candidates: number[] = [];
  for (let x = 0; x < DISPLAY_MOD; x++) {
    const d = real[x] as number;
    if (d < lo || d > hi) continue;
    if (params.trap && !((relaxed[x] as number) >= 0 && (relaxed[x] as number) < d)) continue;
    if (run > 1 && directWorks(world, x)) continue;
    candidates.push(x);
  }
  if (candidates.length === 0) return undefined;
  world.target = rng.pick(candidates);
  world.shortest = shortestPath(world, world.target) as number[];
  world.relaxedDepth = relaxed[world.target] as number;
  return world;
}

/** 直接的做法：只用开机状态里的键把屏幕调到目标，再一路按换状态的键。能做成就说明这台机器太简单 */
function directWorks(world: MachineWorld, target: number): boolean {
  const row0 = world.table[0] as Cell[];
  // 开机状态里只用不换状态的键，BFS 到屏幕 = target（不管压力，直接的做法不知道有压力）
  const prev = new Int32Array(DISPLAY_MOD).fill(-2);
  const via = new Int8Array(DISPLAY_MOD).fill(-1);
  prev[0] = -1;
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const x = queue[head] as number;
    row0.forEach((cell, b) => {
      if (cell.to !== 0) return;
      const y = applyOp(cell.op, x);
      if (prev[y] !== -2) return;
      prev[y] = x;
      via[y] = b;
      queue.push(y);
    });
  }
  if (prev[target] === -2) return false;
  const path: number[] = [];
  for (let x = target; (prev[x] as number) !== -1; x = prev[x] as number) path.push(via[x] as number);
  path.reverse();
  for (let m = 0; m < world.modes.length - 1; m++) {
    const b = (world.table[m] as Cell[]).findIndex((c) => c.to === m + 1);
    path.push(b);
  }
  const s = replay(world, path);
  return !s.locked && s.mode === world.modes.length - 1 && s.x === target;
}

function addOp(rng: Rng): Op {
  return { kind: 'add', k: rng.int(1, 19) };
}

function mixedOp(rng: Rng): Op {
  const kind = rng.weighted(['small', 'big', 'mul', 'set', 'noop'] as const, [30, 25, 20, 15, 10]);
  switch (kind) {
    case 'small':
      return { kind: 'add', k: rng.int(1, 9) };
    case 'big':
      return { kind: 'add', k: rng.pick([rng.int(10, 99), rng.int(901, 990)]) };
    case 'mul':
      return { kind: 'mul', k: rng.int(2, 5) };
    case 'set':
      return { kind: 'set', k: rng.int(0, 999) };
    case 'noop':
      return { kind: 'noop' };
  }
}

function entryOp(rng: Rng): Op {
  const kind = rng.weighted(['add', 'mul', 'set'] as const, [40, 40, 20]);
  if (kind === 'add') return { kind: 'add', k: rng.int(100, 900) };
  if (kind === 'mul') return { kind: 'mul', k: rng.int(2, 5) };
  return { kind: 'set', k: rng.int(0, 999) };
}

export function pad3(x: number): string {
  return String(x).padStart(3, '0');
}

/** 规则的人话版，进评估存档 */
export function describeRules(world: MachineWorld): string[] {
  const lines: string[] = [];
  const run = world.modes.length - 1;
  for (let m = 0; m < run; m++) {
    (world.table[m] as Cell[]).forEach((cell, b) => {
      const key = `${world.modes[m]} ${world.buttons[b]}`;
      const pump = cell.pump === 'vent' ? '，泄压' : cell.pump === 1 ? '，加压' : '';
      if (cell.to !== m) {
        const guard = cell.guard ? `，联锁：屏幕${cell.guard}` : '';
        lines.push(`${key}：换到 ${world.modes[cell.to]}，屏幕${opText(cell.op)}${guard}${pump}`);
      } else {
        lines.push(`${key}：屏幕${opText(cell.op)}${pump}`);
      }
    });
  }
  if (world.params.pressure) lines.push(`压力超过 ${world.params.pressure.max} 就锁死`);
  return lines;
}

function opText(op: Op): string {
  switch (op.kind) {
    case 'add':
      return op.k > 500 ? ` −${DISPLAY_MOD - op.k}` : ` +${op.k}`;
    case 'mul':
      return ` ×${op.k}`;
    case 'set':
      return ` 置为 ${pad3(op.k)}`;
    case 'noop':
      return '不变';
  }
}
