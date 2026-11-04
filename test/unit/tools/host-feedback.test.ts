import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { ctfBeforeTool } from '../../../extensions/ctf/entry.ts';
import { prepareHostFeedback } from '../../../extensions/ctf/host-feedback.ts';
import { newId } from '../../../src/core/ids.ts';
import { Obj } from '../../../src/core/schema.ts';
import { emptyState, type ToolEnv } from '../../../src/tools/session.ts';
import { type BranchKit, branch, call, type Kit, kit, openExplorer } from './gateway-kit.ts';

const PROGRESS = 'BENCHMARK_PROGRESS.json';
const INSTANCE = 'BENCHMARK_INSTANCE.json';
const kits: Kit[] = [];
afterEach(() => {
  for (const k of kits.splice(0)) k.cleanup();
});

function setup(deps: Parameters<typeof kit>[0] = {}) {
  const k = kit({
    ...deps,
    deps: { beforeTools: [ctfBeforeTool], ...deps.deps },
    completion: {
      interpretation: `先读取 /melina/artifacts/${PROGRESS} 和 /melina/artifacts/${INSTANCE}`,
      criteria: ['完成验收'],
    },
  });
  kits.push(k);
  return k;
}

function publish(dir: string, name: string, runId: string, extra = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ run_id: runId, ...extra }));
  chmodSync(path, 0o444);
}

function publishPair(k: Kit, dir = k.views.scoperDir(k.run.id)) {
  publish(dir, PROGRESS, k.run.id, { remaining_flag_count: 2 });
  publish(dir, INSTANCE, k.run.id, { generation: 1 });
}

function environment(k: Kit, b?: BranchKit): ToolEnv {
  return {
    deps: {
      writer: k.runStore.writer,
      queries: k.runStore.queries,
      artifacts: k.runStore.artifacts!,
      runtime: k.runtime,
      redactor: k.redactor,
      views: k.views,
      newId,
      onError: () => {},
      fileTimeoutMs: 1000,
    },
    caller: b
      ? {
          runId: k.run.id,
          branchId: b.branch.id,
          role: 'explorer',
          snapshot: 'root',
          container: b.container,
          readOnly: false,
        }
      : {
          runId: k.run.id,
          role: 'scoper',
          snapshot: 'root',
          container: { id: 'scoper', name: 'scoper' },
          readOnly: true,
        },
    run: k.run,
    state: emptyState(),
    ready: Promise.resolve(),
  };
}

it('开局完成后并发开两条新路线，第一次 read/sh 前补齐同一 Run 的控制文件', async () => {
  const k = setup();
  publishPair(k);
  const source = k.views.scoperDir(k.run.id);
  writeFileSync(join(source, 'private-output'), '不应跨分支复制');
  const initial = await branch(k);
  publishPair(k, k.views.branchDir(k.run.id, initial.branch.id));
  expect(await call(openExplorer(k, initial), 'read', { path: `/melina/artifacts/${PROGRESS}` })).toMatchObject({
    isError: false,
  });
  const later = await Promise.all([branch(k), branch(k)]);
  for (const b of later) {
    expect(existsSync(join(k.views.branchDir(k.run.id, b.branch.id), PROGRESS))).toBe(false);
  }
  const results = await Promise.all(
    later.map((b, i) =>
      call(
        openExplorer(k, b),
        i === 0 ? 'read' : 'sh',
        i === 0 ? { path: `/melina/artifacts/${PROGRESS}` } : { cmd: `cat /melina/artifacts/${INSTANCE}` },
      ),
    ),
  );
  for (const result of results) {
    expect(result.isError, result.content).toBe(false);
    expect(result.content).toContain(k.run.id);
    expect(result.observationId).toBeDefined();
  }
  for (const b of later) {
    const dir = k.views.branchDir(k.run.id, b.branch.id);
    for (const name of [PROGRESS, INSTANCE]) {
      expect(readFileSync(join(dir, name))).toEqual(readFileSync(join(source, name)));
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o444);
    }
    expect(existsSync(join(dir, 'private-output'))).toBe(false);
    expect(readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false);
  }
});

it('只补缺失文件，重开会话也不以种子覆盖分支已有的新反馈', async () => {
  const k = setup();
  publishPair(k);
  const b = await branch(k);
  const dir = k.views.branchDir(k.run.id, b.branch.id);
  publish(dir, PROGRESS, k.run.id, { remaining_flag_count: 0 });
  for (let i = 0; i < 2; i++) {
    const out = await call(openExplorer(k, b), 'read', { path: `/melina/artifacts/${PROGRESS}` });
    expect(out.isError, out.content).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, PROGRESS), 'utf8')).remaining_flag_count).toBe(0);
  }
  expect(JSON.parse(readFileSync(join(dir, INSTANCE), 'utf8')).generation).toBe(1);
});

