// 挑版（runtime/picks.ts）：只在任务停下时挑一次，暂停时不挑；patch 里去掉交付物那个文件。
// 停下时挑一次、等挑完再交付、没挑成交付最先存的那一版，见 run-manager.test.ts「挑版」。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PickResult, SelectVersion } from '../../../src/core/interfaces/agents.ts';
import { VersionPicks, withoutFile } from '../../../src/runtime/picks.ts';
import { MODEL, newRun, observe, snapshotId, startBranch } from '../storage/kit.ts';
import { FakeSelector, type Harness, harness, putText, waitFor } from './kit.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
describe('patch 里去掉交付物那个文件（withoutFile）', () => {
  const patch = [
    'diff --git a/answer.json b/answer.json',
    'new file mode 100644',
    '+{"x": 1}',
    'diff --git a/fit.py b/fit.py',
    '+print(1)',
    '',
  ].join('\n');
  it('段头是这个路径的整段去掉，别的照留', () => {
    expect(withoutFile(patch, 'answer.json')).toBe(['diff --git a/fit.py b/fit.py', '+print(1)', ''].join('\n'));
    expect(withoutFile(patch, './answer.json')).toBe(withoutFile(patch, 'answer.json'));
  });
  it('没有这个文件、格式不认识的原样留着', () => {
    expect(withoutFile(patch, 'other.txt')).toBe(patch);
    expect(withoutFile('改动清单：answer.json', 'answer.json')).toBe('改动清单：answer.json');
  });
});
describe('暂停（起只在停下时挑）', () => {
  it('暂停时不挑；暂停着取消，停下时照样挑一次', async () => {
    const selector = new FakeSelector();
    h = await harness({ selector });
    const hh = h;
    let seen: string | undefined;
    hh.explorer.on('主干直解路线', (ctx) => {
      seen = ctx.observe('覆盖率 82%，测试全过').id;
      return ctx.untilAborted();
    });
    const r0 = await hh.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    for (const claim of ['第一版', '第二版']) {
      const b0 = hh.bet0(r0.id);
      await hh.rt.runners.deliver({
        runId: r0.id,
        branchId: b0.id,
        version: {
          episode: b0.episode,
          claim,
        },
      });
    }
    await hh.rt.runs.pause(r0.id);
    await hh.rt.picks.idle();
    expect(selector.calls).toEqual([]);
    selector.choose = (ids) => ids[1] as string;
    const r = await hh.rt.runs.cancel(r0.id);
    expect(selector.calls).toHaveLength(1);
    const picked = hh.events('version.picked').flatMap((e) => (e.type === 'version.picked' ? [e.data] : []));
    expect(picked).toHaveLength(1);
    expect(r.result?.candidateId).toBe(picked[0]?.versions[1]);
    expect(r.result?.candidateId).toBe(picked[0]?.candidateId);
  });
});
describe('终局选择有界等待', () => {
  async function scene(selectVersion: SelectVersion, read?: () => Promise<Uint8Array>) {
    h = await harness({ start: false });
    const run = newRun(h.runStore);
    const branch = startBranch(h.runStore, run).branch;
    putText(h.runStore, run.id, '摘要里的验证');
    const evidence = observe(h.runStore, branch, '摘要里的验证');
    const versions = ['第一版', '第二版'].map((claim) => {
      const snapshot = snapshotId();
      return h!.runStore.writer.deliverVersion({
        branchId: branch.id,
        episode: branch.episode,
        snapshot: { id: snapshot },
        candidate: {
          runId: run.id,
          branchId: branch.id,
          snapshot,
          claim,
          artifact: evidence.output,
          interim: true,
        },
      }).candidate;
    });
    const picks = new VersionPicks({
      queries: h.runStore.queries,
      writer: h.runStore.writer,
      workspaces: h.workspaces,
      artifacts: { read: read ?? (async () => new TextEncoder().encode('完整的原始输出')) },
      registry: { resolve: () => MODEL },
      selectVersion,
      timeoutMs: 100,
    });
    return { picks, run, versions, evidence, runStore: h.runStore };
  }
  it('自动读入交付物原文，选择函数无需再查询', async () => {
    const select = vi.fn<SelectVersion>(async ({ request }) => ({
      candidateId: request.versions[1]!.candidateId,
      why: '按原文判断',
      basedOnSeq: h!.runStore.queries.lastSeq(),
    }));
    const { picks, run, versions, runStore } = await scene(select);
    expect((await picks.settle(run.id))?.id).toBe(versions[1]!.id);
    expect(select.mock.calls[0]![0].request.versions[0]?.artifact).toBe('完整的原始输出');
    expect(runStore.queries.events({ since: 0, runId: run.id, types: ['version.picked'] })).toHaveLength(1);
  });
  it('生成函数不响应取消也会超时；迟到结果不会写选版记录', async () => {
    const late = Promise.withResolvers<PickResult>();
    const select = vi.fn<SelectVersion>(() => late.promise);
    const { picks, run, versions, runStore } = await scene(select);
    expect((await picks.settle(run.id))?.id).toBe(versions[0]!.id);
    expect(select).toHaveBeenCalledOnce();
    late.resolve({ candidateId: versions[1]!.id, why: '迟到', basedOnSeq: runStore.queries.lastSeq() });
    await picks.idle();
    expect(runStore.queries.events({ since: 0, runId: run.id, types: ['version.picked'] })).toEqual([]);
  });
  it('读取原文卡住也受同一时限约束，不阻塞任务结束', async () => {
    const select = vi.fn<SelectVersion>(() => new Promise(() => {}));
    const { picks, run, versions } = await scene(select, () => new Promise(() => {}));
    expect((await picks.settle(run.id))?.id).toBe(versions[0]!.id);
    expect(select).not.toHaveBeenCalled();
  });
});
