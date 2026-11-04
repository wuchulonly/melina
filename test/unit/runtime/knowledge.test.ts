import { afterEach, describe, expect, it } from 'vitest';
import { mainRoute } from '../../../src/runtime/knowledge.ts';
import { closeEpisode, startBranch } from '../storage/kit.ts';
import { type Harness, harness, observeStored, waitFor } from './kit.ts';

let h: Harness;
afterEach(async () => h?.close());
async function scene() {
  h = await harness();
  const run = await h.run({ config: { bet0: { copies: 1 } } });
  await waitFor(() => h.bet0(run.id).state === 'running', '工作区准备完成');
  return { run, branch: h.bet0(run.id) };
}
async function readReport(runId: string, opts: Parameters<Harness['rt']['knowledge']['write']>[1] = {}) {
  const saved = await h.rt.knowledge.write(runId, opts);
  return { saved, text: Buffer.from(await h.runStore.artifacts!.read(runId, saved.report)).toString() };
}
describe('任务交付记录', () => {
  it('记录每条路线的交接、近期执行和人的补充', async () => {
    const { run, branch } = await scene();
    closeEpisode(h.runStore, branch, { handoff: '已有工作区服务，恢复时运行 ./server.sh' });
    observeStored(h.runStore, branch, '覆盖率达到 82%');
    h.runStore.writer.recordHumanInput({ runId: run.id, text: '先不要改生产数据库' });
    const { text } = await readReport(run.id);
    expect(text).toContain(run.goal.statement);
    expect(text).toContain('./server.sh');
    expect(text).toContain('覆盖率达到 82%');
    expect(text).toContain('先不要改生产数据库');
  });
  it('Watcher 方向与真实尝试保留在交付记录中', async () => {
    const { run, branch } = await scene();
    const evidence = observeStored(h.runStore, branch, '未出现业务标记');
    h.runStore.writer.recordWatch({
      runId: run.id,
      branchId: branch.id,
      basedOnSeq: h.runStore.queries.lastSeq(),
      toolCalls: 1,
      model: h.runStore.queries.getBet(branch.betId)!.model,
      draft: {
        standing: '入口待复验',
        advice: '核对认证',
        tension: [],
        directions: [
          {
            id: 'route',
            direction: '检查业务路径',
            status: 'unclear',
            result: '缺少认证',
            evidence: [evidence.id],
            attempts: [{ id: 't1', action: '带认证发请求', result: '无标记', evidence: [evidence.id] }],
          },
        ],
      },
    });
    const { text } = await readReport(run.id);
    expect(text).toContain('检查业务路径');
    expect(text).toContain('带认证发请求');
  });
  it('未交付时选执行最多路线的最近快照导出未完成 patch', async () => {
    const { run, branch } = await scene();
    const other = startBranch(h.runStore, run, { label: '另一条' }).branch;
    observeStored(h.runStore, other);
    observeStored(h.runStore, other);
    const closed = closeEpisode(h.runStore, other);
    expect(mainRoute(h.runStore.queries, run.id)).toBe(other.id);
    const { saved } = await readReport(run.id);
    expect(saved.patch).toBeDefined();
    expect(h.workspaces.ops('diffSnapshots')).toContainEqual(['root', closed.snapshot!.id]);
    expect(branch.id).not.toBe(other.id);
  });
  it('patch 生成失败仍交付任务记录并写日志', async () => {
    const { run, branch } = await scene();
    closeEpisode(h.runStore, branch);
    h.workspaces.forRun(run).diffSnapshots = async () => {
      throw new Error('快照缺失');
    };
    const { saved, text } = await readReport(run.id);
    expect(saved.patch).toBeUndefined();
    expect(text).toContain(run.goal.statement);
    expect(h.logs.some((l) => l.includes('快照缺失'))).toBe(true);
  });
});
