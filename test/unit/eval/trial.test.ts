// 一次试验：用假的 Melina（按剧本发事件）跑 melinaContender——记提交时的 token、到截断取消、太久没事件取消、开着 Scoper 不传标准；
// 可以重来的被测方 token 累计；不经过 Melina 的标准解和直接做法。单元测试不碰 git：起点 workspace 用普通目录，交付由测试写。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunResultResponse } from '../../../src/core/api.ts';
import type { MelinaEvent } from '../../../src/core/events.ts';
import { type AttemptOutcome, type Contender, melinaContender, solutionContender } from '../../eval/contenders.ts';
import {
  type EvalRunRequest,
  type EventsOptions,
  type MelinaClient,
  MelinaHttpError,
  type MelinaRun,
} from '../../eval/melina.ts';
import { runTrial, type TrialOptions } from '../../eval/trial.ts';
import { BUILTIN_VARIANTS } from '../../eval/variants.ts';
import { MelinaDeliveryError, NoDeliveryError, writeFiles } from '../../eval/workspace.ts';
import { VirtualClock } from '../../sim/kit/clock.ts';
import { deriveSeed } from '../../sim/kit/rng.ts';
import { MACHINE_PRESETS, machineTask } from '../../sim/machine/tasks.ts';
import { generateMachine } from '../../sim/machine/world.ts';
import { SimServer } from '../../sim/server.ts';

const RUN_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const MASTER = 'unit';

function usage(total: number): MelinaEvent {
  return event('usage.updated', {
    delta: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 },
    total: { input: total, cacheRead: 0, cacheWrite: 0, output: 0, usd: total / 1e6 },
  });
}

let seq = 0;
function event(type: string, data: unknown, at = new Date(Date.UTC(2026, 9, 2, 0, 0, seq)).toISOString()): MelinaEvent {
  seq++;
  return { seq, runId: RUN_ID, type, at: at.replace(/\.\d+Z$/, 'Z'), data } as unknown as MelinaEvent;
}

function runUpdated(status: string, mode = 'direct', endReason?: string): MelinaEvent {
  return event('run.updated', { id: RUN_ID, status, mode, ...(endReason ? { endReason } : {}) });
}

/** 假的 Melina：createRun 以后按剧本发事件；cancel 时发一条 cancelled */
class FakeMelina implements MelinaClient {
  requests: EvalRunRequest[] = [];
  cancels = 0;
  readonly script: (run: FakeRun) => void;

  constructor(script: (run: FakeRun) => void) {
    this.script = script;
  }

  async createRun(req: EvalRunRequest): Promise<MelinaRun> {
    this.requests.push(req);
    const run = new FakeRun(this);
    this.script(run);
    return run;
  }
}

class FakeRun implements MelinaRun {
  readonly id = RUN_ID;
  readonly melina: FakeMelina;
  readonly inputs: unknown[] = []; // 跑分代人发的指令
  readonly queue: MelinaEvent[] = [];
  readonly dropped: string[] = []; // 开始读的时候报成不合契约的
  failure: Error | undefined; // 发完 queue 里的就断
  #wake: (() => void) | undefined;

  constructor(melina: FakeMelina) {
    this.melina = melina;
  }

  emit(...events: MelinaEvent[]): void {
    this.queue.push(...events);
    this.#wake?.();
  }

  async *events(options: EventsOptions = {}): AsyncIterable<MelinaEvent> {
    for (const raw of this.dropped.splice(0)) options.onDropped?.(raw, '测试：不合契约');
    while (!options.signal?.aborted) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }

  async input(req: unknown): Promise<unknown> {
    this.inputs.push(req);
    return {};
  }

  async cancel(): Promise<void> {
    this.melina.cancels++;
    this.emit(runUpdated('cancelled', 'direct', '你取消了任务'));
  }

  async result(): Promise<RunResultResponse> {
    return {
      runId: RUN_ID,
      status: 'done',
      branch: `melina/${RUN_ID}`,
      unfinished: false,
      knowledgeReport: `art://${'0'.repeat(64)}`,
    };
  }
}

let server: SimServer;
let out: string;
let options: TrialOptions;
let clock: VirtualClock;
const task = machineTask('easy');

beforeAll(async () => {
  server = new SimServer();
  await server.start();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'melina-eval-trial-'));
  clock = new VirtualClock();
  options = { server, out, master: MASTER, maxTokens: 1_000_000, signal: new AbortController().signal, clock };
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

