import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BenchmarkWatchInputs, platformState } from '../../../extensions/ctf/watch-input.ts';
import { WatchInputs } from '../../../src/api/watch-input.ts';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { newId } from '../../../src/core/ids.ts';
import { type SubmitWatchArgs, TOOL } from '../../../src/core/tools.ts';
import { WATCH_HTTP_BYTES } from '../../../src/core/watch-budget.ts';
import { WATCH_INPUT, type WatchPlatform } from '../../../src/core/watch-input.ts';
import { freezeWatchWindow } from '../../../src/projections/watch-window.ts';
import { watchInput } from '../../fixtures/watch.ts';
import { branch, call, type Kit, kit, openExplorer, SECRET, sh } from '../tools/gateway-kit.ts';

const kits: Kit[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of kits.splice(0)) k.cleanup();
});
const progress = {
  unique_code: 'fixture',
  flag_count: 3,
  remaining_flag_count: 1,
  accepted_flags: ['flag{first}', 'flag{second}'],
  rejected_flags: ['flag{wrong}'],
  hint_status: 'available',
  hint: '检查另一登录面的认证逻辑',
};
const draft = (over: Partial<SubmitWatchArgs> = {}): SubmitWatchArgs => ({
  standing: '尚有目标未验收',
  directions: [],
  tension: [],
  advice: '',
  ...over,
});
async function prepareInputs(
  inputs: WatchInputs,
  run: Kit['run'],
  request: Parameters<WatchInputs['read']>[1],
  extensions: Parameters<WatchInputs['collect']>[2],
  signal: AbortSignal,
) {
  const k = kits.find((k) => k.run.id === run.id)!;
  await inputs.collect(run, request.branchId, extensions, signal);
  return inputs.read(run, freezeWatchWindow(k.runStore.queries, run.id, request, k.runStore.queries.lastSeq()), signal);
}

async function scene(enabled = true) {
  const k = kit({ completion: false, config: { watch: { enabled } } });
  kits.push(k);
  k.run = k.runStore.writer.draftCompletion(k.run.id, {
    completion: { interpretation: '平台验收', criteria: ['全部验收'] },
    constraints: [],
    domain: 'ctf',
  });
  const own = await branch(k, { kind: 'direct' });
  k.runStore.writer.updateBranch(own.branch.id, { workspace: { path: own.ws } });
  const other = await branch(k);
  const inputs = new WatchInputs({
    queries: k.runStore.queries,
    writer: k.runStore.writer,
    artifacts: k.runStore.artifacts!,
    redactor: k.redactor,
    log: { warn: (text) => k.errors.push(text) },
  });
  const path = join(k.views.branchDir(k.run.id, own.branch.id), 'BENCHMARK_PROGRESS.json');
  await writeFile(path, JSON.stringify({ ...progress, run_id: k.run.id }));
  const benchmark = new BenchmarkWatchInputs({ queries: k.runStore.queries, paths: { dataDir: k.views.dataDir } });
  const prepare = (previous?: Parameters<MelinaContextAssembler['forWatcher']>[1]['previous']) =>
    prepareInputs(
      inputs,
      k.run,
      { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq(), ...(previous ? { previous } : {}) },
      [
        { tools: [], watcherInput: (runId, branchId, input) => benchmark.collect(runId, branchId, input) },
        { tools: [], watcherInput: async () => '{"source":"extension-fixture","pending":42}' },
      ],
      new AbortController().signal,
    );
  return {
    k,
    own,
    other,
    inputs,
    path,
    prepare,
    assembler: new MelinaContextAssembler({ queries: k.runStore.queries }),
  };
}

