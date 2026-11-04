import { afterEach, describe, expect, it } from 'vitest';
import { RunProgress } from '../../../src/core/api.ts';
import type { SemanticDigest, TaskProfile } from '../../../src/core/telemetry.ts';
import type { SubmitWatchArgs } from '../../../src/core/tools.ts';
import type { Run } from '../../../src/core/types.ts';
import { isValid } from '../../../src/core/validate.ts';
import { runProgress } from '../../../src/projections/run-progress.ts';
import { closeEpisode, newRun, observe, snapshotId, startBranch, type TestRunStore, testRunStore } from './kit.ts';

let runStore: TestRunStore;
afterEach(() => runStore?.close());
const PROFILE: TaskProfile = {
  tags: ['web', 'java-deserialization'],
  hasSource: true,
  attachmentScale: 'small',
  estimatedMinutes: 15,
  confidence: 0.8,
};
function watchDraft(telemetry?: SemanticDigest | null): SubmitWatchArgs {
  return {
    standing: 'secret task details',
    advice: 'secret advice',
    directions: [],
    tension: [],
    ...(telemetry !== undefined ? { telemetry } : {}),
  };
}
describe('外层调度的进展计数', () => {
  it.each([false, true])('阶段归档不重置停滞计数（已有平台验收：%s）', (hasAcceptance) => {
    runStore = testRunStore();
    const run = newRun(runStore);
    let { branch } = startBranch(runStore, run);
    if (hasAcceptance) {
      runStore.writer.recordHumanInput({
        runId: run.id,
        text: '平台已验收 2 个 Flag',
        acceptance: { task: 'b-03', accepted: 2, total: 4 },
      });
    }
    observe(runStore, branch);
    branch = closeEpisode(runStore, branch).branch;
    const before = runProgress(runStore.queries, run);
    expect(before).toMatchObject({ toolCallsSinceProgress: 1, episodesSinceProgress: 1 });

    for (let i = 1; i <= 2; i++) {
      const snapshot = snapshotId();
      runStore.writer.deliverVersion({
        branchId: branch.id,
        episode: branch.episode,
        snapshot: { id: snapshot },
        candidate: {
          runId: run.id,
          branchId: branch.id,
          snapshot,
          claim: '归档 NOTES.md',
          interim: true,
        },
      });
      observe(runStore, branch);
      expect(runProgress(runStore.queries, run)).toMatchObject({
        goalProgressSeq: before.goalProgressSeq,
        lastGoalProgressAt: before.lastGoalProgressAt,
        lastGoalProgressKind: before.lastGoalProgressKind,
        toolCallsSinceProgress: before.toolCallsSinceProgress + i,
        episodesSinceProgress: before.episodesSinceProgress,
        candidatesCount: i,
      });
    }

    const accepted = runStore.writer.recordHumanInput({
      runId: run.id,
      text: '平台已验收 3 个 Flag',
      acceptance: { task: 'b-03', accepted: 3, total: 4 },
    }).input;
    expect(runProgress(runStore.queries, run)).toMatchObject({
      goalProgressSeq: accepted.seq,
      lastGoalProgressKind: 'acceptance',
      toolCallsSinceProgress: 0,
      episodesSinceProgress: 0,
    });
    observe(runStore, branch);
    for (const count of [3, 2, 3]) {
      runStore.writer.recordHumanInput({
        runId: run.id,
        text: '重复或回退的验收计数',
        acceptance: { task: 'b-03', accepted: count, total: 4 },
      });
    }
    expect(runProgress(runStore.queries, run)).toMatchObject({
      goalProgressSeq: accepted.seq,
      lastGoalProgressKind: 'acceptance',
      toolCallsSinceProgress: 1,
    });
  });

  it('最终候选仍计为交付进展', () => {
    runStore = testRunStore();
    const run = newRun(runStore);
    const { branch } = startBranch(runStore, run);
    observe(runStore, branch);
    const snapshot = snapshotId();
    const closed = closeEpisode(runStore, branch, {
      outcome: 'submitted',
      snapshot: { id: snapshot },
      candidate: { runId: run.id, branchId: branch.id, snapshot, claim: '任务完成' },
    });
    expect(runProgress(runStore.queries, run)).toMatchObject({
      goalProgressSeq: closed.candidate?.seq,
      lastGoalProgressKind: 'record',
      toolCallsSinceProgress: 0,
      candidatesCount: 1,
    });
  });

  it('未观察计数只包含启用观察的存活路线，接力会话仍单独统计', () => {
    runStore = testRunStore();
    const run = newRun(runStore, { config: { watch: { enabled: true, disabledBet0Copies: [3] } } });
    const copies = Array.from({ length: 3 }, () => startBranch(runStore, run));
    const publish = ({ branch, bet }: (typeof copies)[number]) =>
      runStore.writer.recordWatch({
        runId: run.id,
        branchId: branch.id,
        basedOnSeq: runStore.queries.lastSeq(),
        model: bet.model,
        toolCalls: 0,
        draft: watchDraft(),
      });
    publish(copies[0]!);
    expect(runProgress(runStore.queries, run).observer).toMatchObject({ branchesObserved: 1, branchesUnobserved: 1 });
    publish(copies[1]!);
    expect(runProgress(runStore.queries, run).observer).toMatchObject({ branchesObserved: 2, branchesUnobserved: 0 });
    // 关闭观察的副本即使残留报告，也不影响当前观察统计。
    publish(copies[2]!);
    expect(runProgress(runStore.queries, run).observer).toMatchObject({ branchesObserved: 2, branchesUnobserved: 0 });
    const relay = startBranch(runStore, run, {
      continuation: { key: 'progress:1', slot: 0, handoff: '入口已验证', direction: '检查新路径' },
    });
    expect(runProgress(runStore.queries, run).observer).toMatchObject({ branchesObserved: 2, branchesUnobserved: 1 });
    publish(relay);
    expect(runProgress(runStore.queries, run).observer).toMatchObject({ branchesObserved: 3, branchesUnobserved: 0 });
  });

  it('全局关闭观察时不汇总残留的观察报告', () => {
    runStore = testRunStore();
    const run = newRun(runStore, { config: { watch: { enabled: false } } });
    const { branch, bet } = startBranch(runStore, run);
    runStore.writer.recordWatch({
      runId: run.id,
      branchId: branch.id,
      basedOnSeq: runStore.queries.lastSeq(),
      model: bet.model,
      toolCalls: 0,
      draft: watchDraft(),
    });
    expect(runProgress(runStore.queries, run).observer).toBeNull();
  });

  it('省略不删除或续新旧报告，null 显式撤回；终止的分支仍能导出最后画像和报告', () => {
    let now = Date.parse('2026-10-02T00:00:00Z');
    runStore = testRunStore({ now: () => new Date(now) });
    const run = newRun(runStore);
    const { branch, bet } = startBranch(runStore, run, { kind: 'direct' });
    const evidence = observe(runStore, branch);
    const telemetry: SemanticDigest = {
      stage: 'blocked',
      trajectory: 'repeated_blocker',
      bottleneck: 'env_instability',
      confidence: 0.9,
      evidence: [evidence.id],
      profile: PROFILE,
    };
    const publish = (report?: SemanticDigest | null) =>
      runStore.writer.recordWatch({
        runId: run.id,
        branchId: branch.id,
        basedOnSeq: runStore.queries.lastSeq(),
        model: bet.model,
        toolCalls: 1,
        draft: watchDraft(report),
      });
    publish(telemetry);
    const reportedAt = now / 1000;
    const original = runProgress(runStore.queries, run, now / 1000).semantic;
    now += 601000;
    expect(runProgress(runStore.queries, run, now / 1000).semantic?.[0]?.reportedAt).toBe(reportedAt);
    publish();
    expect(runProgress(runStore.queries, run, now / 1000).semantic).toEqual(original);
    expect(publish(null).telemetry).toBeNull();
    expect(runProgress(runStore.queries, run, now / 1000).semantic).toBeUndefined();
    expect(runProgress(runStore.queries, run, now / 1000).profile).toEqual(PROFILE);
    publish();
    expect(runProgress(runStore.queries, run, now / 1000).semantic).toBeUndefined();
    publish(telemetry);
    runStore.writer.updateBranch(branch.id, { state: 'failed' });
    const closed = runProgress(runStore.queries, run, now / 1000);
    expect(closed.observer).toBeNull();
    expect(closed.semantic?.[0]).toMatchObject({
      source: 'observer',
      branchActive: false,
      evidenceAt: reportedAt,
      reportedAt: now / 1000,
      bottleneck: 'env_instability',
    });
    expect(closed.profile).toEqual(PROFILE);
  });
  it('巡检器只汇总当前路线的最新版，按执行时间统计未评估尝试，不因重复发布把旧尝试算新', () => {
    let now = Date.parse('2026-10-02T00:00:00Z');
    runStore = testRunStore({ now: () => new Date(now) });
    const run = newRun(runStore);
    const { branch, bet } = startBranch(runStore, run, { kind: 'direct' });
    const control = observe(runStore, branch);
    now += 601000;
    const fresh = observe(runStore, branch);
    const duplicate = observe(runStore, branch);
    const invalid = observe(runStore, branch);
    const unknown = observe(runStore, branch);
    const publish = () =>
      runStore.writer.recordWatch({
        runId: run.id,
        branchId: branch.id,
        basedOnSeq: runStore.queries.lastSeq(),
        toolCalls: runStore.queries.getBranch(branch.id)!.toolCalls,
        model: bet.model,
        draft: {
          standing: 'secret hypothesis',
          advice: 'secret instruction',
          tension: [],
          directions: [
            {
              id: 'route',
              direction: 'secret route',
              status: 'trying',
              result: 'secret result',
              evidence: [fresh.id],
              attempts: [control, fresh, duplicate, invalid, unknown]
                .map((record, i) => ({
                  id: `t${i}`,
                  evidence: [record.id],
                }))
                .map((attempt) => ({
                  ...attempt,
                  action: 'secret action',
                  result: 'secret output',
                })),
            },
          ],
        },
      });
    publish();
    publish();
    observe(runStore, branch);
    const current = runStore.queries.getRun(run.id) as Run;
    const result = runProgress(runStore.queries, current, now / 1000);
    expect(result.observer).toMatchObject({
      branchesObserved: 1,
      branchesUnobserved: 0,
      lagToolCalls: 1,
      trying: 1,
      recentAttempts: 4,
    });
    expect(isValid(RunProgress, result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
    runStore.writer.updateBranch(branch.id, { state: 'failed' });
    expect(runProgress(runStore.queries, current, now / 1000).observer).toBeNull();
  });
});
