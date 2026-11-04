import { afterEach, describe, expect, it } from 'vitest';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import type { WatchRequest } from '../../../src/core/interfaces/context.ts';
import { watchFromArgs } from '../../../src/core/tools.ts';
import { WATCH_DETAIL_BYTES, WATCH_OVERVIEW_BYTES } from '../../../src/core/watch-budget.ts';
import { WATCH_INPUT } from '../../../src/core/watch-input.ts';
import { freezeWatchWindow } from '../../../src/projections/watch-window.ts';
import { watchInput } from '../../fixtures/watch.ts';
import { type BranchKit, branch, call, type Kit, kit } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());
const draft = { standing: '核对新增材料', advice: '' };

async function observation(own: BranchKit, tool: string, summary: string) {
  return k.runStore.writer.appendObservation(
    {
      runId: k.run.id,
      branchId: own.branch.id,
      role: tool === 'sh' ? 'explorer' : 'watcher',
      tool,
      args: tool === 'sh' ? { cmd: summary } : {},
      summary,
      output: await k.runStore.artifacts!.put(k.run.id, summary),
      snapshot: 'root',
    },
    { countsAsToolCall: tool === 'sh' },
  );
}

function open(own: BranchKit, previous?: WatchRequest['previous']) {
  const request = freezeWatchWindow(
    k.runStore.queries,
    k.run.id,
    {
      branchId: own.branch.id,
      untilSeq: k.runStore.queries.lastSeq(),
      previous,
      window: { maxSteps: 15, maxBytes: 20 * 1024 },
    },
    k.runStore.queries.lastSeq(),
  );
  const layout = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, request);
  const session = k.gateway.open(
    { runId: k.run.id, branchId: own.branch.id, role: 'watcher', readOnly: true, snapshot: 'root' },
    {
      observation: {
        request,
        input: layout.watch!,
        model: own.bet.model,
      },
    },
  );
  return { session, request, layout };
}

describe('观察者记忆和状态的读取预算', () => {
  it('超过首屏预算的上一版保留可查询的方向索引，末尾方向可按位置读全且不推进执行历史', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const previous = k.runStore.writer.recordWatch({
      runId: k.run.id,
      branchId: own.branch.id,
      basedOnSeq: k.runStore.queries.lastSeq(),
      toolCalls: 0,
      model: own.bet.model,
      draft: watchFromArgs({
        ...draft,
        directions: Array.from({ length: 30 }, (_, i) => ({
          id: `direction-${i}`,
          direction: `方向 ${i}`,
          status: 'untried',
          result: `${'必须保留的条件🚀'.repeat(100)} 末尾约束-${i}`,
          evidence: [],
        })),
      }),
    });
    k.runStore.writer.recordHumanInput({
      runId: k.run.id,
      text: `新要求需要展开阅读全文：${'必须先核对的条件🚀'.repeat(2000)}`,
    });
    await observation(own, 'sh', '核对新输入');
    const { session, layout } = open(own, previous);
    expect(Buffer.byteLength(layout.messages[0]!.text)).toBeLessThanOrEqual(WATCH_OVERVIEW_BYTES);
    const first = await call(session, 'observation_context', {});
    expect(first.isError, first.content).toBe(false);
    expect(first.json!.progress).toMatchObject({ complete: true, toolCalls: 0 });
    expect(first.content).not.toContain('末尾约束-29');
    expect(first.json).not.toHaveProperty('background');
    const index = await call(session, 'observation_context', { assessmentIds: [] });
    expect(index.json!.assessments).toHaveLength(30);
    expect(index.content).toContain('direction-29');
    let position = { offset: 1, column: 0 };
    let full = '';
    for (let count = 0; count < 100; count++) {
      const detail = await call(session, 'observation_context', { assessmentIds: ['direction-29'], ...position });
      expect(detail.isError, detail.content).toBe(false);
      expect(Buffer.byteLength(detail.content)).toBeLessThanOrEqual(WATCH_DETAIL_BYTES);
      expect(detail.json!.progress).toEqual(first.json!.progress);
      const row = (detail.json!.assessments as { text: string; next?: typeof position }[])[0]!;
      full += row.text;
      if (!row.next) break;
      position = row.next;
    }
    expect(full).toContain('末尾约束-29');
  });

  it('大量回执仍给执行历史留位置，跨轮读完后不重复占首屏，原文仍可查询', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    await observation(own, 'sh', '应当进入首屏的执行');
    const receipts = [];
    for (let i = 0; i < 90; i++) {
      receipts.push(await observation(own, WATCH_INPUT.receipt, `回执-${i} ${'已验收的条件及结果'.repeat(40)}`));
    }
    const until = k.runStore.queries.lastSeq();
    let previous: WatchRequest['previous'];
    for (let round = 0; round < 10; round++) {
      const { session, layout } = open(own, previous);
      const first = await call(session, 'observation_context', {});
      expect(first.isError, first.content).toBe(false);
      expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(WATCH_OVERVIEW_BYTES);
      if (round === 0) {
        expect(layout.messages[0]!.text).toContain('应当进入首屏的执行');
        expect(first.json!.progress).toMatchObject({ toolCalls: 1 });
      }
      const published = await call(session, 'observation_submit', watchInput(draft));
      expect(published.isError, published.content).toBe(false);
      previous = session.publishedWatch;
      if (previous!.basedOnSeq >= until && previous!.stateSeq! >= until) break;
    }
    expect(previous!.basedOnSeq).toBeGreaterThanOrEqual(until);
    expect(previous!.stateSeq).toBeGreaterThanOrEqual(until);
    await observation(own, 'sh', '回执读完后的新执行');
    const { session, layout } = open(own, previous);
    const next = await call(session, 'observation_context', {});
    expect(layout.messages[0]!.text).toContain('回执读完后的新执行');
    expect(next.json!.progress).toMatchObject({ complete: true, toolCalls: 2 });
    expect(layout.messages[0]!.text).not.toContain('# 最新提示、状态与回执');
    const receipt = receipts.at(-1)!;
    const detail = await call(session, 'observation_context', { evidenceRefs: [receipt.id] });
    expect(detail.isError, detail.content).toBe(false);
    expect(detail.content).toContain('回执-89');
    expect(detail.content).not.toContain('unknown_evidence');
  });
});
