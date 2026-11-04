// 任务启动、暂停、恢复、取消、候选交付、输入广播、续接与删除。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, ROOT } from '../../../src/core/ids.ts';
import type { ModelChoice, ModelRef } from '../../../src/core/model-ref.ts';
import type { Branch, Run } from '../../../src/core/types.ts';
import { CANCEL_NOTES, HINT_NOT_YET, leakedReason } from '../../../src/runtime/templates.ts';
import { COMPLETION, closes, FAST, FakeSelector, type Harness, harness, SCOPED, STRONG, tick, waitFor } from './kit.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
function run(id: string): Run {
  return h.runStore.queries.getRun(id) as Run;
}
function branch(id: string): Branch {
  return h.runStore.queries.getBranch(id) as Branch;
}
async function text(runId: string, handle: string): Promise<string> {
  const bytes = await h.runStore.artifacts?.read(runId, handle as never);
  return Buffer.from(bytes as Uint8Array).toString();
}
describe('建 Run 和准备', () => {
  it('巡检器的模型：默认不写（每轮现挑）；写档位的建任务时换成那一档的首选，写具体模型的照存', async () => {
    h = await harness();
    const plain = await h.rt.runs.create({
      statement: '把冷启动降到 200 ms 以内',
      materials: [],
      config: { bet0: { copies: 1 } },
    });
    expect(plain.config.watch).toEqual({ enabled: true });
    const tiered = await h.rt.runs.create({
      statement: '把冷启动降到 200 ms 以内',
      materials: [],
      config: { watch: { enabled: true, model: { tier: 'fast' } }, bet0: { copies: 1 } },
    });
    expect(tiered.config.watch).toEqual({ enabled: true, model: FAST });
    const off = await h.rt.runs.create({
      statement: '把冷启动降到 200 ms 以内',
      materials: [],
      config: { watch: { enabled: false }, bet0: { copies: 1 } },
    });
    expect(off.config.watch).toEqual({ enabled: false });
    await h.settle();
  });
  it('Bet 0 的 workspace 建在 Scoper 给出 setup 之前：把要跑的准备命令补给它', async () => {
    h = await harness();
    let release = () => {};
    h.scoper.gate = new Promise<void>((r) => {
      release = r;
    });
    h.scoper.output = { ...SCOPED, setup: 'npm ci' };
    const r0 = await h.rt.runs.create({
      statement: '把覆盖率提到 80%',
      materials: [],
      completion: COMPLETION,
      domain: 'code',
      config: { bet0: { copies: 1 } },
    });
    await waitFor(() => h.scoper.calls === 1, 'Scoper 开始');
    const b0 = h.bet0(r0.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, 'Bet 0 开跑');
    release();
    await waitFor(() => (h.explorer.steers.get(b0.id) ?? []).some((t) => t.includes('npm ci')), '补给准备命令');
    const text = (h.explorer.steers.get(b0.id) ?? []).find((t) => t.includes('npm ci')) as string;
    expect(text).toContain('你的 workspace 建的时候还没有它，没跑过');
    // 完成标准建任务时就给了，开跑时已经在上下文里，不再补
    expect(text).not.toContain('完成标准定好了');
    expect(run(r0.id).workspace.setup).toBe('npm ci');
    await h.rt.runs.cancel(r0.id);
    await h.settle();
  });
  it('直接给完成标准和领域（评估用）：Bet 0 照样先开跑；Scoper 照样调并补充约束，完成标准和领域照给的用', async () => {
    h = await harness();
    h.scoper.output = {
      ...SCOPED,
      constraints: ['不改业务代码'],
      completion: { ...COMPLETION, criteria: ['Scoper 自己写的标准'] },
      domain: 'research',
    };
    const r = await h.run({ config: { bet0: { copies: 1 } } });
    expect(h.scoper.calls).toBe(1);
    expect(r.goal).toMatchObject({ completion: COMPLETION, domain: 'code', constraints: ['不改业务代码'] });
    // Scoper 的上下文里写着给定的完成标准，让它照抄、只做判断
    expect(h.runStore.queries.events({ since: 0, runId: r.id, types: ['completion.drafted'] })).toHaveLength(1);
    // 只给求解分支补充约束：预设的完成标准已在上下文中，不重复发送。
    const notices = h.runStore.queries.inbox(h.bet0(r.id).id, 0).map((i) => i.text);
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain('完成标准定好了');
    expect(notices[0]).not.toContain('Scoper 自己写的标准');
    expect(notices[0]).toContain('不改业务代码');
    expect(notices[0]).not.toContain('先跑一遍覆盖率');
  });
  it('只给完成标准、没给领域：领域由 Scoper 选；Scoper 起草过一次就不再起草', async () => {
    h = await harness();
    h.scoper.output = { ...SCOPED, domain: 'research' };
    const created = await h.rt.runs.create({
      statement: '写一份调研',
      materials: [],
      completion: COMPLETION,
      config: { bet0: { copies: 1 } },
    });
    await h.settle();
    expect(run(created.id).goal).toMatchObject({ completion: COMPLETION, domain: 'research' });
    expect(() => h.runStore.writer.draftCompletion(created.id, SCOPED)).toThrow(/已经起草过了/);
  });
  it('Scoper 给了不认识的领域：按拿不准算，用 general', async () => {
    h = await harness();
    h.scoper.output = { ...SCOPED, domain: 'quantum' };
    const created = await h.rt.runs.create({ statement: '算一下', materials: [], config: { bet0: { copies: 1 } } });
    await h.settle();
    expect(run(created.id).goal.domain).toBe('general');
  });
  it.each([undefined, 'progress'] as const)(
    'Scoper 重试耗尽：有 Bet 0 会话在工作就降级并继续（continuation=%s）',
    async (reason) => {
      h = await harness();
      let release = () => {};
      h.scoper.gate = new Promise<void>((r) => {
        release = r;
      });
      h.scoper.failures = 10;
      h.explorer.on('主干直解路线', (ctx) => {
        ctx.observe('看了一眼');
        return ctx.untilAborted();
      });
      const created = await h.rt.runs.create({
        statement: '把冷启动降到 200 ms 以内',
        materials: [],
        config: { bet0: { copies: 1 } },
      });
      await waitFor(() => (h.runStore.queries.listBranches(created.id)[0]?.toolCalls ?? 0) > 0, 'Bet 0 调了一次工具');
      let b0 = h.bet0(created.id);
      if (reason) {
        h.explorer.on('接手路线', (ctx) => {
          ctx.observe('继续核对入口');
          return ctx.untilAborted();
        });
        const bet = h.runStore.writer.createBet({
          runId: created.id,
          kind: 'direct',
          label: '接手路线',
          model: STRONG,
          source: { kind: 'template' },
          startFrom: { snapshot: ROOT },
          continuation: {
            key: `${reason}:1`,
            slot: 0,
            handoff: '入口已验证',
            direction: '继续核对入口',
          },
        });
        const next = await h.rt.branches.apply({ kind: 'open', runId: created.id, bet });
        await waitFor(() => (h.runStore.queries.getBranch(next.id)?.toolCalls ?? 0) > 0, '接手会话开始工作');
        await h.rt.branches.apply({ kind: 'cancel', branchId: b0.id });
        b0 = next;
      }
      release();
      await waitFor(() => (h.explorer.steers.get(b0.id) ?? []).some((t) => t.includes('按字面理解')), '补给 Bet 0');
      const r = run(created.id);
      expect(r).toMatchObject({ status: 'running', mode: 'direct' });
      expect(r.goal).toMatchObject({
        completion: { interpretation: '按字面理解', criteria: ['把冷启动降到 200 ms 以内'] },
        domain: 'general',
      });
      expect(h.scoper.calls).toBe(4);
      expect(h.logs.some((l) => l.includes('Scoper 起不来') && l.includes('按字面理解目标'))).toBe(true);
      await h.rt.runs.cancel(created.id);
      await h.settle();
    },
  );
  it('Bet 0 的 workspace 正在建时 Scoper 起草完：建好以后补一句要跑的准备命令（只一次），容器按起草完的领域起', async () => {
    h = await harness();
    let open = () => {};
    h.workspaces.createGate = new Promise<void>((r) => {
      open = r;
    });
    let draft = () => {};
    h.scoper.gate = new Promise<void>((r) => {
      draft = r;
    });
    h.scoper.output = { ...SCOPED, domain: 'research', setup: 'pip install -r requirements.txt' };
    const created = await h.rt.runs.create({
      statement: '写一份调研',
      materials: [],
      completion: COMPLETION,
      config: { bet0: { copies: 1 } },
    });
    await waitFor(() => h.workspaces.createWaiting, 'Bet 0 在建 workspace');
    draft();
    await waitFor(
      () => h.runStore.queries.events({ since: 0, runId: created.id, types: ['completion.drafted'] }).length === 1,
      'Scoper 起草完',
    );
    const b0 = h.bet0(created.id);
    expect(h.runStore.queries.inbox(b0.id, 0)).toEqual([]); // 起草完那一刻它还没有 workspace，RunManager 不补
    open();
    await waitFor(() => h.explorer.count(b0.id) === 1, 'Bet 0 开跑');
    const notices = h.runStore.queries.inbox(b0.id, 0).map((i) => i.text);
    expect(notices.filter((t) => t.includes('pip install -r requirements.txt'))).toHaveLength(1);
    expect(h.env.domains).toEqual(['research']);
    await h.rt.runs.cancel(created.id);
    await h.settle();
  });
  it('参数不对就拒：domain 不在配置里、只给 domain 不给 completion、工作目录在数据目录里、接着做没结束的任务', async () => {
    h = await harness();
    await expect(h.rt.runs.create({ statement: '  ', materials: [], config: { bet0: { copies: 1 } } })).rejects.toThrow(
      '目标不能是空的',
    );
    await expect(
      h.rt.runs.create({
        statement: '做事',
        materials: [],
        completion: COMPLETION,
        domain: 'math',
        config: { bet0: { copies: 1 } },
      }),
    ).rejects.toThrow('没有这个领域');
    await expect(
      h.rt.runs.create({ statement: '做事', materials: [], domain: 'code', config: { bet0: { copies: 1 } } }),
    ).rejects.toThrow('一起给');
    await expect(
      h.rt.runs.create({
        statement: '做事',
        materials: [],
        workspace: join(h.dir, 'data', 'x'),
        config: { bet0: { copies: 1 } },
      }),
    ).rejects.toThrow('数据目录');
    const live = await h.run({ config: { bet0: { copies: 1 } } });
    await expect(
      h.rt.runs.create({ statement: '接着做', materials: [], continueFrom: live.id, config: { bet0: { copies: 1 } } }),
    ).rejects.toThrow('已经结束');
    await expect(
      h.rt.runs.create({ statement: '接着做', materials: [], continueFrom: newId(), config: { bet0: { copies: 1 } } }),
    ).rejects.toThrow('不存在');
  });
  it('Scoper 出系统错误、主干直解路线也还没调成过工具：重试，还不行任务转 failed，交一份知识报告', async () => {
    h = await harness();
    h.scoper.failures = 10;
    const created = await h.rt.runs.create({
      statement: '把冷启动降到 200 ms 以内',
      materials: [],
      config: { bet0: { copies: 1 } },
    });
    await h.settle();
    const r = run(created.id);
    expect(r.status).toBe('failed');
    expect(r.endReason).toContain('Scoper 的容器起不来');
    expect(h.scoper.calls).toBe(4);
    const report = await text(r.id, r.result?.knowledgeReport as string);
    expect(report).toContain('准备任务时出错：Scoper 的容器起不来');
  });
});
describe('交付前查密钥', () => {
  /** 求解分支一启动就提交候选。 */
  function submitsAtOnce(hh: Harness): void {
    hh.explorer.on('主干直解路线', (ctx) => {
      ctx.observe('覆盖率 82%，测试全过');
      return ctx.done(closes.submit());
    });
  }
  it('改动里有像密钥的东西：不推分支，只交相对起点的 patch，结束原因里说在哪（不含值）', async () => {
    const seen: string[] = [];
    h = await harness({
      secrets: {
        add: async () => 0,
        drop: () => {},
        leaksIn: (patch) => {
          seen.push(patch);
          return ['.token 的整段内容', 'probe.sh 里的 TOKEN'];
        },
      },
    });
    submitsAtOnce(h);
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => run(r0.id).status === 'done', '交付完');
    await h.settle();
    const r = run(r0.id);
    const candidate = h.runStore.queries.candidates(r.id)[0];
    expect(h.workspaces.ops('deliver')).toEqual([]);
    expect(h.workspaces.ops('diffSnapshots')).toEqual([[ROOT, candidate?.snapshot]]);
    expect(seen).toEqual([`diff ${ROOT}..${candidate?.snapshot}\n+没做完的改动\n`]);
    expect(r.result?.branch).toBeUndefined();
    expect(r.result?.patch).toBeDefined();
    expect(r.endReason).toBe(
      leakedReason(['.token 的整段内容', 'probe.sh 里的 TOKEN'], r.workspace.kind === 'git-clone'),
    );
    expect(h.logs.some((t) => t.includes('不推分支、只交 patch'))).toBe(true);
  });
  it('没查出来照常推分支；查的时候出错也照常交付，记一条日志', async () => {
    h = await harness({ secrets: { add: async () => 0, drop: () => {}, leaksIn: () => [] } });
    submitsAtOnce(h);
    const r1 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => run(r1.id).status === 'done', '交付完');
    await h.settle();
    expect(run(r1.id).result?.branch).toBe(`melina/${r1.id}`);
    expect(run(r1.id).endReason).toBeUndefined();
    await h.close();
    h = await harness({
      secrets: {
        add: async () => 0,
        drop: () => {},
        leaksIn: () => {
          throw new Error('读不了 patch');
        },
      },
    });
    submitsAtOnce(h);
    const r2 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => run(r2.id).status === 'done', '交付完');
    await h.settle();
    expect(run(r2.id).result?.branch).toBe(`melina/${r2.id}`);
    expect(h.logs.some((t) => t.includes('交付前查密钥出错，照常交付'))).toBe(true);
  });
});
describe('收尾和交付（settling）', () => {
  it('任务暂停中提交了候选：照常收尾、交付', async () => {
    h = await harness();
    h.explorer.on('主干直解路线', async (ctx) => {
      ctx.observe('做完了');
      await ctx.untilSteered();
      return ctx.done(closes.submit());
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => h.explorer.started.length === 1, 'episode 开始');
    await h.rt.runs.pause(r0.id);
    await waitFor(() => run(r0.id).status === 'done', '交付完');
    expect(run(r0.id).result?.candidateId).toBeDefined();
  });
});
describe('宿主立即暂停和实例交接', () => {
  it('停容器或保存工作区失败时拒绝确认立即暂停，重试后才能确认', async () => {
    h = await harness();
    const created = await h.run({ config: { bet0: { copies: 1 } } });
    const b0 = h.bet0(created.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, '路线开跑');
    const stop = h.env.stop.bind(h.env);
    h.env.stop = async () => {
      throw new Error('宿主无法停止容器');
    };
    await expect(h.rt.runs.interrupt(created.id)).rejects.toThrow('无法停止容器');
    expect(run(created.id).status).toBe('paused');
    h.env.stop = stop;
    h.workspaces.failSnapshot = 1;
    await expect(h.rt.runs.interrupt(created.id)).rejects.toThrow('打 snapshot 失败');
    expect(h.runStore.queries.snapshots(created.id)).toEqual([]);
    expect(await h.rt.runs.interrupt(created.id)).toMatchObject({ id: created.id, status: 'paused' });
    expect(h.runStore.queries.snapshots(created.id)).toHaveLength(1);
    expect(branch(b0.id).failures).toBe(0);
  });
  it('立即暂停也中止正在起草的 Scoper，恢复后在原 Run 补完准备', async () => {
    h = await harness();
    h.scoper.hang = true;
    const created = await h.rt.runs.create({
      statement: '按原题继续',
      materials: [],
      config: { bet0: { copies: 1 } },
    });
    await waitFor(() => h.scoper.calls === 1, 'Scoper 开始');
    expect(await h.rt.runs.interrupt(created.id)).toMatchObject({ status: 'paused' });
    h.scoper.hang = false;
    await h.rt.runs.resume(created.id);
    await waitFor(() => h.scoper.calls === 2 && run(created.id).goal.completion !== undefined, '原 Run 补完 Scoper');
    expect(run(created.id).status).toBe('running');
    expect(h.runStore.queries.listRuns()).toHaveLength(1);
  });
  it('实例交接输入广播送达各路线；并发重试使用同一输入，另一个内容不能复用去重键', async () => {
    h = await harness();

    const created = await h.run({ config: { bet0: { copies: 2 } } });
    await waitFor(() => h.rt.branches.running(created.id).length === 2, '两条路线开跑');
    await h.rt.runs.interrupt(created.id);
    const request = {
      kind: 'hint' as const,
      key: 'instance:second-generation',
      broadcast: true,
      text: '宿主实测事实：实例已更换，旧地址阴性结果作废。',
    };
    const [first, retry] = await Promise.all([
      h.rt.runs.input(created.id, request),
      h.rt.runs.input(created.id, request),
    ]);
    expect(retry.id).toBe(first.id);
    expect(h.runStore.queries.humanInputs(created.id)).toEqual([first]);
    for (const b of h.runStore.queries.listBranches(created.id)) {
      expect(h.runStore.queries.inbox(b.id, 0).filter((item) => item.ref === first.id)).toHaveLength(1);
    }
    await expect(h.rt.runs.input(created.id, { ...request, text: '另一份内容' })).rejects.toThrow(
      '相同输入键的内容不同',
    );
    expect(run(created.id).status).toBe('paused');
  });
});
describe('任务取消', () => {
  it('取消时给主路线另拍 snapshot 出错：patch 退回最近一次收尾的，报告照实写是哪一刻的', async () => {
    h = await harness();
    h.explorer.on(
      '主干直解路线',
      (ctx) => {
        ctx.observe('改了一版');
        return ctx.done(closes.end({}));
      },
      (ctx) => ctx.untilAborted(),
    );
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    const b0 = h.bet0(r0.id);
    await waitFor(() => h.explorer.count(b0.id) === 2, '第二个 episode');
    h.workspaces.failSnapshot = 1;
    const r = await h.rt.runs.cancel(r0.id);
    expect(h.workspaces.ops('diffSnapshots')).toEqual([['root', branch(b0.id).lastSnapshot]]);
    const report = await text(r.id, r.result?.knowledgeReport as string);
    expect(r.result?.patch).toBeDefined();
    expect(report).toContain('改了一版');
  });
  it('还在准备工作目录时取消：Bet 0 还没开，什么都不建，也不调 Scoper', async () => {
    h = await harness();
    let release = () => {};
    h.workspaces.initGate = new Promise<void>((r) => {
      release = r;
    });
    const created = await h.rt.runs.create({ statement: '做个事', materials: [], config: { bet0: { copies: 1 } } });
    await waitFor(() => h.workspaces.ops('init').length === 1, '开始打根 snapshot');
    const r = await h.rt.runs.cancel(created.id);
    expect(r.status).toBe('cancelled');
    release();
    await h.settle();
    expect(h.runStore.queries.listBets(created.id)).toEqual([]);
    expect(h.scoper.calls).toBe(0);
  });
  it('Scoper 还在起草时取消：Scoper 中止，已经开跑的 Bet 0 跟着停下，任务转 cancelled', async () => {
    h = await harness();
    h.scoper.hang = true;
    const created = await h.rt.runs.create({ statement: '做个事', materials: [], config: { bet0: { copies: 1 } } });
    await waitFor(() => h.scoper.calls === 1, 'Scoper 开始');
    const r = await h.rt.runs.cancel(created.id);
    expect(r.status).toBe('cancelled');
    await h.settle();
    expect(h.bet0(created.id)).toMatchObject({ state: 'cancelled', stateNote: CANCEL_NOTES.cancelled });
    expect(h.runStore.queries.events({ since: 0, runId: created.id, types: ['completion.drafted'] })).toEqual([]);
  });
  it('Scoper 还在起草时暂停：马上生效，不等 Scoper；之后照样能取消', async () => {
    h = await harness();
    h.scoper.hang = true;
    const created = await h.rt.runs.create({ statement: '做个事', materials: [], config: { bet0: { copies: 1 } } });
    await waitFor(() => h.scoper.calls === 1, 'Scoper 开始');
    const paused = await Promise.race([h.rt.runs.pause(created.id), tick(1000).then(() => 'timeout' as const)]);
    expect(paused).toMatchObject({ status: 'paused' });
    const r = await h.rt.runs.cancel(created.id);
    expect(r.status).toBe('cancelled');
    await h.settle();
  });
  it('取消和提交候选赛跑：候选的收尾已经排在前面、先落了库，就照常交付它，不当成取消', async () => {
    h = await harness();
    const store = h.runStore.artifacts as NonNullable<typeof h.runStore.artifacts>;
    const put = store.put.bind(store);
    let release = () => {};
    let storing = false;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 交付物从 workspace 读出来以后用 put 存；只卡它这一次
    store.put = async (runId, content) => {
      if (Buffer.from(content).toString() === '# 结果') {
        storing = true;
        await gate;
      }
      return put(runId, content);
    };
    h.explorer.on('主干直解路线', async (ctx) => {
      await writeFileSync(join(ctx.input.branch.workspace?.path as string, 'out.md'), '# 结果');
      ctx.observe('全过');
      return ctx.done(closes.submit({ artifact: 'out.md' }));
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => storing, '收尾在存交付物');
    const cancelling = h.rt.runs.cancel(r0.id);
    await tick(10);
    release();
    const r = await cancelling;
    expect(r.status).toBe('done');
    expect(r.result?.candidateId).toBeDefined();
    expect(h.workspaces.ops('deliver')).toHaveLength(1);
  });
});
// 第八次评价复现的「取消不落库」：原来先一条条停分支、再写知识报告，最后才把任务写成已取消，
// 中途进程没了，重启后任务一直显示在跑。现在结束前什么都不写，最后一个事务结束（RunStoreWriter.endRun）
describe('结束要么写完、要么没写（§14）', () => {
  let dir: string | undefined;
  afterEach(async () => {
    await h?.close(); // 先关库再删目录（外层再关一次也没事）
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  // ：中止撤不回，写结果出错以后库里还是「在跑」、进程里谁也不再推它（追加指令、暂停再恢复都叫不醒），只能重启
  it('取消写结果出错：说清楚在后台重试，这期间暂停、恢复、追加指令、再取消都说在重试；写得进去了任务就转 cancelled', async () => {
    h = await harness();
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    const b0 = h.bet0(r0.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, 'Bet 0 开跑');
    const store = h.runStore.artifacts as NonNullable<typeof h.runStore.artifacts>;
    const put = store.put.bind(store);
    let full = true;
    let tries = 0;
    store.put = async (runId, content) => {
      if (full) {
        tries++;
        throw new Error('磁盘满了');
      }
      return put(runId, content);
    };
    await expect(h.rt.runs.cancel(r0.id)).rejects.toThrow(/取消的结果没写进去（磁盘满了）.*后台接着重试/);
    expect(run(r0.id).status).toBe('running');
    await waitFor(() => tries >= 3, '后台重试了几次');
    for (const op of [
      () => h.rt.runs.pause(r0.id),
      () => h.rt.runs.resume(r0.id),
      () => h.rt.runs.cancel(r0.id),
      () => h.rt.runs.input(r0.id, { kind: 'hint', text: '还在吗' }),
    ]) {
      await expect(op()).rejects.toThrow('Melina 在后台重试');
    }
    // 在跑的 episode 已经停了，重试期间不会再开
    expect(h.explorer.count(b0.id)).toBe(1);
    full = false;
    await waitFor(() => run(r0.id).status === 'cancelled', '重试写进去了');
    expect(run(r0.id)).toMatchObject({ status: 'cancelled', endReason: '你取消了任务' });
    expect(branch(b0.id)).toMatchObject({ state: 'cancelled', stateNote: CANCEL_NOTES.cancelled });
    expect(h.logs.some((l) => l.includes('重试第') && l.includes('写进去了'))).toBe(true);
    await expect(h.rt.runs.pause(r0.id)).rejects.toThrow('已经结束');
  });
  it('收尾写结果出错：交付只做一次，后台重试写知识报告和终态，写进去以后任务转 done', async () => {
    h = await harness();
    const store = h.runStore.artifacts as NonNullable<typeof h.runStore.artifacts>;
    const put = store.put.bind(store);
    let full = true;
    let tries = 0;
    store.put = async (runId, content) => {
      if (full) {
        tries++;
        throw new Error('磁盘满了');
      }
      return put(runId, content);
    };
    h.explorer.on('主干直解路线', (ctx) => {
      ctx.observe('全过');
      return ctx.done(closes.submit());
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => tries >= 3, '收尾写结果出错、后台重试了几次');
    expect(run(r0.id)).toMatchObject({ status: 'running', mode: 'settling' });
    await expect(h.rt.runs.cancel(r0.id)).rejects.toThrow('Melina 在后台重试');
    full = false;
    await waitFor(() => run(r0.id).status === 'done', '重试写进去了');
    expect(run(r0.id).result).toMatchObject({ branch: `melina/${r0.id}` });
    expect(h.workspaces.ops('deliver')).toHaveLength(1);
  });
  it('收尾时停其余分支写不进去：交付照常，没停成的分支随结束的那一个事务转 cancelled，任务转 done', async () => {
    h = await harness();
    // 一条求解分支持续运行，另一条记录观测后提交候选；收尾时应停止其余分支。

    h.explorer.on('主干直解路线（deepseek-pro）', async (ctx) => {
      await waitFor(() => h.explorer.started.length === 2, '侦察开跑');
      ctx.observe('测试全过，覆盖率 82%');
      return ctx.done(closes.submit());
    });
    // 模拟磁盘满：停分支（写 cancelled）的那一次写入失败
    const writer = h.runStore.writer;
    const updateBranch = writer.updateBranch.bind(writer);
    let failed = 0;
    writer.updateBranch = (id, patch) => {
      if (patch.state === 'cancelled' && failed === 0) {
        failed++;
        throw new Error('磁盘满了');
      }
      return updateBranch(id, patch);
    };
    const r0 = await h.run({ config: { bet0: { models: [STRONG, FAST] } } });
    await waitFor(() => run(r0.id).status === 'done', '照常交付、任务结束');
    expect(failed).toBe(1);
    expect(run(r0.id).result).toMatchObject({ branch: `melina/${r0.id}` });
    const sibling = h.runStore.queries.listBranches(r0.id).find((b) => b.id !== h.bet0(r0.id).id);
    expect(sibling).toMatchObject({ state: 'cancelled', stateNote: CANCEL_NOTES.settling });
    expect(h.logs.some((l) => l.includes('收尾时停分支') && l.includes('磁盘满了'))).toBe(true);
  });
  it('取消写到一半时退出 Melina：等它写完再停（只差拼报告和那一个事务），重启后任务是已取消、不会又跑起来', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-runs-'));
    const db = join(dir, 'melina.db');
    h = await harness({ db, dir });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    const b0 = h.bet0(r0.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, 'Bet 0 开跑');
    const store = h.runStore.artifacts as NonNullable<typeof h.runStore.artifacts>;
    const put = store.put.bind(store);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let writing = false;
    store.put = async (runId, content) => {
      writing = true;
      await gate;
      return put(runId, content);
    };
    const cancelling = h.rt.runs.cancel(r0.id);
    await waitFor(() => writing, '取消走到写知识报告');
    let stopped = false;
    const stopping = h.rt.stop().then(() => {
      stopped = true;
    });
    await tick(50);
    expect(stopped).toBe(false);
    expect(run(r0.id).status).toBe('running');
    release();
    await stopping;
    expect(await cancelling).toMatchObject({ status: 'cancelled' });
    expect(branch(b0.id)).toMatchObject({ state: 'cancelled', stateNote: CANCEL_NOTES.cancelled });
    h.runStore.close();
    h = await harness({ db, dir });
    await h.settle();
    await tick(20);
    expect(run(r0.id).status).toBe('cancelled');
    expect(h.explorer.started).toEqual([]);
  });
});
// ── 主干直解路线开几份 ─────────────────────────────
const KIMI: ModelRef = { provider: 'moonshot', model: 'kimi-k2.5', tier: 'strong' };
const GLM: ModelRef = { provider: 'zhipu', model: 'glm-5.3', tier: 'strong' };
const DSF: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash', tier: 'strong' };
/** strong 档是这几个模型（第一个是首选）；keys 里的几家配了 key */
function tiers(strong: ModelRef[], keys: string[]) {
  return {
    resolve: (c: ModelChoice): ModelRef => ('provider' in c ? c : c.tier === 'strong' ? (strong[0] as ModelRef) : FAST),
    tier: (t: 'fast' | 'strong'): ModelRef[] => (t === 'strong' ? strong : [FAST]),
    apiKey: (provider: string) => (keys.includes(provider) ? `${provider}-key` : undefined),
  };
}
describe('主干直解路线开几份', () => {
  it('写了具体模型的照写的开，重复模型保留独立副本，路线名区分每一份', async () => {
    h = await harness({ registry: tiers([KIMI, GLM], ['moonshot', 'zhipu']) });
    const one = await h.run({ config: { bet0: { copies: 1, models: [GLM, GLM] } } });
    expect(one.config.bet0.models).toEqual([GLM, GLM]);
    expect(h.runStore.queries.listBets(one.id).map((b) => [b.label, b.model])).toEqual([
      ['主干直解路线（zhipu/glm-5.3） · 1', GLM],
      ['主干直解路线（zhipu/glm-5.3） · 2', GLM],
    ]);
    // 写了具体的就照写的开：deepseek 没配 key 也开（建任务前的检查只管每一档有没有能用的）
    const two = await h.run({ config: { bet0: { copies: 1, models: [DSF, KIMI] } } });
    expect(h.runStore.queries.listBets(two.id).map((b) => b.label)).toEqual([
      '主干直解路线（deepseek-v4-flash）',
      '主干直解路线（kimi-k2.5）',
    ]);
    // 两家的模型名一样时带上供应商
    const twin: ModelRef = { provider: 'ark', model: 'kimi-k2.5', tier: 'strong' };
    const three = await h.run({ config: { bet0: { copies: 1, models: [KIMI, twin] } } });
    expect(h.runStore.queries.listBets(three.id).map((b) => b.label)).toEqual([
      '主干直解路线（moonshot/kimi-k2.5）',
      '主干直解路线（ark/kimi-k2.5）',
    ]);
    const mixed = await h.run({ config: { bet0: { models: [GLM, KIMI, GLM] } } });
    expect(h.runStore.queries.listBets(mixed.id).map((b) => b.label)).toEqual([
      '主干直解路线（zhipu/glm-5.3） · 1',
      '主干直解路线（kimi-k2.5）',
      '主干直解路线（zhipu/glm-5.3） · 2',
    ]);
    for (const r of [one, two, three, mixed]) await h.rt.runs.cancel(r.id);
    await h.settle();
  });
  it('Scoper 标准补给每份 Bet 0；追加指令广播到所有副本，并立即送达正在运行的会话', async () => {
    h = await harness({ registry: tiers([KIMI, GLM], ['moonshot', 'zhipu']) });
    h.scoper.output = SCOPED;
    const r0 = await h.run({ config: { bet0: { models: [KIMI, GLM] } } });
    const copies = [h.branchOf(r0.id, '主干直解路线（kimi-k2.5）'), h.branchOf(r0.id, '主干直解路线（glm-5.3）')];
    await waitFor(() => copies.every((b) => h.explorer.count(b.id) === 1), '两份都开跑');
    for (const b of copies) {
      const notices = h.runStore.queries.inbox(b.id, 0).filter((i) => i.kind === 'notice');
      expect(notices.some((i) => i.text.includes('第一个测试'))).toBe(false);
    }
    const hint = await h.rt.runs.input(r0.id, { kind: 'hint', text: '旧打分逻辑下个月就删，别测它' });
    expect(hint.text).toContain('旧打分逻辑');
    for (const b of copies) {
      expect(h.runStore.queries.inbox(b.id, 0).filter((i) => i.kind === 'human')).toMatchObject([{ ref: hint.id }]);
      await waitFor(() => (h.explorer.steers.get(b.id) ?? []).some((t) => t.includes('旧打分逻辑')), '追加给这一份');
    }
    expect(run(r0.id).mode).toBe('direct');
    h.runStore.writer.updateRun(r0.id, { mode: 'direct' });
    const told = await h.rt.runs.input(r0.id, { kind: 'hint', text: '先别动数据库' });
    expect(told.text).toBe('先别动数据库');
    for (const b of copies) {
      expect(h.runStore.queries.inbox(b.id, 0).filter((i) => i.ref === told.id)).toMatchObject([
        { kind: 'human', text: '先别动数据库' },
      ]);
    }
    await h.rt.runs.cancel(r0.id);
    await h.settle();
  });
});
describe('人（§4、§15）', () => {
  it('direct 会话追加指令广播路线：写进它的收件箱，正在跑的 episode 立即追加；不触发升级', async () => {
    h = await harness();
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    const b0 = h.bet0(r0.id);
    await waitFor(() => h.explorer.count(b0.id) === 1, 'episode 开始');
    const input = await h.rt.runs.input(r0.id, { kind: 'hint', text: '旧打分逻辑下个月就删，别测它' });
    expect(input.text.length).toBeGreaterThan(0);
    expect(h.runStore.queries.inbox(b0.id, 0)).toMatchObject([{ kind: 'human', ref: input.id }]);
    await waitFor(() => (h.explorer.steers.get(b0.id) ?? []).some((t) => t.includes('旧打分逻辑')), '追加给 Bet 0');
    expect(run(r0.id).mode).toBe('direct');
  });
  it('还在准备工作目录时追加指令：Bet 0 还没开，拒绝并说明；Scoper 还在起草时追加指令：Bet 0 已经在跑，交给它', async () => {
    h = await harness();
    let release = () => {};
    h.workspaces.initGate = new Promise<void>((r) => {
      release = r;
    });
    h.scoper.hang = true;
    const created = await h.rt.runs.create({ statement: '做个事', materials: [], config: { bet0: { copies: 1 } } });
    await waitFor(() => h.workspaces.ops('init').length === 1, '开始打根 snapshot');
    await expect(h.rt.runs.input(created.id, { kind: 'hint', text: '先看看 README' })).rejects.toThrow(HINT_NOT_YET);
    release();
    await waitFor(() => h.scoper.calls === 1, 'Scoper 开始');
    const input = await h.rt.runs.input(created.id, { kind: 'hint', text: '先看看 README' });
    expect(input.text.length).toBeGreaterThan(0);
    expect(h.runStore.queries.inbox(h.bet0(created.id).id, 0)).toMatchObject([{ kind: 'human', ref: input.id }]);
    await h.rt.runs.cancel(created.id);
    await h.settle();
  });
});
describe('接着做、删除', () => {
  it('接着做：没做完的从起点起，带上上个任务的附件、知识报告和没做完的 patch；工作目录照旧', async () => {
    h = await harness();
    h.explorer.on(
      '主干直解路线',
      (ctx) => {
        ctx.observe();
        return ctx.done(closes.end());
      },
      (ctx) => ctx.untilAborted(),
    );
    const upload = join(h.dir, 'data.csv');
    writeFileSync(upload, 'a,b\n1,2\n');
    const r0 = await h.run({ materials: [{ name: 'data.csv', path: upload }], config: { bet0: { copies: 1 } } });
    await waitFor(() => h.explorer.count(h.bet0(r0.id).id) === 2, '第二个 episode');
    const prev = await h.rt.runs.cancel(r0.id);
    const next = await h.rt.runs.create({
      statement: '接着把冷启动降下来',
      materials: [],
      continueFrom: prev.id,
      config: { bet0: { copies: 1 } },
    });
    expect(next).toMatchObject({
      continuedFrom: prev.id,
      workspace: { root: prev.workspace.root, kind: prev.workspace.kind, from: { runId: prev.id, snapshot: 'root' } },
    });
    expect(next.goal.materials.map((m) => m.name)).toEqual(['data.csv', '知识报告.md', '没做完的改动.patch']);
    expect(await text(next.id, next.goal.materials[1]?.handle as string)).toContain('# 任务记录');
    await h.settle();
  });
  it('接着做 done 的任务：从交付的候选 snapshot 起，不带 patch', async () => {
    h = await harness();
    h.explorer.on('主干直解路线', (ctx) => {
      ctx.observe('全过');
      return ctx.done(closes.submit());
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => run(r0.id).status === 'done', '交付完');
    const candidate = h.runStore.queries.candidates(r0.id)[0];
    const next = await h.rt.runs.create({
      statement: '再补几个测试',
      materials: [],
      continueFrom: r0.id,
      completion: COMPLETION,
      domain: 'code',
      config: { bet0: { copies: 1 } },
    });
    expect(next.workspace.from).toEqual({ runId: r0.id, snapshot: candidate?.snapshot });
    expect(next.goal.materials.map((m) => m.name)).toEqual(['知识报告.md']);
    await h.settle();
  });
  it('删除：只删已经结束的，连同 RunStore 记录、Artifact 和数据目录；结果没结束时拿不到', async () => {
    h = await harness();
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await expect(h.rt.runs.delete(r0.id)).rejects.toThrow('只能删除已经结束的任务');
    await expect(h.rt.runs.result(r0.id)).rejects.toThrow('还没结束');
    await h.rt.runs.cancel(r0.id);
    const dataDir = join(h.dir, 'data', r0.id);
    expect(existsSync(dataDir)).toBe(true);
    await h.rt.runs.delete(r0.id);
    expect(h.runStore.queries.getRun(r0.id)).toBeUndefined();
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(join(h.dir, 'artifacts', r0.id))).toBe(false);
    await tick(5);
  });
});
describe('存个阶段版', () => {
  /** 在求解分支当前的 episode 上保存阶段版（BranchRunners.deliver：打 snapshot、写成一版）。 */
  async function deliver(runId: string, claim: string) {
    const b0 = h.bet0(runId);
    return h.rt.runners.deliver({
      runId,
      branchId: b0.id,
      version: {
        episode: b0.episode,
        claim,
      },
    });
  }
  it('没接上挑版：交过几版也交付最先存的那一版，后交的自报证明了全部标准也不顶掉它', async () => {
    h = await harness();
    let seen: string | undefined;
    h.explorer.on('主干直解路线', (ctx) => {
      seen = ctx.observe('覆盖率 82%，测试全过').id;
      return ctx.untilAborted();
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    const part = await deliver(r0.id, '测试全过，覆盖率还没量');
    await deliver(r0.id, '说是两条都证明了的一版');
    const r = await h.rt.runs.cancel(r0.id);
    expect(r.result?.candidateId).toBe(part.candidate.id);
    expect(h.workspaces.ops('deliver')).toEqual([[part.candidate.snapshot]]);
  });
  it('只交过一版：停下时不用挑，交付的就是它', async () => {
    const selector = new FakeSelector();
    h = await harness({ selector });
    let seen: string | undefined;
    h.explorer.on('主干直解路线', (ctx) => {
      seen = ctx.observe('覆盖率 82%，测试全过').id;
      return ctx.untilAborted();
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    const only = await deliver(r0.id, '唯一的一版');
    const r = await h.rt.runs.cancel(r0.id);
    expect(selector.calls).toEqual([]);
    expect(r.result?.candidateId).toBe(only.candidate.id);
  });
  it('取消时要等挑版挑完再交付挑中的那一版', async () => {
    const selector = new FakeSelector();
    let release = () => {};
    selector.gate = new Promise<void>((r) => {
      release = r;
    });
    h = await harness({ selector });
    let seen: string | undefined;
    h.explorer.on('主干直解路线', (ctx) => {
      seen = ctx.observe('覆盖率 82%，测试全过').id;
      return ctx.untilAborted();
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    await deliver(r0.id, '第一版');
    const second = await deliver(r0.id, '第二版');
    const cancelling = h.rt.runs.cancel(r0.id);
    await waitFor(() => selector.calls.length === 1, '开始挑版');
    await tick(20);
    expect(run(r0.id).status).toBe('running'); // 还在等挑版
    release();
    const r = await cancelling;
    expect(r.result?.candidateId).toBe(second.candidate.id);
    expect(selector.calls).toHaveLength(1);
  });
  it('挑版没挑成：交付最先存的那一版，日志写明', async () => {
    const selector = new FakeSelector();
    selector.fail = true;
    h = await harness({ selector });
    let seen: string | undefined;
    h.explorer.on('主干直解路线', (ctx) => {
      seen = ctx.observe('覆盖率 82%，测试全过').id;
      return ctx.untilAborted();
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    const first = await deliver(r0.id, '第一版');
    await deliver(r0.id, '第二版');
    const r = await h.rt.runs.cancel(r0.id);
    expect(r.result?.candidateId).toBe(first.candidate.id);
    expect(selector.calls).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('挑版没挑成'))).toBe(true);
    expect(h.events('version.picked')).toEqual([]);
  });
  it('只交过只证了一部分的一版：取消时照样交付它，知识报告写明还差哪条', async () => {
    h = await harness();
    let seen: string | undefined;
    h.explorer.on('主干直解路线', (ctx) => {
      seen = ctx.observe('测试全过').id;
      return ctx.untilAborted();
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    const part = await deliver(r0.id, '测试全过，覆盖率还没量');
    const r = await h.rt.runs.cancel(r0.id);
    expect(r.result?.candidateId).toBe(part.candidate.id);
    const report = await text(r.id, r.result?.knowledgeReport as string);
    expect(report).toContain('测试全过，覆盖率还没量');
  });
  it('交过两版再取消：交付挑中的那一版（推成 melina/<runId>），知识报告写明，不另存没做完的 patch', async () => {
    h = await harness({ selector: new FakeSelector() });
    let seen: string | undefined;
    h.explorer.on('主干直解路线', (ctx) => {
      seen = ctx.observe('覆盖率 82%，测试全过').id;
      return ctx.untilAborted();
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    const v1 = await deliver(r0.id, '第一版：覆盖率 82%');
    const v2 = await deliver(r0.id, '第二版：覆盖率 82%，补了边界');
    expect(v2.snapshot.parent).toBe(v1.snapshot.id);
    expect(run(r0.id)).toMatchObject({ status: 'running', mode: 'direct' });
    expect(h.bet0(r0.id)).toMatchObject({ state: 'running', lastSnapshot: v2.snapshot.id });
    const r = await h.rt.runs.cancel(r0.id);
    expect(r).toMatchObject({
      status: 'cancelled',
      endReason: '你取消了任务',
      result: { candidateId: v2.candidate.id, branch: `melina/${r.id}` },
    });
    expect(h.workspaces.ops('deliver')).toEqual([[v2.candidate.snapshot]]);
    // 只有挑版读各版内容时算过 patch（相对起点），没另存主路线没做完的
    for (const [base, target] of h.workspaces.ops('diffSnapshots') as [string, string][]) {
      expect(base).toBe('root');
      expect([v1.candidate.snapshot, v2.candidate.snapshot]).toContain(target);
    }
    const report = await text(r.id, r.result?.knowledgeReport as string);
    expect(report).toContain('结果：你取消了任务');
    expect(report).toContain('第二版：覆盖率 82%，补了边界');
    expect(report).not.toContain('另存成了 patch');
    const result = await h.rt.runs.result(r.id);
    expect(result).toMatchObject({
      status: 'cancelled',
      candidate: { id: v2.candidate.id, interim: true },
      branch: `melina/${r.id}`,
      unfinished: false,
    });
  });
  it('交过一版以后又在收尾时交了候选：交付的是候选，Run 转 done', async () => {
    h = await harness();
    let seen: string | undefined;
    let go = () => {};
    const gate = new Promise<void>((r) => {
      go = r;
    });
    h.explorer.on('主干直解路线', async (ctx) => {
      const o = ctx.observe('覆盖率 82%，测试全过');
      seen = o.id;
      await gate;
      return ctx.done(closes.submit());
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    const v = await deliver(r0.id, '先存个阶段版');
    go();
    await waitFor(() => run(r0.id).status === 'done', '交付完');
    const final = h.runStore.queries.candidates(r0.id).find((c) => !c.interim);
    expect(final).toBeDefined();
    expect(run(r0.id).result?.candidateId).toBe(final?.id);
    expect(h.workspaces.ops('deliver')).toEqual([[final?.snapshot]]);
    expect(h.runStore.queries.candidates(r0.id).map((c) => c.id)).toEqual([v.candidate.id, final?.id]);
  });
  it('接着做取消时交付了一版的任务：从那一版的 snapshot 起，不带没做完的 patch', async () => {
    h = await harness();
    let seen: string | undefined;
    h.explorer.on('主干直解路线', (ctx) => {
      seen = ctx.observe('覆盖率 82%，测试全过').id;
      return ctx.untilAborted();
    });
    const r0 = await h.run({ config: { bet0: { copies: 1 } } });
    await waitFor(() => seen !== undefined, '第一次观测');
    const v = await deliver(r0.id, '存了阶段版');
    await h.rt.runs.cancel(r0.id);
    const next = await h.rt.runs.create({
      statement: '再补几个测试',
      materials: [],
      continueFrom: r0.id,
      completion: COMPLETION,
      domain: 'code',
      config: { bet0: { copies: 1 } },
    });
    expect(next.workspace.from).toEqual({ runId: r0.id, snapshot: v.candidate.snapshot });
    expect(next.goal.materials.map((m) => m.name)).toEqual(['知识报告.md']);
    await h.settle();
  });
});
