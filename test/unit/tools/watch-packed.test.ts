import { afterEach, describe, expect, it } from 'vitest';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { newId } from '../../../src/core/ids.ts';
import type { WatchRequest } from '../../../src/core/interfaces/context.ts';
import { WATCH_OVERVIEW_BYTES } from '../../../src/core/watch-budget.ts';
import { watchInput } from '../../fixtures/watch.ts';
import { type BranchKit, branch, call, type Kit, kit } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());
const draft = { standing: '核对执行结果', advice: '' };
async function action(own: BranchKit, index: number, summary = `动作 ${index} 完成`) {
  return k.runStore.writer.appendObservation(
    {
      runId: k.run.id,
      branchId: own.branch.id,
      role: 'explorer',
      tool: 'sh',
      args: { cmd: `inspect-${index}` },
      summary,
      output: await k.runStore.artifacts!.put(k.run.id, `原始输出 ${index}`),
      snapshot: 'root',
    },
    { countsAsToolCall: true },
  );
}
function open(
  own: BranchKit,
  request: WatchRequest = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq() },
  closing?: AbortSignal,
) {
  const layout = new MelinaContextAssembler({ queries: k.runStore.queries }).forWatcher(k.run.id, request);
  const session = k.gateway.open(
    { runId: k.run.id, branchId: own.branch.id, role: 'watcher', readOnly: true, snapshot: 'root' },
    {
      observation: {
        request,
        input: layout.watch!,
        model: own.bet.model,
        closing,
      },
    },
  );
  return Object.assign(session, { overview: layout.messages[0]!.text });
}

