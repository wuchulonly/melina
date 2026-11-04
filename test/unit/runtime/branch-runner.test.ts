// 分支主循环：执行顺序、失败重试、任务暂停、工作区准备与快照清理。
import { afterEach, describe, expect, it } from 'vitest';
import ctfExtension from '../../../extensions/ctf/entry.ts';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { loadPrompt } from '../../../src/context/prompts.ts';
import type { Branch } from '../../../src/core/types.ts';
import { RESUMED_NOTICE, RUN_PAUSE_HINT } from '../../../src/runtime/templates.ts';
import { betDraft, newRun } from '../storage/kit.ts';
import { closes, type Harness, harness, observeStored, tick, waitFor } from './kit.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const SINGLE_ROUTE = { config: { bet0: { copies: 1 } } };
function state(branchId: string): Branch {
  return h.runStore.queries.getBranch(branchId) as Branch;
}
describe('分支状态事件', () => {
  it('启动时接管已提交的分支，启动后新增的分支自动开跑', async () => {
    h = await harness({ start: false });
    const run = newRun(h.runStore);
    const open = (label: string) => {
      const bet = h.runStore.writer.createBet({
        ...betDraft({ label }),
        runId: run.id,
        source: { kind: 'template' },
      });
      return h.runStore.writer.createBranch({ runId: run.id, betId: bet.id, lastSnapshot: 'root' });
    };
    const before = open('启动前的路线');
    expect(h.workspaces.ops('create')).toHaveLength(0);
    expect(h.explorer.started).toHaveLength(0);

    await h.rt.start();
    await waitFor(() => h.explorer.count(before.id) === 1, '接管已有分支');
    const after = open('启动后的路线');
    await waitFor(() => h.explorer.count(after.id) === 1, '事件启动新分支');
    expect(h.explorer.started).toHaveLength(2);

    await h.rt.stop();
    open('关闭后的路线');
    await tick();
    expect(h.explorer.started).toHaveLength(2);
    expect(h.rt.runners.size).toBe(0);
  });
});

