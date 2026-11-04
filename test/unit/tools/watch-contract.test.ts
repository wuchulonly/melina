import { afterEach, describe, expect, it, vi } from 'vitest';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import type { WatchRequest } from '../../../src/core/interfaces/context.ts';
import { WATCH_CONTEXT_CALLS } from '../../../src/core/watch-budget.ts';
import { runProgress } from '../../../src/projections/run-progress.ts';
import { allWatchAttempts } from '../../../src/projections/watch.ts';
import { branch, call, type Kit, kit, openExplorer, sh } from './gateway-kit.ts';

let k: Kit;
afterEach(() => {
  vi.restoreAllMocks();
  k?.cleanup();
});
const draft = { standing: '核对服务', advice: '围绕实际结果继续验证' };

async function scene() {
  k = kit();
  const own = await branch(k, { kind: 'direct' });
  const explorer = openExplorer(k, own);
  const first = await sh(explorer, 'printf first');
  const second = await sh(explorer, 'printf second');
  const refs = [first, second].map((id) => `o${k.runStore.queries.getObservation(id)!.seq}`);
  const open = (previous?: WatchRequest['previous']) => {
    const request = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq(), previous };
    const layout = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, request);
    return k.gateway.open(
      { runId: k.run.id, branchId: own.branch.id, role: 'watcher', readOnly: true, snapshot: 'root' },
      { observation: { request, input: layout.watch!, model: own.bet.model } },
    );
  };
  return { own, explorer, first, second, refs, open };
}

