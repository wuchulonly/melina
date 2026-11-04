import { afterEach, describe, expect, it } from 'vitest';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import type { WatchRequest } from '../../../src/core/interfaces/context.ts';
import type { SubmitWatchArgs } from '../../../src/core/tools.ts';
import type { Observation } from '../../../src/core/types.ts';
import { WATCH_DETAIL_BYTES, WATCH_OVERVIEW_BYTES } from '../../../src/core/watch-budget.ts';
import { WATCH_INPUT } from '../../../src/core/watch-input.ts';
import { freezeWatchWindow } from '../../../src/projections/watch-window.ts';
import { watchInput } from '../../fixtures/watch.ts';
import { type BranchKit, branch, call, type Kit, kit } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());
const draft: SubmitWatchArgs = {
  standing: '继续核对',
  directions: [],
  tension: [],
  advice: '',
};

function freeze(own: BranchKit, previous?: WatchRequest['previous']) {
  return freezeWatchWindow(
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
}

function open(own: BranchKit, request: WatchRequest, closing?: AbortSignal, contextLimit?: number) {
  const layout = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, request);
  const session = k.gateway.open(
    { runId: k.run.id, branchId: own.branch.id, role: 'watcher', snapshot: 'root', readOnly: true },
    {
      observation: {
        request,
        input: layout.watch!,
        model: own.bet.model,
        closing,
        contextLimit,
      },
    },
  );
  return Object.assign(session, { overview: layout.messages[0]!.text });
}

async function state(own: BranchKit, tool: string, summary: string, args: unknown = {}) {
  return k.runStore.writer.appendObservation(
    {
      runId: k.run.id,
      branchId: own.branch.id,
      role: 'watcher',
      tool,
      args,
      summary,
      output: await k.runStore.artifacts!.put(k.run.id, summary),
      snapshot: 'root',
    },
    { countsAsToolCall: false },
  );
}

async function action(own: BranchKit, summary = '执行结果') {
  return k.runStore.writer.appendObservation(
    {
      runId: k.run.id,
      branchId: own.branch.id,
      role: 'explorer',
      tool: 'sh',
      args: { cmd: 'inspect' },
      summary,
      output: await k.runStore.artifacts!.put(k.run.id, summary),
      snapshot: 'root',
    },
    { countsAsToolCall: true },
  );
}