/** Melina 交付的 workspace：写上这个世界的最短解（测试里代替从 git 分支取文件） */
function deliverShortest(rep: number) {
  const world = generateMachine(MACHINE_PRESETS.easy, deriveSeed(MASTER, task.id, rep));
  return async ({ into }: { into: string }) => {
    writeFiles(into, { 'procedure.json': JSON.stringify(world.shortest.map((b) => world.buttons[b])) });
    return 'branch' as const;
  };
}

/** 单元测试不碰 git：起点 workspace 用普通目录 */
function noGit(c: Contender): Contender {
  return { ...c, needsGit: false };
}

describe('melinaContender', () => {
  const melina = BUILTIN_VARIANTS.find((v) => v.name === 'melina');
  const scoper = BUILTIN_VARIANTS.find((v) => v.name === 'melina-scoper');

  it('提交候选、Run 收尾：记下提交那一刻的 token，取交付，在 Run 外面检查', async () => {
    const fake = new FakeMelina((run) => {
      run.emit(
        event('run.created', { id: RUN_ID, status: 'running', mode: 'direct' }),
        event('bet.created', { kind: 'direct' }),
        event('branch.created', {}),
        usage(300_000),
        event('candidate.created', {}),
        usage(320_000),
        runUpdated('done', 'settling'),
      );
    });
    const contender = noGit(melinaContender(fake, melina ?? BUILTIN_VARIANTS[0]!, { deliver: deliverShortest(0) }));
    const r = await runTrial(task, contender, 0, options);
    expect(r).toMatchObject({
      status: 'done',
      submitted: true,
      checkPass: true,
      tokens: 320_000,
      tokensAtSubmit: 300_000,
      routes: 1,
      branches: 1,
      runIds: [RUN_ID],
    });
    // 交出的时间：建 Run 那一下（本机时钟，几毫秒）加上 Run 里从建好到候选的 4 秒（Melina 事件里的时间）
    expect(r.firstCandidateMs).toBeGreaterThanOrEqual(4000);
    expect(r.firstCandidateMs).toBeLessThan(5000);
    const req = fake.requests[0] as EvalRunRequest;
    expect(req.goal.completion?.criteria).toHaveLength(2);
    expect(req.goal.domain).toBe('general');
    expect(req.goal.statement).toContain('procedure.json');
    expect(req.goal.materials.map((p) => p.split('/').pop())).toEqual(['manual.md']);
    expect(readFileSync(req.goal.materials[0] as string, 'utf8')).toContain('FC-3');
    const events = readFileSync(join(out, 'trials', task.id, 'melina', '0', 'attempt-1', 'events.jsonl'), 'utf8');
    expect(events.trim().split('\n')).toHaveLength(7);
  });

  it('到最大截断还没提交：取消 Run，记成 cut', async () => {
    const fake = new FakeMelina((run) => {
      run.emit(
        event('run.created', { id: RUN_ID, status: 'running', mode: 'direct' }),
        usage(400_000),
        usage(1_200_000),
      );
    });
    const r = await runTrial(task, noGit(melinaContender(fake, melina ?? BUILTIN_VARIANTS[0]!)), 0, options);
    expect(fake.cancels).toBe(1);
    expect(r).toMatchObject({ status: 'cut', submitted: false, checkPass: false, tokens: 1_200_000 });
    expect(r.tokensAtSubmit).toBeUndefined();
  });

  it('太久没有事件：取消，记成 stalled；开着 Scoper 的变体不传完成标准和领域', async () => {
    const fake = new FakeMelina((run) =>
      run.emit(event('run.created', { id: RUN_ID, status: 'running', mode: 'direct' })),
    );
    const c = noGit(melinaContender(fake, scoper ?? BUILTIN_VARIANTS[1]!, { stallMs: 50, graceMs: 1000 }));
    const r = await runTrial(task, c, 0, options);
    expect(r.status).toBe('stalled');
    expect(fake.requests[0]?.goal.completion).toBeUndefined();
    expect(fake.requests[0]?.goal.domain).toBeUndefined();
  });
});

