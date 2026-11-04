import { watchEnabled } from '../core/config.ts';
import type { Id } from '../core/ids.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import type { Bet, Run } from '../core/types.ts';

/** 初始副本用于启动补齐和观察配置编号；摘要接力由 continuation 独立标记。 */
export function initialBet0Bets(bets: readonly Bet[]): Bet[] {
  return bets.filter((bet) => !bet.continuation).sort((a, b) => a.seq - b.seq);
}

/** 同模型副本按创建顺序识别，重启后仍使用相同的观察配置。 */
export function bet0WatchEnabled(queries: Pick<RunStoreQueries, 'listBets'>, run: Run, betId: Id): boolean {
  if (!watchEnabled(run.config)) return false;
  const bets = queries.listBets(run.id);
  if (bets.some((bet) => bet.id === betId && bet.continuation)) return run.config.watch?.continuationEnabled ?? true;
  const index = initialBet0Bets(bets).findIndex((bet) => bet.id === betId);
  return index >= 0 && !run.config.watch?.disabledBet0Copies?.includes(index + 1);
}
