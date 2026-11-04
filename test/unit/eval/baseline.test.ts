// 单 agent 基线（test/eval/baseline.ts）：Melina 的模型层（fauxProvider 按剧本回）和 Melina 的环境工具实现，
// 容器换成宿主机上的 bash（test/unit/tools/host-runtime.ts）。看：交付、到截断取消、模型停下两次不交付、done 和别的工具同一轮、
// 大输出落盘给路径、token 记账、到时间停下；并行的基线（U01）：先交的算、别的停下，没交的道从头再来。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import {
  BASELINE_SYSTEM,
  type BaselineOptions,
  baselineContender,
  baselineGoal,
  DONE_TOOL,
  parallelBaselineContender,
} from '../../eval/baseline.ts';
import type { AttemptInput } from '../../eval/contenders.ts';
import { prepareWorkspace } from '../../eval/workspace.ts';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '../models/protocol.ts';
import { HostRuntime } from '../tools/host-runtime.ts';

const MODEL: ModelRef = { provider: 'faux-a', model: 'a-1', tier: 'strong' };
const COMPLETION = {
  interpretation: '在 out.txt 里写 hi',
  criteria: ['out.txt 的内容是 hi'],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (cmd: string) => fauxToolCall('sh', { cmd });
const done = (summary = '写好了，cat 过') => fauxToolCall(DONE_TOOL, { summary });
const turn = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: 'toolUse' });

type Responses = Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0];

function scene(
  responses: Responses,
  budget = 1_000_000,
  opts: { k?: number; deadlineMs?: number; observer?: BaselineOptions['observer'] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'melina-baseline-'));
  dirs.push(root);
  const faux = fauxProvider({
    provider: 'faux-a',
    api: 'faux-a',
    models: [{ id: 'a-1', contextWindow: 50_000, reasoning: true }],
  });
  // 记下每次请求看到的对话
  const seen: unknown[][] = [];
  faux.setResponses(
    responses.map((step) => async (ctx, options, state, model) => {
      seen.push(ctx.messages.slice());
      return typeof step === 'function' ? step(ctx, options, state, model) : step;
    }),
  );
  const last = () => JSON.stringify(seen.at(-1) ?? []);
  const containers = new HostRuntime({ root: join(root, 'containers') });
  const base = {
    ...(opts.observer ? { observer: opts.observer } : {}),
    model: MODEL,
    keys: [{ id: 'k1', key: 'key-a' }],
    containers,
    redactor: { redact: (t: string) => t.split('key-a').join('«key»') },
    providers: [faux.provider],
    global: { retries: { model: 1 }, model: { idleTimeoutMs: 2000 } },
    laneRetryMs: 10,
  };
  const contender = opts.k ? parallelBaselineContender({ ...base, k: opts.k }) : baselineContender(base);
  const workspace = join(root, 'workspace');
  prepareWorkspace(workspace, { 'README.md': '起点\n' }, { git: true });
  const materials = join(root, 'materials');
  mkdirSync(materials, { recursive: true });
  writeFileSync(join(materials, 'notes.md'), '附件\n');
  const dir = join(root, 'attempt');
  mkdirSync(dir, { recursive: true });
  const logs: string[] = [];
  const stop = new AbortController();
  const input = {
    task: {} as never,
    world: { starter: () => ({ 'README.md': '起点\n' }) } as never,
    url: '',
    localUrl: '',
    workspace,
    materials: [{ name: 'notes.md', path: join(materials, 'notes.md') }],
    statement: '在 out.txt 里写 hi',
    completion: COMPLETION,
    domain: 'general',
    budget,
    deadline: Date.now() + (opts.deadlineMs ?? 600_000),
    dir,
    signal: stop.signal,
    log: (line: string) => logs.push(line),
  } satisfies AttemptInput;
  return { faux, contender, input, workspace, dir, containers, stop, logs, last };
}

