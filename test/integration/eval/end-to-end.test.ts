// 跑分脚本的全流程，对着一个照 HTTP 契约（src/core/api.ts、events.ts）写的假 Melina（要真 git）：
// 建 Run（附件走 multipart）→ 假 Melina 在起点仓库的 clone 里跑这个任务的标准解、推成 melina/<runId> → SSE 发合契约的事件
// （用量、候选、收尾）→ 跑分脚本取交付、在 Run 外面检查 → 汇总表。另一个变体永远不提交、token 一直涨，跑分脚本到截断取消它。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveRunConfig } from '../../../src/core/config.ts';
import type { MelinaEvent } from '../../../src/core/events.ts';
import { handleOf, newId } from '../../../src/core/ids.ts';
import type { Run } from '../../../src/core/types.ts';
import { eventIssues } from '../../../src/core/validate.ts';
import { melinaContender } from '../../eval/contenders.ts';
import { HttpMelina } from '../../eval/melina.ts';
import { markdownReport, summarize } from '../../eval/report.ts';
import { runTrial } from '../../eval/trial.ts';
import { git } from '../../eval/workspace.ts';
import { machineTask } from '../../sim/machine/tasks.ts';
import { SimServer } from '../../sim/server.ts';

const task = machineTask('easy');
let seq = 0;

interface FakeRun {
  run: Run;
  events: MelinaEvent[];
  listeners: Set<(e: MelinaEvent) => void>;
  cancelled: boolean;
}

const runs = new Map<string, FakeRun>();

function emit(r: FakeRun, type: string, data: unknown): void {
  const e = { seq: ++seq, runId: r.run.id, type, at: new Date().toISOString(), data } as MelinaEvent;
  const problems = eventIssues(e);
  if (problems.length > 0) throw new Error(`假 Melina 发了不合契约的事件 ${type}：${JSON.stringify(problems)}`);
  r.events.push(e);
  for (const l of r.listeners) l(e);
}

function usage(r: FakeRun, input: number): void {
  const total = { input, cacheRead: 0, cacheWrite: 0, output: 0, usd: input / 1e6 };
  emit(r, 'usage.updated', { delta: total, total });
}

/** 假 Melina 干活：在起点仓库的 clone 里跑标准解，推成 melina/<runId>，再发候选和收尾 */
async function solve(r: FakeRun, materials: Record<string, string>): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'melina-fake-'));
  try {
    git(work, ['clone', '-q', r.run.workspace.root, '.']);
    const url = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+/.exec(r.run.goal.statement)?.[0] as string;
    await task.solve({ url, dir: work, statement: r.run.goal.statement, materials, sleep: async () => {} });
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'Melina：交付']);
    git(work, ['push', '-q', 'origin', `HEAD:refs/heads/melina/${r.run.id}`]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  usage(r, 120_000);
  const candidate = {
    id: newId(),
    runId: r.run.id,
    seq: seq + 1,
    branchId: newId(),
    snapshot: 'snap-1',
    claim: '按键顺序写好了',
  };
  emit(r, 'candidate.created', candidate);
  usage(r, 130_000);
  r.run = {
    ...r.run,
    mode: 'settling',
    status: 'done',
    endedAt: new Date().toISOString(),
    result: { candidateId: candidate.id, branch: `melina/${r.run.id}`, knowledgeReport: handleOf('报告') },
  };
  emit(r, 'run.updated', r.run);
}