it('宿主刷新后仍遵守截窗，状态、HTTP 和工具计数都不越过截止点', async () => {
  const { k, own, inputs } = await scene();
  const observations = [];
  for (let i = 0; i < 5; i++) {
    observations.push(
      k.runStore.writer.appendObservation(
        {
          runId: k.run.id,
          branchId: own.branch.id,
          role: 'explorer',
          tool: 'sh',
          args: { cmd: `curl http://fixture/${i}` },
          summary: `第 ${i} 次`,
          output: await k.runStore.artifacts!.put(k.run.id, `HTTP/1.1 200 OK request-${i}`),
          snapshot: 'root',
        },
        { countsAsToolCall: true },
      ),
    );
  }
  const request = await prepareInputs(
    inputs,
    k.run,
    {
      branchId: own.branch.id,
      untilSeq: observations[1]!.seq,
      window: { maxSteps: 2, maxBytes: 48 * 1024 },
    },
    [{ tools: [], watcherInput: async () => '最新宿主扩展状态' }],
    new AbortController().signal,
  );
  expect(request.untilSeq).toBe(observations[2]!.seq - 1);
  expect(request.toolCalls).toBe(2);
  expect(request.activity?.toolCalls).toBe(2);
  expect(request.http?.map((h) => h.observation)).toEqual(observations.slice(0, 2).map((o) => o.id));
  expect(k.runStore.queries.lastSeq()).toBeGreaterThan(request.untilSeq);
  const text = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, request).messages[0]!
    .text;
  expect(text).toContain('最新宿主扩展状态'); // 最新状态独立冻结，执行仍停在历史边界。
  expect(text).not.toContain('request-2');
});

it('多份 HTTP 摘录共享最终 Markdown 的 UTF-8 预算，原文仍完整可读', async () => {
  const { k, own, prepare } = await scene();
  const refs = [];
  for (let i = 0; i < 12; i++) {
    const raw = `HTTP/1.1 200 OK\n${JSON.stringify({ value: '中文🚀"\\'.repeat(1500) })}`;
    const output = await k.runStore.artifacts!.put(k.run.id, raw);
    refs.push({ output, raw });
    k.runStore.writer.appendObservation(
      {
        runId: k.run.id,
        branchId: own.branch.id,
        role: 'explorer',
        tool: 'sh',
        args: { cmd: `curl http://fixture/${i}` },
        summary: 'HTTP 已返回',
        output,
        snapshot: 'root',
      },
      { countsAsToolCall: true },
    );
  }
  const request = await prepare();
  expect(Buffer.byteLength(JSON.stringify(request.http), 'utf8')).toBeLessThanOrEqual(WATCH_HTTP_BYTES);
  expect(request.http?.length).toBeGreaterThan(0);
  expect(request.http?.[0]?.text).not.toContain('\ufffd');
  const raw = await k.runStore.artifacts!.readLines(k.run.id, refs[0]!.output);
  expect(raw.text).toBe(refs[0]!.raw);
});

it('每轮冻结平台和扩展状态，主代理发言及 HTTP 原文独立可见，保持分支和截止点隔离', async () => {
  const { k, own, other, inputs, prepare, assembler } = await scene();
  const caller = {
    runId: k.run.id,
    role: 'explorer' as const,
    branchId: own.branch.id,
    episode: 1,
    snapshot: 'root',
    readOnly: false,
  };
  inputs.publicText(caller, `我先获取题目状态 ${SECRET.value}`);
  inputs.publicText({ ...caller, branchId: other.branch.id }, '其他路线私有发言');
  inputs.publicText({ ...caller, role: 'watcher' }, '观察者自己的发言');
  const raw = 'HTTP/1.1 401 Unauthorized\nServer: fixture\n\nlogin required';
  k.runStore.writer.appendObservation(
    {
      runId: k.run.id,
      branchId: own.branch.id,
      role: 'explorer',
      tool: 'sh',
      args: { cmd: 'curl http://fixture/login' },
      summary: '输出末尾没有状态行',
      output: await k.runStore.artifacts!.put(k.run.id, raw),
      snapshot: 'root',
    },
    { countsAsToolCall: true },
  );
  const request = await prepare();
  const text = assembler.forWatcher(k.run.id, request).messages[0]!.text;
  expect(request.toolCalls).toBe(1);
  expect(text).toContain('我先获取题目状态');
  expect(text).not.toContain(SECRET.value);
  expect(text).not.toContain('其他路线私有发言');
  expect(text).not.toContain('观察者自己的发言');
  expect(text).toContain('HTTP/1.1 401 Unauthorized');
  expect(text).toContain(progress.hint);
  expect(text).toContain('extension-fixture');
  const note = k.runStore.writer.recordWatch({
    runId: k.run.id,
    branchId: own.branch.id,
    basedOnSeq: request.untilSeq,
    toolCalls: 1,
    model: own.bet.model,
    draft: draft(),
  });
  const next = await prepare(note);
  const again = assembler.forWatcher(k.run.id, next).messages[0]!.text;
  expect(assembler.forWatcher(k.run.id, next).messages[0]!.text).toContain('extension-fixture');
  expect(again).toContain(progress.hint);
  expect(again).toContain('extension-fixture');
  expect(again).not.toContain('我先获取题目状态');
  inputs.publicText(caller, '截止点之后的新判断');
  k.runStore.writer.appendObservation(
    {
      runId: k.run.id,
      branchId: own.branch.id,
      role: 'explorer',
      tool: 'sh',
      args: { cmd: 'echo future' },
      summary: '后续执行',
      output: await k.runStore.artifacts!.put(k.run.id, '后续执行'),
      snapshot: 'root',
    },
    { countsAsToolCall: true },
  );
  await prepare(note);
  expect(assembler.forWatcher(k.run.id, request).messages[0]!.text).toBe(text);
});

