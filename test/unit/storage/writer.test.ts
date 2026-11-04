import { afterEach, describe, expect, it } from 'vitest';
import { handleOf, newId } from '../../../src/core/ids.ts';
import type { NewCandidate } from '../../../src/core/interfaces/store.ts';
import { closeEpisode, newRun, observe, startBranch, type TestRunStore, testRunStore } from './kit.ts';

let runStore: TestRunStore;
afterEach(() => runStore?.close());
function setup() {
  runStore = testRunStore();
  const run = newRun(runStore);
  const { branch, bet } = startBranch(runStore, run);
  return { run, branch, bet };
}
function candidate(runId: string, branchId: string, snapshot: string): NewCandidate {
  return { runId, branchId, snapshot, claim: '测试全部通过，完成目标' };
}

describe('运行状态和事务', () => {
  it('完成标准只起草一次', () => {
    const { run } = setup();
    expect(() =>
      runStore.writer.draftCompletion(run.id, {
        completion: { interpretation: '另一个定义', criteria: ['另一个目标'] },
        constraints: [],
        domain: 'code',
      }),
    ).toThrow();
    expect(runStore.queries.getRun(run.id)?.goal.completion).toEqual(run.goal.completion);
  });
  it('新路线必须引用本任务存在的快照', () => {
    const { run } = setup();
    expect(() => startBranch(runStore, run, { startFrom: { snapshot: 'missing' } })).toThrow();
    expect(runStore.queries.listBets(run.id)).toHaveLength(1);
  });
  it('同一 Bet 只能建立一条分支', () => {
    const { run, bet } = setup();
    expect(() => runStore.writer.createBranch({ runId: run.id, betId: bet.id, lastSnapshot: 'root' })).toThrow();
  });
  it('暂停、恢复后保持观察计数，终态不能经 updateRun 写入', () => {
    const { run, branch } = setup();
    observe(runStore, branch);
    runStore.writer.updateRun(run.id, { status: 'paused' });
    runStore.writer.updateRun(run.id, { status: 'running' });
    expect(runStore.queries.getBranch(branch.id)?.toolCalls).toBe(1);
    expect(() => runStore.writer.updateRun(run.id, { status: 'done' } as never)).toThrow();
  });
  it('正常收尾原子保存快照和交接，开始下一次会话', () => {
    const { branch } = setup();
    observe(runStore, branch);
    const seq = runStore.queries.lastSeq();
    const result = closeEpisode(runStore, branch, { handoff: '已启动服务；恢复时运行 ./server.sh' });
    expect(result.branch).toMatchObject({
      state: 'running',
      episode: 2,
      failures: 0,
      handoff: '已启动服务；恢复时运行 ./server.sh',
      seenSeq: seq,
    });
    expect(result.branch.lastSnapshot).toBe(result.snapshot?.id);
    expect(runStore.queries.lineage(result.snapshot!.id)).toEqual([result.snapshot!.id, 'root']);
  });
  it('过期会话拒收，不产生快照或事件', () => {
    const { branch } = setup();
    closeEpisode(runStore, branch);
    const seq = runStore.queries.lastSeq();
    expect(() =>
      runStore.writer.closeEpisode({
        branchId: branch.id,
        episode: 1,
        outcome: 'ended',
        snapshot: { id: 'stale-snap' },
        handoff: '迟到',
      }),
    ).toThrow();
    expect(runStore.queries.lastSeq()).toBe(seq);
    expect(runStore.queries.snapshots(branch.runId).some((s) => s.id === 'stale-snap')).toBe(false);
  });
  it('连续会话失败达到上限才结束路线，始终保留已保存的工作区', () => {
    const { branch, bet } = setup();
    for (let i = 0; i < 3; i++)
      closeEpisode(runStore, branch, {
        outcome: 'failed',
        failure: 'model_error',
        handoff: undefined,
        seenSeq: undefined,
      });
    expect(runStore.queries.getBranch(branch.id)).toMatchObject({ state: 'failed', failures: 3 });
    expect(runStore.queries.getBet(bet.id)?.status).toBe('closed');
    expect(runStore.queries.snapshots(branch.runId)).toHaveLength(3);
  });
  it('最终候选和 settling 同时提交，另一条路线迟到的提交整个回滚', () => {
    const { run, branch } = setup();
    const other = startBranch(runStore, run).branch;
    closeEpisode(runStore, branch, {
      outcome: 'submitted',
      snapshot: { id: 'winner' },
      candidate: candidate(run.id, branch.id, 'winner'),
    });
    expect(runStore.queries.getRun(run.id)?.mode).toBe('settling');
    const seq = runStore.queries.lastSeq();
    expect(() =>
      closeEpisode(runStore, other, {
        outcome: 'submitted',
        snapshot: { id: 'late' },
        candidate: candidate(run.id, other.id, 'late'),
      }),
    ).toThrow();
    expect(runStore.queries.lastSeq()).toBe(seq);
    expect(runStore.queries.candidates(run.id)).toHaveLength(1);
  });
  it('取消原子结束所有活动分支和 Bet', () => {
    const { run, branch } = setup();
    const other = startBranch(runStore, run).branch;
    const ended = runStore.writer.endRun(run.id, {
      status: 'cancelled',
      result: { knowledgeReport: handleOf('报告') },
      branchNote: '用户取消',
    });
    expect(ended.status).toBe('cancelled');
    for (const b of [branch, other])
      expect(runStore.queries.getBranch(b.id)).toMatchObject({ state: 'cancelled', stateNote: '用户取消' });
    expect(runStore.queries.listBets(run.id).every((b) => b.status === 'closed')).toBe(true);
    expect(() => runStore.writer.updateRun(run.id, { status: 'running' })).toThrow();
  });
  it('事务失败不发布任何中间事件', () => {
    const { run, branch } = setup();
    const seq = runStore.queries.lastSeq();
    const count = runStore.published.length;
    expect(() =>
      closeEpisode(runStore, branch, {
        outcome: 'submitted',
        snapshot: { id: 'rollback' },
        candidate: { ...candidate(run.id, branch.id, 'rollback'), claim: '' },
      }),
    ).toThrow();
    expect(runStore.queries.lastSeq()).toBe(seq);
    expect(runStore.published).toHaveLength(count);
    expect(runStore.queries.snapshots(run.id)).toHaveLength(0);
  });
});