describe('预装骨架与执行证据短码', () => {
  it('混合引用的笔误只告警，持久化有效证据并自动保留历史尝试', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const old = await action(own, 1);
    const direction = { id: 'content-discovery', direction: '内容发现', status: 'works', result: '发现入口' };
    const first = open(own);
    expect(
      (
        await call(first, 'observation_submit', {
          ...draft,
          directions: [
            {
              ...direction,
              evidence: [`o${old.seq}`],
            },
          ],
        })
      ).json,
    ).toEqual({ ok: true, revision: 1 });
    const fresh = await action(own, 2);
    const watcher = open(own, {
      branchId: own.branch.id,
      untilSeq: k.runStore.queries.lastSeq(),
      previous: first.publishedWatch,
    });
    const accepted = await call(watcher, 'observation_submit', {
      ...draft,
      directions: [
        {
          ...direction,
          evidence: [`o${old.seq}`, 'o311811', `o${fresh.seq}`],
        },
      ],
    });
    expect(accepted.isError, accepted.content).toBe(false);
    expect(accepted.terminate).toBe(true);
    expect(accepted.json).toEqual({
      ok: true,
      revision: 2,
      warnings: [expect.stringContaining('o311811')],
    });
    const events = k.runStore.queries.events({ runId: k.run.id, since: 0, types: ['watch.noted'] });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('o311811');
    expect(watcher.publishedWatch).toMatchObject({
      directions: [
        {
          id: 'content-discovery',
          status: 'works',
          evidence: [old.id, fresh.id],
          attempts: [
            { id: 't1', evidence: [old.id] },
            { id: 't2', evidence: [fresh.id] },
          ],
        },
      ],
    });
  });

  it('方向证据自动生成尝试，首次发布与跨轮重试保持幂等', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const record = await action(own, 1);
    const watcher = open(own);
    await call(watcher, 'observation_context', {});
    const direction = {
      id: 'auth',
      direction: '权限核对',
      status: 'works' as const,
      result: '执行完成',
      evidence: [`o${record.seq}`],
    };
    const submitted = watchInput({ ...draft, directions: [direction] });
    const accepted = await call(watcher, 'observation_submit', submitted);
    expect(accepted.isError, accepted.content).toBe(false);
    expect(accepted.json).toMatchObject({ ok: true, revision: 1 });
    expect(accepted.terminate).toBe(true);
    expect(watcher.publishedWatch).toMatchObject({
      directions: [{ id: 'auth', status: 'works', attempts: [{ id: 't1', evidence: [record.id] }] }],
    });
    const next = open(own, {
      branchId: own.branch.id,
      untilSeq: k.runStore.queries.lastSeq(),
      previous: watcher.publishedWatch,
    });
    expect((await call(next, 'observation_submit', submitted)).isError).toBe(false);
    expect(next.publishedWatch!.directions).toEqual(watcher.publishedWatch!.directions);
  });

  it('只有运行意图的 trying 首次转为 unclear，命令完成后可追加真实尝试', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const intent = newId();
    k.runStore.writer.appendShIntent(k.run.id, {
      id: intent,
      branchId: own.branch.id,
      episode: own.branch.episode,
      cmd: 'inspect-running',
    });
    const watcher = open(own);
    expect(watcher.overview).toContain('正在跑');
    const direction = { id: 'running', direction: '运行中的检查', status: 'trying', result: '命令正在运行，等待结果' };
    const accepted = await call(watcher, 'observation_submit', { ...draft, directions: [direction] });
    expect(accepted.json).toMatchObject({
      ok: true,
      revision: 1,
      warnings: [expect.stringContaining('trying 已修正')],
    });
    expect(watcher.publishedWatch!.directions[0]).toMatchObject({
      status: 'unclear',
      result: direction.result,
      attempts: [],
      evidence: [],
    });
    const execution = k.runStore.writer.appendObservation(
      {
        id: intent,
        runId: k.run.id,
        branchId: own.branch.id,
        role: 'explorer',
        tool: 'sh',
        args: { cmd: 'inspect-running' },
        summary: '检查完成',
        output: await k.runStore.artifacts!.put(k.run.id, '检查通过'),
        snapshot: 'root',
      },
      { countsAsToolCall: true },
    );
    const next = open(own, {
      branchId: own.branch.id,
      untilSeq: k.runStore.queries.lastSeq(),
      previous: watcher.publishedWatch,
    });
    expect(
      (
        await call(next, 'observation_submit', {
          ...draft,
          directions: [{ ...direction, status: 'works', result: '检查通过', evidence: [`o${execution.seq}`] }],
        })
      ).isError,
    ).toBe(false);
    expect(next.publishedWatch!.directions[0]).toMatchObject({
      status: 'works',
      attempts: [{ id: 't1', evidence: [execution.id] }],
    });
  });

  it.each(['重试', '软截止'])('%s 时不自动改写判断，模型修正后有效方向正常发布', async (phase) => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const record = await action(own, 1);
    const closing = new AbortController();
    const watcher = open(own, undefined, closing.signal);
    await call(watcher, 'observation_context', {});
    const input = {
      ...draft,
      directions: [
        {
          id: 'unsupported',
          direction: '权限核对',
          status: 'works',
          result: '声称权限检查通过',
          priority: 1,
        },
        {
          id: 'supported',
          direction: '输入核对',
          status: 'works',
          result: '实测完成',
          evidence: [`o${record.seq}`],
        },
      ],
    };
    if (phase === '软截止') closing.abort();
    else {
      const rejected = await call(watcher, 'observation_submit', watchInput(input));
      expect(rejected.isError).toBe(true);
      expect(watcher.publishedWatch).toBeUndefined();
    }
    const rejected = await call(watcher, 'observation_submit', watchInput(input));
    expect(rejected.isError).toBe(true);
    expect(watcher.publishedWatch).toBeUndefined();
    input.directions[0]!.status = 'unclear';
    const accepted = await call(watcher, 'observation_submit', watchInput(input));
    expect(accepted.isError, accepted.content).toBe(false);
    expect(accepted.terminate).toBe(true);
    expect(accepted.json).toEqual({ ok: true, revision: 1 });
    expect(watcher.publishedWatch).toMatchObject({
      directions: [
        { id: 'unsupported', status: 'unclear', attempts: [], result: '声称权限检查通过' },
        { id: 'supported', status: 'works', attempts: [{ evidence: [record.id] }] },
      ],
    });
  });

  it.each(['重试', '软截止'])('%s 时仍拒绝未知或跨分支证据', async (phase) => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const foreign = await branch(k);
    const hidden = await action(foreign, 1);
    await action(own, 2);
    const closing = new AbortController();
    const watcher = open(own, undefined, closing.signal);
    await call(watcher, 'observation_context', {});
    if (phase === '软截止') closing.abort();
    for (const ref of [hidden.id, 'o999999999']) {
      const input = {
        ...draft,
        directions: [
          {
            id: 'bad',
            direction: '未知执行',
            status: 'works',
            result: '声称通过',
            evidence: [ref],
          },
        ],
      };
      if (phase === '重试') expect((await call(watcher, 'observation_submit', watchInput(input))).isError).toBe(true);
      const rejected = await call(watcher, 'observation_submit', watchInput(input));
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toContain('不在本轮可见证据中');
      expect(rejected.terminate).toBeUndefined();
    }
    expect(watcher.closed()).toBeUndefined();
    expect(watcher.publishedWatch).toBeUndefined();
    expect(k.runStore.queries.events({ runId: k.run.id, since: 0, types: ['watch.noted'] })).toEqual([]);
  });

  it('40 步大输出开场完整覆盖，只执行证据暴露短码，一次提交可自动投影', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const records = [];
    for (let i = 0; i < 40; i++) records.push(await action(own, i, `动作 ${i} 完成\n${'大量明细🚀'.repeat(300)}`));
    k.runStore.writer.recordHumanInput({ runId: k.run.id, text: '先核对权限条件' });
    const watcher = open(own);
    const overview = await call(watcher, 'observation_context', {});
    expect(overview.isError, overview.content).toBe(false);
    expect(Buffer.byteLength(overview.content)).toBeLessThanOrEqual(WATCH_OVERVIEW_BYTES);
    expect(overview.json!.progress).toMatchObject({ complete: true, toolCalls: 40 });
    expect(overview.json).not.toHaveProperty('nextCursor');
    expect(watcher.overview).toContain(`[证据ID: o${records[39]!.seq}]`);
    expect(watcher.overview).toContain('先核对权限条件');
    expect(watcher.overview).not.toContain(records[0]!.id);
    const evidence = await call(watcher, 'observation_context', { evidenceRefs: [`o${records[39]!.seq}`] });
    expect(evidence.content).toContain('原始输出 39');
    const submitted = await call(
      watcher,
      'observation_submit',
      watchInput({
        telemetry: {
          stage: 'verification',
          trajectory: 'advancing',
          bottleneck: 'none',
          confidence: 0.8,
          evidence: [`o${records[39]!.seq}`],
        },
        ...draft,
        directions: [
          {
            id: 'tested',
            direction: '权限核对',
            status: 'works',
            result: '执行完成',
            evidence: [`o${records[39]!.seq}`],
          },
          {
            id: 'idea',
            direction: '核对参数',
            status: 'untried',
            result: '输入可能影响结果',
            priority: 1,
          },
        ],
      }),
    );
    expect(submitted.json).toEqual({ ok: true, revision: 1 });
    expect(watcher.publishedWatch).toMatchObject({
      telemetry: { evidence: [records[39]!.id] },
      directions: [{ attempts: [{ id: 't1', evidence: [records[39]!.id] }] }, { priority: 1, attempts: [] }],
    });
  });

  it('长提示摘要不阻塞后续执行结论，直接发布并跨轮保留引用', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const hint = k.runStore.writer.recordHumanInput({
      runId: k.run.id,
      text: `新要求 ${'重要条件🚀'.repeat(10000)} 末尾约束`,
    });
    const late = await action(own, 1);
    const request = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq() };
    const watcher = open(own, request);
    const overview = await call(watcher, 'observation_context', {});
    expect(overview.json!.progress).toMatchObject({ complete: true });
    expect(watcher.overview).toContain(`[证据ID: o${late.seq}]`);
    expect(overview.json!.inspectContext).not.toEqual([]);
    const submitted = await call(
      watcher,
      'observation_submit',
      watchInput({
        ...draft,
        directions: [
          {
            id: 'late',
            direction: '已展示的执行',
            status: 'works',
            result: '完成',
            evidence: [`o${late.seq}`],
          },
        ],
      }),
    );
    expect(submitted.isError, submitted.content).toBe(false);
    expect(watcher.publishedWatch!.basedOnSeq).toBe(request.untilSeq);
    expect(watcher.publishedWatch!.basedOnSeq).toBeGreaterThan(hint.inbox[0]!.seq);
    expect(watcher.publishedWatch!.directions[0]).toMatchObject({ status: 'works', evidence: [late.id] });
    const next = open(own, { ...request, previous: watcher.publishedWatch });
    const accepted = await call(
      next,
      'observation_submit',
      watchInput({
        ...draft,
        directions: [
          {
            id: 'late',
            direction: '已展示的执行',
            status: 'works',
            result: '仍可引用',
            evidence: [late.id],
          },
        ],
      }),
    );
    expect(accepted.isError, accepted.content).toBe(false);
    expect(next.publishedWatch!.basedOnSeq).toBe(watcher.publishedWatch!.basedOnSeq);
    expect(next.publishedWatch!.directions[0]!.result).toBe('仍可引用');
  });

  it('短码跨轮稳定，正文里的完整 ID 不改写，冻结后和其他分支的短码仍不可读', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const first = await action(own, 1);
    const second = await action(own, 2, `正文保留原始标识 ${first.id}`);
    const foreign = await branch(k);
    const hidden = await action(foreign, 3);
    const request = { branchId: own.branch.id, untilSeq: k.runStore.queries.lastSeq() };
    const watcher = open(own, request);
    const future = await action(own, 4);
    expect(watcher.overview).toContain(`正文保留原始标识 ${first.id}`);
    expect(watcher.overview).toContain(`[证据ID: o${second.seq}]`);
    for (const record of [hidden, future]) {
      expect((await call(watcher, 'observation_context', { evidenceRefs: [`o${record.seq}`] })).content).toContain(
        'unknown_evidence',
      );
      const rejected = await call(watcher, 'observation_submit', {
        ...draft,
        directions: [
          {
            id: 'bad',
            direction: '检查',
            status: 'works',
            result: '声称完成',
            evidence: [`o${record.seq}`],
          },
        ],
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toContain('不在本轮可见证据中');
    }
    expect((await call(watcher, 'observation_submit', draft)).isError).toBe(false);
    const next = open(own, { ...request, untilSeq: k.runStore.queries.lastSeq(), previous: watcher.publishedWatch });
    const evidence = await call(next, 'observation_context', { evidenceRefs: [`o${first.seq}`] });
    expect(evidence.isError, evidence.content).toBe(false);
    expect(evidence.content).toContain('原始输出 1');
    expect((evidence.json!.evidence as { ref: string }[])[0]!.ref).toBe(`o${first.seq}`);
  });

  it('另一分支的执行无法通过短码或旧 ID 引入，过期提交不能覆盖新版本', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const foreign = await branch(k);
    const hidden = await action(foreign, 1, '隐藏执行');
    await action(own, 2);
    const watcher = open(own);
    const stale = open(own);
    expect(watcher.overview).not.toContain('隐藏执行');
    expect((await call(watcher, 'observation_context', { evidenceRefs: [hidden.id] })).content).toContain(
      'unknown_evidence',
    );
    expect(
      (
        await call(
          watcher,
          'observation_submit',
          watchInput({
            ...draft,
            directions: [
              {
                id: 'bad',
                direction: '不能引用',
                status: 'works',
                result: '未知',
                evidence: [hidden.id],
              },
            ],
          }),
        )
      ).isError,
    ).toBe(true);
    expect((await call(watcher, 'observation_submit', watchInput(draft))).isError).toBe(false);
    expect((await call(stale, 'observation_submit', watchInput(draft))).content).toContain('窗口已过期');
  });

  it('大记录可按稳定短码读取字段，首屏已提供摘要时无需读完全部原文才发布', async () => {
    k = kit();
    const own = await branch(k, { kind: 'direct' });
    const record = await action(own, 1, `已完成。${'大量执行明细🚀'.repeat(10000)}`);
    const watcher = open(own);
    const detail = await call(watcher, 'observation_context', { evidenceRefs: [`o${record.seq}`], part: 'record' });
    expect((detail.json!.evidence as { next?: unknown }[])[0]!.next).toBeDefined();
    expect(detail.json!.progress).toMatchObject({ complete: true });
    const submitted = await call(
      watcher,
      'observation_submit',
      watchInput({
        ...draft,
        directions: [
          {
            id: 'partial',
            direction: '检查执行',
            status: 'unclear',
            result: '详细条件待核对',
            evidence: [`o${record.seq}`],
          },
        ],
      }),
    );
    expect(submitted.isError, submitted.content).toBe(false);
    expect(watcher.publishedWatch!.basedOnSeq).toBeGreaterThanOrEqual(record.seq);
  });
});
