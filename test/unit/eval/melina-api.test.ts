// HttpMelina 对着 的真 HTTP 服务（Hono、busboy 收附件、SSE、Host 和 Origin 的检查都是真的），
// 运行时用 测试里那个写真 RunStore 的假 RunManager：建 Run（multipart 附件、固定的完成标准和领域、config）→
// 订阅事件 → 取消 → 取结果和知识报告。证明跑分脚本照契约写的客户端和 `melina serve` 对得上。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessPolicy } from '../../../src/api/access.ts';
import { Melina } from '../../../src/api/sdk.ts';
import type { MelinaEvent } from '../../../src/core/events.ts';
import { HttpMelina } from '../../eval/melina.ts';
import { type FakeRuntimeHandle, fakeRuntime, tempDir } from '../api/kit.ts';

let dir: string;
let melina: Melina;
let handle: FakeRuntimeHandle;
let server: { close(callback?: () => void): unknown };
let port: number;

async function freePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port: p } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return p;
}

beforeAll(async () => {
  dir = tempDir('melina-scoring-api-');
  handle = {};
  melina = new Melina(
    { db: join(dir, 'melina.db'), artifacts: join(dir, 'artifacts') },
    { runtime: fakeRuntime(handle), containers: null, env: {}, log: { warn: () => {}, error: () => {} } },
  );
  await melina.ready();
  port = await freePort();
  const app = melina.app({ port, access: accessPolicy(port) });
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await melina.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('HttpMelina 对着 melina serve 的 HTTP 接口', () => {
  it('建 Run、订阅事件、取消、取结果', async () => {
    const client = new HttpMelina({ baseUrl: `http://127.0.0.1:${port}` });
    const manual = join(dir, 'manual.md');
    writeFileSync(manual, '# 手册');
    const workspace = join(dir, 'ws');
    mkdirSync(workspace);
    const completion = { interpretation: '按字面', criteria: ['工作目录根下有 procedure.json'] };
    const run = await client.createRun({
      goal: { statement: '让控制器跑起来', materials: [manual], completion, domain: 'general' },
      workspace: { root: workspace },
      config: { continuation: { enabled: true } },
    });
    const call = handle.runs?.calls.find((c) => c.method === 'create') as unknown as {
      input: Record<string, unknown>;
      contents: string[];
    };
    expect(call.input).toMatchObject({
      statement: '让控制器跑起来',
      workspace,
      completion,
      domain: 'general',
      config: { continuation: { enabled: true } },
    });
    expect((call.input.materials as { name: string }[]).map((m) => m.name)).toEqual(['manual.md']);
    expect(call.contents).toEqual(['# 手册']);

    const seen: MelinaEvent[] = [];
    const stop = new AbortController();
    const reading = (async () => {
      for await (const e of run.events({ signal: stop.signal })) {
        seen.push(e);
        if (e.type === 'run.updated' && e.data.status === 'cancelled') break;
      }
    })();
    for (let i = 0; i < 100 && !seen.some((e) => e.type === 'run.created'); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(seen.map((e) => e.type)).toContain('completion.drafted');
    await run.cancel();
    await reading;
    stop.abort();
    expect(seen[seen.length - 1]).toMatchObject({ type: 'run.updated', data: { status: 'cancelled' } });

    const result = await run.result();
    expect(result).toMatchObject({ runId: run.id, status: 'cancelled', endReason: '你取消了任务' });
    const report = Buffer.from((await run.artifact?.(result.knowledgeReport)) ?? []).toString('utf8');
    expect(report).toContain('知识报告');
  });

  it('Melina 拒绝时带上它的说法：工作目录不存在', async () => {
    const client = new HttpMelina({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(
      client.createRun({ goal: { statement: '目标', materials: [] }, workspace: { root: join(dir, 'nope') } }),
    ).rejects.toThrow(/400/);
  });
});
