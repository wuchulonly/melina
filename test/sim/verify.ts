// 验证一个世界（plan 「做完的标准」）：标准解过检查；没动过的 workspace 不过；
// 中等和难的，直接的做法也不过（证明藏起来的部分是真要摸清的）。环境挂在进程内的 SimServer 上，用虚拟时钟，不真等。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualClock } from './kit/clock.ts';
import type { SimServer } from './server.ts';
import type { CheckResult, Difficulty, SimTask, SimWorld, SolveContext } from './task.ts';

export interface AttemptReport extends CheckResult {
  error?: string; // 解题过程本身抛的错
  requests: number;
  ms: number;
}

export interface WorldReport {
  task: string;
  seed: string;
  generateMs: number;
  reference: AttemptReport;
  naive: AttemptReport;
  untouched: CheckResult;
  /** 这个世界合不合格（qualified）：标准解过、没动过的不过、（中等和难）直接的做法交了东西也不过，两份解都没出错 */
  ok: boolean;
}

export async function verifyWorld(task: SimTask, seed: string, server: SimServer): Promise<WorldReport> {
  const t0 = Date.now();
  const world = task.create(seed);
  const generateMs = Date.now() - t0;
  const reference = await attempt(world, server, (ctx) => task.solve(ctx));
  const naive = await attempt(world, server, (ctx) => task.naive(ctx));
  const empty = mkdtempSync(join(tmpdir(), 'melina-sim-untouched-'));
  try {
    for (const [name, content] of Object.entries(world.starter())) writeFileSync(join(empty, name), content);
    const untouched = world.check(empty);
    const ok = qualified(task.difficulty, reference, naive, untouched);
    return { task: task.id, seed, generateMs, reference, naive, untouched, ok };
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

/**
 * 这个世界合不合格，也就是这几份对照能不能证明检查判得准：标准解过、没动过的不过；中等和难的，直接的做法也不过。
 *  加了三条：标准解、直接的做法自己没出错（解题的代码坏了，「过」「不过」都说明不了检查），
 * 直接的做法交了东西（它判不过的原因和没动过的不一样：什么都没交的「不过」证明不了藏起来的部分真要摸清）
 */
export function qualified(
  difficulty: Difficulty,
  reference: CheckResult & { error?: string },
  naive: CheckResult & { error?: string },
  untouched: CheckResult,
): boolean {
  if (!reference.pass || reference.error !== undefined || untouched.pass) return false;
  if (difficulty === 'easy') return true;
  return !naive.pass && naive.error === undefined && naive.summary !== untouched.summary;
}

async function attempt(
  world: SimWorld,
  server: SimServer,
  run: (ctx: SolveContext) => Promise<void>,
): Promise<AttemptReport> {
  const clock = new VirtualClock();
  const env = server.mount(world.handler(clock));
  const dir = mkdtempSync(join(tmpdir(), 'melina-sim-solve-'));
  const t0 = Date.now();
  let error: string | undefined;
  try {
    for (const [name, content] of Object.entries(world.starter())) writeFileSync(join(dir, name), content);
    const materials = Object.fromEntries(world.materials(env.url).map((m) => [m.name, m.content]));
    await run({ url: env.url, dir, statement: world.statement(env.url), materials, sleep: (ms) => clock.sleep(ms) });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    const result = world.check(dir);
    const report: AttemptReport = { ...result, requests: env.stats.requests, ms: Date.now() - t0 };
    if (error !== undefined) report.error = error;
    return report;
  } finally {
    server.unmount(env.token);
    rmSync(dir, { recursive: true, force: true });
  }
}
