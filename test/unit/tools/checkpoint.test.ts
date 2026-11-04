import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { branch, call, type Kit, kit, openExplorer } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());
it('交接快照等待在途工具，存档完成前阻止下一次执行', async () => {
  k = kit();
  const b = await branch(k),
    session = openExplorer(k, b);
  const saved = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let firstDone = false;
  const first = call(session, 'sh', { cmd: 'sleep .03; printf first > first.txt' }).then((result) => {
    firstDone = true;
    return result;
  });
  const checkpoint = session.checkpoint!(async () => {
    expect(firstDone).toBe(true);
    expect(existsSync(join(b.ws, 'first.txt'))).toBe(true);
    saved.resolve();
    await release.promise;
  });
  const later = call(session, 'sh', { cmd: 'printf later > later.txt' });
  await saved.promise;
  expect(existsSync(join(b.ws, 'later.txt'))).toBe(false);
  release.resolve();
  expect(await checkpoint).toBe(true);
  expect((await first).isError).toBe(false);
  expect((await later).isError).toBe(false);
  expect(existsSync(join(b.ws, 'later.txt'))).toBe(true);
});
it('已接受的候选阻止随后创建快照，存档出错后工具仍可继续', async () => {
  k = kit();
  const session = openExplorer(k, await branch(k));
  await expect(
    session.checkpoint!(async () => {
      throw new Error('snapshot failed');
    }),
  ).rejects.toThrow('snapshot failed');
  expect((await call(session, 'sh', { cmd: 'printf retained' })).isError).toBe(false);
  await call(session, 'end_episode', { candidate: { claim: '完成' } });
  let saved = false;
  expect(
    await session.checkpoint!(async () => {
      saved = true;
    }),
  ).toBe(false);
  expect(saved).toBe(false);
});
