import { describe, expect, it } from 'vitest';
import { COMPLETION, closes, harness, tick, waitFor } from './kit.ts';

describe('交付完成后关闭 Melina', () => {
  it('等待仍在进行的交付清理，避免数据库先关闭后又读取 Run', async () => {
    const h = await harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remove = h.env.removeScoper.bind(h.env);
    h.env.removeScoper = async (runId) => {
      if (h.runStore.queries.getRun(runId)?.status === 'done') {
        entered.resolve();
        await release.promise;
      }
      await remove(runId);
    };
    h.explorer.on('主干直解路线', (ctx) => {
      ctx.observe('检查通过');
      return ctx.done(closes.submit());
    });
    try {
      const run = await h.rt.runs.create({
        statement: '完成测试任务',
        materials: [],
        completion: COMPLETION,
        domain: 'code',
        config: { bet0: { copies: 1 } },
      });
      await entered.promise;
      expect(h.runStore.queries.getRun(run.id)?.status).toBe('done');
      let stopped = false;
      const closing = h.rt.stop().then(() => {
        stopped = true;
      });
      try {
        await tick(30);
        expect(stopped).toBe(false);
      } finally {
        release.resolve();
        await closing;
      }
      await waitFor(() => stopped, '收尾清理后关闭');
      expect(h.logs.some((line) => line.includes('结果没写进去'))).toBe(false);
    } finally {
      release.resolve();
      await h.close();
    }
  });
});