describe('melinaContender 收尾的几种情况', () => {
  const melina = BUILTIN_VARIANTS[0] as (typeof BUILTIN_VARIANTS)[number];
  const created = (mode = 'direct') => event('run.created', { id: RUN_ID, status: 'running', mode });

  it('人按 Ctrl-C：先取消 Run，等它真结束，记成 cancelled', async () => {
    const stop = new AbortController();
    const fake = new FakeMelina((run) => {
      run.emit(created(), usage(100_000));
      setTimeout(() => stop.abort(), 30);
    });
    const r = await runTrial(task, noGit(melinaContender(fake, melina)), 0, { ...options, signal: stop.signal });
    expect(fake.cancels).toBe(1);
    expect(r).toMatchObject({ status: 'cancelled', submitted: false, endReason: '你取消了任务' });
  });

  it('事件流断了：尽量取消 Run，记成 melina_error（Melina 那边的问题，算失败、进分母）', async () => {
    const fake = new FakeMelina((run) => {
      run.emit(created());
      run.failure = new Error('连不上 Melina');
    });
    const r = await runTrial(task, noGit(melinaContender(fake, melina, { graceMs: 50 })), 0, options);
    expect(fake.cancels).toBe(1);
    expect(r.status).toBe('melina_error');
    expect(r.error).toContain('连不上 Melina');
  });

  it('建 Run 时连不上 Melina 是 melina_error；Melina 回 4xx 是跑分这边的请求不对，记成 error', async () => {
    const down = new FakeMelina(() => {});
    down.createRun = async () => {
      throw new TypeError('fetch failed');
    };
    expect((await runTrial(task, noGit(melinaContender(down, melina)), 0, options)).status).toBe('melina_error');
    const rejected = new FakeMelina(() => {});
    rejected.createRun = async () => {
      throw new MelinaHttpError('Melina POST /api/runs 返回 400：完成标准不能是空的', 400);
    };
    expect((await runTrial(task, noGit(melinaContender(rejected, melina)), 1, options)).status).toBe('error');
  });

  it('说做完了、交付里什么都没有是 melina_error；本机读不出交付是 error', async () => {
    const done = () =>
      new FakeMelina((run) => {
        run.emit(created(), event('candidate.created', {}), runUpdated('done', 'settling'));
      });
    const empty = noGit(
      melinaContender(done(), melina, {
        deliver: async () => {
          throw new NoDeliveryError('交付里既没有分支也没有 patch');
        },
      }),
    );
    expect(await runTrial(task, empty, 0, options)).toMatchObject({ status: 'melina_error', checkPass: false });
    const local = noGit(
      melinaContender(done(), melina, {
        deliver: async () => {
          throw new Error('ls-tree 读不出来');
        },
      }),
    );
    expect(await runTrial(task, local, 1, options)).toMatchObject({ status: 'error', checkPass: false });
  });

  it('提交了但 Run 还没收尾就被截断取消：没取到交付，不算误交付', async () => {
    const fake = new FakeMelina((run) => {
      run.emit(created(), usage(1_200_000), event('candidate.created', {}));
    });
    const r = await runTrial(task, noGit(melinaContender(fake, melina, { deliver: deliverShortest(0) })), 0, options);
    expect(r).toMatchObject({ status: 'cut', submitted: true, delivered: false, checkPass: false });
    expect(r.checkSummary).toContain('没收尾完');
  });

  it('不合契约的事件记进 dropped-events.jsonl', async () => {
    const fake = new FakeMelina((run) => {
      run.dropped.push('{"type":"weird"}');
      run.emit(created(), runUpdated('failed', 'direct', '没路了'));
    });
    await runTrial(task, noGit(melinaContender(fake, melina)), 0, options);
    const dropped = readFileSync(
      join(out, 'trials', task.id, 'melina', '0', 'attempt-1', 'dropped-events.jsonl'),
      'utf8',
    );
    expect(dropped).toContain('weird');
  });
});

