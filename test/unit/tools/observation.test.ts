import { afterEach, describe, expect, it } from 'vitest';
import { prepareToolArgs } from '../../../src/agents/tool-args.ts';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import type { WatchRequest } from '../../../src/core/interfaces/context.ts';
import { SubmitWatchArgs } from '../../../src/core/tools.ts';
import { isValid } from '../../../src/core/validate.ts';
import { WATCH_DETAIL_BYTES, WATCH_OVERVIEW_BYTES } from '../../../src/core/watch-budget.ts';
import { WATCH_INPUT } from '../../../src/core/watch-input.ts';
import { allWatchAttempts, latestWatch } from '../../../src/projections/watch.ts';
import { watchInput } from '../../fixtures/watch.ts';
import { type BranchKit, branch, call, type Kit, kit, openExplorer, sh } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());
const draft: SubmitWatchArgs = {
  standing: '检查基线',
  directions: [],
  tension: [],
  advice: '',
};

function openWindow(
  own: BranchKit,
  request: WatchRequest = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq() },
  closing?: AbortSignal,
  contextLimit?: number,
) {
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

async function contextText(watcher: ReturnType<typeof openWindow>): Promise<string> {
  const page = await call(watcher, 'observation_context', {});
  expect(page.isError, page.content).toBe(false);
  return watcher.overview;
}

const attempted = (evidence: string[]): SubmitWatchArgs => ({
  ...draft,
  directions: [
    {
      id: 'tests',
      direction: '验证基线',
      status: 'works',
      result: '测试通过',
      evidence,
      attempts: [{ id: 't1', action: '运行测试', result: '测试通过', evidence }],
    },
  ],
});

async function scene(contextLimit?: number) {
  k = kit();
  const own = await branch(k, { kind: 'direct' });
  const solver = openExplorer(k, own);
  const first = await sh(solver, "printf 'first\\nsecond\\nthird\\n'");
  const foreign = await branch(k);
  const hidden = await sh(openExplorer(k, foreign), 'echo hidden-output');
  const request = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq() };
  const asm = new MelinaContextAssembler({ queries: k.runStore.queries });
  const open = () => openWindow(own, request, undefined, contextLimit);
  return { own, solver, first, hidden, request, asm, open };
}

async function material(own: BranchKit, text: string, cmd = 'read evidence', summary = text) {
  const output = await k.runStore.artifacts!.put(k.run.id, text);
  return k.runStore.writer.appendObservation(
    {
      runId: k.run.id,
      branchId: own.branch.id,
      role: 'explorer',
      tool: 'sh',
      args: { cmd },
      summary,
      output,
      snapshot: 'root',
      exitCode: 0,
    },
    { countsAsToolCall: true },
  );
}