it('两条验收回执各生成一个 flag 节点，只连接引用对应回执的成功方向，跨轮保留', async () => {
  const { k, own, prepare } = await scene();
  const request = await prepare();
  const status = k.runStore.queries
    .events({ runId: k.run.id, since: 0, types: ['observation.created'] })
    .find((e) => e.type === 'observation.created' && e.data.tool === WATCH_INPUT.platform);
  if (status?.type !== 'observation.created') throw new Error('missing platform');
  const state = status.data.args as WatchPlatform;
  const receipt = state.accepted[0]!.receipt!;
  const base = {
    runId: k.run.id,
    branchId: own.branch.id,
    basedOnSeq: request.untilSeq,
    toolCalls: 0,
    model: own.bet.model,
  };
  const note = k.runStore.writer.recordWatch({
    ...base,
    draft: draft({
      directions: [
        {
          id: 'login',
          direction: '认证逻辑',
          status: 'works',
          result: '首个目标验收',
          evidence: [receipt],
          attempts: [{ id: 't1', action: '验证认证逻辑', result: '验收', evidence: [receipt] }],
        },
      ],
    }),
  });
  expect(note.advice).toBe('');
  expect(note.directions[0]).toMatchObject({ id: 'login', direction: '认证逻辑' });
  expect(note.flags).toHaveLength(2);
  expect(note.flags![0]).toMatchObject({ receipt, dependsOn: ['login'] });
  expect(note.flags![1]!.dependsOn).toEqual([]);
  expect(JSON.stringify(note.flags)).not.toContain('wrong');
  const next = await prepare(note);
  const second = k.runStore.writer.recordWatch({ ...base, basedOnSeq: next.untilSeq, draft: draft() });
  expect(second.flags).toEqual(note.flags);
});

it('独立 HTTP 日志进入固定窗口，未变化的不重复收录，不沿符号链接读取其他文件', async () => {
  const { k, own, prepare, assembler } = await scene();
  const directory = join(own.ws, 'BENCHMARK_TRAFFIC', 'generation-1');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'responses.jsonl'), '{"request":"GET http://fixture/api","response":"独立响应"}');
  const privateFile = join(k.dir, 'private.log');
  await writeFile(privateFile, 'HTTP/1.1 200 私有文件内容');
  await symlink(privateFile, join(directory, 'outside.log'));
  const request = await prepare();
  const text = assembler.forWatcher(k.run.id, request).messages[0]!.text;
  expect(text).toContain('独立响应');
  expect(text).not.toContain('私有文件内容');
  const note = k.runStore.writer.recordWatch({
    runId: k.run.id,
    branchId: own.branch.id,
    basedOnSeq: request.untilSeq,
    toolCalls: 0,
    model: own.bet.model,
    draft: draft(),
  });
  const next = await prepare(note);
  expect(next.http).toEqual([]);
  await writeFile(join(directory, 'responses.jsonl'), '{"request":"GET http://fixture/api","response":"新的响应"}');
  expect((await prepare(note)).http?.[0]?.text).toContain('新的响应');
});