it('同一分支同时准备也只发布完整只读文件，不遗留临时文件', async () => {
  const k = setup();
  publishPair(k);
  const b = await branch(k);
  const env = environment(k, b);
  const signal = new AbortController().signal;
  expect(await Promise.all([prepareHostFeedback(env, signal), prepareHostFeedback(env, signal)])).toEqual([
    undefined,
    undefined,
  ]);
  expect(readdirSync(k.views.branchDir(k.run.id, b.branch.id)).sort()).toEqual([INSTANCE, PROGRESS].sort());
});

it('Scoper 开局等两份文件都写好；只到一份时不会提前放行', async () => {
  const k = setup();
  const env = environment(k);
  const source = k.views.scoperDir(k.run.id);
  let settled = false;
  const waiting = prepareHostFeedback(env, new AbortController().signal, 2000).then((result) => {
    settled = true;
    return result;
  });
  publish(source, PROGRESS, k.run.id);
  await delay(150);
  expect(settled).toBe(false);
  publish(source, INSTANCE, k.run.id);
  expect(await waiting).toBeUndefined();
});

it('等待中取消立即退回，不执行命令或记工具账；文件补齐后同一会话可以重试', async () => {
  const k = setup();
  const b = await branch(k);
  const session = openExplorer(k, b);
  const out = await call(
    session,
    'sh',
    { cmd: 'touch should-not-run', expect: '文件已经就绪' },
    {
      signal: AbortSignal.timeout(30),
    },
  );
  expect(out).toMatchObject({ isError: true });
  expect(out.content).toContain('已取消');
  expect(existsSync(join(b.ws, 'should-not-run'))).toBe(false);
  expect(k.runtime.execs).toEqual([]);
  expect(k.ledger).toEqual([]);
  expect(session.toolCalls).toBe(0);
  expect(
    k.runStore.published.filter((event) => event.type === 'sh.intent' || event.type === 'observation.created'),
  ).toEqual([]);
  publishPair(k);
  expect(await call(session, 'sh', { cmd: 'echo ready' })).toMatchObject({ isError: false });
  expect(session.toolCalls).toBe(1);
});

it('超时只退回本次调用，下一次重新检查；不借用 workspace 或其他路线的文件', async () => {
  const k = setup();
  const [b, other] = await Promise.all([branch(k), branch(k)]);
  publishPair(k, b.ws);
  publishPair(k, k.views.branchDir(k.run.id, other.branch.id));
  const env = environment(k, b);
  const signal = new AbortController().signal;
  expect(await prepareHostFeedback(env, signal, 0)).toContain('尚未就绪');
  expect(readdirSync(k.views.branchDir(k.run.id, b.branch.id))).toEqual([]);
  publishPair(k);
  expect(await prepareHostFeedback(env, signal, 0)).toBeUndefined();
});

it.each(['旧 Run', '损坏 JSON', '可写文件', '符号链接', '目录', '过大文件'])(
  '不以%s作为宿主控制文件种子',
  async (kind) => {
    const k = setup();
    const b = await branch(k);
    const source = k.views.scoperDir(k.run.id);
    publish(source, INSTANCE, k.run.id);
    const path = join(source, PROGRESS);
    if (kind === '旧 Run') publish(source, PROGRESS, newId());
    else if (kind === '符号链接') {
      publish(b.ws, PROGRESS, k.run.id);
      symlinkSync(join(b.ws, PROGRESS), path);
    } else if (kind === '目录') mkdirSync(path);
    else {
      writeFileSync(
        path,
        kind === '损坏 JSON'
          ? '{'
          : kind === '过大文件'
            ? ' '.repeat(1024 * 1024 + 1)
            : JSON.stringify({ run_id: k.run.id }),
      );
      if (kind !== '可写文件') chmodSync(path, 0o444);
    }
    expect(await prepareHostFeedback(environment(k, b), new AbortController().signal, 0)).toContain('尚未就绪');
    expect(existsSync(join(k.views.branchDir(k.run.id, b.branch.id), PROGRESS))).toBe(false);
  },
);

it('扩展环境工具也先等控制文件；取消时不调用扩展', async () => {
  const execute = vi.fn(async (env: ToolEnv) => {
    for (const name of [PROGRESS, INSTANCE]) {
      expect(existsSync(join(env.deps.views.branchDir(env.run.id, env.caller.branchId!), name))).toBe(true);
    }
    return { content: 'ready', isError: false };
  });
  const k = setup({
    deps: {
      extensions: [
        {
          spec: { name: 'managed_tool', description: '测试环境工具', parameters: Obj({}), environment: true },
          roles: ['explorer'],
          run: execute,
        },
      ],
    },
  });
  const b = await branch(k);
  const session = openExplorer(k, b);
  expect(await call(session, 'managed_tool', {}, { signal: AbortSignal.abort() })).toMatchObject({ isError: true });
  expect(execute).not.toHaveBeenCalled();
  publishPair(k);
  expect(await call(session, 'managed_tool', {})).toMatchObject({ isError: false });
  expect(execute).toHaveBeenCalledOnce();
});

it('普通任务仍直接执行环境工具', async () => {
  const k = kit();
  kits.push(k);
  const b = await branch(k);
  expect(await call(openExplorer(k, b), 'sh', { cmd: 'echo normal' })).toMatchObject({ isError: false });
});
