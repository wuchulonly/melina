// melinaStream：名额、记账、重试、熔断、备用模型、没动静超时、取消、严格模式被拒。
// 用 pi 的 fauxProvider 按脚本返回；请求、重试和没动静用真计时器，试探边界按需注入时钟。

import { describe, expect, it } from 'vitest';
import { createMelinaStream, type ModelRequestTiming } from '../../../src/models/stream.ts';
import { A1, B1, BRANCH, callOnce, hang, httpError, meta, RUN, setup } from './fakes.ts';
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, normalizeContext } from './protocol.ts';

describe('melinaStream：一次正常的调用', () => {
  it('调用名额等待在 attempt 外计时，排队取消也有记录但不伪造响应或首内容', async () => {
    const s = setup();
    const timings: ModelRequestTiming[] = [];
    const stream = createMelinaStream({
      registry: s.registry,
      scheduler: s.scheduler.scheduler,
      ledger: s.ledger.ledger,
      onTiming: (timing) => timings.push(timing),
    });
    s.scheduler.state.hold = new Promise(() => {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('queue budget'), 30);
    const { message } = await callOnce({ ...s, stream }, meta(A1, { signal: controller.signal }));
    clearTimeout(timer);
    expect(message.stopReason).toBe('aborted');
    expect(s.a.state.callCount).toBe(0);
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ outcome: 'queue_cancelled', cancelKind: 'external', cancelStage: 'queue' });
    expect(timings[0]!.queueMs).toBeGreaterThanOrEqual(15);
    expect(timings[0]!.requestMs).toBeUndefined();
    expect(timings[0]!.headersMs).toBeUndefined();
    expect(timings[0]!.firstContentMs).toBeUndefined();
  });

  it('失败分类显式传回调用方，后续成功清空供应商失败，不从 breaker 状态猜原因', async () => {
    const s = setup();
    const failures: (string | undefined)[] = [];
    s.a.setResponses([httpError(503, 'overloaded'), fauxAssistantMessage('完成')]);
    await callOnce(s, meta(A1, { onFailure: (kind) => failures.push(kind) }));
    expect(failures).toEqual(['provider', undefined]);
    expect(s.breaker.isOpen('faux-a')).toBe(false);
  });
  it('先要调用层的名额，返回后记账，实际 token 报给 Scheduler；事件一次给全', async () => {
    const s = setup();
    s.a.setResponses([fauxAssistantMessage([fauxToolCall('sh', { cmd: 'ls' })], { stopReason: 'toolUse' })]);
    const { message, events } = await callOnce(s);
    expect(message.stopReason).toBe('toolUse');
    expect(events).toEqual(['start', 'done']);
    expect(s.scheduler.state.slots).toEqual([
      { runId: RUN, provider: 'faux-a', job: 'explorer_episode', branchId: BRANCH, estTokens: expect.any(Number) },
    ]);
    expect(s.scheduler.state.slots[0]?.estTokens).toBeGreaterThan(0);
    expect(s.scheduler.state.inFlight).toBe(0);
    expect(s.ledger.entries).toHaveLength(1);
    expect(s.ledger.entries[0]).toMatchObject({
      runId: RUN,
      branchId: BRANCH,
      role: 'explorer',
      provider: 'faux-a',
      model: 'a-1',
      usd: 0,
    });
    const t = s.ledger.entries[0]?.tokens;
    expect((t?.input ?? 0) + (t?.output ?? 0)).toBeGreaterThan(0);
    expect(s.scheduler.state.consumed).toEqual([{ provider: 'faux-a', tokens: expect.any(Number) }]);
  });

  it('API key 从模型页的配置给，SDK 自带的重试关掉，sessionId 用来路由缓存', async () => {
    const s = setup();
    let seen: Record<string, unknown> = {};
    s.a.setResponses([
      (_ctx, options) => {
        seen = { apiKey: options?.apiKey, maxRetries: options?.maxRetries, sessionId: options?.sessionId };
        return fauxAssistantMessage('好');
      },
    ]);
    await callOnce(s, meta(A1, { sessionId: 'branch-x' }));
    expect(seen).toEqual({ apiKey: 'key-a', maxRetries: 0, sessionId: 'branch-x' });
  });
});