/** 永远不提交，token 一直涨，直到被取消 */
function spin(r: FakeRun): void {
  let tokens = 0;
  const timer = setInterval(() => {
    if (r.cancelled) return clearInterval(timer);
    tokens += 300_000;
    usage(r, tokens);
  }, 20);
}

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
    const form = await new Request('http://x/', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: new Uint8Array(await readBody(req)),
    }).formData();
    const body = JSON.parse(String(form.get('run'))) as {
      statement: string;
      workspace: string;
      completion?: unknown;
      domain?: string;
      config?: { continuation?: { enabled?: boolean } };
    };
    const materials: Record<string, string> = {};
    for (const f of form.getAll('materials')) materials[(f as File).name] = await (f as File).text();
    const run: Run = {
      id: newId(),
      seq: seq + 1,
      goal: {
        statement: body.statement,
        constraints: [],
        materials: Object.entries(materials).map(([name, content]) => ({ name, handle: handleOf(content) })),
        ...(body.domain ? { domain: body.domain } : {}),
        ...(body.completion ? { completion: body.completion as Run['goal']['completion'] } : {}),
      } as Run['goal'],
      workspace: { root: body.workspace, kind: 'git-clone' },
      mode: 'direct',
      status: 'running',
      config: resolveRunConfig(),
      createdAt: new Date().toISOString(),
    };
    const r: FakeRun = { run, events: [], listeners: new Set(), cancelled: false };
    runs.set(run.id, r);
    emit(r, 'run.created', run);
    json(200, { runId: run.id });
    if (body.config?.continuation?.enabled === false) spin(r);
    else void solve(r, materials);
    return;
  }
  const m = /^\/api\/runs\/([0-9A-Z]+)\/(events|cancel|result)$/.exec(url.pathname);
  const r = m ? runs.get(m[1] as string) : undefined;
  if (!m || !r) return json(404, { error: { code: 'not_found', message: '没有' } });
  if (m[2] === 'events') {
    const since = Number(url.searchParams.get('since') ?? '0');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (e: MelinaEvent) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of r.events) if (e.seq > since) send(e);
    r.listeners.add(send);
    req.on('close', () => r.listeners.delete(send));
    return;
  }
  if (m[2] === 'cancel') {
    r.cancelled = true;
    r.run = { ...r.run, status: 'cancelled', endedAt: new Date().toISOString(), endReason: '你取消了任务' };
    emit(r, 'run.updated', r.run);
    return json(200, { run: r.run });
  }
  return json(200, {
    runId: r.run.id,
    status: r.run.status,
    branch: r.run.result?.branch,
    unfinished: false,
    knowledgeReport: r.run.result?.knowledgeReport ?? handleOf('报告'),
  });
}

let melina: Server;
let melinaUrl: string;
let sim: SimServer;
let out: string;

beforeAll(async () => {
  melina = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => melina.listen(0, '127.0.0.1', () => resolve()));
  melinaUrl = `http://127.0.0.1:${(melina.address() as AddressInfo).port}`;
  sim = new SimServer();
  await sim.start();
  out = mkdtempSync(join(tmpdir(), 'melina-eval-e2e-'));
});

afterAll(async () => {
  melina.closeAllConnections();
  await new Promise<void>((resolve) => melina.close(() => resolve()));
  await sim.close();
  rmSync(out, { recursive: true, force: true });
});

describe('跑分脚本对着假 Melina 的全流程', () => {
  it('提交的过检查、到截断的取消，汇总表里各是各的', async () => {
    const client = new HttpMelina({ baseUrl: melinaUrl });
    const solver = melinaContender(client, { name: 'melina', title: 'Melina 完整版' });
    const spinner = melinaContender(client, {
      name: 'spin',
      title: '不提交',
      config: { continuation: { enabled: false } },
    });
    const options = { server: sim, out, master: 'e2e', maxTokens: 1_000_000, signal: new AbortController().signal };
    const results = [];
    for (let rep = 0; rep < 2; rep++) {
      results.push(await runTrial(task, solver, rep, options));
      results.push(await runTrial(task, spinner, rep, options));
    }
    const solved = results.filter((r) => r.contender === 'melina');
    const spun = results.filter((r) => r.contender === 'spin');
    for (const r of solved) {
      expect(r).toMatchObject({
        status: 'done',
        submitted: true,
        checkPass: true,
        tokensAtSubmit: 120_000,
        tokens: 130_000,
      });
    }
    for (const r of spun) {
      expect(r).toMatchObject({ status: 'cut', submitted: false, checkPass: false });
      expect(r.tokens).toBeGreaterThanOrEqual(1_000_000);
    }
    const delivered = readFileSync(
      join(out, 'trials', task.id, 'melina', '0', 'attempt-1', 'delivered', 'procedure.json'),
      'utf8',
    );
    expect(JSON.parse(delivered)).toBeInstanceOf(Array);
    const md = markdownReport(summarize(results, [500_000, 1_000_000]), {
      title: '端到端',
      master: 'e2e',
      reps: 2,
      contenders: [
        { name: 'melina', title: 'Melina 完整版' },
        { name: 'spin', title: '不提交' },
      ],
      startedAt: 'now',
    });
    // 随 token 的那张表
    expect(md).toContain('| Melina 完整版 | 仿真 | 简单 | 2 | 100%（2/2） | 100%（2/2） |');
    expect(md).toContain('| 不提交 | 仿真 | 简单 | 2 | 0%（0/2） | 0%（0/2） |');
  });
});
