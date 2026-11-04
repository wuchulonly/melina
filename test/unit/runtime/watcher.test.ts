import { afterEach, describe, expect, it } from 'vitest';
import { createRoleCallRunner } from '../../../src/agents/episode.ts';
import { createWatcherAgent, WATCHER_DEADLINE_HINT, watcherModel } from '../../../src/agents/watcher.ts';
import { isMelinaError } from '../../../src/core/errors.ts';
import type { SubmitWatchArgs } from '../../../src/core/tools.ts';
import type { Run } from '../../../src/core/types.ts';
import {
  WATCH_CONTEXT_CALLS,
  WATCH_OVERVIEW_BYTES,
  WATCH_WINDOW_BYTES,
  WATCH_WINDOW_STEPS,
  WatchFailure,
} from '../../../src/core/watch-budget.ts';
import { freezeWatchWindow } from '../../../src/projections/watch-window.ts';
import { A1, A2, B1 } from '../models/fakes.ts';
import type { TranscriptContext } from '../models/protocol.ts';
import { openExplorer, sh } from '../tools/gateway-kit.ts';
import { liveBranch, type RoleKit, roleKit, runOf, say, tool, turn, userText } from './roles-kit.ts';

const kits: RoleKit[] = [];
afterEach(() => {
  for (const k of kits.splice(0)) k.cleanup();
});
const submission = (evidence: string[]): SubmitWatchArgs => ({
  standing: '第 1 条有观测证明，第 2 条还没测',
  directions: [
    {
      id: 'baseline',
      direction: '先跑通基线',
      status: 'works',
      result: '两条命令都跑完了',
      evidence,
      attempts: [{ id: 't1', action: '先跑通基线', result: '两条命令都跑完了', evidence }],
    },
    {
      id: 'timing',
      direction: '量一下耗时',
      status: 'untried',
      result: '还没量',
      evidence: [],
      attempts: [],
    },
  ],
  tension: [],
  advice: '下一步量耗时',
});
function submitTool(input: SubmitWatchArgs) {
  return tool('observation_submit', {
    ...input,
    directions: input.directions.map(({ attempts: _attempts, ...d }) => d),
  });
}
/** 这一次请求里最后一个工具结果的文字 */
function lastResult(ctx: TranscriptContext): string {
  const m = [...ctx.messages].reverse().find((x) => x.role === 'toolResult');
  return m?.role === 'toolResult' ? m.content.map((c) => (c.type === 'text' ? c.text : '')).join('') : '';
}
async function scene() {
  const rk = roleKit();
  kits.push(rk);
  const bet0 = await liveBranch(rk, { kind: 'direct', label: '主干直解路线' });
  const s = openExplorer(rk.k, bet0);
  const o1 = await sh(s, 'echo 基线跑通了');
  const o2 = await sh(s, 'echo 第二条命令');
  const runner = createRoleCallRunner({ stream: rk.m.stream, registry: rk.m.registry });
  const watcher = createWatcherAgent({
    runner,
    gateway: rk.k.gateway,
    assembler: rk.assembler,
    registry: rk.m.registry,
  });
  return { rk, bet0, o1, o2, watcher, run: runOf(rk) as Run, submit: submission([o1, o2]) };
}
describe('巡检器（agents/watcher.ts）', () => {
  it('模型首屏保留布局中的预期、独立错误和 HTTP 摘录', async () => {
    const { rk, bet0, watcher, run, submit } = await scene();
    rk.k.redactor.hold('watch-input-test', [{ name: 'INPUT_TOKEN', value: 'private-input-token' }]);
    const output = await rk.k.runStore.artifacts!.put(run.id, '普通工具输出');
    const observation = rk.k.runStore.writer.appendObservation(
      {
        runId: run.id,
        branchId: bet0.branch.id,
        role: 'explorer',
        tool: 'sh',
        args: { cmd: 'inspect response' },
        expect: '独立预期标记',
        error: '独立错误标记',
        summary: '普通摘要 private-input-token',
        output,
        snapshot: 'root',
      },
      { countsAsToolCall: true },
    );
    const request = {
      branchId: bet0.branch.id,
      untilSeq: rk.k.runStore.queries.lastSeq(),
      http: [{ observation: observation.id, output, text: '独立 HTTP 摘录标记' }],
    };
    const expected = rk.assembler.forWatcher(run.id, request).messages[0]!.text;
    rk.m.a.setResponses([
      (ctx) => {
        const text = userText(ctx.messages);
        expect(text).toBe(expected);
        expect(text).not.toContain('private-input-token');
        expect(text).toContain('独立预期标记');
        expect(text).toContain('独立错误标记');
        expect(text).toContain('独立 HTTP 摘录标记');
        return turn(submitTool(submit));
      },
    ]);
    await watcher.watch({
      run,
      request,
      author: A1,
      signal: new AbortController().signal,
    });
  });
  it('默认窗口的 60 步较长记录和最新提示都进入模型首屏，发布覆盖到最新执行', async () => {
    const { rk, bet0, watcher, run, submit, o1 } = await scene();
    const output = rk.k.runStore.queries.getObservation(o1)!.output;
    for (let i = 2; i < 60; i++)
      rk.k.runStore.writer.appendObservation(
        {
          runId: run.id,
          branchId: bet0.branch.id,
          role: 'explorer',
          tool: 'sh',
          args: { cmd: `check-step-${i + 1}` },
          summary: `执行进展-${i + 1} ${'检查输入输出与约束条件。'.repeat(25)}`,
          output,
          snapshot: 'root',
        },
        { countsAsToolCall: true },
      );
    rk.k.runStore.writer.recordHumanInput({
      runId: run.id,
      text: '最新要求与六十步进展一起核对',
    });
    const latest = rk.k.runStore.queries.lastSeq();
    const request = freezeWatchWindow(
      rk.k.runStore.queries,
      run.id,
      {
        branchId: bet0.branch.id,
        untilSeq: latest,
        window: { maxSteps: WATCH_WINDOW_STEPS, maxBytes: WATCH_WINDOW_BYTES },
      },
      latest,
    );
    expect(request).toMatchObject({ toolCalls: 60, untilSeq: latest });
    rk.m.a.setResponses([
      (ctx) => {
        const text = userText(ctx.messages);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(WATCH_OVERVIEW_BYTES);
        expect(text).toContain('最新要求与六十步进展一起核对');
        expect(text).toContain('基线跑通了');
        for (let i = 3; i <= 60; i++) expect(text).toContain(`执行进展-${i} `);
        expect(text).toContain('# 本轮状态\n');
        expect(text).toContain('累计 60 次工具调用');
        expect(text).toContain('# 上一版之后的时间线');
        return turn(submitTool(submit));
      },
    ]);
    const result = await watcher.watch({ run, request, author: A1, signal: new AbortController().signal });
    expect(result.published).toMatchObject({ toolCalls: 60, stateSeq: latest, basedOnSeq: latest });
    expect(rk.m.ledger.entries.filter((e) => e.role === 'watcher')).toHaveLength(1);
  });
  it('积压期间首次模型输入已有最新提示，直接发布仍只覆盖历史前 15 步', async () => {
    const { rk, bet0, watcher, run, submit, o1 } = await scene();
    const output = rk.k.runStore.queries.getObservation(o1)!.output;
    for (let i = 2; i < 60; i++)
      rk.k.runStore.writer.appendObservation(
        {
          runId: run.id,
          branchId: bet0.branch.id,
          role: 'explorer',
          tool: 'sh',
          args: {},
          summary: `动作 ${i + 1}`,
          output,
          snapshot: 'root',
        },
        { countsAsToolCall: true },
      );
    const hint = rk.k.runStore.writer.recordHumanInput({
      runId: run.id,
      text: '最新提示立即进入首轮模型输入',
    });
    const latest = rk.k.runStore.queries.lastSeq();
    const request = freezeWatchWindow(
      rk.k.runStore.queries,
      run.id,
      { branchId: bet0.branch.id, untilSeq: latest, window: { maxSteps: 15, maxBytes: 20 * 1024 } },
      latest,
    );
    rk.m.a.setResponses([
      (ctx) => {
        const text = userText(ctx.messages);
        expect(text).toContain('最新提示立即进入首轮模型输入');
        expect(text).toContain(`最新状态截止：${latest}`);
        expect(text).toContain(`执行窗口：1–${request.untilSeq}`);
        return turn(submitTool(submit));
      },
    ]);
    const result = await watcher.watch({ run, request, author: A1, signal: new AbortController().signal });
    expect(result.published).toMatchObject({ toolCalls: 15, stateSeq: latest, basedOnSeq: request.untilSeq });
    expect(result.published.basedOnSeq).toBeLessThan(hint.input.seq);
    expect(rk.m.ledger.entries.filter((e) => e.role === 'watcher')).toHaveLength(1);
  });
  it('提交校验失败后硬截止，即使返回模型错误仍按 budget 分类', async () => {
    const { rk, bet0, run, submit } = await scene();
    const abort = new AbortController();
    const runner = createRoleCallRunner({ stream: rk.m.stream, registry: rk.m.registry });
    const watcher = createWatcherAgent({
      runner: {
        start(input) {
          const handle = runner.start(input);
          return {
            ...handle,
            done: handle.done.then((result) => ({
              ...result,
              outcome: { kind: 'model_error' as const, message: '请求已中断' },
            })),
          };
        },
      },
      gateway: rk.k.gateway,
      assembler: rk.assembler,
      registry: rk.m.registry,
    });
    rk.m.a.setResponses([
      () => turn(tool('observation_context', {})),
      () => turn(submitTool({ ...submit, directions: [{ ...submit.directions[0]!, evidence: ['unknown'] }] })),
      () => {
        abort.abort(new WatchFailure('budget', '硬截止'));
        return say('结束');
      },
    ]);
    await expect(
      watcher.watch({
        run,
        request: { branchId: bet0.branch.id, untilSeq: rk.k.runStore.queries.lastSeq() },
        author: A1,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ reason: 'budget' });
  });
  it('软截止提醒停止扩展，仍能同轮纠正引用并提交', async () => {
    const { rk, bet0, o1, watcher, run, submit } = await scene();
    const closing = new AbortController();
    let reminded = false;
    rk.m.a.setResponses([
      () => turn(tool('observation_context', {})),
      () => {
        closing.abort();
        return turn(submitTool({ ...submit, directions: [{ ...submit.directions[0]!, evidence: ['unknown'] }] }));
      },
      (ctx) => {
        reminded = userText(ctx.messages).includes(WATCHER_DEADLINE_HINT);
        expect(lastResult(ctx)).toContain('不在本轮可见证据');
        return turn(tool('observation_context', { evidenceRefs: [o1] }));
      },
      (ctx) => {
        expect(JSON.parse(lastResult(ctx))).toMatchObject({ phase: 'submit' });
        expect(lastResult(ctx)).not.toContain('unknown_evidence');
        return turn(submitTool(submit));
      },
    ]);
    const result = await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq: rk.k.runStore.queries.lastSeq() },
      author: A1,
      signal: new AbortController().signal,
      closing: closing.signal,
    });
    expect(reminded).toBe(true);
    expect(result.published?.rev).toBe(1);
  });
  it('查询预算耗尽后模型只看到提交工具，沿用本分支模型与冻结窗口', async () => {
    const { rk, bet0, o1, watcher, run, submit } = await scene();
    const seen: {
      tools: string[];
      user: string;
      results: string[];
    }[] = [];
    const record = (ctx: TranscriptContext) => {
      const sys = ctx.messages.find((x) => x.role === 'system');
      seen.push({
        tools: (sys?.role === 'system' ? (sys.toolsAdded ?? []) : []).map((t) => t.name),
        user: userText(ctx.messages),
        results: ctx.messages.flatMap((m) =>
          m.role === 'toolResult' ? [m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')] : [],
        ),
      });
    };
    const reads = Array.from({ length: WATCH_CONTEXT_CALLS }, (_, i) => (ctx: TranscriptContext) => {
      record(ctx);
      return turn(tool('observation_context', i === 0 ? {} : { evidenceRefs: [o1] }));
    });
    rk.m.a.setResponses([
      ...reads,
      (ctx) => {
        record(ctx);
        return turn(submitTool(submit));
      },
    ]);
    const untilSeq = rk.k.runStore.queries.lastSeq();
    const result = await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq },
      author: A1,
      signal: new AbortController().signal,
    });
    expect(result.published.model).toEqual(A1); // 主干直解路线用 A1（faux-a），巡检器没写模型就用它自己的
    expect(result.published.basedOnSeq).toBe(untilSeq);
    expect(result.published.directions).toMatchObject(submit.directions);
    const first = seen[0];
    expect(first?.tools).toEqual(['observation_context', 'observation_submit']);
    expect(seen.at(-1)?.tools).toEqual(['observation_submit']);
    expect(first?.user).toContain('基线跑通了');
    expect(first?.user).toContain('这是第一轮，还没有。');
    expect(result.published?.rev).toBe(1);
    expect(rk.assembler.watchMap(bet0.branch.id)).toContain('先跑通基线');
    expect(seen.at(-1)?.results).toHaveLength(WATCH_CONTEXT_CALLS);
    expect(seen.at(-1)?.results.every((text) => !text.includes('unknown_evidence'))).toBe(true);
    const results = seen.at(-1)!.results.map((text) => JSON.parse(text));
    expect(results[0]).toMatchObject({ progress: { complete: true, toolCalls: 2 } });
    expect(results[0]).not.toHaveProperty('text');
    for (const detail of results.slice(1)) {
      expect(detail).not.toHaveProperty('delta');
      expect(detail).not.toHaveProperty('task');
      expect(detail.evidence[0].ref).toBe(`o${rk.k.runStore.queries.getObservation(o1)!.seq}`);
      expect(detail.window.untilSeq).toBe(untilSeq);
    }
    // 模型调用记在主干直解路线的分支上，角色是巡检器
    const slots = rk.m.scheduler.state.slots.filter((x) => x.job === 'watcher_call');
    expect(slots).toHaveLength(WATCH_CONTEXT_CALLS + 1);
    expect(slots.every((x) => x.branchId === bet0.branch.id && x.provider === 'faux-a')).toBe(true);
    const usage = rk.m.ledger.entries.filter((e) => e.role === 'watcher');
    expect(usage).toHaveLength(WATCH_CONTEXT_CALLS + 1);
    expect(usage.every((e) => e.branchId === bet0.branch.id)).toBe(true);
  });
  it('模型漏填 evidence 时在严格 schema 之前精确补齐，不再多调一轮或降级 trying', async () => {
    const { rk, bet0, watcher, run, o1, o2 } = await scene();
    const refs = [o1, o2].map((id) => `o${rk.k.runStore.queries.getObservation(id)!.seq}`);
    rk.m.a.setResponses([
      () =>
        turn(
          tool('observation_submit', {
            standing: '服务探测仍在验证',
            advice: '',
            directions: [
              {
                id: 'service',
                direction: '服务可达性',
                status: 'trying',
                result: `两次请求已有结果（${refs.join('、')}）`,
              },
            ],
          }),
        ),
    ]);
    const result = await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq: rk.k.runStore.queries.lastSeq() },
      author: A1,
      signal: new AbortController().signal,
    });
    expect(result.published.directions[0]).toMatchObject({
      status: 'trying',
      evidence: [o1, o2],
      attempts: [{ evidence: [o1, o2] }],
    });
    expect(rk.m.ledger.entries.filter((e) => e.role === 'watcher')).toHaveLength(1);
  });
  it('提交的 schema 失败后仅恢复一次纠错补查，下一请求再次只保留提交工具', async () => {
    const { rk, bet0, watcher, run, submit, o1 } = await scene();
    const visible: string[][] = [];
    const capture = (ctx: TranscriptContext) => {
      const system = ctx.messages.find((message) => message.role === 'system');
      visible.push((system?.role === 'system' ? (system.toolsAdded ?? []) : []).map((tool) => tool.name));
    };
    rk.m.a.setResponses([
      ...Array.from({ length: WATCH_CONTEXT_CALLS }, () => () => turn(tool('observation_context', {}))),
      (ctx) => {
        capture(ctx);
        return turn(submitTool({ ...submit, tension: ['单句疑点'] }));
      },
      (ctx) => {
        capture(ctx);
        return turn(tool('observation_context', { evidenceRefs: [o1] }));
      },
      (ctx) => {
        capture(ctx);
        return turn(submitTool(submit));
      },
    ]);
    const result = await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq: rk.k.runStore.queries.lastSeq() },
      author: A1,
      signal: new AbortController().signal,
    });
    expect(result.published.rev).toBe(1);
    expect(visible).toEqual([
      ['observation_submit'],
      ['observation_context', 'observation_submit'],
      ['observation_submit'],
    ]);
    expect(rk.m.ledger.entries.filter((entry) => entry.role === 'watcher')).toHaveLength(WATCH_CONTEXT_CALLS + 3);
  });
  it('交的时候照原版核对：不合格整份退回、写清每一处，改好了再交就收', async () => {
    const { rk, bet0, watcher, run, submit } = await scene();
    const results: string[] = [];
    rk.m.a.setResponses([
      () => turn(tool('observation_context', {})),
      ...Array.from(
        { length: 4 },
        () => () =>
          turn(
            submitTool({
              ...submit,
              tension: ['只有一句'],
              directions: [{ ...submit.directions[0]!, evidence: ['unknown'] }],
            }),
          ),
      ),
      (ctx) => {
        results.push(lastResult(ctx));
        return turn(submitTool(submit));
      },
    ]);
    const result = await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq: rk.k.runStore.queries.lastSeq() },
      author: A1,
      signal: new AbortController().signal,
    });
    expect(result.published.directions).toMatchObject(submit.directions);
    expect(results[0]).toContain('不在本轮可见证据');
    expect(result.published.rev).toBe(1);
    expect(results[0]).not.toContain('tension 要么');
  });
  it('持续纠错不会进入最后一次兜底，未知字段一直报错直到模型修正', async () => {
    const { rk, bet0, watcher, run, submit } = await scene();
    let corrected = false;
    rk.m.a.setResponses([
      () => turn(tool('observation_context', {})),
      ...Array.from(
        { length: 3 },
        () => () =>
          turn(
            tool('observation_submit', { ...(submitTool(submit).arguments as object), unknown_field: '不能静默丢掉' }),
          ),
      ),
      (ctx) => {
        expect(lastResult(ctx)).toContain('unknown_field');
        expect(rk.assembler.watchMap(bet0.branch.id)).toBeUndefined();
        corrected = true;
        return turn(submitTool(submit));
      },
    ]);
    const result = await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq: rk.k.runStore.queries.lastSeq() },
      author: A1,
      signal: new AbortController().signal,
    });
    expect(corrected).toBe(true);
    expect(result.published?.rev).toBe(1);
  });
  it('首屏为原生 Markdown，覆盖信息留在宿主，一次请求即可发布', async () => {
    const { rk, bet0, watcher, run, submit } = await scene();
    const untilSeq = rk.k.runStore.queries.lastSeq();
    rk.m.a.setResponses([
      (ctx) => {
        const text = userText(ctx.messages);
        expect(text).toContain('基线跑通了');
        expect(text).toMatch(/^# 本轮状态\n/);
        expect(text).toContain('# 你上一版的看法\n');
        expect(text).toContain('# 上一版之后的时间线');
        expect(() => JSON.parse(text)).toThrow();
        expect(text).not.toContain('coveredUntilSeq');
        return turn(submitTool(submit));
      },
    ]);
    const result = await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq },
      author: A1,
      signal: new AbortController().signal,
    });
    expect(result.published).toMatchObject({ rev: 1, basedOnSeq: untilSeq, toolCalls: 2 });
    expect(rk.m.ledger.entries.filter((e) => e.role === 'watcher')).toHaveLength(1);
  });
  it('首屏超过预算时只确认已读前缀，不把未提供的事件标为已读', async () => {
    const { rk, bet0, watcher, run, submit, o1 } = await scene();
    const output = rk.k.runStore.queries.getObservation(o1)!.output;
    for (let i = 0; i < 180; i++)
      rk.k.runStore.writer.appendObservation(
        {
          runId: run.id,
          branchId: bet0.branch.id,
          role: 'explorer',
          tool: 'sh',
          args: { cmd: `command-${i}` },
          summary: '结果🚀'.repeat(600),
          output,
          snapshot: 'root',
          exitCode: 0,
        },
        { countsAsToolCall: true },
      );
    const untilSeq = rk.k.runStore.queries.lastSeq();
    const layout = rk.assembler.forWatcher(run.id, { branchId: bet0.branch.id, untilSeq });
    const covered = Math.min(...layout.watch!.history.filter((seq) => !layout.watch!.covered.includes(seq))) - 1;
    rk.m.a.setResponses([
      (ctx) => {
        const text = userText(ctx.messages);
        expect(text).toContain('部分材料未展示');
        expect(text).not.toContain('"nextCursor"');
        return turn(submitTool(submit));
      },
    ]);
    const result = await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq },
      author: A1,
      signal: new AbortController().signal,
    });
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThan(untilSeq);
    expect(result.published?.basedOnSeq).toBe(covered);
    expect(result.published!.toolCalls).toBeLessThan(182);
    expect(rk.m.ledger.entries.filter((e) => e.role === 'watcher')).toHaveLength(1);
  });
  it('上一版里每个方向只列最近 3 次尝试；observation_context 按编号看全部，认不出的照实说', async () => {
    const { rk, bet0, watcher, run, submit, o1 } = await scene();
    const attempts = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i + 1}`,
      action: `第 ${i + 1} 次跑基线`,
      result: '跑完了',
      evidence: [o1],
    }));
    const previous = rk.k.runStore.writer.recordWatch({
      runId: run.id,
      branchId: bet0.branch.id,
      basedOnSeq: rk.k.runStore.queries.lastSeq(),
      toolCalls: 2,
      model: B1,
      draft: { ...submit, directions: submit.directions.map((d, i) => (i === 0 ? { ...d, attempts } : d)) },
    });
    const users: string[] = [];
    const results: string[] = [];
    rk.m.a.setResponses([
      (ctx) => {
        users.push(userText(ctx.messages));
        return turn(tool('observation_context', {}));
      },
      (ctx) => {
        const overview = JSON.parse(lastResult(ctx));
        expect(users[0]).toContain('试过 5 次，下面是最近 3 次');
        expect(overview).not.toHaveProperty('assessments');
        expect(lastResult(ctx)).not.toContain('第 2 次跑基线');
        return turn(tool('observation_context', { assessmentIds: ['baseline', 'ghost'] }));
      },
      (ctx) => {
        results.push(lastResult(ctx));
        return turn(submitTool({ ...submit, directions: [] }));
      },
    ]);
    await watcher.watch({
      run,
      request: { branchId: bet0.branch.id, untilSeq: rk.k.runStore.queries.lastSeq(), previous },
      author: A1,
      signal: new AbortController().signal,
    });
    expect(users[0]).toContain('试过 5 次');
    expect(users[0]).not.toContain('第 2 次跑基线');
    const detail = JSON.parse(results[0] ?? '{}') as {
      assessments: {
        id: string;
        text?: string;
        unavailable?: string;
      }[];
    };
    expect(detail.assessments.find((d) => d.id === 'baseline')?.text).toContain('第 2 次跑基线');
    expect(detail.assessments.find((d) => d.id === 'baseline')?.text).toContain('试过 5 次：');
    expect(detail.assessments.map((d) => d.id)).toEqual(['baseline', 'ghost']);
    expect(detail).not.toHaveProperty('delta');
    expect(detail.assessments.find((d) => d.id === 'ghost')).toEqual({
      id: 'ghost',
      unavailable: 'unknown_assessment',
    });
  });
  it('停下没交会继续提醒直到发布；被取消的是 conflict', async () => {
    const { rk, bet0, watcher, run, submit } = await scene();
    rk.m.a.setResponses([
      () => turn(tool('observation_context', {})),
      say('我看完了'),
      say('继续检查'),
      () => turn(submitTool(submit)),
    ]);
    const request = { branchId: bet0.branch.id, untilSeq: rk.k.runStore.queries.lastSeq() };
    const result = await watcher.watch({ run, request, author: A1, signal: new AbortController().signal });
    expect(result.published?.rev).toBe(1);
    const stop = new AbortController();
    stop.abort(new Error('任务暂停了'));
    const aborted = await watcher.watch({ run, request, author: A1, signal: stop.signal }).catch((e: unknown) => e);
    expect(isMelinaError(aborted) && aborted.code).toBe('conflict');
  });
  it('用哪个模型：watch.model 写了用它，写档位的用那一档的首选；没写用它看的那份自己的模型，那家熔断了照 Reviewer 的挑法挑别家的', async () => {
    const { rk, run } = await scene();
    const r = rk.m.registry;
    expect(watcherModel(r, run, A1)).toEqual(A1);
    expect(watcherModel(r, run, B1)).toEqual(B1);
    expect(watcherModel(r, { ...run, config: { ...run.config, watch: { enabled: true, model: A2 } } }, A1)).toEqual(A2);
    expect(
      watcherModel(r, { ...run, config: { ...run.config, watch: { enabled: true, model: { tier: 'strong' } } } }, B1),
    ).toEqual(A1);
    // 当前供应商熔断时改用其他供应商的可用模型，避免等待熔断恢复。
    r.breaker.failure('faux-a', '503 Service Unavailable');
    expect(watcherModel(r, run, A1)).toEqual(B1);
  });
});
