// 权限场景放在独立进程里：root 启动测试时降权，不改变 Vitest worker 的身份。
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../../src/core/ids.ts';
import { createWorkspaceProviders } from '../../../src/workspace/provider.ts';
import { makeRun, memoryArtifacts, sandbox, sh, treeOf } from './helpers.ts';

if (process.getuid?.() === 0) {
  process.setgroups?.([]);
  process.setgid?.(65534);
  process.setuid?.(65534);
}

const box = sandbox('unreadable');
try {
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  sh(repo, 'git init -q -b main && git commit --allow-empty -qm init');
  const providers = createWorkspaceProviders({ dataDir: box.data, artifacts: memoryArtifacts() });
  const run = makeRun({ root: repo, kind: 'git-clone' });
  const provider = providers.forRun(run);
  await provider.init(run);
  const ws = await provider.create(ROOT);
  const locked = join(ws.path, 'locked.txt');
  writeFileSync(locked, 'secret\n');
  writeFileSync(join(ws.path, 'fine.txt'), 'ok\n');
  chmodSync(locked, 0o000);
  try {
    assert.throws(() => readFileSync(locked), { code: 'EACCES' });
    const snapshot = await provider.snapshot(ws);
    process.stdout.write(JSON.stringify(treeOf((await provider.create(snapshot)).path)));
  } finally {
    chmodSync(locked, 0o644);
  }
} finally {
  box.cleanup();
}