it('观察工具能展开宿主回执和 HTTP 原文，并按对应回执发布 flag 关系', async () => {
  const { k, own, prepare, assembler } = await scene();
  const directory = join(own.ws, 'BENCHMARK_TRAFFIC');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'response.log'), 'HTTP/1.1 200 OK\n独立证据');
  const request = await prepare();
  const observations = k.runStore.queries
    .events({ runId: k.run.id, since: 0, types: ['observation.created'] })
    .flatMap((e) => (e.type === 'observation.created' ? [e.data] : []));
  const receipt = observations.find((o) => o.tool === WATCH_INPUT.receipt)!;
  const http = observations.find((o) => o.tool === WATCH_INPUT.http)!;
  const watcher = k.gateway.open(
    { runId: k.run.id, branchId: own.branch.id, role: 'watcher', snapshot: 'root', readOnly: true },
    {
      observation: {
        request,
        input: assembler.forWatcher(k.run.id, request).watch!,
        model: own.bet.model,
      },
    },
  );
  await call(watcher, TOOL.observationContext, {});
  const evidence = await call(watcher, TOOL.observationContext, { evidenceRefs: [receipt.id, http.id] });
  expect(evidence.isError, evidence.content).toBe(false);
  expect(evidence.content).toContain('独立证据');
  expect(evidence.content).not.toContain('unknown_evidence');
  const submitted = await call(
    watcher,
    TOOL.submitWatch,
    watchInput(
      draft({
        directions: [
          {
            id: 'solve',
            direction: '认证逻辑',
            status: 'works',
            result: '已验收',
            evidence: [receipt.id],
            attempts: [{ id: 't1', action: '验证', result: '已验收', evidence: [http.id, receipt.id] }],
          },
        ],
      }),
    ),
  );
  expect(submitted.isError, submitted.content).toBe(false);
  expect(submitted.terminate).toBe(true);
  expect(watcher.publishedWatch?.flags?.[0]?.dependsOn).toEqual(['solve']);
  expect(watcher.publishedWatch?.flags?.[1]?.dependsOn).toEqual([]);
});

it('迟到的验收来源补齐新回执并连接原始观测，历史不改写，前一 Run 的来源不冒充本轮证据', async () => {
  const { k, own, path, prepare, assembler } = await scene();
  const origin = await sh(openExplorer(k, own), 'printf "verified response"');
  const request = await prepare();
  const base = { runId: k.run.id, branchId: own.branch.id, model: own.bet.model, toolCalls: 1 };
  const before = k.runStore.writer.recordWatch({
    ...base,
    basedOnSeq: request.untilSeq,
    draft: draft({
      directions: [
        {
          id: 'result',
          direction: '取得响应',
          status: 'works',
          result: '响应可用',
          evidence: [origin],
          attempts: [{ id: 'one', action: '请求', result: '取得响应', evidence: [origin] }],
        },
      ],
    }),
  });
  expect(before.flags?.map((flag) => flag.dependsOn)).toEqual([[], []]);
  const source = {
    run_id: k.run.id,
    branch_id: own.branch.id,
    observation_id: origin,
    output: k.runStore.queries.getObservation(origin)!.output,
    tool: 'sh',
    command: 'printf "verified response"',
  };
  await writeFile(
    path,
    JSON.stringify({
      ...progress,
      run_id: k.run.id,
      accepted_sources: {
        [progress.accepted_flags[0]!]: source,
        [progress.accepted_flags[1]!]: { ...source, run_id: newId() },
      },
    }),
  );
  const next = await prepare(before);
  const after = k.runStore.writer.recordWatch({ ...base, basedOnSeq: next.untilSeq, draft: draft() });
  expect(after.flags?.map((flag) => flag.dependsOn)).toEqual([['result'], []]);
  expect(after.flags?.[0]?.source).toMatchObject({ runId: k.run.id, branchId: own.branch.id, observationId: origin });
  expect(after.flags?.[0]?.receipt).not.toBe(before.flags?.[0]?.receipt);
  expect(before.flags?.[0]?.source).toBeUndefined();
  const context = assembler.forWatcher(k.run.id, next).messages[0]!.text;
  expect(context).not.toContain(origin);
  expect(context).toContain('仅供追溯；证据请引用本分支平台回执');
  expect(context.slice(0, context.indexOf('# 你上一版的看法'))).toContain(source.command);
  const again = await prepare(after);
  const stable = k.runStore.writer.recordWatch({ ...base, basedOnSeq: again.untilSeq, draft: draft() });
  expect(stable.flags).toEqual(after.flags);
  expect(
    platformState({ ...progress, accepted_sources: { [progress.accepted_flags[0]!]: { observation_id: origin } } })
      .accepted[0]?.source,
  ).toBeUndefined();
});