describe('runTrial', () => {
  it('同一个存档目录再跑一次：上次留下的东西清掉，从头来', async () => {
    const dir = join(out, 'trials', task.id, 'reference', '0');
    await runTrial(task, solutionContender('reference', clock), 0, options);
    writeFileSync(join(dir, 'stale.txt'), '上次的');
    const r = await runTrial(task, solutionContender('reference', clock), 0, options);
    expect(r.checkPass).toBe(true);
    expect(existsSync(join(dir, 'stale.txt'))).toBe(false);
  });

  it('世界不合格就不跑，记成 error', async () => {
    let called = false;
    const reference = solutionContender('reference', clock);
    const watched: Contender = {
      ...reference,
      attempt: async (input) => {
        called = true;
        return reference.attempt(input);
      },
    };
    const r = await runTrial(task, watched, 0, { ...options, verify: async () => '标准解没过' });
    expect(called).toBe(false);
    expect(r).toMatchObject({ status: 'error', checkPass: false });
    expect(r.error).toContain('不合格');
  });

  it('可以重来的被测方，一次连 token 都没花就结束的不再重来', async () => {
    const idle: Contender = {
      name: 'idle',
      title: '空转',
      restartable: true,
      needsGit: false,
      attempt: async () => ({
        status: 'failed',
        submitted: false,
        tokens: 0,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 },
        wallMs: 1,
        routes: 0,
        branches: 0,
      }),
    };
    expect((await runTrial(task, idle, 0, options)).attempts).toBe(1);
  });

  it('可以重来的被测方：没提交就从头再来，token 累计，提交时的 token 含前面几次', async () => {
    let calls = 0;
    const flaky: Contender = {
      name: 'flaky',
      title: '先失败一次',
      restartable: true,
      needsGit: false,
      async attempt(input): Promise<AttemptOutcome> {
        calls++;
        const base = {
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 },
          wallMs: 10,
          routes: 1,
          branches: 1,
        };
        if (calls === 1) return { ...base, status: 'failed', submitted: false, tokens: 100 };
        await solutionContender('reference', clock).attempt(input);
        return { ...base, status: 'done', submitted: true, tokens: 80, tokensAtSubmit: 50, delivered: input.workspace };
      },
    };
    const r = await runTrial(task, flaky, 0, options);
    expect(r).toMatchObject({ attempts: 2, tokens: 180, tokensAtSubmit: 150, checkPass: true });
  });

  it('不经过 Melina：标准解过，中等的直接做法不过；环境的请求日志存档', async () => {
    const medium = machineTask('medium');
    const ref = await runTrial(medium, solutionContender('reference', clock), 0, options);
    const naive = await runTrial(medium, solutionContender('naive', clock), 0, options);
    expect(ref.checkPass).toBe(true);
    expect(naive.checkPass).toBe(false);
    expect(ref.envRequests).toBeGreaterThan(10);
    const log = readFileSync(join(out, 'trials', medium.id, 'reference', '0', 'env-log.jsonl'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(ref.envRequests);
  });
});

