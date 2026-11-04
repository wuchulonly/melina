// UsageLedger：每次模型调用和工具调用记一行账。
// 账本只用于观测和评估（前端的用量、 的 A/B），不参与任何决策，模型也看不到花了多少。
// 写库和推送都按秒合并：一秒内的账一次写进 usage_ledger，每个 Run 每秒最多发一条 usage.updated。
// 进程崩溃时最多丢最后一秒的账，账本只是观测，丢一点不影响 Run。

import type { UsageTotals } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { ModelUsageEntry, ToolUsageEntry, UsageLedger } from '../core/interfaces/ledger.ts';
import type { RunStoreQueries, RunStoreWriter } from '../core/interfaces/store.ts';
import type { TokenUsage, UsageRow } from '../core/types.ts';

/**
 * 输入 token 的缓存命中率：
 * cacheRead / (input + cacheRead + cacheWrite)。DeepSeek Messages 的 input、cacheRead、cacheWrite 是互斥的用量分项。一个输入 token 都没有时是 undefined。
 * 账本的行（usage_ledger，按角色、分支记）按要看的口径加起来再算，比如只看 Explorer 的；test/dev/usage.ts 按 Run 和角色打出来。
 */
export function cacheHitRate(t: Pick<TokenUsage, 'input' | 'cacheRead' | 'cacheWrite'>): number | undefined {
  const total = t.input + t.cacheRead + t.cacheWrite;
  return total > 0 ? t.cacheRead / total : undefined;
}

export interface LedgerDeps {
  writer: Pick<RunStoreWriter, 'appendUsage' | 'emitUsage'>;
  queries: Pick<RunStoreQueries, 'usageTotals'>;
  /** 合并窗口，默认 1000 毫秒 */
  intervalMs?: number;
  now?: () => number;
  /** 写库或推送出错（比如 Run 刚被删掉）：记日志，不往外抛 */
  onError?: (error: unknown) => void;
}

export interface MelinaUsageLedger extends UsageLedger {
  /** 进程退出前：把攒着的写掉，停掉计时器 */
  close(): void;
}

interface RunUsage {
  total: UsageTotals;
  delta: UsageTotals;
}

export function createUsageLedger(deps: LedgerDeps): MelinaUsageLedger {
  const intervalMs = deps.intervalMs ?? 1000;
  const now = deps.now ?? Date.now;
  const rows: UsageRow[] = [];
  const runs = new Map<Id, RunUsage>();
  const dirty = new Set<Id>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const usageOf = (runId: Id): RunUsage => {
    let u = runs.get(runId);
    if (!u) {
      // 第一次碰到这个 Run：总数从库里已有的账起算（进程重启后接着累计）
      let base: UsageTotals = zero();
      try {
        base = { ...deps.queries.usageTotals(runId) };
      } catch (error) {
        deps.onError?.(error);
      }
      u = { total: base, delta: zero() };
      runs.set(runId, u);
    }
    return u;
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(flush, intervalMs);
    timer.unref?.();
  };

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (rows.length > 0) {
      const batch = rows.splice(0);
      try {
        deps.writer.appendUsage(batch);
      } catch (error) {
        deps.onError?.(error);
      }
    }
    for (const runId of [...dirty]) {
      dirty.delete(runId);
      const u = runs.get(runId);
      if (!u) continue;
      const delta = u.delta;
      u.delta = zero();
      try {
        deps.writer.emitUsage(runId, { delta, total: { ...u.total } });
      } catch (error) {
        deps.onError?.(error);
      }
    }
  }

  return {
    model(entry: ModelUsageEntry) {
      const tokens = {
        input: whole(entry.tokens.input),
        cacheRead: whole(entry.tokens.cacheRead),
        cacheWrite: whole(entry.tokens.cacheWrite),
        output: whole(entry.tokens.output),
      };
      const usd = Number.isFinite(entry.usd) && entry.usd > 0 ? entry.usd : 0;
      rows.push({
        runId: entry.runId,
        ...(entry.branchId !== undefined ? { branchId: entry.branchId } : {}),
        role: entry.role,
        kind: 'model',
        at: new Date(now()).toISOString(),
        ms: whole(entry.ms),
        provider: entry.provider,
        model: entry.model,
        tokens,
        usd,
      });
      const u = usageOf(entry.runId);
      for (const target of [u.total, u.delta]) {
        target.input += tokens.input;
        target.cacheRead += tokens.cacheRead;
        target.cacheWrite += tokens.cacheWrite;
        target.output += tokens.output;
        target.usd += usd;
      }
      if (tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output > 0 || usd > 0) dirty.add(entry.runId);
      schedule();
    },

    tool(entry: ToolUsageEntry) {
      rows.push({
        runId: entry.runId,
        ...(entry.branchId !== undefined ? { branchId: entry.branchId } : {}),
        role: entry.role,
        kind: 'tool',
        at: new Date(now()).toISOString(),
        ms: whole(entry.ms),
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        usd: 0,
        tool: entry.tool,
        ...(entry.exitCode !== undefined ? { exitCode: Math.trunc(entry.exitCode) } : {}),
        ...(entry.bytes !== undefined ? { bytes: whole(entry.bytes) } : {}),
        ...(entry.handle !== undefined ? { handle: entry.handle } : {}),
      });
      schedule();
    },

    totals(runId) {
      return { ...usageOf(runId).total };
    },

    flush,

    close() {
      flush();
    },
  };
}

function zero(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 };
}

function whole(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