it('跨分支验收来源仅供追溯，所有读取入口均不暴露来源 ID', async () => {
  const { k, own, other, path, prepare, assembler } = await scene();
  const origin = await sh(openExplorer(k, other), 'printf "peer response"');
  const source = {
    run_id: k.run.id,
    branch_id: other.branch.id,
    observation_id: origin,
    output: k.runStore.queries.getObservation(origin)!.output,
    tool: 'sh',
    command: 'printf "peer response"',
  };
  await writeFile(
    path,
    JSON.stringify({ ...progress, run_id: k.run.id, accepted_sources: { [progress.accepted_flags[0]!]: source } }),
  );
  const request = await prepare();
  const layout = assembler.forWatcher(k.run.id, request);
  const observations = layout.watch!.records.flatMap((r) => (r.kind === 'observation' ? [r.record] : []));
  const receipt = observations.find((o) => o.tool === WATCH_INPUT.receipt)!;
  const platform = observations.find((o) => o.tool === WATCH_INPUT.platform)!;
  const watcher = k.gateway.open(
    { runId: k.run.id, branchId: own.branch.id, role: 'watcher', snapshot: 'root', readOnly: true },
    { observation: { request, input: layout.watch!, model: own.bet.model } },
  );
  const assertVisible = (text: string) => {
    expect(text).toContain('仅供追溯；证据请引用本分支平台回执');
    for (const hidden of [origin, other.branch.id, source.output]) expect(text).not.toContain(hidden);
  };
  assertVisible(layout.messages[0]!.text);
  for (const part of ['record', 'output'] as const) {
    const result = await call(watcher, TOOL.observationContext, {
      evidenceRefs: [receipt.id, platform.id],
      part,
    });
    expect(result.isError, result.content).toBe(false);
    assertVisible(result.content);
  }
  const byHandle = await call(watcher, TOOL.observationContext, { evidenceRefs: [receipt.output, platform.output] });
  expect(byHandle.isError, byHandle.content).toBe(false);
  assertVisible(byHandle.content);
  const submitted = await call(
    watcher,
    TOOL.submitWatch,
    watchInput(
      draft({
        directions: [
          {
            id: 'accepted',
            direction: '平台验收',
            status: 'works',
            result: '平台已验收首个目标',
            evidence: [receipt.id],
            attempts: [],
          },
        ],
      }),
    ),
  );
  expect(submitted.isError, submitted.content).toBe(false);
  const note = watcher.publishedWatch!;
  expect(note.flags?.[0]).toMatchObject({
    receipt: receipt.id,
    dependsOn: ['accepted'],
    source: { runId: k.run.id, branchId: other.branch.id, observationId: origin, output: source.output },
  });
  assertVisible(assembler.forWatcher(k.run.id, { ...request, previous: note }).messages[0]!.text);
});

