// 模型配置、分档和备用顺序。
import { describe, expect, it } from 'vitest';
import { ModelCatalogResponse } from '../../../src/core/api.ts';
import { isMelinaError } from '../../../src/core/errors.ts';
import { isValid } from '../../../src/core/validate.ts';
import { builtinProviders } from '../../../src/models/builtin.ts';
import { createModelRegistry } from '../../../src/models/registry.ts';
import { A1, A2, B1, F1, setup } from './fakes.ts';

describe('ModelRegistry', () => {
  it('档位换成那一档的首选；具体的模型原样返回；空档报错', () => {
    const s = setup({ fast: [] });
    expect(s.registry.resolve({ tier: 'strong' })).toEqual(A1);
    expect(s.registry.resolve(B1)).toEqual(B1);
    try {
      s.registry.resolve({ tier: 'fast' });
      expect.unreachable();
    } catch (e) {
      expect(isMelinaError(e) && e.code).toBe('unavailable');
    }
  });

  it('允许列表是两档去重；同一个模型两档都放算两个', () => {
    const s = setup({ strong: [A1, B1, A1], fast: [F1] });
    expect(s.registry.allowed()).toEqual([A1, B1, F1]);
    expect(s.registry.isAllowed({ provider: 'faux-b', model: 'b-1' })).toBe(true);
    expect(s.registry.isAllowed({ provider: 'faux-a', model: 'a-2' })).toBe(false);
  });

  it('备用：同档里的下一个，到底了从头找；跳过同一家、熔断中的、没 key 的', () => {
    const C1 = { provider: 'faux-a', model: 'a-2', tier: 'strong' as const };
    const s = setup({ strong: [A1, C1, B1] });
    expect(s.registry.fallback(A1)).toEqual(B1); // a-2 是同一家，跳过
    expect(s.registry.fallback(B1)).toEqual(A1); // 到底了从头找
    s.breaker.failure('faux-b', '连不上');
    expect(s.registry.fallback(A1)).toBeUndefined();
    s.breaker.reset();
    s.keys['faux-b'] = undefined;
    expect(s.registry.fallback(A1)).toBeUndefined();
  });

  it('fallbacks：按顺序列出所有可以换的（熔断中的也列，melinaStream 到点会去试它）；每家只取第一个', () => {
    const C1 = { provider: 'faux-a', model: 'a-2', tier: 'strong' as const };
    const s = setup({ strong: [A1, C1, B1, { provider: 'faux-b', model: 'b-1', tier: 'strong' }] });
    s.breaker.failure('faux-b', '连不上');
    expect(s.registry.fallbacks(A1)).toEqual([B1]);
    expect(s.registry.fallback(A1)).toBeUndefined();
    expect(setup({ global: { models: { fallback: 'none' } } }).registry.fallbacks(A1)).toEqual([]);
  });

  it('备用：models.fallback 为 none 时不换', () => {
    const s = setup({ global: { models: { fallback: 'none' } } });
    expect(s.registry.fallback(A1)).toBeUndefined();
  });

  it('上下文窗口取 模型目录', () => {
    const s = setup({ contextWindow: 12_345 });
    expect(s.registry.contextWindow(A1)).toBe(12_345);
    expect(s.registry.contextWindow(A2)).toBe(50_000);
    expect(s.registry.contextWindow({ provider: 'nope', model: 'x' })).toBeUndefined();
  });

  it('熔断状态按配置里的供应商列出', () => {
    const s = setup();
    s.breaker.failure('faux-a', '401：API key 无效');
    s.breaker.noteFallback('faux-a', B1);
    expect(s.registry.providers()).toEqual(['faux-a', 'faux-b']);
    expect(s.registry.breakers()).toEqual([
      {
        provider: 'faux-a',
        breaker: 'open',
        reason: '401：API key 无效',
        fallbackTo: B1,
        keys: [{ id: 'key-faux-a', state: 'active' }],
      },
      { provider: 'faux-b', breaker: 'ok', keys: [{ id: 'key-faux-b', state: 'active' }] },
    ]);
  });

  it('每家的 key 按模型页的顺序列出：在用、备用、用不了（带原因）；解不开的算用不了；没配 key 的不列', () => {
    const s = setup({ keys: { 'faux-a': 'key-a' } });
    s.keyLists['faux-a'] = [
      { id: 'k1', name: '公司账号', key: 'sk-1' },
      { id: 'k2', key: 'sk-2' },
      { id: 'k3', name: '备用', key: 'sk-3' },
    ];
    s.keyPool.failure('faux-a', { id: 'k1', key: 'sk-1' }, '402：Insufficient Balance');
    expect(s.registry.breakers()).toEqual([
      {
        provider: 'faux-a',
        breaker: 'ok',
        keys: [
          { id: 'k1', name: '公司账号', state: 'down', reason: '402：Insufficient Balance' },
          { id: 'k2', state: 'active' },
          { id: 'k3', name: '备用', state: 'standby' },
        ],
      },
      { provider: 'faux-b', breaker: 'ok' },
    ]);
    expect(s.registry.apiKey('faux-a')).toBe('sk-1');
  });

  it('模型目录里没有的供应商或模型：抛 invalid', () => {
    const s = setup();
    expect(() => s.registry.model({ provider: 'nope', model: 'x' })).toThrow(/不支持供应商 nope/);
    expect(() => s.registry.model({ provider: 'faux-a', model: 'x' })).toThrow(/没有模型 faux-a\/x/);
    expect(s.registry.model(A1).contextWindow).toBe(20_000);
  });

  it('模型页的配置问题', () => {
    const s = setup();
    expect(s.registry.problems()).toEqual([]);
    expect(
      s.registry.problems({
        providers: [{ provider: 'nope' }],
        strong: [{ provider: 'faux-a', model: 'zzz', tier: 'strong' }, F1],
        fast: [],
      }),
    ).toEqual([
      '不支持供应商 nope；当前仅启用 DeepSeek',
      '模型目录里没有模型 faux-a/zzz',
      'faux-b/b-1 放在 strong 档，tier 却写的是 fast',
      'fast 档还没有模型',
    ]);
    s.keys['faux-b'] = undefined;
    expect(
      s.registry.problems({
        providers: [{ provider: 'faux-a', keys: [{ id: 'key-faux-a', hasKey: true }] }, { provider: 'faux-b' }],
        strong: [A1, B1],
        fast: [F1],
      }),
    ).toEqual(['供应商 faux-b 还没有 API key']);
  });

  it('DeepSeek 原生目录里有 DeepSeek .1 Flash（deepseek-flash，100 万窗口）', () => {
    const registry = createModelRegistry({
      source: {
        getModels: () => ({
          providers: [{ provider: 'deepseek', keys: [{ id: 'k1', hasKey: true }] }],
          strong: [{ provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' }],
          fast: [{ provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' }],
        }),
        apiKeys: () => [{ id: 'k1', key: 'sk-test' }],
        global: () => setup().global,
      },
      providers: builtinProviders(),
    });
    const model = registry.model({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(model).toMatchObject({ api: 'deepseek-messages', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 });
    expect(registry.problems()).toEqual([]);
  });

  it('模型目录（GET /models/catalog）：每家的对话模型、上下文、最大输出、是不是思考型；hasKey 看有没有能用的 key', () => {
    const s = setup({ keys: { 'faux-a': 'key-a' } });
    const catalog = s.registry.catalog();
    expect(isValid(ModelCatalogResponse, catalog)).toBe(true);
    expect(catalog.providers.map((p) => [p.provider, p.hasKey])).toEqual([
      ['faux-a', true],
      ['faux-b', false],
    ]);
    // 名字和 id 一样就不重复写；价格是 0（未知）就不写
    expect(catalog.providers[0]?.models).toEqual([
      { model: 'a-1', contextWindow: 20_000, maxOutput: 16_384, reasoning: true },
      { model: 'a-2', contextWindow: 50_000, maxOutput: 16_384, reasoning: false },
    ]);
  });

  it('只注册 DeepSeek；旧供应商和自定义接口存配置时明确拒绝', () => {
    const registry = createModelRegistry({
      providers: builtinProviders(),
      source: {
        getModels: () => ({ providers: [], strong: [], fast: [] }),
        apiKeys: () => [],
        global: () => setup().global,
      },
    });
    expect(registry.catalog().providers.map((p) => p.provider)).toEqual(['deepseek']);
    expect(registry.catalog().providers[0]).toMatchObject({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
    });
    expect(registry.provider('openai')).toBeUndefined();
    expect(registry.unusable({ providers: [{ provider: 'openai' }], strong: [], fast: [] })).toEqual([
      '不支持供应商 openai；当前仅启用 DeepSeek',
    ]);
    expect(
      registry.unusable({
        providers: [
          {
            provider: 'deepseek',
            custom: { api: 'anthropic-messages', baseUrl: 'https://another.invalid', models: [] },
          },
        ],
        strong: [],
        fast: [],
      })[0],
    ).toContain('不再支持自定义供应商');
  });

  it('模型目录用 DeepSeek 原生：价格是每百万 token 的美元，和 pi 的 cost 同一个口径', () => {
    const registry = createModelRegistry({
      source: {
        getModels: () => ({ providers: [], strong: [], fast: [] }),
        apiKeys: () => [],
        global: () => setup().global,
      },
      providers: builtinProviders(),
    });
    const catalog = registry.catalog();
    expect(isValid(ModelCatalogResponse, catalog)).toBe(true);
    expect(catalog.providers.every((p) => !p.hasKey && p.models.length > 0)).toBe(true);
    const pi = registry.model({ provider: 'deepseek', model: 'deepseek-flash' });
    const flash = catalog.providers
      .find((p) => p.provider === 'deepseek')
      ?.models.find((m) => m.model === 'deepseek-flash');
    expect(flash).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_000_000,
      maxOutput: pi.maxTokens,
      reasoning: pi.reasoning,
      price: { input: pi.cost.input, output: pi.cost.output },
    });
  });
});