describe('观察者提交与补查契约', () => {
  it('有限验证从模型 schema 写入事件并供主代理读取；计划不冒充实际尝试', async () => {
    const s = await scene();
    let watcher = s.open();
    const experiment = {
      question: '响应差异是否来自会话身份',
      check: '对同一资源做两种身份的有限对照',
      expected: '仅身份变化时响应差异支持权限边界解释',
      stopWhen: '两种身份结果一致时重新评估前提',
    };
    const direction = {
      id: 'identity',
      direction: '会话身份差异',
      status: 'untried',
      result: '现有响应需要对照确认',
      evidence: [s.refs[0]],
      doubt: '尚无相同资源对照',
      experiment,
    };
    const result = await call(watcher, 'observation_submit', { ...draft, directions: [direction] });
    expect(result.isError, result.content).toBe(false);
    const first = watcher.publishedWatch!;
    expect(first.directions[0]).toMatchObject({ experiment, attempts: [], status: 'untried' });
    const assembler = new MelinaContextAssembler({ queries: k.runStore.queries });
    expect(assembler.watchMap(s.own.branch.id)).toContain('停止/转向 两种身份结果一致时重新评估前提');
    expect(assembler.watchMap(s.own.branch.id)).toContain('OPEN_QUESTIONS:');
    const layout = assembler.forWatcher(k.run.id, {
      branchId: s.own.branch.id,
      untilSeq: k.runStore.queries.lastSeq(),
      previous: first,
    });
    expect(layout.messages[0]!.text).toContain('有限检查：对同一资源做两种身份的有限对照');
    watcher = s.open(first);
    expect((await call(watcher, 'observation_submit', draft)).isError).toBe(false);
    expect(watcher.publishedWatch!.directions[0]!.experiment).toEqual(experiment);
    watcher = s.open(watcher.publishedWatch);
    expect(
      (await call(watcher, 'observation_submit', { ...draft, directions: [{ id: 'identity', retired: true }] }))
        .isError,
    ).toBe(false);
    expect(watcher.publishedWatch!.directions[0]!.experiment).toEqual(experiment);
    watcher = s.open(watcher.publishedWatch);
    const { experiment: _experiment, ...withoutPlan } = direction;
    expect(
      (await call(watcher, 'observation_submit', { ...draft, directions: [{ ...withoutPlan, retired: false }] }))
        .isError,
    ).toBe(false);
    expect(watcher.publishedWatch!.directions[0]).not.toHaveProperty('experiment');
    expect(first.directions[0]!.experiment).toEqual(experiment);
  });

  it.each([
    { question: '问题', check: '检查', expected: '预期' },
    { question: '问题', check: '检查', expected: '预期', stopWhen: '' },
    { question: '问题', check: '检查', expected: '预期', stopWhen: '界'.repeat(301) },
  ])('实验缺少停止条件或超出上限时拒绝且不发布', async (experiment) => {
    const s = await scene();
    const watcher = s.open();
    const result = await call(watcher, 'observation_submit', {
      ...draft,
      directions: [
        {
          id: 'bounded',
          direction: '有限检查',
          status: 'untried',
          result: '尚未执行',
          evidence: [],
          experiment,
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(watcher.publishedWatch).toBeUndefined();
  });

  it.each(['works', 'failed', 'trying'] as const)(
    '%s 的正文执行引用补齐遗漏字段，一次发布且重提不重复计次',
    async (status) => {
      const s = await scene();
      const watcher = s.open();
      const input = {
        ...draft,
        directions: [
          { id: 'reachability', direction: '服务可达性', status, result: `两次请求均返回结果（${s.refs.join('、')}）` },
        ],
      };
      const original = structuredClone(input);
      const accepted = await call(watcher, 'observation_submit', input);
      expect(accepted.isError, accepted.content).toBe(false);
      expect(accepted.json!.warnings).toEqual([expect.stringContaining('从 result 中明确引用')]);
      expect(watcher.publishedWatch!.directions[0]).toMatchObject({
        status,
        evidence: [s.first, s.second],
        attempts: [{ id: 't1', evidence: [s.first, s.second] }],
      });
      const next = s.open(watcher.publishedWatch);
      expect((await call(next, 'observation_submit', input)).isError).toBe(false);
      expect(allWatchAttempts(next.publishedWatch!.directions[0]!)).toHaveLength(1);
      expect(input).toEqual(original);
    },
  );

  it('显式空证据、仅有笔误、其他分支与冻结后引用均不能从正文猜补', async () => {
    const s = await scene();
    const other = await branch(k);
    const foreign = await sh(openExplorer(k, other), 'printf foreign');
    const watcher = s.open();
    const late = await sh(s.explorer, 'printf late');
    const direction = { id: 'check', direction: '检查', status: 'works', result: `观察到结果 ${s.refs[0]}` };
    const empty = await call(watcher, 'observation_submit', { ...draft, directions: [{ ...direction, evidence: [] }] });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain('至少一次尝试');
    for (const ref of [
      `o${k.runStore.queries.getObservation(foreign)!.seq}`,
      `o${k.runStore.queries.getObservation(late)!.seq}`,
      'o999999',
    ]) {
      const result = await call(watcher, 'observation_submit', {
        ...draft,
        directions: [{ ...direction, evidence: [ref] }],
      });
      expect(result.isError, ref).toBe(true);
      expect(result.content).toContain('不在本轮可见证据');
      expect(watcher.publishedWatch).toBeUndefined();
    }
    const result = await call(watcher, 'observation_submit', {
      ...draft,
      directions: [{ ...direction, evidence: [s.refs[0], 'o999999'] }],
    });
    expect(result.isError, result.content).toBe(false);
    expect(watcher.publishedWatch!.directions[0]!.evidence).toEqual([s.first]);
  });

  it('仅归档或恢复保留未试状态，不把不再需要验证伪装成失败或实际尝试', async () => {
    const s = await scene();
    let watcher = s.open();
    const direction = { id: 'optional', direction: '备选入口', status: 'untried', result: '尚未验证', evidence: [] };
    expect((await call(watcher, 'observation_submit', { ...draft, directions: [direction] })).isError).toBe(false);
    const original = watcher.publishedWatch!.directions[0]!;
    for (const retired of [true, false]) {
      watcher = s.open(watcher.publishedWatch);
      const result = await call(watcher, 'observation_submit', { ...draft, directions: [{ id: 'optional', retired }] });
      expect(result.isError, result.content).toBe(false);
      expect(watcher.publishedWatch!.directions[0]).toEqual({ ...original, retired });
    }
    watcher = s.open(watcher.publishedWatch);
    const unknown = await call(watcher, 'observation_submit', {
      ...draft,
      directions: [{ id: 'missing', retired: true }],
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('尚不存在');
  });

  it('telemetry 未更新或引用无效时保留旧报告原时间，显式 null 才撤回', async () => {
    const s = await scene();
    let watcher = s.open();
    const telemetry = {
      stage: 'analysis',
      trajectory: 'advancing',
      bottleneck: 'none',
      confidence: 0.8,
      evidence: s.refs,
    };
    expect((await call(watcher, 'observation_submit', { ...draft, telemetry })).isError).toBe(false);
    const original = runProgress(k.runStore.queries, k.run).semantic;
    expect(original).toHaveLength(1);
    const malformed = s.open(watcher.publishedWatch);
    const rejected = await call(malformed, 'observation_submit', {
      ...draft,
      telemetry: { ...telemetry, evidence: ['o999999'], unknown_field: '不能随坏引用一起被静默丢弃' },
    });
    expect(rejected.isError).toBe(true);
    expect(malformed.publishedWatch).toBeUndefined();
    expect(runProgress(k.runStore.queries, k.run).semantic).toEqual(original);
    for (const input of [draft, { ...draft, telemetry: { ...telemetry, evidence: ['o999999'] } }]) {
      watcher = s.open(watcher.publishedWatch);
      expect((await call(watcher, 'observation_submit', input)).isError).toBe(false);
      expect(watcher.publishedWatch!.telemetry).toBeUndefined();
      expect(runProgress(k.runStore.queries, k.run).semantic).toEqual(original);
    }
    watcher = s.open(watcher.publishedWatch);
    expect((await call(watcher, 'observation_submit', { ...draft, telemetry: null })).isError).toBe(false);
    expect(watcher.publishedWatch!.telemetry).toBeNull();
    expect(runProgress(k.runStore.queries, k.run).semantic).toBeUndefined();
  });

  it('三次补查后只保留提交工具；提交失败可用一次纠错读取，读操作不会无限续期', async () => {
    const s = await scene();
    const watcher = s.open();
    const context = watcher.tools.find((tool) => tool.spec.name === 'observation_context')!;
    const read = vi.spyOn(k.runStore.artifacts!, 'readLines');
    for (let i = 0; i < WATCH_CONTEXT_CALLS; i++) {
      const result = await call(watcher, 'observation_context', { evidenceRefs: s.refs });
      expect(result.isError, result.content).toBe(false);
      expect(result.json!.contextBudget).toMatchObject({ remaining: WATCH_CONTEXT_CALLS - i - 1 });
    }
    expect(context.available?.()).toBe(false);
    const reads = read.mock.calls.length;
    expect((await call(watcher, 'observation_context', { evidenceRefs: s.refs })).isError).toBe(true);
    expect(read).toHaveBeenCalledTimes(reads);
    expect((await call(watcher, 'observation_submit', { ...draft, tension: ['单句'] })).isError).toBe(true);
    expect(context.available?.()).toBe(true);
    expect((await call(watcher, 'observation_context', { evidenceRefs: s.refs })).isError).toBe(false);
    expect(context.available?.()).toBe(false);
    expect((await call(watcher, 'observation_submit', { ...draft, tension: ['仍是单句'] })).isError).toBe(true);
    expect(context.available?.()).toBe(false);
    expect((await call(watcher, 'observation_submit', draft)).isError).toBe(false);
    expect(watcher.publishedWatch!.rev).toBe(1);
  });
});
