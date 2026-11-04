// 真模型冒烟测试：一次工具调用来回、一次提交工具。只在配了 key 时跑：
//   DEEPSEEK_API_KEY → deepseek/deepseek-flash
// 换模型：MELINA_SMOKE_MODELS="deepseek/deepseek-flash,deepseek/deepseek-v4-pro"。
// 跑：pnpm test:integration test/integration/models/smoke.test.ts
// 每个测试打一行「[冒烟] …」：发了几次请求、各自的状态码、哪些工具开着 strict 发出去、melinaStream 记了什么（重试、关严格模式、熔断）。
// 各家出错时的样子另用 test/dev/provider-errors.ts 看。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoleCallRunner } from '../../../src/agents/episode.ts';
import { resolveGlobalConfig } from '../../../src/core/config.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import { scoperTools, TOOL, TOOL_SPECS } from '../../../src/core/tools.ts';
import { ScoperOutput } from '../../../src/core/types.ts';
import { isValid } from '../../../src/core/validate.ts';
import { builtinProviders } from '../../../src/models/builtin.ts';
import { createModelRegistry } from '../../../src/models/registry.ts';
import { createMelinaStream } from '../../../src/models/stream.ts';
import { fakeLedger, fakeScheduler, fakeSession, meta } from '../../unit/models/fakes.ts';

const DEFAULTS: Record<string, { model: string; env: string }> = {
  deepseek: { model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
};

function targets(): { ref: ModelRef; key: string | undefined }[] {
  const listed = process.env.MELINA_SMOKE_MODELS;
  const pairs = listed
    ? listed.split(',').map((s) => s.trim().split('/') as [string, string])
    : Object.entries(DEFAULTS).map(([p, d]) => [p, d.model] as [string, string]);
  return pairs.map(([provider, model]) => ({
    ref: { provider, model, tier: 'strong' },
    key: process.env[DEFAULTS[provider]?.env ?? `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`],
  }));
}

/** 发出去的每次请求：状态码、开着 strict 的工具（看供应商收不收严格模式的 schema） */
interface Request {
  status: number | string;
  strict: string[];
}

let requests: Request[] = [];
const realFetch = globalThis.fetch;

// melinaStream 的自定义 fetch 每次请求现取 globalThis.fetch，在这里记一笔再放行
beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request: Request = { status: '没响应', strict: strictTools(init?.body) };
    requests.push(request);
    const response = await realFetch(input, init);
    request.status = response.status;
    return response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 请求体里的工具：OpenAI 系是 { function: { name, strict } }，Anthropic 系是 { name, strict } */
interface ToolJson {
  name?: string;
  strict?: boolean;
  function?: { name?: string; strict?: boolean };
}

function strictTools(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  try {
    const tools = (JSON.parse(body) as { tools?: ToolJson[] }).tools ?? [];
    return tools.flatMap((t) => {
      const name = t.function?.name ?? t.name;
      return (t.function?.strict ?? t.strict) === true && name ? [name] : [];
    });
  } catch {
    return [];
  }
}

function harness(ref: ModelRef, key: string) {
  const registry = createModelRegistry({
    source: {
      getModels: () => ({
        providers: [{ provider: ref.provider, keys: [{ id: 'k1', hasKey: true }] }],
        strong: [ref],
        fast: [],
      }),
      apiKeys: () => [{ id: 'k1', key }],
      global: () => resolveGlobalConfig({ retries: { model: 2 } }),
    },
    providers: builtinProviders(),
  });
  const ledger = fakeLedger();
  const notices: string[] = [];
  const stream = createMelinaStream({
    registry,
    scheduler: fakeScheduler().scheduler,
    ledger: ledger.ledger,
    onNotice: (text) => notices.push(text),
  });
  const report = (what: string) => {
    const statuses = requests.map((r) => r.status).join('、');
    const strict = [...new Set(requests.flatMap((r) => r.strict))].join('、') || '没有';
    console.info(
      `[冒烟] ${ref.provider}/${ref.model} ${what}：请求 ${requests.length} 次（${statuses}），开着 strict 的工具：${strict}；` +
        `melinaStream 记的：${notices.length > 0 ? notices.join('；') : '没有'}`,
    );
  };
  return { runner: createRoleCallRunner({ stream, registry }), ledger, report };
}

for (const { ref, key } of targets()) {
  describe.skipIf(!key)(`真模型 ${ref.provider}/${ref.model}`, () => {
    it('一次工具调用来回，再用收尾工具结束', { timeout: 300_000 }, async () => {
      const { runner, ledger, report } = harness(ref, key as string);
      const session = fakeSession([TOOL_SPECS.sh, TOOL_SPECS.endEpisode], {
        impl: {
          sh: () => ({
            content: '{"observationId":"01JAAAAAAAAAAAAAAAAAAAAAAA","summary":"退出码 0：hello"}',
            isError: false,
          }),
        },
      });
      const r = await runner.start({
        meta: meta(ref),
        layout: {
          role: 'explorer',
          system: '你在做 Melina 的冒烟测试。严格按用户的步骤调用工具，不要多做别的。',
          tools: session.tools.map((t) => t.spec),
          messages: [
            {
              role: 'user',
              text:
                '第一步：用 sh 工具执行 echo hello。\n' +
                '第二步：看到输出后，单独调用 end_episode，handoff 填 "冒烟测试做完了"。',
            },
          ],
          basedOnSeq: 1,
        },
        session,
        closeReminder: '请单独调用 end_episode 收尾。',
      }).done;
      report('工具来回');
      expect(r.outcome.kind, JSON.stringify(r.outcome)).toBe('closed');
      expect(session.calls.map((c) => c.name)).toContain(TOOL.sh);
      expect(session.calls.at(-1)?.name).toBe(TOOL.endEpisode);
      expect(ledger.entries.length).toBeGreaterThanOrEqual(2);
      expect(r.usage.input + r.usage.cacheRead).toBeGreaterThan(0);
    });

    it('提交工具（开严格模式的 submit_completion）交回合格的结构化输出', { timeout: 300_000 }, async () => {
      const { runner, report } = harness(ref, key as string);
      const session = fakeSession(scoperTools());
      const r = await runner.start({
        meta: meta(ref, { role: 'scoper', job: 'scoper_call', sessionId: 'smoke' }),
        layout: {
          role: 'scoper',
          system: '你是 Melina 的 Scoper。不要调用 sh 和 read，直接调用 submit_completion 提交。',
          tools: session.tools.map((t) => t.spec),
          messages: [{ role: 'user', text: '目标：让这个仓库的 npm test 全部通过。领域选 code，setup 写 npm ci。' }],
          basedOnSeq: 1,
        },
        session,
        closeReminder: '请调用 submit_completion 提交。',
      }).done;
      report('提交工具');
      expect(r.outcome.kind, JSON.stringify(r.outcome)).toBe('closed');
      const args = r.outcome.kind === 'closed' ? r.outcome.args : undefined;
      expect(isValid(ScoperOutput, args), JSON.stringify(args)).toBe(true);
    });
  });
}

it('没配任何 key 时，上面的测试都跳过', () => {
  expect(targets().length).toBeGreaterThan(0);
});