describe('单 agent 基线', () => {
  it('动态观察摘要实际到达供应商；每次从原始系统提示替换，工具定义与持续对话保留', async () => {
    const systems: string[] = [];
    let observed = 0;
    let closed = false;
    const s = scene(
      [
        (ctx) => {
          systems.push(String(ctx.messages.find((m) => m.role === 'system')?.content));
          return turn(sh('echo hi > out.txt'));
        },
        (ctx) => {
          systems.push(String(ctx.messages.find((m) => m.role === 'system')?.content));
          return turn(done());
        },
      ],
      1_000_000,
      {
        observer: () => ({
          system(original) {
            expect(original).not.toContain('<heimdall-map>');
            return `${original}\n<heimdall-map>v${observed}</heimdall-map>`;
          },
          observe(call) {
            if (call.name !== 'done') observed++;
          },
          async close() {
            closed = true;
          },
        }),
      },
    );
    expect(await s.contender.attempt(s.input)).toMatchObject({ status: 'done' });
    expect(systems[0]).toContain('<heimdall-map>v0</heimdall-map>');
    expect(systems[1]).toContain('<heimdall-map>v1</heimdall-map>');
    expect(systems[1]).not.toContain('v0');
    expect(s.last()).toContain('退出码 0');
    expect(closed).toBe(true);
  });
  it('一条对话做到底：跑命令、交付；交付的是 workspace，token 记到交付那一刻；容器用完删掉', async () => {
    const s = scene([turn(sh('echo hi > out.txt')), turn(sh('cat out.txt')), turn(done())]);
    const out = await s.contender.attempt(s.input);
    expect(out).toMatchObject({
      status: 'done',
      submitted: true,
      delivered: s.workspace,
      routes: 1,
    });
    expect(readFileSync(join(s.workspace, 'out.txt'), 'utf8')).toBe('hi\n');
    expect(out.tokens).toBeGreaterThan(0);
    expect(out.tokensAtSubmit).toBe(out.tokens);
    expect(out.usdAtSubmit).toBe(out.usage.usd);
    expect(out.firstCandidateMs).toBeDefined();
    expect(s.containers.containers.size).toBe(0);
    const tools = readFileSync(join(s.dir, 'baseline-tools.jsonl'), 'utf8');
    expect(tools).toContain('"tool":"sh"');
    expect(tools).toContain('"done":"写好了，cat 过"');
    // 模型看到的：基线自己的系统提示、目标和完成标准，工具结果是 Melina 的摘要（不带 observationId）
    expect(s.last()).toContain('退出码 0');
    expect(s.last()).not.toContain('observationId');
  });

  it('到截断还没交付：取消这次，记 cut', async () => {
    const s = scene([turn(sh('echo 1')), turn(sh('echo 2')), turn(sh('echo 3')), turn(done())], 1);
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('cut');
    expect(out.submitted).toBe(false);
    expect(out.tokens).toBeGreaterThan(0);
  });

  it('模型停下、提醒一次还不交付：这次没交（failed），交给跑分脚本重来', async () => {
    const s = scene([
      turn(sh('echo hi > out.txt')),
      fauxAssistantMessage([fauxText('我做完了')], { stopReason: 'stop' }),
      fauxAssistantMessage([fauxText('真的做完了')], { stopReason: 'stop' }),
    ]);
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('failed');
    expect(out.submitted).toBe(false);
    expect(s.last()).toContain('你停下了，但还没调用 done');
  });

  it('done 和别的工具同一轮：拒掉，单独再调一次才算', async () => {
    const s = scene([turn(sh('echo hi > out.txt'), done()), turn(done())]);
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('done');
    expect(s.last()).toContain('done 要单独调用');
  });

  it('大输出照 Melina 的做法落盘：只给开头结尾和 /melina/artifacts 里的路径', async () => {
    const s = scene([turn(sh('seq 1 20000')), turn(done())]);
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('done');
    const ctx = s.last();
    expect(ctx).toContain('/melina/artifacts/');
    expect(ctx).not.toContain('\\n12345\\n');
  });

  it('到时间（这次试验的截断）还没交付：停下，记 timeout', async () => {
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 150));
      return turn(sh('echo 1'));
    };
    const s = scene([slow, slow, slow, slow, slow, slow], 1_000_000, { deadlineMs: 300 });
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('timeout');
    expect(out.submitted).toBe(false);
  });

  it('附件里像密钥的值照 Melina 的认法遮掉：读附件只看到占位符（两边一个口径）', async () => {
    const s = scene([turn(fauxToolCall('read', { path: '/melina/materials/notes.md' })), turn(done())]);
    writeFileSync(s.input.materials[0]?.path as string, 'client_id: melina-eval\nclient_secret: "s3cr3t-value-1234"\n');
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('done');
    expect(s.last()).not.toContain('s3cr3t-value-1234');
    expect(s.last()).toContain('client_id: melina-eval');
  });

  it('人按了 Ctrl-C：记 cancelled', async () => {
    const s = scene([
      async () => {
        s.stop.abort();
        return turn(sh('echo 1'));
      },
      turn(done()),
    ]);
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('cancelled');
    expect(out.submitted).toBe(false);
  });
});

