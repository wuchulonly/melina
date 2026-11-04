import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunResultResponse, RunSummary } from '../../../src/core/api.ts';
import { type Handle, sha256OfHandle } from '../../../src/core/ids.ts';
import { ANSWER } from '../../dev/demo/story.ts';
import { type Demo, startDemo } from '../../dev/demo.ts';
import { git, gitRepo, removeDir, waitFor } from '../m0/kit.ts';

let demo: Demo | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await demo?.stop();
  demo = undefined;
  for (const d of dirs.splice(0)) removeDir(d);
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'melina-demo-test-'));
  dirs.push(d);
  return d;
}

async function start(options: { pace?: number; data?: string } = {}): Promise<Demo> {
  demo = await startDemo({
    port: await freePort(),
    pace: options.pace ?? 0,
    ...(options.data ? { data: options.data } : {}),
    log: () => {},
  });
  return demo;
}

/** 照浏览器的样子发请求（Melina 校验 Host 和 Origin） */
function client(d: Demo) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${d.url}/api${path}`, {
      method,
      headers: { origin: d.url, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };
  return {
    create: (statement: string, workspace?: string) =>
      call<{ runId: string }>('POST', '/runs', { statement, ...(workspace ? { workspace } : {}) }).then((r) => r.runId),
    run: (id: string) => call<RunSummary>('GET', `/runs/${id}`),
    result: (id: string) => call<RunResultResponse>('GET', `/runs/${id}/result`),
    hint: (id: string, text: string) => call('POST', `/runs/${id}/input`, { kind: 'hint', text }),
    pause: (id: string) => call('POST', `/runs/${id}/pause`),
    resume: (id: string) => call('POST', `/runs/${id}/resume`),
    cancel: (id: string) => call('POST', `/runs/${id}/cancel`),
    artifact: async (id: string, handle: Handle) => {
      const res = await fetch(`${d.url}/api/runs/${id}/artifacts/${sha256OfHandle(handle)}`);
      return res.text();
    },
  };
}

describe('真实 HTTP 演示服务', () => {
  it('三路 direct 会话写文件、核对并交付', async () => {
    const c = client(await start());
    const id = await c.create('创建演示说明');
    const summary = await waitFor(
      '交付完成',
      async () => {
        const summary = await c.run(id);
        return summary.run.status === 'done' ? summary : undefined;
      },
      30000,
    );
    expect(summary.branches).toHaveLength(3);
    expect(summary.branches.every((b) => b.bet.kind === 'direct')).toBe(true);
    const result = await c.result(id);
    expect(result.candidate?.claim).toBe('演示文件已写入并核对');
    expect(result.artifact?.path).toBe('demo/answer.md');
    expect(await c.artifact(id, result.artifact!.handle)).toBe(ANSWER);
  });
  it('git 交付保留原始工作区并创建结果分支', async () => {
    const project = gitRepo(join(tempDir(), 'project'), { 'seed.txt': '起点\n' });
    const c = client(await start());
    const id = await c.create('创建演示说明', project);
    await waitFor('git 交付', async () => (await c.run(id)).run.status === 'done', 30000);
    const result = await c.result(id);
    expect(result.branch).toBe(`melina/${id}`);
    expect(git(project, 'show', `${result.branch}:demo/answer.md`)).toBe(ANSWER.trim());
    expect(existsSync(join(project, 'demo/answer.md'))).toBe(false);
  });
});
