// 挑版、巡检与工具输出共用的目标简述和资源限制说明。
// 纯函数：同样的记录写出逐字节相同的文字。

import type { Contention, ExecContention, Goal } from '../core/types.ts';
import { formatNumber } from './render.ts';

export function contentionShown(c: Contention, opts: { reading: boolean }): Contention | undefined {
  const out: Contention = { scope: c.scope };
  if (c.pidsMax) out.pidsMax = c.pidsMax;
  if (c.oomKills) out.oomKills = c.oomKills;
  if (opts.reading && c.scope === 'container' && c.cpuWait !== undefined) out.cpuWait = c.cpuWait;
  if (out.pidsMax === undefined && out.oomKills === undefined && out.cpuWait === undefined) return undefined;
  return c.alongside && c.alongside.length > 0 ? { ...out, alongside: c.alongside } : out;
}

/**
 * 撞到的资源上限怎么说：谁的上限（这个容器自己的，还是几条路线和本机别的进程共用的这台机器）、撞了什么。
 * 只说 runtime 量到的，不说结论受没受影响。
 */
export function contentionText(c: Pick<ExecContention, 'scope' | 'pidsMax' | 'oomKills' | 'cpuWait'>): string {
  const parts: string[] = [];
  if (c.pidsMax) parts.push(`进程数撞到上限 ${c.pidsMax} 次（起进程、起线程失败）`);
  if (c.oomKills) parts.push(`${c.oomKills} 个进程因为内存超限被杀`);
  if (c.cpuWait !== undefined) parts.push(`${Math.round(c.cpuWait * 100)}% 的时间有进程在等 CPU`);
  return `${c.scope === 'host' ? '这台机器（几条路线和本机别的进程共用）' : '这个容器'}：${parts.join('，')}`;
}

/**
 * 「；同时在跑命令的还有「A」「B」」：上限是几条路线共用的（整台机器，或者等 CPU）才列，容器自己的进程数、内存上限和别的路线无关。
 * 最多列四条，多的写条数
 */
export function alongsideText(c: Contention, labels: readonly string[]): string {
  if (labels.length === 0 || (c.scope !== 'host' && c.cpuWait === undefined)) return '';
  const shown = labels.slice(0, 4).map((l) => `「${l}」`);
  const more = labels.length > 4 ? ` 等 ${labels.length} 条路线` : '';
  return `；同时在跑命令的还有${shown.join('、')}${more}`;
}

/**
 * 目标简述：目标、对目标的理解、完成标准、主指标、约束、共用的外部系统。
 * 同一个 Run 里逐字节相同（开跑后只读），放进 system，命中缓存。
 */
export function goalBrief(goal: Goal): string {
  const lines = ['# 目标', '', goal.statement];
  const completion = goal.completion;
  if (completion) {
    lines.push('', `对目标的理解：${completion.interpretation}`, '', '完成标准：');
    completion.criteria.forEach((c, i) => {
      lines.push(`${i + 1}. ${c}`);
    });
    const m = completion.metric;
    if (m) {
      const better = m.better === 'lower' ? '越小越好' : '越大越好';
      const unit = m.unit ? `，单位 ${m.unit}` : '';
      lines.push('', `主指标：${m.name}${unit}，${better}，目标 ${formatNumber(m.target)}。`);
    }
  }
  if (goal.constraints.length > 0) {
    lines.push('', '约束（不许做的事）：');
    for (const c of goal.constraints) lines.push(`- ${c}`);
  }
  if (goal.sharedSystems && goal.sharedSystems.length > 0) {
    lines.push(
      '',
      `共用的外部系统：${goal.sharedSystems.join('、')}。没法复制，几条路线改的是同一个系统，会互相影响，snapshot 也恢复不了它们。`,
    );
  }
  return lines.join('\n');
}