describe('两个观察工具', () => {
  it('未试方向显式填写空证据，非语义字段的 null 经参数准备后可首次发布', async () => {
    const s = await scene();
    const watcher = s.open();
    const spec = watcher.tools.find((tool) => tool.spec.name === 'observation_submit')!.spec;
    const input = {
      standing: '先检查鉴权条件',
      directions: [
        {
          id: 'auth',
          direction: '鉴权逻辑',
          status: 'untried',
          result: '现有线索指向权限检查',
          evidence: [],
          priority: 1,
        },
      ],
      advice: '',
    };
    for (const empty of [{}, { tension: null }]) {
      const prepared = prepareToolArgs(spec, { ...input, ...empty }).args;
      expect(prepared).toEqual(input);
    }
    const result = await call(watcher, 'observation_submit', watchInput(input));
    expect(result.json).toEqual({ ok: true, revision: 1 });
    expect(watcher.publishedWatch).toMatchObject({
      directions: [{ id: 'auth', status: 'untried', attempts: [], evidence: [] }],
      tension: [],
    });
    expect(watcher.closed()?.args).toMatchObject({
      tension: [],
    });
  });

  it('更新结论时省略 attempts 保留旧尝试，省略 directions 保留整个方向', async () => {
    const s = await scene();
    const first = s.open();
    await contextText(first);
    expect((await call(first, 'observation_submit', watchInput(attempted([s.first])))).isError).toBe(false);
    const next = openWindow(s.own, { ...s.request, previous: first.publishedWatch });
    const input = {
      standing: '结果需要核对适用范围',
      directions: [
        {
          id: 'tests',
          direction: '验证基线',
          status: 'unclear',
          result: '大输入未覆盖',
          doubt: '范围不明',
        },
      ],
      advice: '',
    };
    expect((await call(next, 'observation_submit', watchInput(input))).json).toEqual({ ok: true, revision: 2 });
    expect(next.publishedWatch!.directions[0]).toMatchObject({
      status: 'unclear',
      result: '大输入未覆盖',
      doubt: '范围不明',
      evidence: [],
      attempts: first.publishedWatch!.directions[0]!.attempts,
    });
    const unchanged = openWindow(s.own, { ...s.request, previous: next.publishedWatch });
    const { directions: _directions, ...guidance } = input;
    expect((await call(unchanged, 'observation_submit', watchInput(guidance))).json).toEqual({ ok: true, revision: 3 });
    expect(unchanged.publishedWatch!.directions).toEqual(next.publishedWatch!.directions);
  });

  it('新建已试方向缺执行依据时返回错误，重试不擅自改写判断', async () => {
    const s = await scene();
    const watcher = s.open();
    const input = {
      standing: '检查基线',
      directions: [
        {
          id: 'tests',
          direction: '验证基线',
          status: 'works',
          result: '声称测试通过',
          evidence: [],
        },
      ],
      advice: '',
    };
    const spec = watcher.tools.find((tool) => tool.spec.name === 'observation_submit')!.spec;
    expect(prepareToolArgs(spec, input).args).toEqual(input);
    const rejected = await call(watcher, 'observation_submit', watchInput(input));
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain('至少一次尝试');
    expect(watcher.publishedWatch).toBeUndefined();
    const result = await call(watcher, 'observation_submit', watchInput(input));
    expect(result.isError, result.content).toBe(true);
    expect(result.content).toContain('至少一次尝试');
    expect(watcher.publishedWatch).toBeUndefined();
  });

  it('模型可显式将缺执行依据的判断改为疑点，宿主保留原描述', async () => {
    const s = await scene();
    const watcher = s.open();
    const spec = watcher.tools.find((tool) => tool.spec.name === 'observation_submit')!.spec;
    const input = {
      standing: '核对鉴权',
      directions: [
        {
          id: 'auth',
          direction: '鉴权路径',
          status: 'works',
          result: '声称已取得数据',
          evidence: [],
          priority: 1,
        },
      ],
      advice: '',
    };
    const prepared = prepareToolArgs(spec, input).args;
    const rejected = await call(watcher, 'observation_submit', watchInput(prepared));
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain('至少一次尝试');
    expect(watcher.publishedWatch).toBeUndefined();
    const revised = {
      ...input,
      directions: [{ ...input.directions[0]!, status: 'unclear', doubt: '需要核实执行结果' }],
    };
    const result = await call(watcher, 'observation_submit', revised);
    expect(result.isError, result.content).toBe(false);
    expect(latestWatch(k.runStore.queries, k.run.id, s.own.branch.id)).toMatchObject({
      directions: [{ status: 'unclear', attempts: [], result: '声称已取得数据', doubt: '需要核实执行结果' }],
    });
  });

  it('新增大状态快照限长，正常 15 步首屏即可覆盖，原始状态仍可按句柄分页查', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const raw = `宿主状态 ${'详细状态🚀'.repeat(10_000)} 原文末尾`;
    const output = await k.runStore.artifacts!.put(k.run.id, raw);
    k.runStore.writer.appendObservation(
      {
        runId: k.run.id,
        branchId: own.branch.id,
        role: 'watcher',
        tool: WATCH_INPUT.platform,
        args: {},
        summary: raw,
        output,
        snapshot: 'root',
      },
      { countsAsToolCall: false },
    );
    for (let i = 0; i < 15; i++) await material(own, `完成步骤 ${i}`);
    const watcher = openWindow(own);
    const first = await call(watcher, 'observation_context', {});
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(WATCH_OVERVIEW_BYTES);
    expect(first.json!.progress).toMatchObject({ complete: true, toolCalls: 15 });
    expect(first.content).not.toContain('原文末尾');
    const evidence = await call(watcher, 'observation_context', { evidenceRefs: [output] });
    expect((evidence.json!.evidence as { next?: unknown }[])[0]!.next).toBeDefined();
    expect(evidence.content).toContain('宿主状态');
    expect((await k.runStore.artifacts!.readLines(k.run.id, output)).text).toBe(raw);
  });
  it('软截止关闭概览读取，只按已读前缀提交', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    for (let i = 0; i < 180; i++) await material(own, `步骤 ${i}\n${'详细结果🚀'.repeat(200)}`);
    const closing = new AbortController();
    const watcher = openWindow(own, undefined, closing.signal);
    const first = await call(watcher, 'observation_context', {});
    expect(first.json!.nextCursor).toBeUndefined();
    closing.abort();
    for (const args of [{}, {}]) {
      const blocked = await call(watcher, 'observation_context', args);
      expect(blocked.json).toMatchObject({ phase: 'submit', submissionRequired: true, progress: first.json!.progress });
      expect(blocked.json).not.toHaveProperty('text');
      expect(blocked.json).not.toHaveProperty('nextCursor');
    }
    expect((await call(watcher, 'observation_submit', watchInput(draft))).isError).toBe(false);
    expect(watcher.publishedWatch!.basedOnSeq).toBe(
      (first.json!.progress as { coveredUntilSeq: number }).coveredUntilSeq,
    );
  });

  it('发言、提示、状态与工具以摘要预装，观测用稳定短码，其他材料保留 ID', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const append = async (tool: string, text: string) =>
      k.runStore.writer.appendObservation(
        {
          runId: k.run.id,
          branchId: own.branch.id,
          role: tool === WATCH_INPUT.speech ? 'explorer' : 'watcher',
          tool,
          args: {},
          summary: text,
          output: await k.runStore.artifacts!.put(k.run.id, text),
          snapshot: 'root',
        },
        { countsAsToolCall: false },
      );
    const speech = await append(WATCH_INPUT.speech, '先确认输入条件');
    const earlyState = await append(WATCH_INPUT.platform, '早期状态');
    k.runStore.writer.recordHumanInput({ runId: k.run.id, text: '核对新提示' });
    const entries = [];
    for (let i = 0; i < 40; i++) entries.push(await material(own, `步骤 ${i}\n${'详细结果🚀'.repeat(200)}`));
    const lateState = await append(WATCH_INPUT.platform, '后期状态');
    const request = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq() };
    const layout = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, request);
    const text = layout.messages[0]!.text;
    const positions = [`o${speech.seq}`, `o${earlyState.seq}`, `o${entries[0]!.seq}`, `o${lateState.seq}`].map((id) =>
      text.indexOf(id),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const watcher = openWindow(own, request);
    const page = await call(watcher, 'observation_context', {});
    expect(page.json!.progress).toMatchObject({ coveredUntilSeq: request.untilSeq, complete: true });
    expect(page.json).not.toHaveProperty('nextCursor');
    expect(watcher.overview).toContain('后期状态');
    expect(watcher.overview).toContain('先确认输入条件');
    expect(watcher.overview).toContain('核对新提示');
    for (const id of [speech.id, earlyState.id, lateState.id]) expect(watcher.overview).not.toContain(id);
  });

  it('软截止接受冻结窗口内的引用，不延后方向更新，未展示的中间摘要仍留到下一轮', async () => {
    const s = await scene();
    const previous = k.runStore.writer.recordWatch({
      runId: k.run.id,
      branchId: s.own.branch.id,
      basedOnSeq: k.runStore.queries.lastSeq(),
      toolCalls: 1,
      model: s.own.bet.model,
      draft: attempted([s.first]),
    });
    const entries = [];
    // 较早步骤只保留首行摘要；首行也足够长，才能在扩大首屏后仍验证未读前缀。
    for (let i = 0; i < 180; i++) entries.push(await material(s.own, `步骤 ${i} ${'详细结果🚀'.repeat(200)}`));
    const closing = new AbortController();
    const request = { branchId: s.own.branch.id, untilSeq: k.runStore.queries.lastSeq(), previous };
    const watcher = openWindow(s.own, request, closing.signal);
    const first = await call(watcher, 'observation_context', {});
    const progress = first.json!.progress as { coveredUntilSeq: number; toolCalls: number };
    expect(progress.coveredUntilSeq).toBeLessThan(entries.at(-1)!.seq);
    closing.abort();
    const submission = attempted([entries.at(-1)!.id]);
    submission.directions[0]!.result = '尚未覆盖的最新结论';
    submission.directions[0]!.retired = true;
    submission.directions.push({
      id: 'dependent',
      direction: '引用未读证据的备选',
      status: 'untried',
      result: '待试',
      evidence: [entries.at(-1)!.id],
      attempts: [],
    });
    submission.directions.push({
      id: 'independent',
      direction: '已读材料的独立方向',
      status: 'works',
      result: '已执行',
      evidence: [entries[0]!.id],
      attempts: [{ id: 'one', action: '核对', result: '已执行', evidence: [entries[0]!.id] }],
    });

    const original = structuredClone(submission);
    const accepted = await call(watcher, 'observation_submit', watchInput(submission));
    expect(accepted.isError, accepted.content).toBe(false);
    expect(accepted.json!.warnings).toBeUndefined();
    expect(submission).toEqual(original);
    expect(watcher.publishedWatch).toMatchObject({
      basedOnSeq: progress.coveredUntilSeq,
      toolCalls: progress.toolCalls,
    });
    expect(watcher.publishedWatch!.directions[0]).toMatchObject({ retired: true, result: '尚未覆盖的最新结论' });
    expect(watcher.publishedWatch!.deliveredRefs).toContain(entries.at(-1)!.id);
    expect(watcher.publishedWatch!.directions.map((d) => d.id)).toEqual(['tests', 'dependent', 'independent']);
    const next = openWindow(s.own, { ...request, previous: watcher.publishedWatch });
    expect(await contextText(next)).toContain('步骤');
  });

  it('软截止时只有未知、不可见或冻结截止点之后的依据仍须退回', async () => {
    const s = await scene();
    const late = await material(s.own, '冻结之后');
    const closing = new AbortController();
    const watcher = openWindow(s.own, s.request, closing.signal);
    await contextText(watcher);
    closing.abort();
    for (const ref of ['unknown', s.hidden, late.id]) {
      const rejected = await call(watcher, 'observation_submit', watchInput(attempted([ref])));
      expect(rejected.isError).toBe(true);
      expect(watcher.publishedWatch).toBeUndefined();
    }
  });

  it('软截止下混合引用只保留窗口内执行依据，越界引用不写入历史', async () => {
    const s = await scene();
    const late = await material(s.own, '冻结之后');
    const closing = new AbortController();
    const watcher = openWindow(s.own, s.request, closing.signal);
    closing.abort();
    const accepted = await call(
      watcher,
      'observation_submit',
      watchInput(attempted([s.first, 'unknown', s.hidden, late.id])),
    );
    expect(accepted.isError, accepted.content).toBe(false);
    expect(accepted.json).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([expect.stringContaining('已忽略')]),
    });
    expect(watcher.publishedWatch!.directions[0]).toMatchObject({
      status: 'works',
      evidence: [s.first],
      attempts: [{ evidence: [s.first] }],
    });
  });

  it('达到 20 次后可提交最后一次尝试并归档，发布一次且历史不丢', async () => {
    const s = await scene();
    const initial = attempted([s.first]);
    initial.directions[0]!.attempts = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      action: '核对',
      result: '执行过',
      evidence: [s.first],
    }));
    const previous = k.runStore.writer.recordWatch({
      runId: k.run.id,
      branchId: s.own.branch.id,
      basedOnSeq: s.request.untilSeq,
      toolCalls: 1,
      model: s.own.bet.model,
      draft: initial,
    });
    const last = await material(s.own, '最终核对');
    const watcher = openWindow(s.own, { branchId: s.own.branch.id, untilSeq: k.runStore.queries.lastSeq(), previous });
    await contextText(watcher);
    const final = attempted([last.id]);
    final.directions[0]!.attempts[0]!.id = 'last';
    final.directions[0]!.result = '最终结论';
    final.directions[0]!.retired = true;
    const accepted = await call(watcher, 'observation_submit', watchInput(final));
    expect(accepted.isError, accepted.content).toBe(false);
    expect(watcher.publishedWatch!.directions[0]).toMatchObject({ retired: true, result: '最终结论' });
    expect(allWatchAttempts(watcher.publishedWatch!.directions[0]!)).toHaveLength(21);
    expect(watcher.publishedWatch!.directions[0]!.attempts).toHaveLength(20);
    expect(k.runStore.queries.events({ runId: k.run.id, since: 0, types: ['watch.noted'] })).toHaveLength(2);
  });

  it('单句 tension 明确退回且不写入；修正后发布原方向，不补造尝试', async () => {
    const s = await scene();
    const watcher = s.open();
    await contextText(watcher);
    const submission = attempted([s.first]);
    submission.directions.push({
      id: 'next',
      direction: '另一个有依据的方向',
      status: 'untried',
      result: '尚未尝试',
      evidence: [s.first],
      attempts: [],
    });

    submission.tension = ['缺少另一句'];
    const original = structuredClone(submission);
    const rejected = await call(watcher, 'observation_submit', watchInput(submission));
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain('tension');
    expect(watcher.publishedWatch).toBeUndefined();
    const accepted = await call(watcher, 'observation_submit', watchInput({ ...submission, tension: [] }));
    expect(accepted.isError, accepted.content).toBe(false);
    expect(watcher.publishedWatch).toMatchObject({
      tension: [],
    });
    expect(watcher.publishedWatch!.directions.map((d) => d.id)).toEqual(['tests', 'next']);
    expect(watcher.publishedWatch!.directions[1]!.attempts).toEqual([]);
    expect(submission).toEqual(original);
  });

  it('重试不改写无依据结论；补齐执行依据后发布原实测结论', async () => {
    const s = await scene();
    const watcher = s.open();
    await contextText(watcher);
    const submission = attempted([]);

    expect((await call(watcher, 'observation_submit', watchInput(submission))).content).toContain('至少一次尝试');
    expect(watcher.publishedWatch).toBeUndefined();
    expect((await call(watcher, 'observation_submit', watchInput(submission))).isError).toBe(true);
    expect(watcher.publishedWatch).toBeUndefined();
    const cycle = attempted([s.first]);
    expect((await call(watcher, 'observation_submit', watchInput(cycle))).isError).toBe(false);
    expect(watcher.publishedWatch!.directions[0]).toMatchObject({
      status: 'works',
      result: cycle.directions[0]!.result,
    });
    expect(watcher.publishedWatch!.directions[0]!.attempts).toHaveLength(1);
  });

  it('大段历史留在短背景，新增提示只出现一次，跨类事件和补充索引从首屏推进', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const old = await material(own, '旧执行');
    const history = '历史提示原文🚀'.repeat(6000);
    const oldHint = k.runStore.writer.recordHumanInput({ runId: k.run.id, text: history });
    for (const tool of [WATCH_INPUT.platform, WATCH_INPUT.extension]) {
      k.runStore.writer.appendObservation(
        {
          runId: k.run.id,
          branchId: own.branch.id,
          role: 'watcher',
          tool,
          args: {},
          summary: `宿主状态 ${'状态细节'.repeat(6000)}`,
          output: await k.runStore.artifacts!.put(k.run.id, history),
          snapshot: 'root',
        },
        { countsAsToolCall: false },
      );
    }
    const initial = attempted([old.id]);
    const previous = k.runStore.writer.recordWatch({
      runId: k.run.id,
      branchId: own.branch.id,
      basedOnSeq: k.runStore.queries.lastSeq(),
      toolCalls: 1,
      model: own.bet.model,
      draft: initial,
    });
    // HTTP 原记录不由布局展开，会由视图层补短索引；它也必须排在后来事件之前。
    const receipt = k.runStore.writer.appendObservation(
      {
        runId: k.run.id,
        branchId: own.branch.id,
        role: 'watcher',
        tool: WATCH_INPUT.http,
        args: {},
        summary: '早于步骤的 HTTP 回执',
        output: await k.runStore.artifacts!.put(k.run.id, 'HTTP/1.1 200 OK'),
        snapshot: 'root',
      },
      { countsAsToolCall: false },
    );
    const first = await material(own, 'first-new-step');
    const hint = k.runStore.writer.recordHumanInput({
      runId: k.run.id,
      text: '本窗口唯一的新提示',
    });
    const entries = [];
    for (let i = 0; i < 40; i++) entries.push(await material(own, `第 ${i} 步\n${'结果🚀'.repeat(200)}`));
    const request = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq(), previous };
    const layout = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, request);
    expect(Buffer.byteLength(layout.messages[0]!.text)).toBeLessThanOrEqual(WATCH_OVERVIEW_BYTES);
    expect(layout.messages[0]!.text).toContain(oldHint.inbox[0]!.id);
    expect(layout.messages[0]!.text).not.toContain('历史提示原文'.repeat(100));
    expect(layout.messages[0]!.text.split('本窗口唯一的新提示')).toHaveLength(2);
    const watcher = openWindow(own, request);
    const page = await call(watcher, 'observation_context', {});
    const progress = page.json!.progress as { coveredUntilSeq: number; complete: boolean };
    expect(progress.coveredUntilSeq).toBeGreaterThanOrEqual(hint.inbox[0]!.seq);
    expect(progress.complete).toBe(true);
    const text = watcher.overview;
    expect(text.indexOf('早于步骤的 HTTP 回执')).toBeLessThan(text.indexOf('first-new-step'));
    expect(watcher.overview).not.toContain(receipt.id);
    expect(watcher.overview).not.toContain(first.id);
    expect(text).toContain('本窗口唯一的新提示');
    expect(text).not.toContain('已登记实验条件');
    const published = await call(
      watcher,
      'observation_submit',
      watchInput({
        ...draft,
      }),
    );
    expect(published.isError, published.content).toBe(false);
    expect(watcher.publishedWatch?.basedOnSeq).toBe(progress.coveredUntilSeq);
    expect(watcher.publishedWatch?.directions[0]?.attempts).toEqual(initial.directions[0]!.attempts);
  });

  it('软截止保留有限纠错读取预算，耗尽后仍可提交，重读概览不能绕过预算', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const record = await material(own, '输出🚀'.repeat(10_000), 'inspect', '证据可按原文续读');
    const closing = new AbortController();
    const request = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq() };
    const layout = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, request);
    const watcher = k.gateway.open(
      { runId: k.run.id, branchId: own.branch.id, role: 'watcher', snapshot: 'root', readOnly: true },
      {
        observation: {
          request,
          input: layout.watch!,
          model: own.bet.model,
          closing: closing.signal,
          contextLimit: 100,
        },
      },
    );
    await call(watcher, 'observation_context', {});
    closing.abort();
    const first = await call(watcher, 'observation_context', { evidenceRefs: [record.output] });
    expect(first.isError, first.content).toBe(false);
    expect(first.json).toMatchObject({ phase: 'submit' });
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(WATCH_DETAIL_BYTES);
    expect((await call(watcher, 'observation_context', {})).json).toMatchObject({
      phase: 'submit',
      submissionRequired: true,
    });
    expect((await call(watcher, 'observation_context', { evidenceRefs: [record.output] })).content).toContain(
      '根据已有摘要提交判断',
    );
    const accepted = await call(watcher, 'observation_submit', watchInput(attempted([record.id])));
    expect(accepted.isError, accepted.content).toBe(false);
  });
  it('超长单行 JSON 按明确位置跨会话续读，UTF-8、转义和多份证据的总预算都不丢不重', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const text = JSON.stringify({ payload: '中文🚀"\\'.repeat(10_000) });
    expect(Buffer.byteLength(text)).toBeGreaterThan(100_000);
    const first = await material(own, text, 'large-json', '一行 JSON');
    const second = await material(own, '第二份材料', 'small', '另一条记录');
    const watcher = openWindow(own, undefined, undefined, 100);
    const another = openWindow(own, undefined, undefined, 100);
    const initial = await call(watcher, 'observation_context', {
      evidenceRefs: [first.output, second.output],
      limit: 1,
    });
    expect(initial.isError, initial.content).toBe(false);
    expect(Buffer.byteLength(initial.content)).toBeLessThanOrEqual(WATCH_DETAIL_BYTES);
    expect(initial.content).toContain('第二份材料');
    let row = (
      initial.json!.evidence as { ref: string; text: string; next?: { offset: number; column: number } }[]
    )[0]!;
    const chunks = [row.text];
    let count = 0;
    while (row.next) {
      const args = { evidenceRefs: [first.output], limit: 1, ...row.next };
      const page = await call(watcher, 'observation_context', args);
      expect(page.isError, page.content).toBe(false);
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(WATCH_DETAIL_BYTES);
      if (count === 0)
        expect((await call(another, 'observation_context', args)).json!.evidence).toEqual(page.json!.evidence);
      row = (page.json!.evidence as (typeof row)[])[0]!;
      chunks.push(row.text);
      expect(++count).toBeLessThan(100);
    }
    expect(chunks.join('')).toBe(text);
    const search = await call(watcher, 'observation_context', { query: { text: 'large-json' } });
    expect(search.content).toContain(`o${first.seq}`);
    expect(search.content).not.toContain('payload');
    expect(search.json!.records).toEqual([expect.objectContaining({ id: `o${first.seq}`, seq: first.seq })]);
  });

  it('骨架超预算时自动分轮；提前发布只确认已展示前缀，下一轮保留未读事件和旧尝试的证据', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const old = await material(own, '旧的执行依据', 'old');
    const previous = k.runStore.writer.recordWatch({
      runId: k.run.id,
      branchId: own.branch.id,
      basedOnSeq: k.runStore.queries.lastSeq(),
      toolCalls: 1,
      model: own.bet.model,
      draft: attempted([old.id]),
    });
    const entries = [];
    for (let i = 0; i < 250; i++)
      entries.push(await material(own, `输出 ${i}`, `command-${i}`, `完成 ${i} ${'材料🚀'.repeat(160)}`));
    const untilSeq = k.runStore.queries.lastSeq();
    const watcher = openWindow(own, { branchId: own.branch.id, untilSeq, previous });
    const page = await call(watcher, 'observation_context', {});
    expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(WATCH_OVERVIEW_BYTES);
    expect(page.json).not.toHaveProperty('assessments');
    expect(page.json).not.toHaveProperty('guidance');
    expect(page.json).not.toHaveProperty('platform');
    const progress = page.json!.progress as { coveredUntilSeq: number; toolCalls: number; complete: boolean };
    expect(progress.complete).toBe(false);
    expect(progress.coveredUntilSeq).toBeGreaterThan(previous.basedOnSeq);
    expect(progress.coveredUntilSeq).toBeLessThan(untilSeq);
    expect(page.json!.nextCursor).toBeUndefined();
    expect(watcher.overview).toContain(`[证据ID: o${entries[0]!.seq}]`);
    expect(page.content).not.toContain(old.id);
    const historical = await call(watcher, 'observation_context', { evidenceRefs: [old.id] });
    expect(historical.content).toContain('旧的执行依据');
    // 省略的旧方向保留已发布的旧尝试；新方向可以在同一次提交中创建并引用。
    const accepted = await call(
      watcher,
      'observation_submit',
      watchInput({
        ...draft,
        directions: [
          {
            id: 'new',
            direction: '新的备选',
            status: 'untried',
            result: '未试',
            evidence: [],
            attempts: [],
          },
        ],
      }),
    );
    expect(accepted.isError, accepted.content).toBe(false);
    expect(watcher.publishedWatch?.basedOnSeq).toBe(progress.coveredUntilSeq);
    expect(watcher.publishedWatch?.toolCalls).toBe(progress.toolCalls);
    const pending = entries.find((entry) => entry.seq > progress.coveredUntilSeq)!;
    const next = openWindow(own, {
      branchId: own.branch.id,
      untilSeq: k.runStore.queries.lastSeq(),
      previous: watcher.publishedWatch,
    });
    const resumed = await call(next, 'observation_context', {});
    expect(next.overview).toContain((pending.args as { cmd: string }).cmd);
    expect(resumed.json!.window).toMatchObject({ sinceSeq: progress.coveredUntilSeq });
  }, 15_000);

  it('没有执行时，空依据、主代理发言、提示和状态摘要都不能把测试通过发布到地图', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const refs: string[] = [];
    for (const tool of [WATCH_INPUT.speech, WATCH_INPUT.platform, WATCH_INPUT.extension]) {
      const output = await k.runStore.artifacts!.put(k.run.id, '接下来运行测试');
      const o = k.runStore.writer.appendObservation(
        {
          runId: k.run.id,
          branchId: own.branch.id,
          role: tool === WATCH_INPUT.speech ? 'explorer' : 'watcher',
          tool,
          args: {},
          summary: '接下来运行测试',
          output,
          snapshot: 'root',
        },
        { countsAsToolCall: false },
      );
      refs.push(o.id);
    }
    const hint = k.runStore.writer.recordHumanInput({ runId: k.run.id, text: '先跑测试' });
    refs.push(hint.input.id, ...hint.inbox.map((i) => i.id));
    const asm = new MelinaContextAssembler({ queries: k.runStore.queries });
    let previous: WatchRequest['previous'];
    for (const evidence of [[], ...refs.map((id) => [id]), refs]) {
      const watcher = openWindow(own, { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq(), previous });
      await call(watcher, 'observation_context', {});
      const rejected = await call(watcher, 'observation_submit', watchInput(attempted(evidence)));
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toContain('至少一次尝试');
      expect(watcher.publishedWatch).toBeUndefined();
      expect(watcher.closed()).toBeUndefined();
      const repeated = await call(watcher, 'observation_submit', watchInput(attempted(evidence)));
      expect(repeated.json).toMatchObject({ ok: false });
      expect(watcher.publishedWatch).toBeUndefined();
      const revised = attempted(evidence);
      revised.directions[0]!.status = 'unclear';
      revised.directions[0]!.result = '尚无执行结果';
      expect((await call(watcher, 'observation_submit', watchInput(revised))).isError).toBe(false);
      expect(asm.watchMap(own.branch.id)).not.toContain('测试通过');
      previous = watcher.publishedWatch;
    }
    expect(k.runStore.queries.getBranch(own.branch.id)?.toolCalls).toBe(0);
    // 提示可支持尚未尝试的方向，不能伪造一次尝试。
    const watcher = openWindow(own, { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq(), previous });
    expect((await call(watcher, 'observation_context', { contextRefs: [hint.input.id] })).isError).toBe(false);
    const untried = attempted([hint.input.id]);
    untried.directions[0]!.status = 'untried';
    untried.directions[0]!.result = '尚未执行';
    untried.directions[0]!.attempts = [];
    expect((await call(watcher, 'observation_submit', watchInput(untried))).json).toEqual({
      ok: true,
      revision: previous!.rev + 1,
    });
    expect(watcher.publishedWatch?.directions[0]).toMatchObject({ status: 'untried', attempts: [] });
    expect(asm.watchMap(own.branch.id)).not.toContain('测试通过');
  });

  it.each([WATCH_INPUT.receipt, WATCH_INPUT.http])('宿主采集的 %s 可单独证明实际尝试', async (tool) => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const output = await k.runStore.artifacts!.put(k.run.id, '实际请求得到响应');
    const o = k.runStore.writer.appendObservation(
      {
        runId: k.run.id,
        branchId: own.branch.id,
        role: 'watcher',
        tool,
        args: {},
        summary: '实际请求得到响应',
        output,
        snapshot: 'root',
      },
      { countsAsToolCall: false },
    );
    const watcher = openWindow(own);
    await call(watcher, 'observation_context', {});
    expect((await call(watcher, 'observation_submit', watchInput(attempted([o.id])))).json).toEqual({
      ok: true,
      revision: 1,
    });
    expect(k.runStore.queries.getBranch(own.branch.id)?.toolCalls).toBe(0);
  });

  it('失败的工具执行也算实际尝试，可如实发布 failed 结果', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const failed = await sh(openExplorer(k, own), 'echo test-failed; exit 1');
    const submission = attempted([failed]);
    const direction = submission.directions[0]!;
    direction.status = 'failed';
    direction.result = '测试失败';
    direction.attempts[0]!.result = '退出码为 1';
    const watcher = openWindow(own);
    await call(watcher, 'observation_context', {});
    expect((await call(watcher, 'observation_submit', watchInput(submission))).json).toEqual({ ok: true, revision: 1 });
    expect(latestWatch(k.runStore.queries, k.run.id, own.branch.id)?.directions[0]?.status).toBe('failed');
  });

  it('只提供两个入口，原文分页、历史查找共享固定截止点和分支可见性', async () => {
    const s = await scene(10);
    const watcher = s.open();
    expect(watcher.tools.map((t) => t.spec.name)).toEqual(['observation_context', 'observation_submit']);
    const first = k.runStore.queries.getObservation(s.first)!;
    const hidden = k.runStore.queries.getObservation(s.hidden)!;
    const later = await sh(s.solver, 'echo future-output');
    const future = k.runStore.queries.getObservation(later)!;
    const overview = await call(watcher, 'observation_context', {});
    expect(overview.json).toMatchObject({
      baseRevision: 0,
      window: { untilSeq: s.request.untilSeq },
    });
    const refs = [first.id, hidden.id, hidden.output, future.id, future.output];
    const page = await call(watcher, 'observation_context', { evidenceRefs: refs, limit: 1 });
    expect(page.json).not.toHaveProperty('delta');
    expect(page.json).not.toHaveProperty('task');
    expect(page.json).not.toHaveProperty('assessments');
    expect(page.json).toMatchObject({ baseRevision: 0, window: { untilSeq: s.request.untilSeq } });
    const evidence = page.json!.evidence as {
      ref: string;
      part?: string;
      text?: string;
      nextOffset?: number;
      unavailable?: string;
    }[];
    expect(evidence.find((e) => e.part === 'output')).toMatchObject({
      ref: `o${first.seq}`,
      next: { offset: 2, column: 0 },
    });
    expect(evidence.filter((e) => e.ref !== `o${first.seq}`).every((e) => e.unavailable === 'unknown_evidence')).toBe(
      true,
    );
    const next = await call(watcher, 'observation_context', { evidenceRefs: [first.output], offset: 2, limit: 1 });
    expect(next.content).toContain('second');
    expect((next.json!.evidence as { text: string }[])[0]!.text).not.toContain('third');
    const search = await call(watcher, 'observation_context', { query: { text: 'first' } });
    expect(search.content).toContain(`o${first.seq}`);
    expect(search.content).not.toContain('future-output');
    expect(search.content).not.toContain('hidden-output');
    expect(search.json).not.toHaveProperty('delta');
    expect(search.json).not.toHaveProperty('evidence');
    // 按需查询不移动窗口，空参数查询只返回覆盖进度。
    const final = await call(watcher, 'observation_context', {});
    expect(final.json!.progress).toEqual(overview.json!.progress);
    expect(final.json!.window).toEqual(overview.json!.window);
    expect((await call(watcher, 'read', { path: '/etc/passwd' })).isError).toBe(true);
  });

  it('错误引用反复退回且不发布；纠正后一次落库，地图立即可读，不能重复发布', async () => {
    const s = await scene();
    const watcher = s.open();
    const direction = {
      id: 'baseline',
      direction: '运行基线',
      status: 'works' as const,
      result: '得到输出',
      evidence: [s.hidden],
      attempts: [{ id: 't1', action: '输出三行', result: '有输出', evidence: [s.hidden] }],
    };
    for (let n = 0; n < 4; n++) {
      const rejected = await call(
        watcher,
        'observation_submit',
        watchInput({
          ...draft,
          directions: [direction],
        }),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.json).toMatchObject({ ok: false });
      expect(latestWatch(k.runStore.queries, k.run.id, s.own.branch.id)).toBeUndefined();
    }
    const context = await call(watcher, 'observation_context', {});
    expect(context.json).toMatchObject({ submissionAttempts: 4 });
    expect(context.json!.lastErrors).not.toEqual([]);
    const detail = await call(watcher, 'observation_context', { evidenceRefs: [s.first] });
    expect(detail.json).toMatchObject({ submissionAttempts: 4, lastErrors: context.json!.lastErrors });
    expect(detail.json).not.toHaveProperty('delta');
    const accepted = {
      ...draft,
      directions: [
        { ...direction, evidence: [s.first], attempts: [{ ...direction.attempts[0]!, evidence: [s.first] }] },
      ],
    };
    const result = await call(watcher, 'observation_submit', watchInput(accepted));
    expect(result.json).toEqual({ ok: true, revision: 1 });
    expect(result.terminate).toBe(true);
    expect(watcher.publishedWatch?.rev).toBe(1);
    expect(s.asm.watchMap(s.own.branch.id)).toContain('运行基线');
    expect((await call(watcher, 'observation_submit', watchInput(accepted))).isError).toBe(true);
    expect(k.runStore.queries.events({ runId: k.run.id, since: 0, types: ['watch.noted'] })).toHaveLength(1);
  });

  it('其他窗口发布后拒绝旧窗口；已中断的提交不发布', async () => {
    const s = await scene();
    const stale = s.open();
    const current = s.open();
    expect((await call(current, 'observation_submit', watchInput(draft))).isError).toBe(false);
    expect((await call(stale, 'observation_submit', watchInput(draft))).content).toContain('窗口已过期');
    const stop = new AbortController();
    stop.abort();
    const tool = stale.tools.find((t) => t.spec.name === 'observation_submit')!;
    expect((await tool.run({ id: 'cancelled', name: tool.spec.name, args: draft }, stop.signal)).isError).toBe(true);
    expect(latestWatch(k.runStore.queries, k.run.id, s.own.branch.id)?.rev).toBe(1);
  });

  it('模型与执行入口共用精简 schema，已删除的台账不再接受或合并', async () => {
    const s = await scene();
    const watcher = s.open();
    const spec = watcher.tools.find((tool) => tool.spec.name === 'observation_submit')!.spec;
    expect(spec.parameters).toEqual(
      s.asm.forWatcher(k.run.id, s.request).tools.find((tool) => tool.name === 'observation_submit')!.parameters,
    );
    expect(isValid(SubmitWatchArgs, attempted([s.first]))).toBe(true);
    for (const removed of ['baselines', 'reviews', 'learning', 'comparedWith'])
      expect(JSON.stringify(spec.parameters)).not.toContain(`"${removed}"`);
    const oldAttempt = attempted([s.first]);
    const legacy = {
      ...oldAttempt,
      directions: oldAttempt.directions.map((d) => ({
        ...d,
        attempts: d.attempts.map((a) => ({ ...a, learning: { validity: 'valid' } })),
      })),
    };
    for (const input of [{ ...draft, baselines: [] }, { ...draft, reviews: [] }, legacy]) {
      expect((await call(watcher, 'observation_submit', input)).isError).toBe(true);
      expect(watcher.publishedWatch).toBeUndefined();
    }
    await contextText(watcher);
    expect((await call(watcher, 'observation_submit', watchInput(oldAttempt))).json).toEqual({ ok: true, revision: 1 });
  });
});
