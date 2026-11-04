// 已结束任务的搜索、按结果筛、按天分组。纯函数。

import type { RunListItem } from '../../../../src/core/api.ts';
import { formatDay } from '../../lib/format.ts';

/** 结束的任务到这么多条才给搜索框和筛选（少的时候一眼看得完） */
export const SEARCH_FROM = 8;

export type RunFilter = 'all' | 'done' | 'stopped';

export const RUN_FILTERS: readonly { key: RunFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'done', label: '做完了' },
  { key: 'stopped', label: '没做完' },
];

/** 按目标、结果、目录搜（空格分开的几个词都要对得上），再按结果筛 */
export function filterRuns(runs: readonly RunListItem[], query: string, filter: RunFilter): RunListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return runs.filter((r) => {
    if (filter === 'done' && r.status !== 'done') return false;
    if (filter === 'stopped' && r.status === 'done') return false;
    if (words.length === 0) return true;
    const hay = `${r.statement}\n${r.outcome ?? ''}\n${r.workspace}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 按结束那天分组（今天、昨天、9月28日）；组的顺序和组里的顺序都照原来的（新建的在前） */
export function groupByDay(runs: readonly RunListItem[], now = Date.now()): { day: string; runs: RunListItem[] }[] {
  const groups = new Map<string, RunListItem[]>();
  for (const r of runs) {
    const day = formatDay(r.endedAt ?? r.createdAt, now);
    const list = groups.get(day);
    if (list) list.push(r);
    else groups.set(day, [r]);
  }
  return [...groups].map(([day, list]) => ({ day, runs: list }));
}
