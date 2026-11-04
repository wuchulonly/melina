// 保守的宿主信号：只报告相同执行条件和摘要的连续重复，不替模型判定方向失败。
import type { Id } from '../core/ids.ts';
import { countsAsToolCall } from '../core/tools.ts';
import type { Observation } from '../core/types.ts';

export interface WatchRepeatSignal {
  observations: readonly Observation[];
}

/** 冻结窗口内的本分支记录；读写、条件改变和 episode 切换都会打断连续重复。 */
export function watchRepeatSignals(
  observations: readonly Observation[],
  branchId: Id,
  sinceSeq: number,
  untilSeq: number,
): WatchRepeatSignal[] {
  const signals: WatchRepeatSignal[] = [];
  let group: Observation[] = [];
  let key: string | undefined;
  const flush = () => {
    if (group.length >= 3 && group.some((o) => o.seq > sinceSeq)) signals.push({ observations: group });
  };
  const own = observations
    .filter((o) => o.branchId === branchId && o.role === 'explorer' && o.seq <= untilSeq && countsAsToolCall(o))
    .sort((a, b) => a.seq - b.seq);
  for (const o of own) {
    const args = o.args as { cmd?: unknown; background?: unknown } | null;
    const next =
      o.tool === 'sh' && typeof args?.cmd === 'string' && args.background !== true
        ? JSON.stringify([o.episode, o.snapshot, o.args, o.expect, o.summary, o.exitCode, o.error, o.contention])
        : undefined;
    if (next === undefined || next !== key) {
      flush();
      group = [];
    }
    key = next;
    if (next !== undefined) group.push(o);
  }
  flush();
  return signals.slice(-3);
}
