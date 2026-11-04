// 容器里的 /melina/origin：人选的工作目录原样只读挂进来，没选的（Melina 建的空目录）不挂。
// 分支容器、Scoper 的临时容器都挂。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerRef, ContainerRuntime, ContainerSpec } from '../../../src/core/interfaces/container.ts';
import type { Bet, Branch, Run } from '../../../src/core/types.ts';
import { ContainerBranchEnv, originDirOf, runtimePaths, serialized } from '../../../src/runtime/branch-env.ts';

const RUN = '01J0000000000000000000RUN1';

function run(root: string): Run {
  return {
    id: RUN,
    workspace: { root, kind: 'git-clone' },
    goal: { statement: '目标', constraints: [], materials: [] },
  } as unknown as Run;
}

/** 只记下起容器时给的 spec */
function recorder(): { runtime: ContainerRuntime; specs: ContainerSpec[] } {
  const specs: ContainerSpec[] = [];
  const ref = (spec: ContainerSpec): ContainerRef => ({ id: spec.name, name: spec.name });
  const runtime = {
    start: async (spec: ContainerSpec) => {
      specs.push(spec);
      return ref(spec);
    },
    ephemeral: async (spec: ContainerSpec) => {
      specs.push(spec);
      return ref(spec);
    },
  } as unknown as ContainerRuntime;
  return { runtime, specs };
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('任务的领域镜像', () => {
  it.each([
    { label: 'CTF', domain: 'ctf', domains: ['general', 'ctf'], expected: 'ctf' },
    { label: '代码', domain: 'code', domains: ['general', 'code'], expected: 'code' },
    { label: '研究', domain: 'research', domains: ['general', 'research'], expected: 'research' },
    { label: '领域未定', domain: undefined, domains: ['general', 'ctf'], expected: 'general' },
    { label: '领域不可用', domain: 'missing', domains: ['general', 'ctf'], expected: 'general' },
    { label: '仅部署 CTF，领域未定', domain: undefined, domains: ['ctf'], expected: 'ctf' },
    { label: '仅部署 CTF，领域不可用', domain: 'missing', domains: ['ctf'], expected: 'ctf' },
  ])('Scoper 和所有分支共用领域镜像：$label', async ({ domain, domains, expected }) => {
    dir = mkdtempSync(join(tmpdir(), 'melina-domain-env-'));
    const { runtime, specs } = recorder();
    const env = new ContainerBranchEnv({
      runtime,
      paths: runtimePaths(dir),
      credentials: () => [],
      domains: () => domains,
    });
    const task = run(join(dir, 'project'));
    task.goal.domain = domain;
    for (const copy of [1, 2, 3]) {
      const branch = { id: `branch-${copy}`, runId: RUN, workspace: { path: join(dir, `copy-${copy}`) } } as Branch;
      await env.ensure(task, branch, { kind: 'direct' } as Bet);
    }
    await env.scoper(task, join(dir, 'scoper'));

    expect(specs).toHaveLength(4);
    expect(specs.map((spec) => spec.domain)).toEqual([expected, expected, expected, expected]);
    expect(specs.map((spec) => spec.workspace.readOnly)).toEqual([false, false, false, true]);
    expect(specs.map((spec) => spec.labels?.['melina.run'])).toEqual([RUN, RUN, RUN, RUN]);
    expect(new Set(specs.map((spec) => spec.name)).size).toBe(4);
  });
});

describe('/melina/origin', () => {
  it('宿主立即暂停的严格停止错误不能被吞掉，串行封装也保留这个要求', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-strict-stop-'));
    const runtime = {
      find: async () => ({ id: 'container-id', name: 'container-name' }),
      stop: async () => {
        throw new Error('停止失败');
      },
      remove: async () => {
        throw new Error('删除失败');
      },
    } as unknown as ContainerRuntime;
    const env = serialized(
      new ContainerBranchEnv({ runtime, paths: runtimePaths(dir), credentials: () => [], domains: () => ['general'] }),
    );
    const branch = { id: '01J000000000000000000BRAN1', runId: RUN } as Branch;
    await expect(env.stop(branch, true)).rejects.toThrow('停止失败');
    await expect(env.removeScoper(RUN, true)).rejects.toThrow('删除失败');
  });
  it('人选的工作目录原样挂；Melina 建的空目录、路径里有冒号或换行、不是绝对路径的不挂', () => {
    expect(originDirOf(run('/home/me/project'))).toBe('/home/me/project');
    expect(originDirOf(run(`/home/me/.melina/empty/${RUN}`))).toBeUndefined();
    expect(originDirOf(run('/home/me/empty/other'))).toBe('/home/me/empty/other');
    expect(originDirOf(run('/home/me/a:b'))).toBeUndefined();
    expect(originDirOf(run('/home/me/a\nb'))).toBeUndefined();
    expect(originDirOf(run('relative/dir'))).toBeUndefined();
  });

  it('分支容器、Scoper 的临时容器都挂；没选工作目录的任务都不挂', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-branch-env-'));
    const paths = runtimePaths(dir);
    const { runtime, specs } = recorder();
    const deps = { runtime, paths, credentials: () => [], domains: () => ['general'] };
    const env = new ContainerBranchEnv(deps);
    const branch = { id: '01J000000000000000000BRAN1', runId: RUN, workspace: { path: join(dir, 'ws') } } as Branch;
    const bet = { kind: 'direct' } as Bet;

    for (const root of ['/home/me/project', paths.emptyRoot(RUN)]) {
      specs.length = 0;
      const r = run(root);
      await env.ensure(r, branch, bet);
      await env.scoper(r, join(dir, 'ws'));
      expect(specs).toHaveLength(2);
      for (const s of specs) {
        if (root === '/home/me/project') expect(s.originDir).toBe('/home/me/project');
        else expect(s.originDir).toBeUndefined();
      }
    }
  });
});