it('宿主把外部分支的 flag 关联到产出方向，消费者无需重提回执，来源查询遵守冻结边界', async () => {
  const { k, own, path, prepare } = await scene();
  const producer = await branch(k, { kind: 'direct' });
  const origin = await sh(openExplorer(k, producer), 'printf "accepted result"');
  const publishProducer = (id: string) =>
    k.runStore.writer.recordWatch({
      runId: k.run.id,
      branchId: producer.branch.id,
      basedOnSeq: k.runStore.queries.lastSeq(),
      toolCalls: 1,
      model: producer.bet.model,
      draft: draft({
        directions: [
          {
            id,
            direction: '产出目标',
            status: 'works',
            result: '平台接受原始结果',
            evidence: [origin],
            attempts: [{ id: 't1', action: '取得结果', result: '成功', evidence: [origin] }],
          },
        ],
      }),
    });
  publishProducer('produce');
  await writeFile(
    path,
    JSON.stringify({
      ...progress,
      run_id: k.run.id,
      accepted_sources: {
        [progress.accepted_flags[0]!]: { run_id: k.run.id, branch_id: producer.branch.id, observation_id: origin },
      },
    }),
  );
  const request = await prepare();
  publishProducer('late-assessment');
  const publish = (until: number) =>
    k.runStore.writer.recordWatch({
      runId: k.run.id,
      branchId: own.branch.id,
      basedOnSeq: until,
      toolCalls: 0,
      model: own.bet.model,
      draft: draft(),
    });
  const first = publish(request.untilSeq);
  expect(first.directions).toEqual([]);
  expect(first.flags?.[0]).toMatchObject({
    dependsOn: [],
    source: { runId: k.run.id, branchId: producer.branch.id, observationId: origin, directionIds: ['produce'] },
  });
  const receipt = k.runStore.queries.getObservation(first.flags![0]!.receipt)!;
  expect(receipt).toMatchObject({ branchId: own.branch.id, tool: WATCH_INPUT.receipt });
  const next = await prepare(first);
  const second = publish(next.untilSeq);
  expect(second.flags?.[0]?.source?.directionIds).toEqual(['produce', 'late-assessment']);
  expect(first.flags?.[0]?.source?.directionIds).toEqual(['produce']);
  expect(second.directions).toEqual([]);
});

it('缺失或损坏宿主状态不采信 workspace 的完成声明，不从总数制造验收回执', async () => {
  const { k, own, prepare, path, assembler } = await scene();
  await unlink(path);
  await mkdir(own.ws, { recursive: true });
  await writeFile(join(own.ws, 'BENCHMARK_PROGRESS.json'), JSON.stringify({ ...progress, remaining_flag_count: 0 }));
  const request = await prepare();
  expect(assembler.forWatcher(k.run.id, request).messages[0]!.text).toContain('当前平台状态不可用');
  const note = k.runStore.writer.recordWatch({
    runId: k.run.id,
    branchId: own.branch.id,
    basedOnSeq: request.untilSeq,
    toolCalls: 0,
    model: own.bet.model,
    draft: draft(),
  });
  expect(note.flags).toBeUndefined();
  expect(() => platformState({ ...progress, accepted_flags: undefined })).toThrow();
  expect(() => platformState({ ...progress, remaining_flag_count: -1 })).toThrow();
  expect(() => platformState({ ...progress, filtered_local_candidates: [123] })).toThrow();
  expect(platformState({ ...progress, accepted_flags: [] }).accepted).toEqual([]);
  expect(platformState({ ...progress, filtered_local_candidates: ['flag{VM_KEY07}'] }).filteredCount).toBe(1);
});

it('发言只在观察轮次合并存档，关闭巡检器时不存档', async () => {
  for (const enabled of [true, false]) {
    const { k, own, inputs, prepare } = await scene(enabled);
    const caller = {
      runId: k.run.id,
      branchId: own.branch.id,
      role: 'explorer' as const,
      snapshot: 'root',
      readOnly: false,
    };
    const seq = k.runStore.queries.lastSeq();
    inputs.publicText(caller, '第一段判断');
    inputs.publicText(caller, '第二段判断');
    expect(k.runStore.queries.lastSeq()).toBe(seq);
    await prepare();
    const speech = k.runStore.queries.observations(own.branch.id).items.filter((o) => o.tool === WATCH_INPUT.speech);
    expect(speech).toHaveLength(enabled ? 1 : 0);
    if (enabled) {
      expect(speech[0]?.summary).toContain('第一段判断');
      expect(speech[0]?.summary).toContain('第二段判断');
    }
  }
});

