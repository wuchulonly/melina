// createKernel 直接满足 SDK 的 Runtime 契约：先恢复、再开始调度，关闭时统一收尾。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../../../src/api/sdk.ts';
import type { RuntimeKernel } from '../../../src/runtime/runtime.ts';
import { type Harness, harness } from './kit.ts';

/** 类型层面：形状对得上（对不上 pnpm check 的类型检查就过不了） */
const asSdk = (rt: RuntimeKernel): Runtime => rt;
let h: Harness;
afterEach(async () => {
  await h?.close();
});
describe('接进 Melina', () => {
  it('runs、recovery、scheduler、close 都在；数据目录的锁不归运行时（Melina 打开 RunStore 之前拿）', async () => {
    h = await harness({ start: false });
    const sdk = asSdk(h.rt);
    await sdk.recovery?.run();
    await sdk.start();
    expect(sdk.scheduler?.status().toolExec.limit).toBe(4);
    expect(existsSync(join(h.dir, 'data', 'melina.lock'))).toBe(false);
    await sdk.close();
  });

  it('续接计划恢复完成后才启动 worker，续接调度关闭后才停止 worker', async () => {
    h = await harness({ start: false });
    const restored = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    vi.spyOn(h.continuations, 'restore').mockReturnValue(restored.promise);
    vi.spyOn(h.continuations, 'close').mockReturnValue(closed.promise);
    const startWorkers = vi.spyOn(h.rt.runners, 'start');
    const stopWorkers = vi.spyOn(h.rt.runners, 'stop');
    const startContinuations = vi.spyOn(h.continuations, 'start');

    const starting = h.rt.start();
    expect(startWorkers).not.toHaveBeenCalled();
    expect(startContinuations).not.toHaveBeenCalled();
    restored.resolve();
    await starting;
    expect(startWorkers).toHaveBeenCalledOnce();
    expect(startContinuations).toHaveBeenCalledWith();

    const closing = h.rt.close();
    expect(stopWorkers).not.toHaveBeenCalled();
    closed.resolve();
    await closing;
    expect(stopWorkers).toHaveBeenCalledOnce();
  });

  it('等待创建前校验，拒绝时不留任务或文件；之后仍能正常创建', async () => {
    const validated = Promise.withResolvers<void>();
    const beforeCreate = vi.fn().mockImplementationOnce(() => validated.promise);
    h = await harness({ beforeCreate });
    const files = readdirSync(h.dir, { recursive: true });
    const creating = h.run();
    expect(beforeCreate).toHaveBeenCalledWith(expect.objectContaining({ materials: [] }));
    expect(h.runStore.queries.listRuns()).toEqual([]);
    expect(readdirSync(h.dir, { recursive: true })).toEqual(files);

    const failure = new Error('创建条件不满足');
    const rejected = expect(creating).rejects.toBe(failure);
    validated.reject(failure);
    await rejected;
    expect(h.runStore.queries.listRuns()).toEqual([]);
    expect(readdirSync(h.dir, { recursive: true })).toEqual(files);

    const run = await h.run();
    expect(h.runStore.queries.getRun(run.id)).toBeDefined();
    expect(beforeCreate).toHaveBeenCalledTimes(2);
  });
});
