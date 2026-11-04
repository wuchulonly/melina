// 官方 Harness DeepSeek 适配器 + 本地 HTTP 网关，覆盖真实协议而不调用付费 API。
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRoleCallRunner } from '../../../src/agents/episode.ts';
import { resolveGlobalConfig } from '../../../src/core/config.ts';
import { explorerTools } from '../../../src/core/tools.ts';
import { deepseekProvider } from '../../../src/models/builtin.ts';
import { createModelRegistry } from '../../../src/models/registry.ts';
import { createMelinaStream } from '../../../src/models/stream.ts';
import { fakeLedger, fakeScheduler, fakeSession, layoutFor, meta } from './fakes.ts';
import { messagesSse } from './native-fixture.ts';

interface Request {
  path: string;
  key: string | undefined;
  body: Record<string, unknown>;
}
let received: Request[] = [];
let reply: (request: Request, response: ServerResponse) => void;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const request = {
    path: req.url ?? '',
    key: req.headers['x-api-key'] as string | undefined,
    body: JSON.parse(Buffer.concat(chunks).toString()),
  };
  received.push(request);
  reply(request, res);
});
let endpoint: string;
beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

function setup(options: { idle?: number; keys?: string[] } = {}) {
  received = [];
  const native = deepseekProvider();
  const models = native.getModels().map((m) => ({ ...m, baseUrl: endpoint }));
  const provider = { ...native, baseUrl: endpoint, getModels: () => models };
  const ref = { provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' as const };
  const keys = (options.keys ?? ['key-first']).map((key, i) => ({ id: `k${i}`, key }));
  const registry = createModelRegistry({
    providers: [provider],
    source: {
      getModels: () => ({
        providers: [{ provider: 'deepseek', keys: keys.map((k) => ({ id: k.id, hasKey: true })) }],
        fast: [],
        strong: [ref],
      }),
      apiKeys: () => keys,
      global: () => resolveGlobalConfig({ retries: { model: 1 }, model: { idleTimeoutMs: options.idle ?? 2000 } }),
    },
  });
  const ledger = fakeLedger();
  const scheduler = fakeScheduler();
  const stream = createMelinaStream({
    registry,
    ledger: ledger.ledger,
    scheduler: scheduler.scheduler,
    backoff: { baseMs: 1, maxMs: 1 },
    backgroundWaitMs: 30,
  });
  return { registry, ledger, scheduler, stream, ref };
}
function respond(res: ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(body);
}

describe('DeepSeek Harness 原生 Messages', () => {
  it.each([
    { name: 'sh', rawArgs: '{"cmd":"ls"}}', args: { cmd: 'ls' } },
    { name: 'end_episode', rawArgs: '{"handoff":"已验证","notebook":', args: { handoff: '已验证' } },
  ])('真实流的 $name 参数损坏仍交给 repairToolArguments 修复，不重试请求', async ({ name, rawArgs, args }) => {
    const s = setup();
    reply = (_req, res) => respond(res, messagesSse({ tool: { name, rawArgs } }));
    const out = s.stream(meta(s.ref))(s.registry.model(s.ref), {
      messages: [{ role: 'user', content: '调用工具', timestamp: 1 }],
    });
    const message = await out.result();
    expect(message.stopReason).toBe('toolUse');
    expect(message.content).toEqual([{ type: 'toolCall', id: 'call_test', name, arguments: args }]);
    expect(message.errorMessage).toBeUndefined();
    expect(message.failureCode).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(s.ledger.entries).toHaveLength(1);
    expect(s.scheduler.state.inFlight).toBe(0);
  });

  it('无法修复的真实工具参数返回 INVALID_ARGS，模型下一轮可修正', async () => {
    const s = setup();
    const rawArgs = '{"cmd":"unfinished';
    reply = (_req, res) =>
      respond(
        res,
        messagesSse({
          tool:
            received.length === 1
              ? { name: 'sh', rawArgs }
              : received.length === 2
                ? { name: 'sh', args: { cmd: 'ls' } }
                : { name: 'end_episode', args: { handoff: '已验证' } },
        }),
      );
    const session = fakeSession(explorerTools());
    const result = await createRoleCallRunner(s).start({
      meta: meta(s.ref),
      layout: layoutFor(session),
      session,
      closeReminder: '请收尾',
    }).done;
    expect(result.outcome.kind).toBe('closed');
    expect(received).toHaveLength(3);
    const history = JSON.stringify(received[1]?.body.messages);
    expect(history).toContain('tool_result');
    expect(history).toContain('参数不对，没有执行');
    expect(history).toContain('"is_error":true');
    expect(history).toContain('unfinished');
    expect(session.calls.map((call) => call.name)).toEqual(['sh', 'end_episode']);
    expect(s.ledger.entries).toHaveLength(3);
    expect(s.registry.breaker.isOpen('deepseek')).toBe(false);
  });

  it.each(['truncated', 'invalid-event'])('坏工具参数后出现 %s 流错误仍按模型错误处理', async (kind) => {
    const s = setup();
    const body = messagesSse({ tool: { name: 'sh', rawArgs: '{"cmd":"ls"}}' } });
    reply = (_req, res) =>
      respond(
        res,
        body.slice(0, body.indexOf('event: message_stop')) +
          (kind === 'invalid-event' ? 'event: message_stop\ndata: {invalid}\n\n' : ''),
      );
    const out = deepseekProvider().streamSimple(
      s.registry.model(s.ref),
      { messages: [{ role: 'user', content: '调用工具', timestamp: 1 }] },
      { apiKey: 'key-first' },
    );
    const message = await out.result();
    expect(message.stopReason).toBe('error');
    expect(message.failureCode).toBe(kind === 'truncated' ? 'STREAM_CLOSED' : 'MALFORMED_RESPONSE');
    expect(received).toHaveLength(1);
    expect(s.scheduler.state.inFlight).toBe(0);
  });

  it('工具往返保留思考签名，使用原生工具 schema，缓存及成本逐请求记账', async () => {
    const s = setup();
    reply = (_req, res) =>
      respond(
        res,
        messagesSse(
          received.length === 1
            ? { reasoning: true, tool: { name: 'sh', args: { cmd: 'ls' } } }
            : { tool: { name: 'end_episode', args: { handoff: '已经检查目录，继续验证。' } } },
        ),
      );
    const session = fakeSession(explorerTools());
    const result = await createRoleCallRunner(s).start({
      meta: meta(s.ref),
      layout: layoutFor(session),
      session,
      closeReminder: '请收尾',
    }).done;
    expect(result.outcome.kind).toBe('closed');
    expect(received).toHaveLength(2);
    expect(received.every((r) => r.path === '/anthropic/v1/messages' && r.key === 'key-first')).toBe(true);
    expect(received[0]?.body).toMatchObject({ model: 'deepseek-flash', stream: true });
    const history = JSON.stringify(received[1]?.body.messages);
    expect(history).toContain('native-signature-123');
    expect(history).toContain('tool_result');
    expect(history).toContain('call_test');
    expect(session.log).toContain('start sh');
    expect(s.ledger.entries).toHaveLength(2);
    expect(s.ledger.entries[0]?.tokens).toEqual({ input: 100, cacheRead: 40, cacheWrite: 10, output: 20 });
    expect(s.ledger.entries[0]?.usd).toBeCloseTo((100 * 0.3 + 40 * 0.006 + 20 * 1.2) / 1_000_000);
    expect(s.scheduler.state.consumed).toEqual([
      { provider: 'deepseek', tokens: 170 },
      { provider: 'deepseek', tokens: 170 },
    ]);
    expect(s.scheduler.state.inFlight).toBe(0);
  });

  it('401/402 同次换 Key，429 按 Retry-After 重试，记录所有尝试', async () => {
    const s = setup({ keys: ['bad', 'empty', 'usable'] });
    let limited = false;
    reply = (req, res) => {
      const status = req.key === 'bad' ? 401 : req.key === 'empty' ? 402 : !limited ? 429 : 200;
      if (status === 200) return respond(res, messagesSse());
      if (status === 429) limited = true;
      res.writeHead(status, {
        'content-type': 'application/json',
        ...(status === 429 ? { 'retry-after': '0.01' } : {}),
      });
      res.end(
        JSON.stringify({
          error: {
            type: 'error',
            message: status === 401 ? 'Invalid API Key' : status === 402 ? 'Insufficient Balance' : 'rate limit',
          },
        }),
      );
    };
    const out = s.stream(meta(s.ref))(s.registry.model(s.ref), {
      messages: [{ role: 'user', content: 'OK', timestamp: 1 }],
    });
    expect((await out.result()).stopReason).toBe('stop');
    expect(received.map((r) => r.key)).toEqual(['bad', 'empty', 'usable', 'usable']);
    expect(s.ledger.entries).toHaveLength(4);
    expect(s.scheduler.state.throttled).toEqual([{ provider: 'deepseek', status: 429, retryAfterMs: 10 }]);
    expect(s.registry.breakers()[0]?.keys?.map((k) => k.state)).toEqual(['down', 'down', 'active']);
    expect(s.scheduler.state.inFlight).toBe(0);
  });

  it('取消在途流后释放模型名额，关闭会话并停止重试', async () => {
    const s = setup();
    const stop = new AbortController();
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => stop.abort('用户停止'), 10);
    };
    const session = fakeSession(explorerTools());
    const result = await createRoleCallRunner(s).start({
      meta: meta(s.ref, { signal: stop.signal }),
      layout: layoutFor(session),
      session,
      closeReminder: '请收尾',
    }).done;
    expect(result.outcome).toEqual({ kind: 'aborted', reason: '用户停止' });
    expect(received).toHaveLength(1);
    expect(s.scheduler.state.inFlight).toBe(0);
  });

  it('上下文过长按角色失败处理，不重试、不熔断', async () => {
    const s = setup();
    reply = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'prompt is too long: context window exceeded' },
        }),
      );
    };
    const session = fakeSession(explorerTools());
    const result = await createRoleCallRunner(s).start({
      meta: meta(s.ref),
      layout: layoutFor(session),
      session,
      closeReminder: '请收尾',
    }).done;
    expect(result.outcome.kind).toBe('context_overflow');
    expect(received).toHaveLength(1);
    expect(s.registry.breaker.isOpen('deepseek')).toBe(false);
    expect(s.ledger.entries).toHaveLength(1);
  });
});
