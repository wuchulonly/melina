// 分支命令串行应用；暂停、取消、候选交付及安全读取工作区文件。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '../../../src/core/events.ts';
import { newId } from '../../../src/core/ids.ts';
import type { EpisodeHandle, EpisodeOutcome } from '../../../src/core/interfaces/agents.ts';
import type { CloseOutcome } from '../../../src/core/tools.ts';
import type { Branch, Run } from '../../../src/core/types.ts';
import { RuntimeBranchManager, readWorkspaceFile } from '../../../src/runtime/branch-manager.ts';
import { betDraft, newRun, startBranch, type TestRunStore, testRunStore } from '../storage/kit.ts';
import { closes, observeStored as observe } from './kit.ts';

let runStore: TestRunStore;
let dir: string;
afterEach(() => {
  runStore?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'melina-bm-'));
  runStore = testRunStore({ artifacts: join(dir, 'artifacts') });
  const bm = new RuntimeBranchManager({
    writer: runStore.writer,
    queries: runStore.queries,
    artifacts: runStore.artifacts as NonNullable<TestRunStore['artifacts']>,
  });
  return { bm };
}
/** 一个正在跑的假 episode：记下追加的内容和取消 */
function episode() {
  const steered: string[] = [];
  const abort = new AbortController();
  // 中止以后交回「既没有 close 也没有 failure」（被中止，和真的 Explorer 一样）：kill、取消要等它交回才接着执行
  const done = new Promise<EpisodeOutcome>((resolve) => {
    abort.signal.addEventListener('abort', () => resolve({ toolCalls: 0, seenSeq: 0, usage: { ...ZERO_USAGE } }), {
      once: true,
    });
  });
  const handle: EpisodeHandle = { done, steer: (text) => steered.push(text) };
  return { handle, abort, steered };
}
function outcome(close?: CloseOutcome, toolCalls = 3): EpisodeOutcome {
  return {
    ...(close ? { close } : { failure: 'no_close' as const }),
    toolCalls,
    seenSeq: runStore.queries.lastSeq(),
    usage: { ...ZERO_USAGE },
  };
}
function fresh(b: Branch): Branch {
  return runStore.queries.getBranch(b.id) as Branch;
}
function runOf(b: Branch): Run {
  return runStore.queries.getRun(b.runId) as Run;
}
describe('命令', () => {
  it('从已保存的工作区建立干净 direct 分支，模型只接收文字交接', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const source = startBranch(runStore, run).branch;
    runStore.writer.closeEpisode({
      branchId: source.id,
      episode: 1,
      outcome: 'ended',
      snapshot: { id: 'snapshot-source' },
      handoff: '已有入口，workspace/entry.txt 保存凭据',
    });
    const bet = runStore.writer.createBet({
      ...betDraft({
        label: '接力路线',
        startFrom: { snapshot: 'snapshot-source' },
        diffFrom: { branchId: source.id, note: '继续内网' },
        continuation: {
          key: 'progress:1',
          slot: 0,
          handoff: '已有入口，workspace/entry.txt 保存凭据',
          direction: '继续内网',
        },
      }),
      runId: run.id,
      source: { kind: 'template' },
    });
    const fork = await bm.apply({ kind: 'open', runId: run.id, bet });
    expect(fork).toMatchObject({
      state: 'starting',
      queued: true,
      episode: 1,
      lastSnapshot: 'snapshot-source',
      parentBranchId: source.id,
      toolCalls: 0,
    });
    expect(runStore.queries.observations(fork.id).items).toEqual([]);
    expect(runStore.queries.getBet(fork.betId)?.continuation?.handoff).toContain('workspace/entry.txt');
  });

  it('pause：episode 在跑就记下、追加一句提示，收尾时转 paused；没在跑就直接转 paused', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const a = startBranch(runStore, run).branch;
    const ep = episode();
    bm.attachEpisode(a.id, ep.handle, ep.abort, { runId: run.id, startSeq: runStore.queries.lastSeq(), seenSeq: 0 });
    const pending = await bm.apply({ kind: 'pause', branchId: a.id, reason: '先把容量让给主路线' });
    expect(pending).toMatchObject({ state: 'running', pendingPause: '先把容量让给主路线' });
    expect(ep.steered).toEqual([expect.stringContaining('先把容量让给主路线')]);
    observe(runStore, a);
    bm.detach(a.id);
    const closed = await bm.closeEpisode(fresh(a), outcome(closes.end()), 'snap-a1');
    expect(closed).toMatchObject({ state: 'paused', stateNote: '先把容量让给主路线' });
    expect(closed.pendingPause).toBeUndefined();
    const b = startBranch(runStore, run, { label: '另一条' }).branch;
    const paused = await bm.apply({ kind: 'pause', branchId: b.id, reason: '落后了' });
    expect(paused).toMatchObject({ state: 'paused', stateNote: '落后了', queued: false });
  });
  it('resume：重新排队、起主循环；还没生效的暂停直接撤掉', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const a = startBranch(runStore, run).branch;
    await bm.apply({ kind: 'pause', branchId: a.id, reason: '停一下' });
    const resumed = await bm.apply({ kind: 'resume', branchId: a.id });
    expect(resumed).toMatchObject({ state: 'running', queued: true });
    expect(resumed.stateNote).toBeUndefined();
    const ep = episode();
    bm.attachEpisode(a.id, ep.handle, ep.abort, { runId: run.id, startSeq: 0, seenSeq: 0 });
    await bm.apply({ kind: 'pause', branchId: a.id, reason: '停一下' });
    const undone = await bm.apply({ kind: 'resume', branchId: a.id });
    expect(undone.state).toBe('running');
    expect(undone.pendingPause).toBeUndefined();
  });
  it('cancel 带原因、prioritize 改权重；结束了的分支不能再调', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const a = startBranch(runStore, run).branch;
    expect((await bm.apply({ kind: 'prioritize', branchId: a.id, weight: 2 })).weight).toBe(2);
    const c = await bm.cancel(a.id, '另一条路线先交了');
    expect(c).toMatchObject({ state: 'cancelled', stateNote: '另一条路线先交了' });
    await expect(bm.apply({ kind: 'prioritize', branchId: a.id, weight: 3 })).rejects.toThrow('已经结束');
  });
  it('steer：没有在跑的 episode 返回 false', () => {
    const { bm } = setup();
    expect(bm.steer(newId(), '你好')).toBe(false);
  });
});
describe('收尾（closeEpisode）', () => {
  it('end_episode.candidate：分支 succeeded，Run 切到 settling；交付物从 workspace 存进 Artifact store', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const ws = join(dir, 'ws');
    rmSync(ws, { recursive: true, force: true });
    const a = startBranch(runStore, run).branch;
    const withWs = runStore.writer.updateBranch(a.id, { workspace: { path: ws } });
    await import('node:fs/promises').then((fs) => fs.mkdir(join(ws, 'docs'), { recursive: true }));
    writeFileSync(join(ws, 'docs', 'report.md'), '# 综述\n\n三种等价说法');
    observe(runStore, withWs);
    const closed = await bm.closeEpisode(
      fresh(a),
      outcome(closes.submit({ artifact: '/workspace/docs/report.md' })),
      'snap-c',
    );
    expect(closed.state).toBe('succeeded');
    expect(runOf(closed).mode).toBe('settling');
    const c = runStore.queries.candidates(run.id)[0];
    expect(c).toMatchObject({ snapshot: 'snap-c', artifactPath: 'docs/report.md' });
    const content = await runStore.artifacts?.read(run.id, c?.artifact as never);
    expect(Buffer.from(content as Uint8Array).toString()).toContain('三种等价说法');
  });
  it('存交付物时先冻结挂着这个 workspace 的容器，读完再放开（和打 snapshot 一样）', async () => {
    setup();
    const frozen: string[] = [];
    let readInside = false;
    const bm = new RuntimeBranchManager({
      writer: runStore.writer,
      queries: runStore.queries,
      artifacts: runStore.artifacts as NonNullable<TestRunStore['artifacts']>,
      freeze: async (path, work) => {
        frozen.push(path);
        readInside = true;
        try {
          return await work();
        } finally {
          readInside = false;
        }
      },
    });
    const run = newRun(runStore);
    const ws = join(dir, 'ws-frozen');
    await import('node:fs/promises').then((fs) => fs.mkdir(ws, { recursive: true }));
    writeFileSync(join(ws, 'report.md'), '# 报告');
    const a = runStore.writer.updateBranch(startBranch(runStore, run).branch.id, { workspace: { path: ws } });
    observe(runStore, a);
    const store = runStore.artifacts as NonNullable<TestRunStore['artifacts']>;
    const put = store.put.bind(store);
    let putWhileFrozen: boolean | undefined;
    store.put = async (runId, content) => {
      putWhileFrozen ??= readInside;
      return put(runId, content);
    };
    await bm.closeEpisode(fresh(a), outcome(closes.submit({ artifact: 'report.md' })), 'snap-f');
    expect(frozen).toEqual([ws]);
    expect(putWhileFrozen).toBe(false); // 冻结期间只读文件，存进 Artifact store 在放开以后
    const c = runStore.queries.candidates(run.id)[0];
    expect(c).toMatchObject({ artifactPath: 'report.md' });
    const content = await runStore.artifacts?.read(run.id, c?.artifact as never);
    expect(Buffer.from(content as Uint8Array).toString()).toBe('# 报告');
  });
  it('交付物指到 workspace 外面（符号链接）就不收，候选照样提交', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const ws = join(dir, 'ws2');
    await import('node:fs/promises').then((fs) => fs.mkdir(ws, { recursive: true }));
    writeFileSync(join(dir, 'secret.txt'), '机密');
    symlinkSync(join(dir, 'secret.txt'), join(ws, 'link.txt'));
    const a = runStore.writer.updateBranch(startBranch(runStore, run).branch.id, { workspace: { path: ws } });
    observe(runStore, a);
    await bm.closeEpisode(fresh(a), outcome(closes.submit({ artifact: 'link.txt' })), 'snap-l');
    const c = runStore.queries.candidates(run.id)[0];
    expect(c?.artifact).toBeUndefined();
  });
  it('正常交接无需环境调用；暂停照常生效，异常会话仍计失败', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const a = startBranch(runStore, run).branch;
    runStore.writer.updateBranch(a.id, { pendingPause: '先让一让' });
    const closed = await bm.closeEpisode(fresh(a), outcome(closes.end(), 0), 'snap-p1');
    expect(closed).toMatchObject({ state: 'paused', failures: 0, stateNote: '先让一让' });
    const b = startBranch(runStore, run, { label: '另一条' }).branch;
    runStore.writer.updateRun(run.id, { status: 'paused' });
    const asFailure: EpisodeOutcome = { ...outcome(undefined, 0), failure: 'context_overflow' };
    const closedB = await bm.closeEpisode(fresh(b), asFailure, 'snap-p2');
    expect(closedB).toMatchObject({ state: 'running', failures: 1, queued: true });
  });
  it('任务暂停时收尾：分支还是 running，去排队', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const a = startBranch(runStore, run).branch;
    runStore.writer.updateRun(run.id, { status: 'paused' });
    observe(runStore, a);
    const closed = await bm.closeEpisode(fresh(a), outcome(closes.end()), 'snap-p');
    expect(closed).toMatchObject({ state: 'running', queued: true });
  });
  it('崩溃恢复：待生效的暂停这时生效，其余的去排队', async () => {
    const { bm } = setup();
    const run = newRun(runStore);
    const a = startBranch(runStore, run).branch;
    const b = startBranch(runStore, run, { label: '另一条' }).branch;
    runStore.writer.updateBranch(a.id, { pendingPause: '先停' });
    expect(await bm.recover(a.id)).toMatchObject({ state: 'paused', stateNote: '先停' });
    expect(await bm.recover(b.id)).toMatchObject({ state: 'running', queued: true });
  });
});
describe('在宿主机上读 workspace 里的交付物（readWorkspaceFile）', () => {
  function tree() {
    dir = mkdtempSync(join(tmpdir(), 'melina-read-'));
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(ws, 'docs', 'report.md'), '# 报告');
    writeFileSync(join(dir, 'outside', 'melina.key'), '宿主机上的密钥');
    return ws;
  }
  it('workspace 里的普通文件：读出内容，路径相对 workspace；指到里面别处的符号链接照收', async () => {
    const ws = tree();
    symlinkSync('docs/report.md', join(ws, 'latest.md'));
    expect(await readWorkspaceFile(ws, 'docs/report.md', 1024)).toEqual({
      content: Buffer.from('# 报告'),
      path: 'docs/report.md',
    });
    expect(await readWorkspaceFile(ws, 'latest.md', 1024)).toMatchObject({ path: 'docs/report.md' });
  });
  it('最后一段或中间一级是指到外面的符号链接：不收', async () => {
    const ws = tree();
    symlinkSync(join(dir, 'outside', 'melina.key'), join(ws, 'key.md'));
    symlinkSync(join(dir, 'outside'), join(ws, 'sub'));
    expect(await readWorkspaceFile(ws, 'key.md', 1024)).toBe('指到了 workspace 外面');
    expect(await readWorkspaceFile(ws, 'sub/melina.key', 1024)).toBe('指到了 workspace 外面');
    expect(await readWorkspaceFile(ws, '../outside/melina.key', 1024)).toBe('指到了 workspace 外面');
  });
  it('不是普通文件、太大：不收；FIFO 不会把 Melina 卡住', async () => {
    const ws = tree();
    execFileSync('mkfifo', [join(ws, 'pipe')]);
    writeFileSync(join(ws, 'big.bin'), Buffer.alloc(2048));
    expect(await readWorkspaceFile(ws, 'pipe', 1024)).toBe('不是普通文件');
    expect(await readWorkspaceFile(ws, 'docs', 1024)).toBe('不是普通文件');
    expect(await readWorkspaceFile(ws, 'big.bin', 1024)).toMatch(/^超过/);
  });
});