describe('melinaStream：供应商那边的错', () => {
  it('429 带 Retry-After：收紧并发、至少等那么久再重试，成功后不熔断', async () => {
    const s = setup();
    s.a.setResponses([
      httpError(429, '429 Rate limit reached', { 'retry-after-ms': '60' }),
      fauxAssistantMessage('好'),
    ]);
    const started = Date.now();
    const { message } = await callOnce(s);
    expect(message.stopReason).toBe('stop');
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(s.scheduler.state.throttled).toEqual([{ provider: 'faux-a', status: 429, retryAfterMs: 60 }]);
    expect(s.scheduler.state.slots).toHaveLength(2); // 每次重试都重新要名额
    expect(s.ledger.entries).toHaveLength(2); // 每次请求一行
    expect(s.breaker.isOpen('faux-a')).toBe(false);
    // 每次重试记一笔日志（账本里看不出哪次出了错）
    expect(s.notices).toEqual(['faux-a/a-1 出错，0.1 秒后重试（第 1 次，最多 2 次）：429 Rate limit reached']);
  });

  it('重试 retries.model 次还不行就熔断这家，换同档位的备用模型；Agent 看不到这些错', async () => {
    const s = setup(); // retries.model = 2
    s.a.setResponses([
      httpError(503, '503 Service Unavailable'),
      httpError(500, '500 Internal Server Error'),
      httpError(502, '502 Bad Gateway'),
    ]);
    s.b.setResponses([fauxAssistantMessage('备用模型的回答')]);
    const { message } = await callOnce(s);
    expect(message).toMatchObject({ stopReason: 'stop', provider: 'faux-b', model: 'b-1' });
    expect(s.a.state.callCount).toBe(3);
    expect(s.registry.breakers()[0]).toEqual({
      provider: 'faux-a',
      breaker: 'open',
      reason: '502 Bad Gateway（重试 2 次仍不行）',
      fallbackTo: B1,
      keys: [{ id: 'key-faux-a', state: 'active' }], // 供应商那边的错不换 key
    });
    expect(s.notices.join('\n')).toMatch(/faux-a 熔断/);
    expect(s.notices.join('\n')).toMatch(/换到 faux-b\/b-1/);
    expect(s.notices.filter((n) => n.includes('后重试'))).toEqual([
      expect.stringContaining('（第 1 次，最多 2 次）：503 Service Unavailable'),
      expect.stringContaining('（第 2 次，最多 2 次）：500 Internal Server Error'),
    ]);
  });

  it('没有备用模型：排队，每个周期试一次，通了就恢复', async () => {
    const s = setup({ strong: [A1], probeIntervalMs: 30, global: { retries: { model: 0 } } });
    s.a.setResponses([httpError(500, '500 boom'), httpError(500, '500 still'), fauxAssistantMessage('通了')]);
    const started = Date.now();
    const { message } = await callOnce(s);
    expect(message.stopReason).toBe('stop');
    expect(s.a.state.callCount).toBe(3); // 熔断、试探失败、试探成功
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(s.breaker.isOpen('faux-a')).toBe(false);
  });

  it('401、余额不足：不重试，直接熔断，换备用', async () => {
    for (const [status, text, reason] of [
      [401, '401 Authentication Fails, Your api key is invalid', /401/],
      [402, '402 Insufficient Balance', /Insufficient Balance/],
    ] as const) {
      const s = setup();
      s.a.setResponses([httpError(status, text)]);
      s.b.setResponses([fauxAssistantMessage('好')]);
      const { message } = await callOnce(s);
      expect(message.provider).toBe('faux-b');
      expect(s.a.state.callCount).toBe(1);
      expect(s.registry.breakers()[0]?.reason).toMatch(reason);
    }
  });

  it('没配 key：熔断这家（原因写明），不记账', async () => {
    // 真实的适配层（openai-completions、anthropic-messages）没有 key 时同步抛 No API key for provider；faux 不查，这里照着模拟
    const s = setup({
      keys: { 'faux-b': 'key-b' },
      wrapA: (provider) => ({
        ...provider,
        streamSimple: (model, context, options) => {
          if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
          return provider.streamSimple(model, context, options);
        },
      }),
    });
    s.b.setResponses([fauxAssistantMessage('好')]);
    const { message } = await callOnce(s);
    expect(message.provider).toBe('faux-b');
    expect(s.registry.breakers()[0]).toMatchObject({ breaker: 'open', reason: expect.stringMatching(/No API key/) });
    expect(s.ledger.entries.map((e) => e.provider)).toEqual(['faux-b']);
  });

  it('长时间没有新内容（model.idleTimeoutMs）：掐断、按供应商那边的错重试', async () => {
    const s = setup({ global: { model: { idleTimeoutMs: 40 } } });
    s.a.setResponses([hang(), fauxAssistantMessage('第二次好了')]);
    const { message } = await callOnce(s);
    expect(message.stopReason).toBe('stop');
    expect(s.a.state.callCount).toBe(2);
  });

  it('熔断期间新来的调用直接走备用，到时间再有一个去试原来那家', async () => {
    let now = 1000;
    const s = setup({ probeIntervalMs: 40, now: () => now });
    s.breaker.failure('faux-a', '503 Service Unavailable');
    s.b.setResponses([fauxAssistantMessage('备用一'), fauxAssistantMessage('备用二')]);
    now += 39;
    expect((await callOnce(s)).message.provider).toBe('faux-b');
    now += 1;
    s.a.setResponses([fauxAssistantMessage('原来的好了')]);
    expect((await callOnce(s)).message.provider).toBe('faux-a');
    expect(s.breaker.isOpen('faux-a')).toBe(false);
  });
});