describe('并行的单 agent 基线（U01）', () => {
  // 每一道按自己的对话走：第一轮写文件，之后交付（几道的请求怎么交错都一样）
  const lanes = (n: number): Responses =>
    Array.from(
      { length: n },
      () => async (ctx: { messages: unknown[] }) =>
        ctx.messages.some((m) => (m as { role?: string }).role === 'toolResult')
          ? turn(done())
          : turn(sh('echo hi > out.txt')),
    );

  it('同时开两道，先交的算、交的是它自己的 workspace，另一道停下；token 两道加起来；容器都删掉', async () => {
    const s = scene(lanes(8), 1_000_000, { k: 2 });
    const out = await s.contender.attempt(s.input);
    expect(out).toMatchObject({ status: 'done', submitted: true, routes: 2 });
    expect(out.branches).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(out.delivered as string, 'out.txt'), 'utf8')).toBe('hi\n');
    expect(out.firstCandidateMs).toBeDefined();
    expect(out.tokensAtSubmit).toBeLessThanOrEqual(out.tokens);
    expect(s.containers.containers.size).toBe(0);
    expect(s.logs.some((l) => l.includes('先交'))).toBe(true);
  });

  it('一道没交就停了：在新的 workspace 里从头再来，交的是重来那次的', async () => {
    const s = scene(
      [
        turn(sh('echo no > out.txt')),
        fauxAssistantMessage([fauxText('我做完了')], { stopReason: 'stop' }),
        fauxAssistantMessage([fauxText('真的做完了')], { stopReason: 'stop' }),
        turn(sh('echo hi > out.txt')),
        turn(done()),
      ],
      1_000_000,
      { k: 1 },
    );
    const out = await s.contender.attempt(s.input);
    expect(out).toMatchObject({ status: 'done', branches: 2 });
    expect(out.delivered).toBe(join(s.dir, 'lane-1', 'try-2', 'workspace'));
    expect(readFileSync(join(out.delivered as string, 'out.txt'), 'utf8')).toBe('hi\n');
    expect(readFileSync(join(s.workspace, 'out.txt'), 'utf8')).toBe('no\n');
  });

  it('到时间都没交：记 timeout', async () => {
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 150));
      return turn(sh('echo 1'));
    };
    const s = scene(Array(12).fill(slow), 1_000_000, { k: 2, deadlineMs: 300 });
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('timeout');
    expect(out.submitted).toBe(false);
  });

  it('有一道始终起不来（一个 token 都没花就出错，隔一会儿再试 3 次）：不是 k 道在比，整次记成跑分这边出错', async () => {
    const s = scene(lanes(8), 1_000_000, { k: 2 });
    // 容器起不来（开发机进程数撞顶时会这样）
    s.containers.start = async () => {
      throw new Error('起不来容器');
    };
    const out = await s.contender.attempt(s.input);
    expect(out.status).toBe('error');
    expect(out.submitted).toBe(false);
    expect(out.error).toContain('2 道里有 2 道起不来');
    expect(s.containers.containers.size).toBe(0);
  });
});

describe('给模型的目标', () => {
  it('和 Melina 同一份目标、完成标准和附件，不带 Melina 自己的说法', () => {
    const text = baselineGoal({
      statement: '把 deploy.json 写好',
      completion: { interpretation: '一份能过校验的清单', criteria: ['过校验', '机器不超过 5 台'] },
      domain: 'general',
      materials: [{ name: 'deploy.md' }],
    });
    expect(text).toContain('把 deploy.json 写好');
    expect(text).toContain('1. 过校验');
    expect(text).toContain('2. 机器不超过 5 台');
    expect(text).toContain('/melina/materials/deploy.md');
    for (const melina of ['分支', '候选', 'Observation']) {
      expect(text).not.toContain(melina);
      expect(BASELINE_SYSTEM).not.toContain(melina);
    }
  });
});
