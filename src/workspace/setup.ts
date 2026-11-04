// workspace.setup：snapshot 不含被忽略的文件（依赖、构建产物），所以每次建 workspace 后都跑一遍。
//
// 失败不算 create 失败：workspace 照样交出去，结果记在 WorkspaceRef.setup 上，
// runtime 往分支收件箱放一条提示，由 Explorer 自己修环境（AI first）。没配执行器（测试、还没有容器）就记成没跑。
// 取消了（kill、暂停、取消任务、退出 Melina，create 的 signal）就停下正在跑的 setup，记成没跑完（skipped 写原因）。

import type { ExecResult } from '../core/interfaces/workspace.ts';
import type { SetupResult } from '../core/types.ts';

export const SETUP_TIMEOUT_MS = 20 * 60_000;
const TAIL_CHARS = 4000;

/** 契约里的 SetupResult（core/types.ts）：skipped 是没跑或没跑完的原因 */
export type SetupOutcome = SetupResult;

/** 取消时的 skipped：这条路线被叫停、暂停，或者任务取消、Melina 退出了 */
export const SETUP_CANCELLED = '取消了，setup 没跑完';

export function setupOutcome(cmd: string, r: ExecResult): SetupOutcome {
  const all = [r.stdout, r.stderr].filter((s) => s.length > 0).join('\n');
  return {
    cmd,
    ok: r.exitCode === 0 && !r.timedOut && !r.cancelled,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    tail: all.length > TAIL_CHARS ? `……\n${all.slice(-TAIL_CHARS)}` : all,
  };
}

export function setupSkipped(cmd: string, why: string): SetupOutcome {
  return { cmd, ok: false, exitCode: null, timedOut: false, durationMs: 0, tail: '', skipped: why };
}

export function setupError(cmd: string, e: unknown): SetupOutcome {
  const message = e instanceof Error ? e.message : String(e);
  return { cmd, ok: false, exitCode: null, timedOut: false, durationMs: 0, tail: message };
}

/** 跑到一半被取消：输出留着，记成没跑完（runtime 不往收件箱放「setup 失败」的提示） */
export function setupCancelled(outcome: SetupOutcome): SetupOutcome {
  return { ...outcome, ok: false, skipped: SETUP_CANCELLED };
}
