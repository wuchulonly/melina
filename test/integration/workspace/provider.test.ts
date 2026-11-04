// 按工作目录自动选 provider。

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceProviders } from '../../../src/workspace/provider.ts';
import { makeRun, memoryArtifacts, sandbox, sh } from './helpers.ts';

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
  box = sandbox('detect');
});

afterEach(() => {
  box.cleanup();
});

describe('WorkspaceProviders', () => {
  it('git 仓库的顶层用 git-clone；普通目录、仓库的子目录用 dir-copy', async () => {
    const providers = createWorkspaceProviders({ dataDir: box.data, artifacts: memoryArtifacts() });
    const repo = join(box.dir, 'repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    sh(repo, 'git init -q -b main');
    const plain = join(box.dir, 'plain');
    mkdirSync(plain);
    const link = join(box.dir, 'link-to-repo');
    symlinkSync(repo, link);
    expect(await providers.detect(repo)).toBe('git-clone');
    expect(await providers.detect(link)).toBe('git-clone');
    expect(await providers.detect(join(repo, 'sub'))).toBe('dir-copy');
    expect(await providers.detect(plain)).toBe('dir-copy');
  });

  it('目录不存在、不是目录、包住了数据目录，都拒绝', async () => {
    const providers = createWorkspaceProviders({ dataDir: box.data, artifacts: memoryArtifacts() });
    const file = join(box.dir, 'file.txt');
    writeFileSync(file, 'x');
    await expect(providers.detect(join(box.dir, 'nope'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(providers.detect(file)).rejects.toMatchObject({ code: 'invalid' });
    await expect(providers.detect(box.dir)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('forRun 按 kind 给实例，同一个 Run 复用同一个，并换上最新的 Run', async () => {
    const providers = createWorkspaceProviders({ dataDir: box.data, artifacts: memoryArtifacts() });
    const run = makeRun({ root: box.dir, kind: 'dir-copy' });
    const p = providers.forRun(run);
    expect(p.kind).toBe('dir-copy');
    expect(providers.forRun({ ...run, workspace: { ...run.workspace, setup: 'make' } })).toBe(p);
    expect(providers.forRun(makeRun({ root: box.dir, kind: 'git-clone' })).kind).toBe('git-clone');
  });
});
