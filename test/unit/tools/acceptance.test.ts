import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ctfBeforeClose } from '../../../extensions/ctf/entry.ts';
import { newId } from '../../../src/core/ids.ts';
import { branch, call, type Kit, kit, openExplorer } from './gateway-kit.ts';

// 新架构各求解分支统一使用候选交付协议。
function submitCandidate(session: ReturnType<typeof openExplorer>, args: { claim: string; artifact?: string }) {
  return call(session, 'end_episode', { candidate: args });
}

const kits: Kit[] = [];
afterEach(() => {
  for (const k of kits.splice(0)) k.cleanup();
});

async function setup(managed = true) {
  const k = kit({
    deps: { submissionGuards: [ctfBeforeClose] },
    completion: {
      interpretation: '完成任务',
      criteria: [managed ? 'BENCHMARK_PROGRESS.json 中 remaining_flag_count 为 0' : '完成测试'],
    },
  });
  kits.push(k);
  const b = await branch(k, { kind: 'direct' });
  const session = openExplorer(k, b);
  await call(session, 'sh', { cmd: 'echo observed' });
  const args = { claim: '已完成' };
  const path = join(k.views.branchDir(k.run.id, b.branch.id), 'BENCHMARK_PROGRESS.json');
  const progress = {
    run_id: k.run.id,
    flag_count: 3,
    correct_flag_count: 1,
    remaining_flag_count: 2,
    is_completed: false,
  };
  const write = (over = {}) => writeFileSync(path, JSON.stringify({ ...progress, ...over }));
  return { k, b, session, args, path, write, progress };
}

it('单项验收后继续同一会话，多次请求收尾不消耗返修；全部验收后才终止', async () => {
  const { k, session, args, write } = await setup();
  write();
  for (let i = 0; i < 3; i++) {
    const out = await submitCandidate(session, args);
    expect(out).toMatchObject({ isError: false });
    expect(out.content).toContain('还剩 2 项');
    expect(out.terminate).toBeUndefined();
    expect(session.closed()).toBeUndefined();
  }
  expect(k.runStore.queries.getRun(k.run.id)?.status).toBe('running');
  await call(session, 'sh', { cmd: 'echo next-result' });
  write({ correct_flag_count: 3, remaining_flag_count: 0, is_completed: true });
  expect(await submitCandidate(session, args)).toMatchObject({ isError: false, terminate: true });
  expect(session.closed()?.tool).toBe('end_episode');
});

it('拒绝一个字符串和提交待确认都不能结束路线；任何求解分支都受平台约束', async () => {
  const { k, write } = await setup();
  write({ rejected_flags: ['flag{rejected}'], pending_flags: ['flag{pending}'] });
  const b = await branch(k, { kind: 'direct' });
  const session = openExplorer(k, b);
  await call(session, 'sh', { cmd: 'echo second-solver' });
  writeFileSync(
    join(k.views.branchDir(k.run.id, b.branch.id), 'BENCHMARK_PROGRESS.json'),
    JSON.stringify({
      run_id: k.run.id,
      flag_count: 3,
      correct_flag_count: 1,
      remaining_flag_count: 2,
    }),
  );
  const out = await submitCandidate(session, {
    claim: '部分找到',
  });
  expect(out.content).toContain('拒绝只否定该字符串');
  expect(session.closed()).toBeUndefined();
});

it('缺失、损坏、旧 Run、矛盾数量和 workspace 伪造反馈不能绕过验收', async () => {
  const { k, b, session, args, path, write } = await setup();
  writeFileSync(
    join(b.ws, 'BENCHMARK_PROGRESS.json'),
    JSON.stringify({ run_id: k.run.id, remaining_flag_count: 0, is_completed: true }),
  );
  const pending = async () => {
    const out = await submitCandidate(session, args);
    expect(out).toMatchObject({ isError: false });
    expect(out.content).toContain('平台验收尚未确认');
    expect(out.terminate).toBeUndefined();
  };
  await pending();
  writeFileSync(path, '{');
  await pending();
  write({ run_id: newId(), correct_flag_count: 3, remaining_flag_count: 0 });
  await pending();
  write({ remaining_flag_count: 0 });
  await pending();
  write({ flag_count: 0, correct_flag_count: 0, remaining_flag_count: 0 });
  await pending();
  rmSync(path);
  symlinkSync(join(b.ws, 'BENCHMARK_PROGRESS.json'), path);
  await pending();
});

it('平台显式完成允许收尾，普通任务不要求平台文件；暂停交接仍能收尾', async () => {
  const first = await setup();
  first.write({ is_completed: true, remaining_flag_count: 0 });
  expect(await submitCandidate(first.session, first.args)).toMatchObject({ terminate: true });
  const second = await setup(false);
  expect(await submitCandidate(second.session, second.args)).toMatchObject({ terminate: true });
  const third = await setup();
  expect(await call(third.session, 'end_episode', { handoff: '继续补齐未验收的目标' })).toMatchObject({
    terminate: true,
  });
});

it.each(['missing', 'partial', 'complete'] as const)(
  'Scoper 标准省略文件名时，宿主任务仍按平台进度验收：%s',
  async (feedback) => {
    const k = kit({
      statement:
        '授权任务，实例和验收分别以 /melina/artifacts/BENCHMARK_INSTANCE.json 与 /melina/artifacts/BENCHMARK_PROGRESS.json 为准。',
      completion: false,
      deps: { submissionGuards: [ctfBeforeClose] },
    });
    kits.push(k);
    const b = await branch(k, { kind: 'direct' });
    const session = openExplorer(k, b);
    await call(session, 'sh', { cmd: 'echo observed' });
    k.runStore.writer.draftCompletion(k.run.id, {
      completion: { interpretation: '补齐本题全部 flag', criteria: ['平台确认 remaining_flag_count 为 0'] },
      constraints: [],
      domain: 'ctf',
    });
    if (feedback !== 'missing') {
      writeFileSync(
        join(k.views.branchDir(k.run.id, b.branch.id), 'BENCHMARK_PROGRESS.json'),
        JSON.stringify({
          run_id: k.run.id,
          flag_count: 3,
          correct_flag_count: feedback === 'complete' ? 3 : 1,
          remaining_flag_count: feedback === 'complete' ? 0 : 2,
          is_completed: feedback === 'complete',
        }),
        { mode: 0o444 },
      );
    }
    const result = await submitCandidate(session, { claim: '已完成' });
    expect(result.isError).toBe(false);
    expect(result.terminate === true).toBe(feedback === 'complete');
    expect(session.closed() !== undefined).toBe(feedback === 'complete');
    if (feedback !== 'complete') expect(result.content).toContain(feedback === 'partial' ? '还剩 2 项' : '尚未确认');
  },
);

it('普通文件处理任务仅在题面提及进度文件时不启用平台验收', async () => {
  const k = kit({
    statement: '整理 BENCHMARK_PROGRESS.json 的字段说明',
    completion: { interpretation: '编写字段文档', criteria: ['文档说明各个字段含义'] },
    deps: { submissionGuards: [ctfBeforeClose] },
  });
  kits.push(k);
  const session = openExplorer(k, await branch(k));
  expect(await submitCandidate(session, { claim: '文档已完成' })).toMatchObject({ terminate: true });
});
