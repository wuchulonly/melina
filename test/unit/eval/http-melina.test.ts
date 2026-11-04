// HttpMelina 对着一个假的 Melina HTTP 服务（照 src/core/api.ts 的契约）：建 Run 时附件走 multipart、保留文件名；
// 没附件走 JSON；SSE 断了按 since 续上、补发的旧事件不重复、不合契约的事件跳过；取消、结果、产物；出错带上 Melina 的说法。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MelinaEvent } from '../../../src/core/events.ts';
import { HttpMelina } from '../../eval/melina.ts';

const RUN_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const HANDLE = `art://${'ab'.repeat(32)}` as const;

function usage(seq: number): MelinaEvent {
  const totals = { input: seq * 100, cacheRead: 0, cacheWrite: 0, output: seq, usd: 0 };
  return {
    seq,
    runId: RUN_ID,
    type: 'usage.updated',
    at: '2026-10-02T00:00:00Z',
    data: { delta: totals, total: totals },
  } as MelinaEvent;
}

interface Captured {
  contentType: string;
  run: unknown;
  files: { name: string; content: string }[];
}

let server: Server;
let base: string;
let dir: string;
const created: Captured[] = [];
const sseRequests: string[] = [];
let cancelled = 0;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && url.pathname === '/api/runs') {
    const body = await readBody(req);
    const contentType = req.headers['content-type'] ?? '';
    let run: unknown;
    const files: Captured['files'] = [];
    if (contentType.startsWith('multipart/form-data')) {
      const form = await new Request('http://x/', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: new Uint8Array(body),
      }).formData();
      run = JSON.parse(String(form.get('run')));
      for (const f of form.getAll('materials')) {
        const file = f as File;
        files.push({ name: file.name, content: await file.text() });
      }
    } else {
      run = JSON.parse(body.toString('utf8'));
    }
    if ((run as { statement?: string }).statement === 'bad') {
      return json(400, { error: { code: 'invalid', message: '工作目录不存在' } });
    }
    created.push({ contentType, run, files });
    return json(200, { runId: RUN_ID });
  }
  if (req.method === 'GET' && url.pathname === `/api/runs/${RUN_ID}/events`) {
    const since = Number(url.searchParams.get('since') ?? '0');
    sseRequests.push(String(since));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ping\n\n');
    if (sseRequests.length === 1) {
      // 第一次连上：发两条，中间夹一条不合契约的，然后断开（像 Melina 崩了）
      res.write(`id: 1\ndata: ${JSON.stringify(usage(1))}\n\n`);
      res.write(`id: 2\ndata: ${JSON.stringify({ ...usage(2), type: 'no.such.event' })}\n\n`);
      res.write(`id: 3\ndata: ${JSON.stringify(usage(3))}\n\n`);
      setTimeout(() => res.destroy(), 20);
      return;
    }
    // 重连：多补发一条 since 那条，按字节切开写
    const text = [usage(3), usage(4), usage(5)].map((e) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    for (let i = 0; i < text.length; i += 7) res.write(text.slice(i, i + 7));
    return;
  }
  if (req.method === 'POST' && url.pathname === `/api/runs/${RUN_ID}/cancel`) {
    cancelled++;
    return json(200, { run: {} });
  }
  if (req.method === 'GET' && url.pathname === `/api/runs/${RUN_ID}/result`) {
    return json(200, {
      runId: RUN_ID,
      status: 'done',
      branch: `melina/${RUN_ID}`,
      unfinished: false,
      knowledgeReport: HANDLE,
    });
  }
  if (req.method === 'GET' && url.pathname === `/api/runs/${RUN_ID}/artifacts/${'ab'.repeat(32)}`) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('diff --git a/x b/x');
    return;
  }
  json(404, { error: { code: 'not_found', message: '没有' } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'melina-http-'));
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('HttpMelina', () => {
  it('有附件时 multipart：run 字段放请求，materials 放文件、保留文件名；没附件时 JSON', async () => {
    const melina = new HttpMelina({ baseUrl: `${base}/` });
    writeFileSync(join(dir, 'manual.md'), '# 手册');
    writeFileSync(join(dir, 'services.json'), '[]');
    const completion = { interpretation: '按字面', criteria: ['有 answer.json'] };
    const run = await melina.createRun({
      goal: {
        statement: '目标',
        materials: [join(dir, 'manual.md'), join(dir, 'services.json')],
        completion,
        domain: 'general',
      },
      workspace: { root: '/tmp/ws' },
      config: { continuation: { enabled: true } },
    });
    expect(run.id).toBe(RUN_ID);
    expect(created[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(created[0]?.run).toEqual({
      statement: '目标',
      workspace: '/tmp/ws',
      config: { continuation: { enabled: true } },
      completion,
      domain: 'general',
    });
    expect(created[0]?.files).toEqual([
      { name: 'manual.md', content: '# 手册' },
      { name: 'services.json', content: '[]' },
    ]);
    await melina.createRun({ goal: { statement: '只有目标', materials: [] } });
    expect(created[1]).toMatchObject({ contentType: 'application/json', run: { statement: '只有目标' }, files: [] });
  });

  it('SSE 断了按 since 续上，补发的旧事件不重复，不合契约的跳过；break 以后不再连', async () => {
    const run = await new HttpMelina({ baseUrl: base }).createRun({ goal: { statement: '目标', materials: [] } });
    const seqs: number[] = [];
    const dropped: string[] = [];
    for await (const e of run.events({ onDropped: (_raw, problems) => dropped.push(problems) })) {
      seqs.push(e.seq);
      if (e.seq === 5) break;
    }
    expect(seqs).toEqual([1, 3, 4, 5]);
    expect(sseRequests).toEqual(['0', '3']);
    expect(dropped).toHaveLength(1);
  });

  it('取消、结果、产物；Melina 报错时带上它的说法', async () => {
    const melina = new HttpMelina({ baseUrl: base });
    const run = await melina.createRun({ goal: { statement: '目标', materials: [] } });
    await run.cancel();
    expect(cancelled).toBe(1);
    expect(await run.result()).toMatchObject({ status: 'done', branch: `melina/${RUN_ID}` });
    expect(Buffer.from((await run.artifact?.(HANDLE)) ?? []).toString()).toBe('diff --git a/x b/x');
    await expect(melina.createRun({ goal: { statement: 'bad', materials: [] } })).rejects.toThrow('工作目录不存在');
  });
});
