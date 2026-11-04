import type { RunStoreQueries } from '../core/interfaces/store.ts';
import type { Run } from '../core/types.ts';
export function minuteOf(run: Run, at: number): string {
  return Math.max(0, (at - Date.parse(run.createdAt)) / 60000).toFixed(1);
}
export function momentOf(q: RunStoreQueries, seq: number): number | undefined {
  const event = q.events({ since: Math.max(0, seq - 1), limit: 1 }).find((e) => e.seq === seq);
  return event ? Date.parse(event.at) : undefined;
}