describe('melinaStream：审查发现的边角', () => {
  it('只当备用的那家熔断后，到了试探时间也会被试，通了就恢复', async () => {
    // 只推进熔断器的钟：机器一忙真实时钟会让首选也到点。
    let now = 1000;
    const s = setup({ probeIntervalMs: 40, now: () => now });
    s.breaker.failure('faux-b', '503 Service Unavailable'); // 备用先熔断
    now += 25;
    s.breaker.failure('faux-a', '503 Service Unavailable'); // 首选后熔断：它还没到试探时间，备用先到
    now += 15;
    expect(s.breaker.ready('faux-a')).toBe('wait');
    expect(s.breaker.ready('faux-b')).toBe('due');
    s.b.setResponses([fauxAssistantMessage('备用通了')]);
    const { message } = await callOnce(s);
    expect(message.provider).toBe('faux-b');
    expect(s.breaker.isOpen('faux-b')).toBe(false);
    expect(s.breaker.isOpen('faux-a')).toBe(true);
  });

  it('首选和备用都熔断了：排队，谁先到试探时间就试谁', async () => {
    const s = setup({ probeIntervalMs: 30 });
    s.breaker.failure('faux-a', '连不上');
    s.breaker.failure('faux-b', '连不上');
    s.a.setResponses([fauxAssistantMessage('首选通了')]);
    const { message } = await callOnce(s);
    expect(message.provider).toBe('faux-a');
    expect(s.breaker.isOpen('faux-a')).toBe(false);
  });

  it('后台调用（摘要、挑版、巡检器）：熔断又没有能换的备用，等一会儿还不行就交回出错，不一直排队', async () => {
    const s = setup({ strong: [A1], probeIntervalMs: 60_000, backgroundWaitMs: 40 });
    s.breaker.failure('faux-a', '503 Service Unavailable');
    for (const extra of [
      { role: 'explorer', job: 'handoff_call' },
      { role: 'explorer', job: 'selection_call' },
      { role: 'watcher', job: 'watcher_call' }, // 巡检器：一轮没做成，等主干直解路线再做一段重来
    ] as const) {
      const started = Date.now();
      const { message } = await callOnce(s, meta(A1, extra));
      expect(message.stopReason).toBe('error');
      expect(message.errorMessage).toMatch(/faux-a 熔断中（503 Service Unavailable），没有配同档位的备用模型/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    }
    expect(s.a.state.callCount).toBe(0);
  });

  it('后台的角色：试探比等待上限勤、每次试探都失败，到上限照样交回出错，不一直试下去', async () => {
    // 以前每次回到选模型那一步都重新计时：试探间隔（这里 30 ms）比上限（150 ms）短，上限永远到不了，一直挡着 idle 规则
    const s = setup({ strong: [A1], probeIntervalMs: 30, backgroundWaitMs: 150 });
    s.breaker.failure('faux-a', '503 Service Unavailable');
    s.a.setResponses(Array.from({ length: 200 }, () => httpError(503, '503 Service Unavailable')));
    const guard = new AbortController();
    const timer = setTimeout(() => guard.abort(new Error('兜底：1.5 秒还没交回')), 1500);
    const started = Date.now();
    const { message } = await callOnce(s, meta(A1, { role: 'explorer', job: 'selection_call', signal: guard.signal }));
    clearTimeout(timer);
    expect(message.stopReason).toBe('error');
    expect(message.errorMessage).toMatch(/faux-a 熔断中.*后台的调用不排队等/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(s.a.state.callCount).toBeGreaterThan(0); // 期间照常去试探过
  });

  it('后台的角色等的时候这家到了试探时间：照常去试，通了就照常交回', async () => {
    const s = setup({ strong: [A1], probeIntervalMs: 30, backgroundWaitMs: 5000 });
    s.breaker.failure('faux-a', '连不上');
    s.a.setResponses([fauxAssistantMessage('通了')]);
    const { message } = await callOnce(s, meta(A1, { role: 'explorer', job: 'handoff_call' }));
    expect(message.stopReason).toBe('stop');
    expect(s.breaker.isOpen('faux-a')).toBe(false);
  });

  it('认不出的错：重试 retries.model 次还不行就交给 Agent，不熔断', async () => {
    const s = setup(); // retries.model = 2
    const weird = fauxAssistantMessage([], {
      stopReason: 'error',
      errorMessage: 'Cannot read properties of undefined',
    });
    s.a.setResponses([weird, weird, weird]);
    const { message } = await callOnce(s);
    expect(message).toMatchObject({ stopReason: 'error', errorMessage: 'Cannot read properties of undefined' });
    expect(s.a.state.callCount).toBe(3);
    expect(s.breaker.isOpen('faux-a')).toBe(false);
  });

  it('认不出的错偶尔出一次：重试就好了', async () => {
    const s = setup();
    s.a.setResponses([
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'weird glitch' }),
      fauxAssistantMessage('好了'),
    ]);
    expect((await callOnce(s)).message.stopReason).toBe('stop');
  });

  it('记账出错不影响调用，试探也照样回报（不会卡在 probing）', async () => {
    const s = setup({ strong: [A1], probeIntervalMs: 1 });
    const stream = createMelinaStream({
      registry: s.registry,
      scheduler: {
        ...s.scheduler.scheduler,
        consumed: () => {
          throw new Error('scheduler bug');
        },
      },
      ledger: {
        model: () => {
          throw new Error('ledger bug');
        },
      },
      backoff: { baseMs: 1, maxMs: 5 },
    });
    s.breaker.failure('faux-a', '连不上');
    await new Promise((r) => setTimeout(r, 5));
    s.a.setResponses([fauxAssistantMessage('通了')]);
    const out = await stream(meta(A1))(s.registry.model(A1), normalizeContext({ messages: [] }), {});
    expect((await out.result()).stopReason).toBe('stop');
    expect(s.breaker.status(['faux-a'])).toEqual([{ provider: 'faux-a', breaker: 'ok' }]);
  });

  it('等调用名额时不占试探机会', async () => {
    const s = setup({ strong: [A1], probeIntervalMs: 1 });
    s.breaker.failure('faux-a', '连不上');
    await new Promise((r) => setTimeout(r, 5));
    s.scheduler.state.hold = new Promise<void>(() => {}); // 名额一直不给
    const controller = new AbortController();
    const pending = callOnce(s, meta(A1, { signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 10));
    expect(s.breaker.ready('faux-a')).toBe('due');
    expect(s.breaker.status(['faux-a'])[0]?.breaker).toBe('open');
    controller.abort();
    expect((await pending).message.stopReason).toBe('aborted');
  });

  it('选模型时出错（比如读 key 抛错）不当成取消', async () => {
    const s = setup({
      keys: new Proxy({} as Record<string, string | undefined>, {
        get: () => {
          throw new Error('API key 解密失败');
        },
      }),
    });
    s.breaker.failure('faux-a', '连不上'); // 首选熔断，要去看备用，读 key 时抛错
    // 不用 callOnce：它先用 registry.piModel 取模型，那一步读配置（假的模型页配置会读 key）就抛了；这里只看 melinaStream 里面
    const context = normalizeContext({ messages: [{ role: 'user', content: '你好', timestamp: 1 }] });
    const out = await s.stream(meta())(s.a.getModel(), context, {});
    const message = await out.result();
    expect(message.stopReason).toBe('error');
    expect(message.errorMessage).toMatch(/API key 解密失败/);
  });
});

describe('melinaStream：交给角色处理的错', () => {
  it('上下文撑爆：不重试、不熔断，原样交给 Agent', async () => {
    const s = setup();
    s.a.setResponses([httpError(400, 'prompt is too long: 213462 tokens > 200000 maximum')]);
    const { message, events } = await callOnce(s);
    expect(events).toEqual(['error']);
    expect(message.stopReason).toBe('error');
    expect(s.a.state.callCount).toBe(1);
    expect(s.breaker.isOpen('faux-a')).toBe(false);
  });

  it('其他 4xx：模型这边的问题，原样交给 Agent', async () => {
    const s = setup();
    s.a.setResponses([httpError(400, '400 Invalid request: tool_call_id not found')]);
    const { message } = await callOnce(s);
    expect(message.errorMessage).toMatch(/tool_call_id/);
    expect(s.a.state.callCount).toBe(1);
  });

  it('首选模型不在 pi 的目录里：交给 Agent 一条出错的回复', async () => {
    const s = setup();
    const fn = s.stream(meta({ provider: 'faux-a', model: 'nope', tier: 'strong' }));
    const out = await fn(s.registry.model(A1), normalizeContext({ messages: [] }), {});
    expect((await out.result()).errorMessage).toMatch(/没有模型 faux-a\/nope/);
  });
});

describe('melinaStream：取消', () => {
  it('等名额时取消', async () => {
    const s = setup();
    let release = () => {};
    s.scheduler.state.hold = new Promise<void>((r) => {
      release = r;
    });
    const controller = new AbortController();
    const pending = callOnce(s, meta(A1, { signal: controller.signal }));
    setTimeout(() => controller.abort('kill'), 5);
    const { message } = await pending;
    release();
    expect(message.stopReason).toBe('aborted');
    expect(s.a.state.callCount).toBe(0);
  });

  it('请求在途时取消：中止请求，不重试', async () => {
    const s = setup();
    s.a.setResponses([hang()]);
    const controller = new AbortController();
    const pending = callOnce(s, meta(A1), { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const { message } = await pending;
    expect(message.stopReason).toBe('aborted');
    expect(s.a.state.callCount).toBe(1);
  });

  it('请求出错和取消同时发生：按取消算，不计重试、不熔断', async () => {
    const s = setup({ global: { retries: { model: 0 } } });
    s.a.setResponses([
      (_ctx, options) =>
        new Promise((resolve) =>
          options?.signal?.addEventListener('abort', () =>
            resolve(fauxAssistantMessage([], { stopReason: 'error', errorMessage: '500 socket closed' })),
          ),
        ),
    ]);
    const controller = new AbortController();
    const pending = callOnce(s, meta(A1), { signal: controller.signal });
    setTimeout(() => controller.abort('kill'), 5);
    const { message } = await pending;
    expect(message).toMatchObject({ stopReason: 'aborted', errorMessage: 'kill' });
    expect(s.breaker.isOpen('faux-a')).toBe(false);
    expect(s.a.state.callCount).toBe(1);
  });

  it('熔断排队时取消', async () => {
    const s = setup({ strong: [A1], probeIntervalMs: 10_000 });
    s.breaker.failure('faux-a', '连不上');
    const controller = new AbortController();
    const pending = callOnce(s, meta(A1, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    expect((await pending).message.stopReason).toBe('aborted');
  });

  it('试探的调用被取消：交还试探机会', async () => {
    const s = setup({ strong: [A1], probeIntervalMs: 1 });
    s.breaker.failure('faux-a', '连不上');
    await new Promise((r) => setTimeout(r, 5));
    s.a.setResponses([hang()]);
    const controller = new AbortController();
    const pending = callOnce(s, meta(A1), { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    expect((await pending).message.stopReason).toBe('aborted');
    expect(s.breaker.gate('faux-a')).toBe('probe');
  });
});

describe('melinaStream：一家配几个 API key（§12）', () => {
  const K1 = { id: 'k1', name: '公司账号', key: 'sk-1' };
  const K2 = { id: 'k2', name: '个人账号', key: 'sk-2' };
  type Step = Extract<FauxResponseStep, (...args: never[]) => unknown>;

  /** faux-a 配两个 key；记下每次请求用的 key */
  function twoKeys(opts: Parameters<typeof setup>[0] = {}) {
    let now = 1000;
    const advance = (ms: number) => {
      now += ms;
    };
    const s = setup({ probeIntervalMs: 40, now: () => now, ...opts });
    s.keyLists['faux-a'] = [K1, K2];
    const used: (string | undefined)[] = [];
    const reply = (step: Step): Step => {
      return (ctx, options, state, model) => {
        used.push(options?.apiKey);
        return step(ctx, options, state, model);
      };
    };
    const ok = (text = '好'): Step => reply(() => fauxAssistantMessage(text));
    const fail = (status: number, text: string): Step => reply(httpError(status, text) as Step);
    return { s, used, ok, fail, advance };
  }

  it('额度用完：同一次调用马上换下一个 key 重发，不算重试、不熔断；之后一直用这个 key', async () => {
    const { s, used, ok, fail } = twoKeys({ global: { retries: { model: 0 } } });
    s.a.setResponses([fail(402, '402 Insufficient Balance'), ok(), ok()]);
    const { message } = await callOnce(s);
    expect(message).toMatchObject({ stopReason: 'stop', provider: 'faux-a' });
    expect(used).toEqual(['sk-1', 'sk-2']);
    expect(s.breaker.isOpen('faux-a')).toBe(false);
    expect(s.registry.breakers()[0]?.keys).toEqual([
      { id: 'k1', name: '公司账号', state: 'down', reason: '402 Insufficient Balance' },
      { id: 'k2', name: '个人账号', state: 'active' },
    ]);
    expect(s.notices.join('\n')).toMatch(/faux-a 的 API key（公司账号）用不了：402 Insufficient Balance。换下一个 key/);
    await callOnce(s);
    expect(used).toEqual(['sk-1', 'sk-2', 'sk-2']);
    expect(s.scheduler.state.slots).toHaveLength(3); // 换 key 重发也重新要名额
  });

  it('key 失效（401、403）也换；限流、5xx 不换 key', async () => {
    const { s, used, ok, fail } = twoKeys();
    s.a.setResponses([fail(429, '429 Rate limit reached'), fail(503, '503 Service Unavailable'), ok()]);
    await callOnce(s);
    expect(used).toEqual(['sk-1', 'sk-1', 'sk-1']);
    expect(s.registry.breakers()[0]?.keys?.map((k) => k.state)).toEqual(['active', 'standby']);

    const second = twoKeys();
    second.s.a.setResponses([second.fail(403, '403 Forbidden'), second.ok()]);
    await callOnce(second.s);
    expect(second.used).toEqual(['sk-1', 'sk-2']);
  });

  it('这家的 key 都用不了才熔断，换同档位的备用模型；原因写明', async () => {
    const { s, used, fail } = twoKeys();
    s.a.setResponses([fail(402, '402 Insufficient Balance'), fail(401, '401 Authentication Fails')]);
    s.b.setResponses([fauxAssistantMessage('备用模型的回答')]);
    const { message } = await callOnce(s);
    expect(message.provider).toBe('faux-b');
    expect(used).toEqual(['sk-1', 'sk-2']);
    expect(s.registry.breakers()[0]).toMatchObject({
      breaker: 'open',
      reason: '2 个 API key 都用不了（最后一个：401 Authentication Fails）',
      fallbackTo: B1,
      keys: [
        { id: 'k1', state: 'down', reason: '402 Insufficient Balance' },
        { id: 'k2', state: 'down', reason: '401 Authentication Fails' },
      ],
    });
  });

  it('只配了一个 key：和以前一样，用不了就熔断，原因就是那个错', async () => {
    const s = setup();
    s.a.setResponses([httpError(402, '402 Insufficient Balance')]);
    s.b.setResponses([fauxAssistantMessage('好')]);
    expect((await callOnce(s)).message.provider).toBe('faux-b');
    expect(s.a.state.callCount).toBe(1);
    expect(s.registry.breakers()[0]).toMatchObject({ breaker: 'open', reason: '402 Insufficient Balance' });
  });

  it('用不了的 key 到点拿一次真实调用去试：通了就用回它', async () => {
    const { s, used, ok, fail, advance } = twoKeys();
    s.a.setResponses([fail(402, '402 Insufficient Balance'), ok(), ok('充值以后'), ok()]);
    await callOnce(s);
    advance(40);
    await callOnce(s);
    expect(used).toEqual(['sk-1', 'sk-2', 'sk-1']);
    expect(s.registry.breakers()[0]?.keys?.map((k) => k.state)).toEqual(['active', 'standby']);
    await callOnce(s);
    expect(used.at(-1)).toBe('sk-1');
  });

  it('试探又失败：这次调用照样马上换到下一个 key，下次隔得更久', async () => {
    const { s, used, ok, fail, advance } = twoKeys();
    s.a.setResponses([fail(402, '402 Insufficient Balance'), ok(), fail(402, '402 还是没钱'), ok(), ok()]);
    await callOnce(s);
    advance(40);
    const { message } = await callOnce(s);
    expect(message.stopReason).toBe('stop');
    expect(used).toEqual(['sk-1', 'sk-2', 'sk-1', 'sk-2']);
    advance(79); // 第二次试探要等 80 毫秒：差一毫秒仍用备用 key。
    await callOnce(s);
    expect(used.at(-1)).toBe('sk-2');
    expect(s.registry.breakers()[0]?.keys?.[0]).toMatchObject({ state: 'down', reason: '402 还是没钱' });
    advance(1);
    s.a.setResponses([ok('充值以后')]);
    await callOnce(s);
    expect(used.at(-1)).toBe('sk-1');
  });

  it('熔断以后到点试探、没有别的可换：用不了的 key 不看自己的时间一个个试，有一个通了这家就恢复', async () => {
    // 没有备用模型：保留真实时钟验证排队唤醒；熔断 40 毫秒到点，key 自己要一分钟后才试。
    const { s, used, ok, fail } = twoKeys({ strong: [A1], keyProbeIntervalMs: 60_000, now: Date.now });
    s.a.setResponses([
      fail(402, '402 Insufficient Balance'),
      fail(402, '402 Insufficient Balance'),
      fail(402, '402 还是没钱'),
      ok('第二个账号充值了'),
    ]);
    const { message } = await callOnce(s);
    expect(message).toMatchObject({ stopReason: 'stop', provider: 'faux-a' });
    expect(used).toEqual(['sk-1', 'sk-2', 'sk-1', 'sk-2']);
    expect(s.breaker.isOpen('faux-a')).toBe(false);
    expect(s.registry.breakers()[0]?.keys?.map((k) => k.state)).toEqual(['down', 'active']);
  });

  it('key 都用不了、有备用模型顶着：熔断到点了也只拿到了点的 key 去试，没到点的不去撞', async () => {
    // 熔断 40 毫秒到点，用不了的 key 150 毫秒后才试
    const { s, used, ok, fail, advance } = twoKeys({ keyProbeIntervalMs: 150 });
    const weekly = "403 You've reached your weekly (7-day) usage limit";
    s.a.setResponses([fail(403, weekly), fail(403, weekly), ok('周额度刷新了')]);
    s.b.setResponses([fauxAssistantMessage('备用模型的回答'), fauxAssistantMessage('还是备用模型')]);
    expect((await callOnce(s)).message.provider).toBe('faux-b');
    expect(used).toEqual(['sk-1', 'sk-2']);

    advance(40);
    expect(s.breaker.ready('faux-a')).toBe('due');
    expect((await callOnce(s)).message.provider).toBe('faux-b');
    expect(used).toEqual(['sk-1', 'sk-2']); // 熔断到点了，key 还没到：一个请求都不发
    expect(s.registry.breakers()[0]).toMatchObject({ breaker: 'open', fallbackTo: B1 });

    advance(110);
    const { message } = await callOnce(s);
    expect(message).toMatchObject({ stopReason: 'stop', provider: 'faux-a' }); // 到点的首选去试，通了这家就恢复
    expect(used).toEqual(['sk-1', 'sk-2', 'sk-1']);
    expect(s.breaker.isOpen('faux-a')).toBe(false);
    expect(s.registry.breakers()[0]?.keys?.map((k) => k.state)).toEqual(['active', 'down']);
  });

  it('照常用的 key 这次通了，不去清别的调用刚记下的「用不了」', async () => {
    const { s, used } = twoKeys();
    s.a.setResponses([
      (_ctx, options) => {
        used.push(options?.apiKey);
        s.keyPool.failure('faux-a', K1, '402 Insufficient Balance'); // 在途时别的调用撞上了余额不足
        return fauxAssistantMessage('这次赶上了');
      },
    ]);
    expect((await callOnce(s)).message.stopReason).toBe('stop');
    expect(used).toEqual(['sk-1']);
    expect(s.registry.breakers()[0]?.keys?.map((k) => k.state)).toEqual(['down', 'active']);
  });

  it('人在模型页把用不了的 key 换了：马上用新的', async () => {
    const { s, used, ok, fail } = twoKeys({ probeIntervalMs: 60_000 });
    s.a.setResponses([fail(402, '402 Insufficient Balance'), ok(), ok()]);
    await callOnce(s);
    s.keyLists['faux-a'] = [{ ...K1, key: 'sk-1-new' }, K2];
    await callOnce(s);
    expect(used).toEqual(['sk-1', 'sk-2', 'sk-1-new']);
  });

  it('拿来试探的 key 遇到供应商那边的错：交还试探机会，按重试处理', async () => {
    const { s, used, ok, fail, advance } = twoKeys();
    s.a.setResponses([fail(402, '402 Insufficient Balance'), ok(), fail(503, '503 Service Unavailable'), ok()]);
    await callOnce(s);
    advance(40);
    await callOnce(s);
    expect(used).toEqual(['sk-1', 'sk-2', 'sk-1', 'sk-1']); // 503 后重试还是拿 sk-1 去试，通了
    expect(s.registry.breakers()[0]?.keys?.map((k) => k.state)).toEqual(['active', 'standby']);
  });

  it('试探中的调用被取消：交还 key 的试探机会', async () => {
    const { s, used, ok, fail, advance } = twoKeys();
    s.a.setResponses([fail(402, '402 Insufficient Balance'), ok()]);
    await callOnce(s);
    advance(40);
    const controller = new AbortController();
    s.a.setResponses([
      (ctx, options, state, model) => {
        used.push(options?.apiKey);
        controller.abort();
        return (hang() as Step)(ctx, options, state, model);
      },
    ]);
    const { message } = await callOnce(s, meta(A1, { signal: controller.signal }));
    expect(message.stopReason).toBe('aborted');
    expect(used.at(-1)).toBe('sk-1');
    expect(s.keyPool.pick('faux-a', [K1, K2])).toEqual({ key: K1, probe: true }); // 没卡在 probing
  });
});
