import { expect, it } from 'vitest';
import { harness, tick, waitFor } from '../runtime/kit.ts';

it('等待工具结束时取消摘要存档立即返回，迟到的工具不能再保存快照', async () => {
  const h = await harness();
  let release!: () => void;
  const boundary = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  const open = h.gateway.open.bind(h.gateway);
  h.gateway.open = (caller) => {
    const session = open(caller);
    session.checkpoint = async (save) => {
      waiting = true;
      await boundary;
      await save();
      return true;
    };
    return session;
  };
  try {
    const run = await h.run({ config: { bet0: { copies: 1 } } });
    const branch = h.bet0(run.id);
    await waitFor(() => h.explorer.started.some((input) => input.branch.id === branch.id));
    const before = h.workspaces.ops('snapshot').length;
    const abort = new AbortController();
    const request = h.rt.runners.checkpoint(branch.id, '保留当前现场', abort.signal);
    await waitFor(() => waiting);
    abort.abort(new Error('停止摘要存档'));
    await expect(request).rejects.toThrow('停止摘要存档');
    release();
    await tick();
    expect(h.workspaces.ops('snapshot')).toHaveLength(before);
    expect(h.runStore.queries.getBranch(branch.id)?.lastSnapshot).toBe('root');
  } finally {
    release();
    await h.close();
  }
});
