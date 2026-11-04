import { describe, expect, it } from 'vitest';
import { newId, ROOT } from '../../../src/core/ids.ts';
import { parseApplyConflicts } from '../../../src/workspace/apply.ts';
import { sanitizeUrl } from '../../../src/workspace/git-clone.ts';
import { checkSnapshotId, runPaths, wsIdOf } from '../../../src/workspace/layout.ts';
import { KeyedMutex, RwLock } from '../../../src/workspace/locks.ts';
import { setupOutcome } from '../../../src/workspace/setup.ts';

describe('sanitizeUrl', () => {
  it('http 的 URL 去掉用户名和密码，ssh 的不动', () => {
    expect(sanitizeUrl('https://bot:s3cret@example.com/x.git')).toBe('https://example.com/x.git');
    expect(sanitizeUrl('https://ghp_token@github.com/x.git')).toBe('https://github.com/x.git');
    expect(sanitizeUrl('https://user:p@ss@example.com/x.git')).toBe('https://example.com/x.git');
    expect(sanitizeUrl('https://a@b@example.com/x.git?y=1')).toBe('https://example.com/x.git?y=1');
    expect(sanitizeUrl('git@github.com:team/x.git')).toBe('git@github.com:team/x.git');
    expect(sanitizeUrl('ssh://git@host/x.git')).toBe('ssh://git@host/x.git');
  });
});

describe('parseApplyConflicts', () => {
  it('从 git apply 的报错里摘出文件', () => {
    const stderr = [
      'error: patch failed: a.txt:1',
      'error: a.txt: patch does not apply',
      'error: nope/q.txt: No such file or directory',
      'error: new.txt: already exists in working directory',
    ].join('\n');
    expect(parseApplyConflicts(stderr)).toEqual(['a.txt', 'nope/q.txt', 'new.txt']);
  });

  it('认不出来的报错原样给第一行', () => {
    expect(parseApplyConflicts('fatal: corrupt patch at line 3\n')).toEqual(['fatal: corrupt patch at line 3']);
  });
});

describe('layout', () => {
  it('snapshot id 只认 root 和 ULID', () => {
    expect(checkSnapshotId(ROOT)).toBe(ROOT);
    const id = newId();
    expect(checkSnapshotId(id)).toBe(id);
    for (const bad of ['../x', 'refs/heads/main', '', 's0001-abc']) {
      expect(() => checkSnapshotId(bad)).toThrow(/不是这个 provider 的 snapshot/);
    }
  });

  it('只认这个 Run 的 ws/<id>', () => {
    const runId = newId();
    const paths = runPaths('/data', runId);
    const id = newId();
    expect(wsIdOf(paths, { path: `/data/${runId}/ws/${id}`, id })).toBe(id);
    expect(() => wsIdOf(paths, { path: `/data/${runId}/ws/${id}` })).toThrow();
    expect(() => wsIdOf(paths, { path: '/home/me/project', id })).toThrow();
    expect(() => wsIdOf(paths, { path: `/data/${runId}/ws/${id}/../../../x`, id })).toThrow();
    expect(() => wsIdOf(paths, { path: `/data/${newId()}/ws/${id}`, id })).toThrow();
  });
});

describe('locks', () => {
  it('同一个 key 串行，不同 key 并行', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const task = (key: string, name: string, ms: number) =>
      m.run(key, async () => {
        order.push(`${name}+`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}-`);
      });
    await Promise.all([task('a', 'a1', 20), task('a', 'a2', 1), task('b', 'b1', 5)]);
    expect(order.indexOf('a1-')).toBeLessThan(order.indexOf('a2+'));
    expect(order.indexOf('b1+')).toBeLessThan(order.indexOf('a1-'));
  });

  it('读写锁：exclusive 等 shared 都放了才进，之后来的 shared 排在它后面', async () => {
    const lock = new RwLock();
    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const s1 = lock.shared(async () => {
      order.push('s1+');
      await sleep(20);
      order.push('s1-');
    });
    const x = lock.exclusive(async () => {
      order.push('x+');
      await sleep(5);
      order.push('x-');
    });
    const s2 = lock.shared(async () => {
      order.push('s2+');
    });
    await Promise.all([s1, x, s2]);
    expect(order).toEqual(['s1+', 's1-', 'x+', 'x-', 's2+']);
  });
});

describe('setupOutcome', () => {
  it('退出码 0 才算成功；输出只留最后一段', () => {
    const r = setupOutcome('npm ci', {
      exitCode: 0,
      stdout: 'x'.repeat(5000),
      stderr: '',
      timedOut: false,
      cancelled: false,
      durationMs: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.tail.length).toBeLessThan(4100);
    expect(
      setupOutcome('x', { exitCode: 0, stdout: '', stderr: '', timedOut: true, cancelled: false, durationMs: 1 }).ok,
    ).toBe(false);
  });
});
