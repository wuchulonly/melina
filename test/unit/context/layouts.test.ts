import { afterEach, expect, it } from 'vitest';
import { MelinaContextAssembler } from '../../../src/context/assembler.ts';
import { newRun, startBranch, type TestRunStore, testRunStore } from '../storage/kit.ts';

let b: TestRunStore;
afterEach(() => b?.close());
it('同一存储版本组装稳定，直接会话只有目标和人的消息', () => {
  b = testRunStore();
  const run = newRun(b),
    { branch } = startBranch(b, run);
  const assembler = new MelinaContextAssembler({ queries: b.queries });
  const first = assembler.forExplorer(branch);
  expect(assembler.forExplorer(branch)).toEqual(first);
  expect(first.role).toBe('explorer');
  expect(first.tools.map((t) => t.name)).toEqual(['sh', 'read', 'edit', 'write', 'deliver', 'end_episode']);
  expect(first.system).toContain(run.goal.statement);
  expect(first.messages[0]?.text).toBe('开始执行目标。');
});
it('事件更新只消费指定分支未读文字，首轮交接说明快照恢复边界', () => {
  b = testRunStore();
  const run = newRun(b),
    source = startBranch(b, run),
    next = startBranch(b, run, {
      label: '接力',
      continuation: {
        key: 'progress:1',
        slot: 0,
        handoff: '入口已获得；服务监听 8080。',
        direction: '从已有入口调查新路径',
      },
    });
  b.writer.appendInbox({ runId: run.id, branchId: next.branch.id, kind: 'human', text: '先核对权限' });
  b.writer.appendInbox({ runId: run.id, branchId: source.branch.id, kind: 'human', text: '源路线私有提示' });
  const assembler = new MelinaContextAssembler({ queries: b.queries }),
    layout = assembler.forExplorer(next.branch);
  expect(layout.messages[0]?.text).toContain('入口已获得');
  expect(layout.messages[0]?.text).toContain('容器是新建的');
  expect(layout.messages[0]?.text).toContain('从已有入口');
  expect(layout.messages[0]?.text).not.toContain('源路线私有提示');
  const update = assembler.explorerUpdate(next.branch, 0);
  expect(update?.text).toBe('先核对权限');
  expect(assembler.explorerUpdate(next.branch, update!.seenSeq!)).toBeUndefined();
});
it('Scoper 的领域列表只在只读作用域内提供', () => {
  b = testRunStore();
  const run = newRun(b, { completion: false }),
    assembler = new MelinaContextAssembler({
      queries: b.queries,
      domains: () => [{ name: 'code', description: '代码领域' }],
    });
  const layout = assembler.forScoper(run);
  expect(layout.role).toBe('scoper');
  expect(layout.tools.map((t) => t.name)).toEqual(['sh', 'read', 'submit_completion']);
  expect(JSON.stringify(layout)).toContain('code');
});

it('接力分支继承创建前的追加指令与验收回执，已有收件箱引用不重复', () => {
  b = testRunStore();
  const run = newRun(b),
    source = startBranch(b, run);
  const historical = '不要修改原始输入文件';
  b.writer.recordHumanInput({ runId: run.id, text: historical });
  b.writer.recordHumanInput({
    runId: run.id,
    text: '第一项已验收，继续剩余目标',
    acceptance: { task: 'task-a', total: 2, accepted: 1 },
  });
  const next = startBranch(b, run, {
    label: '接力路线',
    continuation: {
      key: 'progress:1',
      slot: 0,
      handoff: '已排除无效路径，保留当前入口。',
      direction: '调查新的调用链',
    },
  });
  const current = '优先核对输入边界';
  const { input } = b.writer.recordHumanInput({ runId: run.id, text: current });
  expect(b.queries.inbox(next.branch.id, 0).some((item) => item.ref === input.id)).toBe(true);
  b.writer.appendInbox({ runId: run.id, branchId: source.branch.id, kind: 'notice', text: '仅源路线的恢复提示' });
  b.writer.appendInbox({ runId: run.id, branchId: next.branch.id, kind: 'notice', text: '新容器服务需要重启' });
  const assembler = new MelinaContextAssembler({ queries: b.queries }),
    layout = assembler.forExplorer(next.branch),
    text = layout.messages[0]!.text;
  for (const hint of [historical, '第一项已验收，继续剩余目标', current]) expect(text.split(hint)).toHaveLength(2);
  expect(text).toContain('新容器服务需要重启');
  expect(text).not.toContain('仅源路线的恢复提示');
  const resumed = assembler.forExplorer({ ...next.branch, seenSeq: b.queries.lastSeq() }).messages[0]!.text;
  for (const hint of [historical, '第一项已验收，继续剩余目标', current]) expect(resumed.split(hint)).toHaveLength(2);
});
