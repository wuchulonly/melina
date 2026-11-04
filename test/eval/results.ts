// 试验结果的存档：results.jsonl 一行一次试验，跑一半停了下次接着跑（已经有结果的跳过）。

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { TrialResult } from './trial.ts';

export function trialKey(r: Pick<TrialResult, 'task' | 'contender' | 'rep'>): string {
  return `${r.task}|${r.contender}|${r.rep}`;
}

export function readResults(path: string): TrialResult[] {
  if (!existsSync(path)) return [];
  const out: TrialResult[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as TrialResult);
    } catch {
      // 上次写到一半被打断的那行，丢掉
    }
  }
  return out;
}

export function appendResult(path: string, result: TrialResult): void {
  appendFileSync(path, `${JSON.stringify(result)}\n`);
}

/** 同一次试验有几行时取最后一行（重跑过的） */
export function latest(results: readonly TrialResult[]): TrialResult[] {
  const byKey = new Map<string, TrialResult>();
  for (const r of results) byKey.set(trialKey(r), r);
  return [...byKey.values()];
}

/** 一个世界：任务和第几次（各个被测方同一次用同一个世界） */
export function worldKey(r: Pick<TrialResult, 'task' | 'rep'>): string {
  return `${r.task}|${r.rep}`;
}

/**
 * 几方都跑完了的世界：每方最后一次的结果都在、
 * 都不是跑分这边出错的、是同一批跑的。整组重跑到一半被打断时，先跑完的几方是新一批、别的还是旧一批，
 * 这样的组也要整组重跑，不然会拿不同时段的两次配成一对。 之前的结果没有批次，彼此算同一批
 */
export function completeWorlds(results: readonly TrialResult[], contenders: readonly string[]): Set<string> {
  const byKey = new Map(latest(results).map((r) => [trialKey(r), r] as const));
  const out = new Set<string>();
  for (const r of results) {
    const group = contenders.map((contender) => byKey.get(trialKey({ task: r.task, contender, rep: r.rep })));
    const ran = group.every((g) => g !== undefined && g.status !== 'error');
    if (ran && new Set(group.map((g) => g?.batch)).size === 1) out.add(worldKey(r));
  }
  return out;
}

/** 两次结果是不是同一批跑的（同一时刻开跑）： 之前的结果没有批次，两边都没有时算 */
export function sameBatch(a: Pick<TrialResult, 'batch'>, b: Pick<TrialResult, 'batch'>): boolean {
  return a.batch === b.batch;
}
