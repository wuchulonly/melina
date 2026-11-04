// UsageLedger：每次调用记一行账；写库和 usage.updated 按秒合并；总数从库里已有的账起算。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageTotals, UsageUpdated } from '../../../src/core/events.ts';
import { ZERO_USAGE } from '../../../src/core/events.ts';
import type { UsageRow } from '../../../src/core/types.ts';
import { UsageRow as UsageRowSchema } from '../../../src/core/types.ts';
import { isValid } from '../../../src/core/validate.ts';
import { createUsageLedger } from '../../../src/runtime/ledger.ts';

const R1 = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const R2 = '01JCCCCCCCCCCCCCCCCCCCCCCC';
const BR = '01JBBBBBBBBBBBBBBBBBBBBBBB';
function fakeRunStore(base: Record<string, UsageTotals> = {}) {
  const appended: UsageRow[][] = [];
  const emitted: {
    runId: string;
    usage: UsageUpdated;
  }[] = [];
  return {
    appended,
    emitted,
    writer: {
      appendUsage: (rows: UsageRow[]) => {
        appended.push(rows);
      },
      emitUsage: (runId: string, usage: UsageUpdated) => {
        emitted.push({ runId, usage });
        return emitted.length;
      },
    },
    queries: { usageTotals: (runId: string) => base[runId] ?? { ...ZERO_USAGE } },
  };
}
const modelEntry = (runId: string, input: number, usd = 0.01) => ({
  runId,
  branchId: BR,
  role: 'explorer' as const,
  provider: 'deepseek',
  model: 'deepseek-flash',
  tokens: { input, cacheRead: 100, cacheWrite: 0, output: 10 },
  usd,
  ms: 1234.6,
});
describe('UsageLedger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T08:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  it('一秒内的账一次写库；每个 Run 每秒最多一条 usage.updated，带这一秒的增量和总数', () => {
    const runStore = fakeRunStore();
    const ledger = createUsageLedger(runStore);
    ledger.model(modelEntry(R1, 1000));
    ledger.model(modelEntry(R1, 500));
    ledger.model(modelEntry(R2, 7));
    expect(runStore.appended).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(runStore.appended).toHaveLength(1);
    expect(runStore.appended[0]).toHaveLength(3);
    expect(runStore.emitted).toEqual([
      {
        runId: R1,
        usage: {
          delta: { input: 1500, cacheRead: 200, cacheWrite: 0, output: 20, usd: 0.02 },
          total: { input: 1500, cacheRead: 200, cacheWrite: 0, output: 20, usd: 0.02 },
        },
      },
      {
        runId: R2,
        usage: {
          delta: { input: 7, cacheRead: 100, cacheWrite: 0, output: 10, usd: 0.01 },
          total: { input: 7, cacheRead: 100, cacheWrite: 0, output: 10, usd: 0.01 },
        },
      },
    ]);
    ledger.model(modelEntry(R1, 1));
    vi.advanceTimersByTime(1000);
    expect(runStore.emitted.at(-1)).toEqual({
      runId: R1,
      usage: {
        delta: { input: 1, cacheRead: 100, cacheWrite: 0, output: 10, usd: 0.01 },
        total: { input: 1501, cacheRead: 300, cacheWrite: 0, output: 30, usd: 0.03 },
      },
    });
  });
  it('每一行符合 usage_ledger 的格式', () => {
    const runStore = fakeRunStore();
    const ledger = createUsageLedger(runStore);
    ledger.model(modelEntry(R1, 1000));
    ledger.tool({
      runId: R1,
      branchId: BR,
      role: 'explorer',
      tool: 'npm',
      exitCode: 1,
      bytes: 2048,
      handle: `art://${'a'.repeat(64)}`,
      ms: 50,
    });
    ledger.flush();
    const rows = runStore.appended[0] ?? [];
    for (const row of rows) expect(isValid(UsageRowSchema, row), JSON.stringify(row)).toBe(true);
    expect(rows[0]).toMatchObject({ kind: 'model', at: '2026-10-02T08:00:00.000Z', ms: 1235, provider: 'deepseek' });
    expect(rows[1]).toMatchObject({ kind: 'tool', tool: 'npm', exitCode: 1, usd: 0 });
  });
  it('工具调用只记账，不发 usage.updated（token 和费用没变）', () => {
    const runStore = fakeRunStore();
    const ledger = createUsageLedger(runStore);
    ledger.tool({ runId: R1, role: 'explorer', tool: 'ls', ms: 3 });
    vi.advanceTimersByTime(1000);
    expect(runStore.appended[0]).toHaveLength(1);
    expect(runStore.emitted).toEqual([]);
  });
  it('总数从库里已有的账起算（进程重启后接着累计）', () => {
    const runStore = fakeRunStore({ [R1]: { input: 10000, cacheRead: 0, cacheWrite: 0, output: 500, usd: 1.5 } });
    const ledger = createUsageLedger(runStore);
    expect(ledger.totals(R1)).toEqual({ input: 10000, cacheRead: 0, cacheWrite: 0, output: 500, usd: 1.5 });
    ledger.model(modelEntry(R1, 1000));
    expect(ledger.totals(R1)).toEqual({ input: 11000, cacheRead: 100, cacheWrite: 0, output: 510, usd: 1.51 });
    ledger.flush();
    expect(runStore.emitted[0]?.usage.total.input).toBe(11000);
  });
  it('flush、close 立即写；写库或推送出错不往外抛', () => {
    const errors: unknown[] = [];
    const ledger = createUsageLedger({
      writer: {
        appendUsage: () => {
          throw new Error('disk full');
        },
        emitUsage: () => {
          throw new Error('run deleted');
        },
      },
      queries: { usageTotals: () => ({ ...ZERO_USAGE }) },
      onError: (e) => errors.push(e),
    });
    ledger.model(modelEntry(R1, 1));
    expect(() => ledger.close()).not.toThrow();
    expect(errors.map((e) => (e as Error).message)).toEqual(['disk full', 'run deleted']);
    vi.advanceTimersByTime(5000);
    expect(errors).toHaveLength(2);
  });
  it('负数、小数、NaN 归整', () => {
    const runStore = fakeRunStore();
    const ledger = createUsageLedger(runStore);
    ledger.model({
      ...modelEntry(R1, -5, Number.NaN),
      tokens: { input: -5, cacheRead: 1.6, cacheWrite: Number.NaN, output: 2 },
    });
    ledger.flush();
    expect(runStore.appended[0]?.[0]).toMatchObject({
      tokens: { input: 0, cacheRead: 2, cacheWrite: 0, output: 2 },
      usd: 0,
    });
  });
});