describe('最新状态与连续历史分别冻结', () => {
  it('60 个动作后新来的提示与回执首轮可查询、引用、生成验收节点，历史只推进 15 步', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const actions: Observation[] = [];
    for (let i = 0; i < 60; i++) actions.push(await action(own, `动作 ${i + 1}`));
    const hint = k.runStore.writer.recordHumanInput({
      runId: k.run.id,
      text: '最新线索：检查校验分支',
    });
    const receipt = await state(own, WATCH_INPUT.receipt, '权威回执：平台已验收目标一', { id: 'flag-one' });
    const platform = {
      task: 'B-03',
      total: 2,
      remaining: 1,
      hintStatus: 'ready',
      hint: '平台最新提示',
      accepted: [{ id: 'flag-one', label: '目标一', receipt: receipt.id }],
      rejectedCount: 0,
    };
    const status = await state(own, WATCH_INPUT.platform, JSON.stringify(platform), platform);
    const request = freeze(own);
    expect(request.untilSeq).toBeLessThan(actions[15]!.seq);
    expect(request.state!.untilSeq).toBeGreaterThanOrEqual(status.seq);
    const watcher = open(own, request);
    const first = await call(watcher, 'observation_context', {});
    expect(first.isError, first.content).toBe(false);
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(WATCH_OVERVIEW_BYTES);
    expect(watcher.overview).toContain('最新线索：检查校验分支');
    expect(watcher.overview).toContain('权威回执');
    expect(watcher.overview).toContain(`o${receipt.seq}`);
    expect(first.json!.state).toMatchObject({ seenSeq: request.state!.untilSeq, complete: true });
    expect(first.json!.progress).toMatchObject({ toolCalls: 15, coveredUntilSeq: request.untilSeq });
    expect(watcher.overview).toContain('累计 60 次工具调用');
    const evidence = await call(watcher, 'observation_context', { evidenceRefs: [receipt.id, hint.input.id] });
    expect(evidence.content).toContain('权威回执');
    expect(evidence.content).not.toContain('unknown_evidence');
    const hidden = await call(watcher, 'observation_context', { evidenceRefs: [actions[15]!.id] });
    expect(hidden.content).toContain('unknown_evidence');
    const submitted = await call(
      watcher,
      'observation_submit',
      watchInput({
        ...draft,
        directions: [
          {
            id: 'accepted',
            direction: '目标一验收',
            status: 'works',
            result: '平台确认通过，执行过程尚未覆盖',
            evidence: [receipt.id],
            attempts: [{ id: 'receipt', action: '平台验收', result: '已通过', evidence: [receipt.id] }],
          },
          {
            id: 'hint',
            direction: '检查校验分支',
            status: 'untried',
            result: '提示提供了新线索',
            evidence: [hint.input.id],
            attempts: [],
          },
        ],
      }),
    );
    expect(submitted.isError, submitted.content).toBe(false);
    const note = watcher.publishedWatch!;
    expect(note).toMatchObject({ toolCalls: 15, basedOnSeq: request.untilSeq, stateSeq: request.state!.untilSeq });
    expect(note.stateRefs).toContain(receipt.id);
    expect(note.flags).toEqual([expect.objectContaining({ receipt: receipt.id, dependsOn: ['accepted'] })]);
    const next = freeze(own, note);
    const nextWatcher = open(own, next);
    const nextPage = await call(nextWatcher, 'observation_context', {});
    expect(nextPage.json!.progress).toMatchObject({ toolCalls: 30 });
    expect(nextWatcher.overview).toContain('动作 16');
    expect((await call(nextWatcher, 'observation_context', { evidenceRefs: [receipt.id] })).content).toContain(
      '权威回执',
    );
    expect((await call(nextWatcher, 'observation_context', { evidenceRefs: [hint.input.id] })).content).toContain(
      '最新线索',
    );
  });

  it('冻结后到达的提示、回执与其他分支材料不可见，不能把普通执行冒充状态越过历史水位', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const actions: Observation[] = [];
    for (let i = 0; i < 60; i++) actions.push(await action(own));
    const known = await state(own, WATCH_INPUT.receipt, '冻结前的回执');
    const request = freeze(own);
    const foreign = await branch(k);
    const hidden = await state(foreign, WATCH_INPUT.receipt, '其他分支回执');
    const late = await state(own, WATCH_INPUT.receipt, '冻结后回执');
    const lateHint = k.runStore.writer.recordHumanInput({ runId: k.run.id, text: '冻结后提示' });
    request.state!.refs.push(hidden.id, late.id, actions[40]!.id);
    const closing = new AbortController();
    const watcher = open(own, request, closing.signal);
    expect(watcher.overview).toContain('冻结前的回执');
    expect(watcher.overview).not.toContain('冻结后');
    const queried = await call(watcher, 'observation_context', {
      evidenceRefs: [hidden.id, late.id, actions[40]!.id, lateHint.input.id],
    });
    expect(queried.json!.evidence as unknown[]).toHaveLength(4);
    expect(queried.content.match(/unknown_evidence/g)).toHaveLength(4);
    closing.abort();
    const result = await call(
      watcher,
      'observation_submit',
      watchInput({
        ...draft,
        directions: [
          {
            id: 'receipt',
            direction: '验收',
            status: 'works',
            result: '已通过',
            evidence: [known.id],
            attempts: [{ id: 'r', action: '平台验收', result: '通过', evidence: [known.id] }],
          },
        ],
      }),
    );
    expect(result.isError, result.content).toBe(false);
    expect(watcher.publishedWatch!.directions).toHaveLength(1);
    expect(() =>
      k.runStore.writer.recordWatch({
        runId: k.run.id,
        branchId: own.branch.id,
        basedOnSeq: request.untilSeq,
        toolCalls: 15,
        state: { untilSeq: k.runStore.queries.lastSeq(), seenSeq: request.state!.untilSeq, refs: [actions[40]!.id] },
        model: own.bet.model,
        draft,
      }),
    ).toThrow('最新状态只能引用');
  });

  it('状态与历史共用概览，长提示摘要足以提交，原文仍可按需展开', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    for (let i = 0; i < 60; i++) await action(own);
    const expected = new Map<number, string>();
    for (let i = 0; i < 12; i++) {
      const hint = k.runStore.writer.recordHumanInput({
        runId: k.run.id,
        text: `提示 ${i} ${'细节🚀'.repeat(600)} 原文末尾 ${i}`,
      });
      expected.set(hint.inbox[0]!.seq, hint.inbox[0]!.text);
    }
    const request = freeze(own);
    const watcher = open(own, request, undefined, 100);
    const first = await call(watcher, 'observation_context', {});
    expect(first.isError, first.content).toBe(false);
    expect(first.json!.state).toMatchObject({ complete: true, seenSeq: request.state!.untilSeq });
    expect(watcher.overview).toContain('提示 11');
    expect(first.json).not.toHaveProperty('nextCursor');
    const received = new Map<number, string>();
    const contextRefs = request.state!.refs.filter((id) => k.runStore.queries.getRecord(id)?.kind === 'inbox');
    for (const contextRef of contextRefs) {
      let page = await call(watcher, 'observation_context', { contextRefs: [contextRef] });
      let record = '';
      for (;;) {
        expect(page.isError, page.content).toBe(false);
        expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(WATCH_DETAIL_BYTES);
        expect(page.json!.progress).toEqual(first.json!.progress);
        for (const part of page.json!.evidence as {
          part: string;
          text: string;
          next?: { offset: number; column: number };
        }[])
          if (part.part === 'record') record += part.text;
        const next = (page.json!.evidence as { next?: { offset: number; column: number } }[])[0]!.next;
        if (!next) break;
        page = await call(watcher, 'observation_context', { contextRefs: [contextRef], ...next });
      }
      const parsed = JSON.parse(record) as { seq: number; text: string };
      received.set(parsed.seq, parsed.text);
    }
    expect(received).toEqual(expected);
    expect((await call(watcher, 'observation_submit', watchInput(draft))).isError).toBe(false);
    expect(watcher.publishedWatch).toMatchObject({
      toolCalls: 15,
      basedOnSeq: request.untilSeq,
      stateSeq: request.state!.untilSeq,
    });
  });

  it('摘要已推进状态，长提示可直接查看末尾，也可按位置完整续读', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    await action(own);
    const hint = k.runStore.writer.recordHumanInput({
      runId: k.run.id,
      text: '约束🚀'.repeat(10000),
    });
    const request = freeze(own);
    const watcher = open(own, request, undefined, 100);
    const args = { contextRefs: [hint.inbox[0]!.id] };
    const initial = await call(watcher, 'observation_context', args);
    const first = (initial.json!.evidence as { text: string; next: { offset: number; column: number } }[])[0]!;
    expect(first.next).toBeDefined();
    const tail = await call(watcher, 'observation_context', { ...args, offset: 1, column: 39000 });
    expect(tail.isError, tail.content).toBe(false);
    expect(tail.json!.state).toMatchObject({ complete: true, seenSeq: request.state!.untilSeq });
    let position = first.next;
    let completed = false;
    for (let count = 0; count < 100; count++) {
      const page = await call(watcher, 'observation_context', { ...args, ...position });
      expect(page.isError, page.content).toBe(false);
      const row = (page.json!.evidence as { next?: typeof position }[])[0]!;
      if (!row.next) {
        expect(page.json!.state).toMatchObject({ complete: true, seenSeq: request.state!.untilSeq });
        completed = true;
        break;
      }
      position = row.next;
    }
    expect(completed).toBe(true);
  });

  it('首屏提示摘要即可发布状态，不因未展开全文反复唤醒', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    for (let i = 0; i < 60; i++) await action(own);
    const hints = Array.from({ length: 12 }, (_, i) =>
      k.runStore.writer.recordHumanInput({
        runId: k.run.id,
        text: `提示 ${i} ${'细节🚀'.repeat(600)}`,
      }),
    );
    let previous: WatchRequest['previous'];
    const firstIds: string[] = [];
    for (let round = 0; round < 12; round++) {
      const request = freeze(own, previous);
      const watcher = open(own, request);
      const page = await call(watcher, 'observation_context', {});
      expect(page.isError, page.content).toBe(false);
      firstIds.push(watcher.overview.match(/\[叙述ID: ([^\]]+)\]/)![1]!);
      const submitted = await call(watcher, 'observation_submit', watchInput(draft));
      expect(submitted.isError, submitted.content).toBe(false);
      previous = watcher.publishedWatch;
      if (round === 0) {
        expect(previous!.stateSeq).toBe(request.state!.untilSeq);
        expect(previous!.stateRefs).toContain(hints.at(-1)!.input.id);
      }
      if (previous!.stateSeq === request.state!.untilSeq) break;
    }
    expect(previous!.stateSeq).toBeGreaterThanOrEqual(hints.at(-1)!.inbox[0]!.seq);
    expect(firstIds).toHaveLength(1);
  });
});
