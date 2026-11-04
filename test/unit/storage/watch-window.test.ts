import { afterEach, describe, expect, it } from 'vitest';
import { BranchDetail } from '../../../src/core/api.ts';
import { handleOf } from '../../../src/core/ids.ts';
import type { SubmitWatchArgs } from '../../../src/core/tools.ts';
import { check } from '../../../src/core/validate.ts';
import { WATCH_INPUT } from '../../../src/core/watch-input.ts';
import { freezeWatchWindow, watchBacklog, watchLag } from '../../../src/projections/watch-window.ts';
import { MODEL, newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

const boards: TestRunStore[] = [];
afterEach(() => {
  for (const b of boards.splice(0)) b.close();
});
function setup() {
  let now = Date.parse('2026-10-16T00:00:00.000Z');
  const b = testRunStore({ now: () => new Date(now) });
  boards.push(b);
  const run = newRun(b);
  const branch = startBranch(b, run, { kind: 'direct' }).branch;
  const draft: SubmitWatchArgs = {
    standing: '还在验证',
    directions: [],
    tension: [],
    advice: '继续验证',
  };
  const publish = (basedOnSeq: number, toolCalls: number) =>
    b.writer.recordWatch({
      runId: run.id,
      branchId: branch.id,
      basedOnSeq,
      toolCalls,
      model: MODEL,
      draft,
    });
  return {
    b,
    run,
    branch,
    publish,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}
describe('巡检器覆盖水位', () => {
  it.each([
    { role: 'explorer' as const, tool: WATCH_INPUT.speech },
    ...Object.values(WATCH_INPUT).map((tool) => ({ role: 'watcher' as const, tool })),
  ])('本分支 $role 的 $tool 不增加工具数也形成未读积压', ({ role, tool }) => {
    const s = setup();
    s.advance(1000);
    s.b.writer.appendObservation(
      {
        runId: s.run.id,
        branchId: s.branch.id,
        episode: s.branch.episode,
        role,
        tool,
        args: {},
        summary: '新的可见输入',
        output: handleOf('新的可见输入'),
        snapshot: s.branch.lastSnapshot,
      },
      { countsAsToolCall: false },
    );
    const current = s.b.queries.getBranch(s.branch.id)!;
    expect(current.toolCalls).toBe(0);
    expect(watchBacklog(s.b.queries, current, 0, 0)).toEqual({
      unread: true,
      firstUnreadAt: '2026-10-16T00:00:01.000Z',
      hintSeq: 0,
    });
  });
  it('普通通知不会唤醒追赶，但仍计入窗口阅读预算', () => {
    const s = setup();
    observe(s.b, s.branch);
    const notice = s.b.writer.appendInbox({
      runId: s.run.id,
      branchId: s.branch.id,
      kind: 'notice',
      text: '通知内容'.repeat(200),
    });
    const request = freezeWatchWindow(
      s.b.queries,
      s.run.id,
      {
        branchId: s.branch.id,
        untilSeq: s.b.queries.lastSeq(),
        window: { maxSteps: 15, maxBytes: 1024 },
      },
      s.b.queries.lastSeq(),
    );
    expect(request.untilSeq).toBe(notice.seq - 1);
  });
  it('状态查询实时计算步数与最早未读账龄，追平后积压归零而覆盖账龄仍增长', () => {
    const s = setup();
    expect(s.b.queries.branchDetail(s.run.id, s.branch.id)?.watchLag).toBeUndefined();
    const covered = observe(s.b, s.branch);
    s.publish(covered.seq, 1);
    s.advance(10000);
    const pending = observe(s.b, s.branch);
    const firstUnreadAt = s.b.published.find((e) => e.seq === pending.seq)!.at;
    s.advance(5000);
    const detail = check(BranchDetail, s.b.queries.branchDetail(s.run.id, s.branch.id));
    expect(detail.watchLag).toEqual({
      lagTools: 1,
      backlogAgeMs: 5000,
      firstUnreadAt,
      coveredAt: '2026-10-16T00:00:00.000Z',
      coveredAgeMs: 15000,
    });
    s.publish(pending.seq, 2);
    s.advance(2000);
    expect(s.b.queries.branchDetail(s.run.id, s.branch.id)?.watchLag).toEqual({
      lagTools: 0,
      backlogAgeMs: 0,
      coveredAt: firstUnreadAt,
      coveredAgeMs: 7000,
    });
  });
  it('覆盖截止落在非材料事件上时回溯可见材料，其他路线、其他任务和普通通知不会形成积压', () => {
    const s = setup();
    const covered = observe(s.b, s.branch);
    const other = startBranch(s.b, s.run).branch;
    s.advance(1000);
    observe(s.b, other);
    const foreignRun = newRun(s.b);
    observe(s.b, startBranch(s.b, foreignRun, { kind: 'direct' }).branch);
    const note = s.publish(s.b.queries.lastSeq(), 1);
    s.b.writer.appendInbox({ runId: s.run.id, branchId: s.branch.id, kind: 'notice', text: '系统通知' });
    s.advance(9000);
    expect(watchBacklog(s.b.queries, s.b.queries.getBranch(s.branch.id)!, note.basedOnSeq, 1).unread).toBe(false);
    expect(s.b.queries.branchDetail(s.run.id, s.branch.id)?.watchLag).toEqual({
      lagTools: 0,
      backlogAgeMs: 0,
      coveredAt: s.b.published.find((e) => e.seq === covered.seq)!.at,
      coveredAgeMs: 10000,
    });
    observe(s.b, other);
    s.b.writer.appendInbox({ runId: s.run.id, branchId: s.branch.id, kind: 'notice', text: '另一条系统通知' });
    expect(watchBacklog(s.b.queries, s.b.queries.getBranch(s.branch.id)!, note.basedOnSeq, 1).unread).toBe(false);
  });
  it('连续前缀截窗的水位可落在事件间隙，账龄使用上一条已覆盖材料', () => {
    const s = setup();
    const covered = observe(s.b, s.branch);
    s.advance(1000);
    const pending = observe(s.b, s.branch);
    const request = freezeWatchWindow(
      s.b.queries,
      s.run.id,
      {
        branchId: s.branch.id,
        untilSeq: s.b.queries.lastSeq(),
        window: { maxSteps: 1, maxBytes: 20480 },
      },
      s.b.queries.lastSeq(),
    );
    expect(request.untilSeq).toBe(pending.seq - 1);
    const note = s.publish(request.untilSeq, request.toolCalls!);
    expect(note.toolCalls).toBe(1);
    expect(watchLag(s.b.queries, s.b.queries.getBranch(s.branch.id)!, note, s.now()).coveredAt).toBe(
      s.b.published.find((e) => e.seq === covered.seq)!.at,
    );
  });
  it('没有覆盖材料时不伪造覆盖时间，时钟回拨不会返回负账龄或负步数', () => {
    const s = setup();
    expect(watchLag(s.b.queries, s.branch, { basedOnSeq: 0, toolCalls: 5 }, s.now())).toEqual({
      lagTools: 0,
      backlogAgeMs: 0,
    });
    const covered = observe(s.b, s.branch);
    expect(
      watchLag(
        s.b.queries,
        s.b.queries.getBranch(s.branch.id)!,
        {
          basedOnSeq: covered.seq,
          toolCalls: 1,
        },
        s.now() - 1000,
      ).coveredAgeMs,
    ).toBe(0);
  });
});