describe('一个 episode', () => {
  it('Scoper 确定 CTF 领域后，原会话下一次请求包含扩展规则', async () => {
    h = await harness({
      global: { domains: ['general', 'ctf'] },
      assembler: (runStore) => {
        const extension = ctfExtension({ queries: runStore.queries } as unknown as Parameters<typeof ctfExtension>[0]);
        return new MelinaContextAssembler({
          queries: runStore.queries,
          prompt: (name, run) => {
            const extra = extension.prompts?.[name];
            return [loadPrompt(name), typeof extra === 'function' ? run && extra({ run }) : extra]
              .filter(Boolean)
              .join('\n\n');
          },
        });
      },
    });
    const gate = Promise.withResolvers<void>();
    h.scoper.gate = gate.promise;
    h.scoper.output = {
      completion: { interpretation: '补齐全部 flag', criteria: ['平台确认全部验收通过'] },
      constraints: [],
      domain: 'ctf',
    };
    const run = await h.rt.runs.create({
      statement:
        '授权 CTF 任务，实例与验收以 /melina/artifacts/BENCHMARK_INSTANCE.json 和 /melina/artifacts/BENCHMARK_PROGRESS.json 为准。',
      materials: [],
      ...SINGLE_ROUTE,
    });
    try {
      await waitFor(() => h.explorer.started.length === 1 && h.scoper.calls === 1, '原会话先于 Scoper 开始');
      const input = h.explorer.started[0]!;
      expect(input.layout.system).not.toContain('# CTF 执行约束');
      expect(input.systemPrompt?.()).toBe(input.layout.system);
      gate.resolve();
      await waitFor(() => h.runStore.queries.getRun(run.id)?.goal.domain === 'ctf', 'Scoper 确定领域');
      const updated = input.systemPrompt?.();
      expect(updated?.split('# CTF 执行约束')).toHaveLength(2);
      expect(updated?.split('# TSec 宿主协议')).toHaveLength(2);
      expect(updated).toContain('平台确认全部验收通过');
      expect(input.systemPrompt?.()).toBe(updated);
      expect(h.explorer.started).toHaveLength(1);
      expect(input.layout.system).not.toContain('# CTF 执行约束');
    } finally {
      gate.resolve();
    }
  });

  it('连续 3 个 episode 没有合法收尾：转 failed，每次都打 snapshot、往收件箱放提示', async () => {
    h = await harness();
    const fail = (ctx: Parameters<Parameters<typeof h.explorer.on>[1]>[0]) => {
      ctx.observe('改了一半');
      return ctx.done(undefined, 'no_close');
    };
    h.explorer.on('主干直解路线', fail, fail, fail);
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => state(b0.id).state === 'failed', 'Bet 0 转 failed');
    expect(state(b0.id)).toMatchObject({ failures: 3, stateNote: '连续 3 次会话失败' });
    expect(h.workspaces.ops('snapshot')).toHaveLength(3);
    expect(h.runStore.queries.inbox(b0.id, 0)).toHaveLength(3);
  });
  it('模型连续出错转 failed：出错原因写进下一个 episode 的提示和分支的 stateNote', async () => {
    h = await harness();
    const fail = (ctx: Parameters<Parameters<typeof h.explorer.on>[1]>[0]) => {
      ctx.observe('改了一半');
      return ctx.done(undefined, 'model_error', '400：请求里的工具定义不合法');
    };
    h.explorer.on('主干直解路线', fail, fail, fail);
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => state(b0.id).state === 'failed', 'Bet 0 转 failed');
    expect(state(b0.id).stateNote).toBe('连续 3 次会话失败：400：请求里的工具定义不合法');
    const notices = h.runStore.queries.inbox(b0.id, 0).map((i) => i.text);
    expect(notices).toHaveLength(3);
    for (const t of notices) expect(t).toContain('400：请求里的工具定义不合法');
  });
  it('先建 Bet 再开分支：清理旧 snapshot 时保留尚未开出分支的起点', async () => {
    h = await harness();
    h.explorer.on(
      '主干直解路线',
      (ctx) => {
        ctx.observe();
        return ctx.done(closes.end());
      },
      async (ctx) => {
        ctx.observe();
        await ctx.untilSteered((t) => t === '接着做');
        return ctx.done(closes.end());
      },
      (ctx) => ctx.untilAborted(),
    );
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.explorer.count(b0.id) === 2, '第二个 episode 开始');
    const forkFrom = state(b0.id).lastSnapshot;
    // 摘要续接的 Bet 已建好，分支尚未打开
    h.runStore.writer.createBet({
      ...betDraft({ label: '从这里分出去', startFrom: { snapshot: forkFrom } }),
      runId: run.id,
      source: { kind: 'template' },
    });
    h.rt.branches.steer(b0.id, '接着做');
    await waitFor(() => h.workspaces.ops('prune').length === 2, '第二次清理');
    const keep = h.workspaces.ops('prune')[1]?.[1] as string[];
    expect(keep).toContain(forkFrom);
    expect(keep).toContain(state(b0.id).lastSnapshot);
  });
  it('setup 失败不让分支失败：输出放进收件箱，Explorer 自己修', async () => {
    h = await harness();
    h.workspaces.setup = {
      cmd: 'npm ci',
      ok: false,
      exitCode: 1,
      timedOut: false,
      durationMs: 1200,
      tail: 'npm ERR! missing script',
    }; // 字段要全：Branch.workspace 落库时按契约的 SetupResult 校验
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, 'episode 开始');
    const notice = h.runStore.queries.inbox(b0.id, 0)[0];
    expect(notice?.kind).toBe('notice');
    expect(notice?.text).toContain('npm ci');
    expect(notice?.text).toContain('npm ERR! missing script');
    expect(state(b0.id).state).toBe('running');
  });
  it('系统出错（建 workspace 失败）：按间隔重试，都不行分支转 failed，原因写进 stateNote', async () => {
    h = await harness();
    h.workspaces.failCreate = 10;
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => state(b0.id).state === 'failed', 'Bet 0 转 failed');
    expect(state(b0.id).stateNote).toContain('建 workspace 失败');
    expect(h.workspaces.ops('create')).toHaveLength(4);
  });
  it('容器起不来一次：重试一次就好了', async () => {
    h = await harness();
    h.env.failEnsure = 1;
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, 'episode 开始');
    expect(state(b0.id).state).toBe('running');
  });
});
describe('暂停和中止', () => {
  it('请求暂停分支：在跑的 episode 收到提示，收尾时转 paused，主循环退出，容器停掉', async () => {
    h = await harness();
    h.explorer.on('主干直解路线', async (ctx) => {
      ctx.observe();
      await ctx.untilSteered((t) => t.includes('先让一让'));
      return ctx.done(closes.end());
    });
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, 'episode 开始');
    await h.rt.branches.apply({ kind: 'pause', branchId: b0.id, reason: '先让一让' });
    await waitFor(() => state(b0.id).state === 'paused', '收尾时转 paused');
    expect(state(b0.id).stateNote).toBe('先让一让');
    await waitFor(() => h.env.ops('stop', b0.id) === 1, '容器停掉');
    await tick(20);
    expect(h.explorer.count(b0.id)).toBe(1);
    // 恢复：重新排队，开新 episode
    await h.rt.branches.apply({ kind: 'resume', branchId: b0.id });
    await waitFor(() => h.explorer.count(b0.id) === 2, '恢复后开新 episode');
  });
  it('打 snapshot 的那几秒里来了 pause：记成待生效，收尾照常落库，随后转 paused', async () => {
    h = await harness();
    let release = () => {};
    h.workspaces.snapshotGate = new Promise<void>((r) => {
      release = r;
    });
    h.explorer.on('主干直解路线', (ctx) => {
      ctx.observe();
      return ctx.done(closes.end());
    });
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.workspaces.snapshotWaiting, '开始打 snapshot');
    await h.rt.branches.apply({ kind: 'pause', branchId: b0.id, reason: '先停一下' });
    expect(state(b0.id)).toMatchObject({ state: 'running', pendingPause: '先停一下' });
    release();
    await waitFor(() => state(b0.id).state === 'paused', '收尾后转 paused');
    expect(state(b0.id)).toMatchObject({ episode: 2, stateNote: '先停一下' });
    expect(h.events('episode.closed')).toHaveLength(1);
  });
  it('pause 排在收尾落库之后、注销之前：不再开新的 episode，分支直接转 paused', async () => {
    h = await harness();
    h.explorer.on(
      '主干直解路线',
      (ctx) => {
        ctx.observe();
        return ctx.done(closes.end());
      },
      // 以前会照开第 2 个 episode：暂停提示给了已经结束的第 1 个，它收不到、一直跑
      (ctx) => ctx.untilAborted(),
    );
    // pause 正好排进 BranchManager 队列、在 closeEpisode 后面（落库以后，runner 注销 episode 之前执行）
    const branches = h.rt.branches;
    const closeEpisode = branches.closeEpisode.bind(branches);
    let pausing: Promise<Branch> | undefined;
    branches.closeEpisode = (b, outcome, snapshot) => {
      const closing = closeEpisode(b, outcome, snapshot);
      pausing ??= branches.apply({ kind: 'pause', branchId: b.id, reason: '让一让' });
      return closing;
    };
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => pausing !== undefined, 'pause 排进队列');
    await pausing;
    await waitFor(() => state(b0.id).state === 'paused', '转 paused');
    expect(state(b0.id)).toMatchObject({ episode: 2, stateNote: '让一让' });
    expect(state(b0.id).pendingPause).toBeUndefined();
    await waitFor(() => h.env.ops('stop', b0.id) >= 1, '容器停掉');
    await tick(50);
    expect(h.explorer.count(b0.id)).toBe(1);
    // 恢复以后照常开新 episode（待生效的暂停已经用掉了，不会又停一次）
    await h.rt.branches.apply({ kind: 'resume', branchId: b0.id });
    await waitFor(() => h.explorer.count(b0.id) === 2, '恢复后开新 episode');
    expect(state(b0.id).state).toBe('running');
  });
  it('打 snapshot 的那几秒里人取消了任务：已经交上来的候选照常落库、交付（谁先提交就交付谁，§4）', async () => {
    h = await harness();
    let release = () => {};
    h.workspaces.snapshotGate = new Promise<void>((r) => {
      release = r;
    });
    h.explorer.on('主干直解路线', (ctx) => {
      ctx.observe('测试全过');
      return ctx.done(closes.submit());
    });
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.workspaces.snapshotWaiting, '开始打 snapshot');
    const cancelling = h.rt.runs.cancel(run.id);
    await tick(30);
    release();
    const ended = await cancelling;
    expect(ended.status).toBe('done');
    expect(ended.result?.candidateId).toBe(h.runStore.queries.candidates(run.id)[0]?.id);
    expect(state(b0.id).state).toBe('succeeded');
  });
  it('建 workspace（跑 setup）的时候分支被叫停：setup 跟着停下，建好的 workspace 删掉，不开 episode', async () => {
    h = await harness();
    let release = () => {};
    h.workspaces.createGate = new Promise<void>((r) => {
      release = r;
    });
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.workspaces.createWaiting, '开始建 workspace');
    const signal = h.workspaces.createSignals[0];
    expect(signal?.aborted).toBe(false);
    await h.rt.branches.apply({ kind: 'pause', branchId: b0.id, reason: '先让一让' });
    expect(signal?.aborted).toBe(true);
    release();
    await waitFor(() => h.workspaces.ops('dispose').length === 1, '没用上的 workspace 删掉');
    await tick(20);
    expect(h.explorer.count(b0.id)).toBe(0);
    expect(state(b0.id)).toMatchObject({ state: 'paused' });
    expect(state(b0.id).workspace).toBeUndefined();
    // 恢复以后重新建
    await h.rt.branches.apply({ kind: 'resume', branchId: b0.id });
    await waitFor(() => h.explorer.count(b0.id) === 1, '恢复后建好 workspace、开 episode');
    expect(h.workspaces.ops('create')).toHaveLength(2);
  });
  it('任务暂停：在跑的收到提示，收完尾去排队、停容器，不开新 episode；恢复后每条分支收到提示，接着跑', async () => {
    h = await harness();
    h.explorer.on('主干直解路线', async (ctx) => {
      ctx.observe();
      await ctx.untilSteered((t) => t === RUN_PAUSE_HINT);
      return ctx.done(closes.end());
    });
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, 'episode 开始');
    const paused = await h.rt.runs.pause(run.id);
    expect(paused.status).toBe('paused');
    await waitFor(() => state(b0.id).episode === 2, '收完尾');
    expect(state(b0.id)).toMatchObject({ state: 'running', queued: true });
    await waitFor(() => h.env.ops('stop', b0.id) === 1, '收完尾停容器');
    await tick(30);
    expect(h.explorer.count(b0.id)).toBe(1);
    await h.rt.runs.resume(run.id);
    await waitFor(() => h.explorer.count(b0.id) === 2, '恢复后接着跑');
    expect(h.runStore.queries.inbox(b0.id, 0).map((i) => i.text)).toContain(RESUMED_NOTICE);
    expect(state(b0.id).queued).toBe(false);
  });
  it('打 snapshot 一直失败：分支转 failed，不再开新的 episode', async () => {
    h = await harness();
    h.workspaces.failSnapshot = 100;
    h.explorer.on('主干直解路线', (ctx) => {
      ctx.observe();
      return ctx.done(closes.end());
    });
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => state(b0.id).state === 'failed', '分支转 failed');
    expect(state(b0.id).stateNote).toContain('打 snapshot 一直失败');
    expect(h.explorer.count(b0.id)).toBe(1);
  });
  it('清理 snapshot 时留下所有分支的 lastSnapshot：fork 出来、已经开跑但还没收过尾的分支用的是源分支的那个', async () => {
    h = await harness({ modelCalls: { deepseek: 2 } });
    h.explorer.on(
      '主干直解路线',
      (ctx) => {
        ctx.observe();
        return ctx.done(closes.end());
      },
      async (ctx) => {
        ctx.observe();
        await ctx.untilSteered((t) => t === '收尾');
        return ctx.done(closes.end());
      },
      (ctx) => ctx.untilAborted(),
    );
    h.explorer.on('从这一版出发', (ctx) => ctx.untilAborted());
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.explorer.count(b0.id) === 2, '第二个 episode');
    const first = state(b0.id).lastSnapshot;
    h.runStore.writer.updateRun(run.id, { mode: 'direct' });
    const bet = h.runStore.writer.createBet({
      kind: 'direct',
      label: '从这一版出发',
      startFrom: { snapshot: first },
      model: { provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' },
      diffFrom: { branchId: b0.id, note: '换个改法' },
      runId: run.id,
      source: { kind: 'template' },
    });
    const fork = await h.rt.branches.apply({ kind: 'open', runId: run.id, bet });
    await waitFor(() => h.explorer.count(fork.id) === 1, 'fork 开跑');
    expect(state(fork.id).workspace).toBeDefined();
    h.rt.branches.steer(b0.id, '收尾');
    await waitFor(() => h.workspaces.ops('prune').length === 2, '第二次清理');
    const keep = h.workspaces.ops('prune')[1]?.[1] as string[];
    expect(keep).toContain(first);
  });
  it('清理 snapshot 时留下还没开跑的分支要用的起点', async () => {
    h = await harness({ modelCalls: { deepseek: 1 } }); // 新分支排在初始求解分支后面。
    h.explorer.on(
      '主干直解路线',
      (ctx) => {
        ctx.observe();
        return ctx.done(closes.end());
      },
      async (ctx) => {
        ctx.observe();
        await ctx.untilSteered((t) => t === '收尾');
        return ctx.done(closes.end());
      },
      (ctx) => ctx.untilAborted(),
    );
    const run = await h.run(SINGLE_ROUTE);
    const b0 = h.bet0(run.id);
    await waitFor(() => h.explorer.count(b0.id) === 2, '第二个 episode');
    const first = state(b0.id).lastSnapshot;
    h.runStore.writer.updateRun(run.id, { mode: 'direct' });
    const bet = h.runStore.writer.createBet({
      kind: 'direct',
      label: '从这一版出发',
      startFrom: { snapshot: first },
      model: { provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' },
      runId: run.id,
      source: { kind: 'template' },
    });
    const pending = await h.rt.branches.apply({ kind: 'open', runId: run.id, bet });
    await tick(10);
    expect(state(pending.id)).toMatchObject({ state: 'starting', queued: true });
    h.rt.branches.steer(b0.id, '收尾');
    await waitFor(() => h.workspaces.ops('prune').length === 2, '第二次清理');
    const keep = h.workspaces.ops('prune')[1]?.[1] as string[];
    expect(keep).toContain(state(b0.id).lastSnapshot);
    expect(keep).toContain(first);
  });
});
void observeStored;