it('旧 Run 的平台反馈不生成验收回执', async () => {
  const { k, own, path, prepare } = await scene();
  await writeFile(path, JSON.stringify({ ...progress, run_id: newId() }));
  await prepare();
  const observations = k.runStore.queries.observations(own.branch.id).items;
  expect(observations.filter((o) => o.tool === WATCH_INPUT.receipt)).toEqual([]);
  expect(observations.find((o) => o.tool === WATCH_INPUT.platform)?.summary).toContain('平台状态不可用');
});

it.each(['artifact', 'store'] as const)('发言在 %s 存档失败后重试，期间到达的发言也保留', async (failure) => {
  const { k, own, inputs } = await scene();
  const caller = {
    runId: k.run.id,
    branchId: own.branch.id,
    role: 'explorer' as const,
    snapshot: 'root',
    readOnly: false,
  };
  inputs.publicText(caller, '失败前的发言');
  if (failure === 'artifact')
    vi.spyOn(k.runStore.artifacts!, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
  else
    vi.spyOn(k.runStore.writer, 'appendObservation').mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
  const signal = new AbortController().signal;
  await expect(inputs.collect(k.run, own.branch.id, [], signal)).rejects.toThrow('storage unavailable');
  inputs.publicText(caller, '失败后的发言');
  await inputs.collect(k.run, own.branch.id, [], signal);
  await inputs.collect(k.run, own.branch.id, [], signal);
  const speech = k.runStore.queries.observations(own.branch.id).items.filter((o) => o.tool === WATCH_INPUT.speech);
  expect(speech).toHaveLength(1);
  expect(speech[0]!.summary).toBe('失败前的发言\n\n失败后的发言');
});

it('存档期间新发言不会被确认掉；截窗外的已存档发言下一轮仍可读取', async () => {
  const { k, own, inputs } = await scene();
  const caller = {
    runId: k.run.id,
    branchId: own.branch.id,
    role: 'explorer' as const,
    snapshot: 'root',
    readOnly: false,
  };
  for (let i = 0; i < 2; i++) await sh(openExplorer(k, own), `echo step-${i}`);
  inputs.publicText(caller, '第一批发言');
  const put = k.runStore.artifacts!.put.bind(k.runStore.artifacts!);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(k.runStore.artifacts!, 'put').mockImplementationOnce(async (runId, raw) => {
    await gate;
    return put(runId, raw);
  });
  const signal = new AbortController().signal;
  const saving = inputs.collect(k.run, own.branch.id, [], signal);
  inputs.publicText(caller, '写入期间的新发言');
  release();
  await saving;
  await inputs.collect(k.run, own.branch.id, [], signal);
  const speech = k.runStore.queries
    .observations(own.branch.id)
    .items.filter((o) => o.tool === WATCH_INPUT.speech)
    .sort((a, b) => a.seq - b.seq);
  speech.sort((a, b) => a.seq - b.seq);
  expect(speech.map((o) => o.summary)).toEqual(['第一批发言', '写入期间的新发言']);
  const request = freezeWatchWindow(
    k.runStore.queries,
    k.run.id,
    {
      branchId: own.branch.id,
      untilSeq: k.runStore.queries.lastSeq(),
      window: { maxSteps: 1, maxBytes: 48 * 1024 },
    },
    k.runStore.queries.lastSeq(),
  );
  expect(request.untilSeq).toBeLessThan(speech[0]!.seq);
  const seq = k.runStore.queries.lastSeq();
  expect(await inputs.read(k.run, request, signal)).toMatchObject(request);
  expect(k.runStore.queries.lastSeq()).toBe(seq);
  const previous = k.runStore.writer.recordWatch({
    runId: k.run.id,
    branchId: own.branch.id,
    basedOnSeq: request.untilSeq,
    toolCalls: request.toolCalls!,
    model: own.bet.model,
    draft: draft(),
  });
  const next = freezeWatchWindow(
    k.runStore.queries,
    k.run.id,
    { branchId: own.branch.id, untilSeq: seq, previous },
    seq,
  );
  const text = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, next).messages[0]!.text;
  expect(text).toContain('第一批发言');
  expect(text).toContain('写入期间的新发言');
});
