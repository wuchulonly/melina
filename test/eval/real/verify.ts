// 验证真实任务的一个世界（同 test/sim/verify.ts 的口径）：标准解过检查；没动过的 workspace 不过；中等和难的，直接的做法也不过。
// 标准解、起点、直接的做法都是题目自带的、可信的代码，单元测试里代码题的隐藏测试用宿主机上的沙箱跑（hostSandbox）；
// 跑分时用检查交付的同一个沙箱验，
// 检查没过又分不清是谁的问题时，再拿标准解在同一个沙箱里复跑一次当对照（referenceCheck）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckResult, SolveContext } from '../../sim/task.ts';
import { qualified } from '../../sim/verify.ts';
import { type EvalTask, type EvalWorld, materialText, type Sandbox } from '../task.ts';
import { writeFiles } from '../workspace.ts';

export interface RealAttemptReport extends CheckResult {
  error?: string; // 解题过程本身抛的错
  ms: number;
}

export interface RealWorldReport {
  task: string;
  seed: string;
  generateMs: number;
  reference: RealAttemptReport;
  naive: RealAttemptReport;
  untouched: CheckResult;
  /** 合格（test/sim/verify.ts 的 qualified）：标准解过、没动过的不过、（中等和难）直接的做法交了东西也不过，两份解都没出错 */
  ok: boolean;
}

export async function verifyRealWorld(task: EvalTask, seed: string, sandbox: Sandbox): Promise<RealWorldReport> {
  const t0 = Date.now();
  const world = task.create(seed);
  const materials = Object.fromEntries(world.materials('').map((m) => [m.name, materialText(m.name, m.content)]));
  const generateMs = Date.now() - t0;
  const reference = await attempt(world, materials, sandbox, (ctx) => task.solve(ctx));
  const naive = await attempt(world, materials, sandbox, (ctx) => task.naive(ctx));
  const untouched = (await attempt(world, materials, sandbox, async () => {})) as CheckResult;
  const ok = qualified(task.difficulty, reference, naive, untouched);
  return {
    task: task.id,
    seed,
    generateMs,
    reference,
    naive,
    untouched: { pass: untouched.pass, summary: untouched.summary },
    ok,
  };
}

/** 对照：这个世界的标准解在给定的沙箱里过不过检查 */
export async function referenceCheck(task: EvalTask, seed: string, sandbox: Sandbox): Promise<RealAttemptReport> {
  const world = task.create(seed);
  const materials = Object.fromEntries(world.materials('').map((m) => [m.name, materialText(m.name, m.content)]));
  return attempt(world, materials, sandbox, (ctx) => task.solve(ctx));
}

async function attempt(
  world: EvalWorld,
  materials: Record<string, string>,
  sandbox: Sandbox,
  run: (ctx: SolveContext) => Promise<void>,
): Promise<RealAttemptReport> {
  const dir = mkdtempSync(join(tmpdir(), 'melina-real-solve-'));
  const t0 = Date.now();
  let error: string | undefined;
  try {
    writeFiles(dir, world.starter());
    try {
      await run({ url: '', dir, statement: world.statement(''), materials, sleep: async () => {} });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const result = await world.check(dir, { sandbox });
    const report: RealAttemptReport = { ...result, ms: Date.now() - t0 };
    if (error !== undefined) report.error = error;
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