describe('melinaContender：交过几版、取交付、取消收尾（对照样例的结果都是已知的）', () => {
  const melina = BUILTIN_VARIANTS[0] as (typeof BUILTIN_VARIANTS)[number];
  const at = (s: number) => new Date(Date.UTC(2026, 9, 2, 1, 0, s)).toISOString();
  const created = () => event('run.created', { id: RUN_ID, status: 'running', mode: 'direct' }, at(0));
  const spent = (total: number, s: number) =>
    event(
      'usage.updated',
      {
        delta: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 },
        total: { input: total, cacheRead: 0, cacheWrite: 0, output: 0, usd: total / 1e6 },
      },
      at(s),
    );
  const candidate = (id: string, s: number, interim = false) =>
    event('candidate.created', { id, ...(interim ? { interim: true } : {}) }, at(s));
  const ended = (status: string, s: number, candidateId?: string, mode = 'settling') =>
    event(
      'run.updated',
      { id: RUN_ID, status, mode, endReason: '你取消了任务', ...(candidateId ? { result: { candidateId } } : {}) },
      at(s),
    );

  it('交过几版：交出的时刻、那一刻的 token 和费用都按交付的那一个记；首个候选按第一次交出记', async () => {
    const fake = new FakeMelina((run) => {
      run.emit(
        created(),
        spent(100_000, 5),
        candidate('c1', 10, true),
        spent(600_000, 50),
        candidate('c2', 60),
        ended('done', 62, 'c2'),
      );
    });
    const r = await runTrial(task, noGit(melinaContender(fake, melina, { deliver: deliverShortest(0) })), 0, options);
    expect(r).toMatchObject({
      status: 'done',
      checkPass: true,
      tokensAtSubmit: 600_000,
      usdAtSubmit: 0.6,
    });
    expect((r.firstCandidateMs as number) - (r.firstSubmitMs as number)).toBe(50_000);
  });

  it('先存了阶段版以后 token 上限照管：到上限取消，Melina 交付那一版、照常判（之前交过一版就不管了）', async () => {
    const fake = new FakeMelina((run) => {
      run.cancel = async () => {
        fake.cancels++;
        run.emit(ended('cancelled', 40, 'c1', 'direct'));
      };
      run.emit(created(), spent(100_000, 5), candidate('c1', 10, true), spent(1_200_000, 30));
    });
    const r = await runTrial(task, noGit(melinaContender(fake, melina, { deliver: deliverShortest(0) })), 0, options);
    expect(fake.cancels).toBe(1);
    expect(r).toMatchObject({ status: 'done', deliveredVersion: true, tokensAtSubmit: 100_000, checkPass: true });
  });

  it('交了正式候选以后 Run 在收尾：用量再涨也不取消', async () => {
    const fake = new FakeMelina((run) => {
      run.emit(created(), spent(100_000, 5), candidate('c1', 10), spent(1_200_000, 12), ended('done', 15, 'c1'));
    });
    const r = await runTrial(task, noGit(melinaContender(fake, melina, { deliver: deliverShortest(0) })), 0, options);
    expect(fake.cancels).toBe(0);
    expect(r).toMatchObject({ status: 'done', checkPass: true, tokensAtSubmit: 100_000 });
  });

  it('用量以 Run 结束后的摘要为准：最后一秒的账可能晚于结束的那条事件', async () => {
    const fake = new FakeMelina((run) => {
      Object.assign(run, {
        summary: async () => ({
          branches: [],
          usage: { input: 3_200_000, cacheRead: 0, cacheWrite: 0, output: 0, usd: 3.2 },
        }),
      });
      run.emit(created(), spent(3_000_000, 50), candidate('c1', 60), ended('done', 62, 'c1'));
    });
    const c = noGit(melinaContender(fake, melina, { deliver: deliverShortest(0) }));
    const r = await runTrial(task, c, 0, { ...options, maxTokens: 10_000_000 });
    expect(r).toMatchObject({ tokens: 3_200_000, tokensAtSubmit: 3_000_000 });
    expect(r.usage.usd).toBe(3.2);
  });

  it('取消请求要等 Melina 收尾完才回：宽限期从请求回来时算，最后一条事件照读', async () => {
    const fake = new FakeMelina((run) => {
      run.cancel = async () => {
        fake.cancels++;
        await new Promise((resolve) => setTimeout(resolve, 300));
        run.emit(ended('cancelled', 400, undefined, 'direct'));
      };
      run.emit(created());
    });
    const r = await runTrial(task, noGit(melinaContender(fake, melina, { stallMs: 50, graceMs: 100 })), 0, options);
    expect(r).toMatchObject({ status: 'stalled', endReason: '你取消了任务' });
    expect(r.error).toBeUndefined();
  });

  it('说做完了却取不到交付算 Melina 失败（§16）：分支不在、patch 取不到、GET /result 回 409；本机读不出交付才算跑分出错', async () => {
    const done = (resultError?: Error) =>
      new FakeMelina((run) => {
        if (resultError) {
          run.result = async () => {
            throw resultError;
          };
        }
        run.emit(created(), candidate('c1', 10), ended('done', 12, 'c1'));
      });
    const throwing = (e: Error) => async () => {
      throw e;
    };
    const statusOf = async (fake: FakeMelina, opts: Parameters<typeof melinaContender>[2], rep: number) =>
      (await runTrial(task, noGit(melinaContender(fake, melina, opts)), rep, options)).status;
    expect(await statusOf(done(), { deliver: throwing(new MelinaDeliveryError('分支不在')) }, 0)).toBe('melina_error');
    const missing = throwing(new MelinaHttpError('Melina GET /artifacts 返回 404：这个任务里没有产物', 404));
    expect(await statusOf(done(), { deliver: missing }, 1)).toBe('melina_error');
    const conflict = new MelinaHttpError('Melina GET /result 返回 409：任务还没结束', 409);
    expect(await statusOf(done(conflict), { deliver: deliverShortest(2) }, 2)).toBe('melina_error');
    const local = Object.assign(new Error('spawnSync git EAGAIN'), { code: 'EAGAIN' });
    expect(await statusOf(done(), { deliver: throwing(local) }, 3)).toBe('error');
  });

  it('结果里记这一批的标记', async () => {
    const r = await runTrial(task, solutionContender('reference', clock), 0, { ...options, batch: 'batch-1' });
    expect(r.batch).toBe('batch-1');
  });
});