describe('宿主交接与输入', () => {
  it('现场存档不结束当前会话，后续快照继承它', () => {
    const { branch } = setup();
    observe(runStore, branch);
    const saved = runStore.writer.checkpointBranch(
      branch.id,
      { id: 'handoff-snap' },
      { episode: 1, handoff: '已有 shell，文件在 workspace' },
    );
    expect(saved).toMatchObject({ state: 'running', episode: 1, toolCalls: 1, lastSnapshot: 'handoff-snap' });
    expect(closeEpisode(runStore, branch).snapshot?.parent).toBe('handoff-snap');
  });
  it('旧会话、暂停中和 settling 不接受运行中的现场存档', () => {
    const { run, branch } = setup();
    expect(() => runStore.writer.checkpointBranch(branch.id, { id: 'stale' }, { episode: 2, handoff: '旧' })).toThrow();
    runStore.writer.updateRun(run.id, { status: 'paused' });
    expect(() =>
      runStore.writer.checkpointBranch(branch.id, { id: 'paused' }, { episode: 1, handoff: '旧' }),
    ).toThrow();
    expect(runStore.writer.checkpointBranch(branch.id, { id: 'interrupted' }).lastSnapshot).toBe('interrupted');
  });
  it('输入广播给每条未结束路线，重试键保证只写一次', () => {
    const { run, branch } = setup();
    const other = startBranch(runStore, run).branch;
    const input = {
      runId: run.id,
      text: '已验收第一阶段，继续内网',
      key: 'host-1',
      acceptance: { task: 'task-1', accepted: 1, total: 2 },
    };
    const saved = runStore.writer.recordHumanInput(input);
    const seq = runStore.queries.lastSeq();
    expect(saved.inbox.map((i) => i.branchId)).toEqual([branch.id, other.id]);
    expect(runStore.writer.recordHumanInput(input).input.id).toBe(saved.input.id);
    expect(runStore.queries.lastSeq()).toBe(seq);
    expect(() => runStore.writer.recordHumanInput({ ...input, text: '不同内容' })).toThrow();
  });
  it.each([-1, 0.5, 3])('拒绝无效验收计数 %s', (accepted) => {
    const { run } = setup();
    const seq = runStore.queries.lastSeq();
    expect(() =>
      runStore.writer.recordHumanInput({
        runId: run.id,
        text: '平台验收',
        acceptance: { task: 'task-1', accepted, total: 2 },
      }),
    ).toThrow();
    expect(runStore.queries.lastSeq()).toBe(seq);
  });
  it('被取消路线不再收到新输入，其他路线继续收到', () => {
    const { run, branch } = setup();
    const other = startBranch(runStore, run).branch;
    runStore.writer.updateBranch(branch.id, { state: 'cancelled' });
    const saved = runStore.writer.recordHumanInput({ id: newId(), runId: run.id, text: '继续' });
    expect(saved.inbox.map((i) => i.branchId)).toEqual([other.id]);
  });
});
