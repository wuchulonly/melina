// 崩溃恢复：在跑的分支回到 lastSnapshot、停容器、作废在途 episode；只有意图的 sh 调用放提示；
// 待生效的暂停立即生效；准备到一半的接着准备；收尾到一半的接着交付。
// 进程内模拟崩溃：第一套 runtime 跑到一半直接停掉（不写任何收尾），第二套打开同一个库文件和数据目录接着跑。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerRef, ContainerRuntime } from '../../../src/core/interfaces/container.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import type { Branch, Run } from '../../../src/core/types.ts';
import { RECOVERED_NOTICE } from '../../../src/runtime/templates.ts';
import type { Store } from '../../../src/storage/store.ts';
import { updateRecord } from '../../../src/storage/tables.ts';
import { COMPLETION, closes, type Harness, type HarnessOptions, harness, STRONG, waitFor } from './kit.ts';

let dir: string;
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close().catch(() => {});
  if (dir) rmSync(dir, { recursive: true, force: true });
});
async function boot(start = true, extra: HarnessOptions = {}): Promise<Harness> {
  const h = await harness({ dir, db: join(dir, 'melina.db'), start, ...extra });
  open.push(h);
  return h;
}
/** 模拟崩溃：停掉调度（在途的 episode 丢掉、不收尾），关库 */
async function crash(h: Harness): Promise<void> {
  open.splice(open.indexOf(h), 1);
  await h.rt.stop();
  h.runStore.close();
}
describe('崩溃后恢复', () => {
  it('容器停止且 run.recovered 落库后恢复扩展状态，再启动新的 episode', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-extension-'));
    const first = await boot();
    const run = await first.run({ config: { bet0: { copies: 1 } } });
    const b0 = first.bet0(run.id);
    await waitFor(() => first.explorer.count(b0.id) === 1, '原 episode 开始');
    await crash(first);
    const called: string[] = [];
    let second: Harness;
    second = await boot(false, {
      onRecover: async (runId) => {
        called.push(runId);
        expect(second.env.ops('stop', b0.id)).toBe(1);
        expect(second.events('run.recovered')).toHaveLength(1);
        expect(second.explorer.count(b0.id)).toBe(0);
      },
    });
    await second.rt.recovery.run();
    expect(called).toEqual([run.id]);
  });
  it('在跑的分支恢复快照并重新排队；未完成的 sh.intent 进入收件箱', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-'));
    const h1 = await boot();
    h1.explorer.on(
      '主干直解路线',
      (ctx) => {
        ctx.observe('量了一下');
        return ctx.done(closes.end());
      },
      async (ctx) => {
        const b = ctx.runStore.queries.getBranch(ctx.input.branch.id) as Branch;
        ctx.runStore.writer.appendShIntent(b.runId, {
          id: '01J0000000000000000000ACT1',
          branchId: b.id,
          episode: b.episode,
          cmd: 'curl -X POST https://api.example.com/deploy',
          expect: '部署成功，返回 200',
        });
        return ctx.untilAborted();
      },
    );
    const run = await h1.run({ config: { bet0: { copies: 1 } } });
    const b0 = h1.bet0(run.id);
    await waitFor(() => h1.explorer.count(b0.id) === 2, '第二个 episode 在跑');
    const before = h1.runStore.queries.getBranch(b0.id) as Branch;
    await crash(h1);
    const h2 = await boot(false);
    h2.explorer.on('主干直解路线', (ctx) => ctx.untilAborted());
    const report = await h2.rt.recovery.run();
    expect(report).toEqual({
      runs: [run.id],
      branches: [b0.id],
      unknownCommands: ['01J0000000000000000000ACT1'],
      rescoped: [],
    });
    expect(h2.env.ops('stop', b0.id)).toBe(1);
    expect(h2.workspaces.ops('restore')).toEqual([[before.workspace?.path, before.lastSnapshot]]);
    const inbox = h2.runStore.queries.inbox(b0.id, 0).map((i) => i.text);
    expect(inbox[0]).toBe(RECOVERED_NOTICE);
    expect(inbox[1]).toContain('curl -X POST https://api.example.com/deploy');
    expect(inbox[1]).toContain('部署成功，返回 200');
    // 时间线上的那一条：先记 run.recovered，再放收件箱的提示，顺序定死（前端看到它就不再按提示各写一条）
    const recovered = h2.events('run.recovered');
    expect(recovered.map((e) => e.data)).toEqual([
      { branches: [b0.id], unknownCommands: ['01J0000000000000000000ACT1'], rescoped: false },
    ]);
    const recoveredSeq = recovered[0]?.seq ?? Number.POSITIVE_INFINITY;
    expect(h2.runStore.queries.inbox(b0.id, 0).every((i) => i.seq > recoveredSeq)).toBe(true);
    expect(h2.events('run.recovered')[0]?.runId).toBe(run.id);
    expect(h2.runStore.queries.getBranch(b0.id)).toMatchObject({ state: 'running', queued: true, episode: 2 });
    await h2.rt.start();
    await waitFor(() => h2.explorer.count(b0.id) === 1, '恢复后开新 episode');
    expect(h2.explorer.started[0]?.branch.episode).toBe(2);
    // 第二次恢复不再重复提示同一个 sh 调用以外的旧意图
  });
  it('一条分支 restore 失败：那条转 failed，其他分支和命令提示照常恢复', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-'));
    const h1 = await boot();

    const run = await h1.run({ config: { bet0: { models: [STRONG, STRONG] } } });
    const b0 = h1.bet0(run.id);
    const sibling = h1.runStore.queries.listBranches(run.id).find((b) => b.id !== b0.id)!;
    await waitFor(() => h1.explorer.started.length === 2, '两条分支都在跑');
    h1.runStore.writer.updateRun(run.id, { mode: 'direct' });
    const siblingWs = (h1.runStore.queries.getBranch(sibling.id) as Branch).workspace?.path as string;
    await crash(h1);
    const h2 = await boot(false);
    h2.workspaces.failRestore.add(siblingWs);
    const report = await h2.rt.recovery.run();
    expect(report.branches).toEqual([b0.id]);
    expect(h2.runStore.queries.getBranch(sibling.id)).toMatchObject({ state: 'failed' });
    expect((h2.runStore.queries.getBranch(sibling.id) as Branch).stateNote).toContain('没能把 workspace 改回');
    expect(h2.runStore.queries.getBranch(b0.id)).toMatchObject({ state: 'running', queued: true });
  });
  it('分支暂停还没生效就崩了：恢复时生效；暂停的任务恢复完仍是暂停', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-'));
    const h1 = await boot();
    const run = await h1.run({ config: { bet0: { copies: 1 } } });
    const b0 = h1.bet0(run.id);
    await waitFor(() => h1.explorer.count(b0.id) === 1, 'episode 在跑');
    h1.runStore.writer.updateRun(run.id, { mode: 'direct' });
    await h1.rt.branches.apply({ kind: 'pause', branchId: b0.id, reason: '先让一让' });
    await h1.rt.runs.pause(run.id);
    await crash(h1);
    const h2 = await boot(false);
    await h2.rt.recovery.run();
    expect(h2.runStore.queries.getBranch(b0.id)).toMatchObject({ state: 'paused', stateNote: '先让一让' });
    // 暂停的任务恢复后仍保持暂停，不启动新的会话
    await h2.rt.start();
    expect((h2.runStore.queries.getRun(run.id) as Run).status).toBe('paused');
  });
  it('Scoper 未完成而 Bet 0 已启动时崩溃：恢复原分支并重新起草', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-'));
    const h1 = await boot();
    h1.scoper.hang = true;
    const created = await h1.rt.runs.create({
      statement: '把冷启动降到 200 ms 以内',
      materials: [],
      config: { bet0: { copies: 1 } },
    });
    await waitFor(() => h1.scoper.calls === 1, 'Scoper 开始');
    await waitFor(() => h1.explorer.started.length === 1, 'Bet 0 在起草期间独立启动');
    const initial = h1.bet0(created.id);
    await crash(h1);
    const h2 = await boot(false);
    const report = await h2.rt.recovery.run();
    expect(report.rescoped).toEqual([created.id]);
    expect(report.branches).toEqual([initial.id]);
    expect(h2.events('run.recovered').map((e) => e.data)).toEqual([
      { branches: [initial.id], unknownCommands: [], rescoped: true },
    ]);
    await h2.rt.start();
    await h2.settle();
    await waitFor(() => h2.runStore.queries.listBets(created.id).length === 1, '建好 direct 路线');
    expect(h2.scoper.calls).toBe(1);
    expect((h2.runStore.queries.getRun(created.id) as Run).goal.completion).toBeDefined();
  });
  it('主干直解路线一份份开到一半就崩了：恢复时按配置补开缺的那几份，已经开了的不重开', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-'));
    const h1 = await boot();
    const created = await h1.run({ config: { bet0: { copies: 1 } } });
    const first = h1.bet0(created.id);
    // 配置里是两份，崩之前只开出了第一份
    const glm: ModelRef = { provider: 'zhipu', model: 'glm-5.3', tier: 'strong' };
    const store = (
      h1.runStore.queries as unknown as {
        store: Store;
      }
    ).store;
    const r = h1.runStore.queries.getRun(created.id) as Run;
    updateRecord(store, 'run', { ...r, config: { ...r.config, bet0: { models: [STRONG, glm] } } });
    await crash(h1);
    const h2 = await boot(false);
    await h2.rt.recovery.run();
    await h2.rt.start();
    await h2.settle();
    await waitFor(() => h2.runStore.queries.listBranches(created.id).length === 2, '补开第二份');
    const directs = h2.runStore.queries.listBets(created.id).filter((b) => b.kind === 'direct');
    expect(directs.map((b) => [b.label, b.model])).toEqual([
      ['主干直解路线', STRONG],
      ['主干直解路线（glm-5.3）', glm],
    ]);
    expect(h2.runStore.queries.listBranches(created.id)[0]?.id).toBe(first.id);
  });
  it('收尾到一半就崩了（候选已经提交、还没交付）：启动后接着交付', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-'));
    const h1 = await boot(false);
    const created = await h1.rt.runs.create({
      statement: '把覆盖率提到 80%',
      materials: [],
      completion: COMPLETION,
      domain: 'code',
      config: { bet0: { copies: 1 } },
    });
    await h1.settle();
    const b0 = h1.bet0(created.id);
    const w = h1.runStore.writer;
    w.updateBranch(b0.id, { state: 'running', queued: false, workspace: { path: join(dir, 'ws') } });
    h1.runStore.writer.appendObservation(
      {
        runId: created.id,
        branchId: b0.id,
        episode: 1,
        role: 'explorer',
        tool: 'sh',
        args: {},
        summary: '全过',
        output: (await h1.runStore.artifacts?.put(created.id, '全过')) as never,
        snapshot: 'root',
      },
      { countsAsToolCall: true },
    );
    w.closeEpisode({
      branchId: b0.id,
      episode: 1,
      outcome: 'submitted',
      snapshot: { id: 'snap-final' },
      seenSeq: h1.runStore.queries.lastSeq(),
      candidate: {
        runId: created.id,
        branchId: b0.id,
        snapshot: 'snap-final',
        claim: '做完了',
      },
    });
    expect((h1.runStore.queries.getRun(created.id) as Run).mode).toBe('settling');
    await crash(h1);
    const h2 = await boot(false);
    await h2.rt.recovery.run();
    await h2.rt.start();
    await waitFor(() => (h2.runStore.queries.getRun(created.id) as Run).status === 'done', '交付完');
    expect(h2.workspaces.ops('deliver')).toEqual([['snap-final']]);
  });
  it('上次留下的容器：本库任务的临时容器删；任务或分支已经结束的分支容器删掉，在跑的留着照常恢复；别的 Melina 的一个都不碰', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-'));
    const h1 = await boot();
    const run = await h1.run({ config: { bet0: { copies: 1 } } });
    const b0 = h1.bet0(run.id);
    await waitFor(() => h1.explorer.count(b0.id) === 1, 'episode 在跑');
    const ended = await h1.run({ config: { bet0: { copies: 1 } } });
    await h1.settle();
    const endedBranch = h1.bet0(ended.id);
    await h1.rt.runs.cancel(ended.id);
    await crash(h1);
    const removed: string[] = [];
    const ref = (name: string): ContainerRef => ({ id: name, name });
    const left = [
      { ref: ref('melina-helper-1'), ephemeral: true, labels: { 'melina.run': run.id, 'melina.branch': b0.id } },
      { ref: ref('melina-live'), ephemeral: false, labels: { 'melina.run': run.id, 'melina.branch': b0.id } },
      {
        ref: ref('melina-ended'),
        ephemeral: false,
        labels: { 'melina.run': ended.id, 'melina.branch': endedBranch.id },
      },
      // 同一个引擎上另一个数据目录的 Melina：它的分支容器和临时容器都不属于本次恢复范围。
      {
        ref: ref('melina-other'),
        ephemeral: false,
        labels: { 'melina.run': '01J00000000000000000000GONE', 'melina.branch': 'x' },
      },
      { ref: ref('melina-other-helper'), ephemeral: true, labels: { 'melina.run': '01J00000000000000000000GONE' } },
      { ref: ref('other'), ephemeral: false, labels: {} },
    ];
    let unscoped = 0;
    const containers = {
      // 引擎上全部 Melina 的临时容器都删：列得出容器的运行时不该再调它
      removeEphemeral: async () => {
        unscoped++;
        return [];
      },
      managed: async () => left.filter((c) => !removed.includes(c.ref.name)).map((c) => ({ ...c, running: true })),
      remove: async (r: ContainerRef) => {
        removed.push(r.name);
      },
    } as unknown as ContainerRuntime;
    const h2 = await boot(false, { containers });
    await h2.rt.recovery.run();
    expect(removed.sort()).toEqual(['melina-ended', 'melina-helper-1']);
    expect(unscoped).toBe(0);
    expect(h2.logs.some((t) => t.includes('删掉了上次留下的容器 melina-ended'))).toBe(true);
    expect(h2.logs.some((t) => t.includes('删掉了上次留下的临时容器 melina-helper-1'))).toBe(true);
  });
  it('列不出容器的运行时（开发机的 proot）：交给它自己的 removeEphemeral', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-recover-'));
    const h1 = await boot();
    await crash(h1);
    let calls = 0;
    const containers = {
      removeEphemeral: async () => {
        calls++;
        return [];
      },
    } as unknown as ContainerRuntime;
    const h2 = await boot(false, { containers });
    await h2.rt.recovery.run();
    expect(calls).toBe(1);
  });
});
