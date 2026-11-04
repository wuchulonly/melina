// DeepSeek 模型目录的选择、搜索与旧配置提示。

import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '../../test/fixtures/static.ts';
import {
  catalogIssues,
  hostOf,
  lookOf,
  modelBrief,
  priceBrief,
  providerChoices,
  providerHaystack,
  providerLook,
} from '../src/pages/models/catalog.ts';

describe('选择面板：加一家供应商', () => {
  it('仅提供 DeepSeek 官方接口；页面上已有的标「已加」', () => {
    const groups = providerChoices(MODEL_CATALOG, ['deepseek']);
    expect(groups.map((g) => [g.group, g.items.map((i) => i.provider)])).toEqual([['official', ['deepseek']]]);
    const deepseek = groups[0]?.items.find((i) => i.provider === 'deepseek');
    expect(deepseek).toMatchObject({
      name: 'DeepSeek',
      cn: '深度求索',
      host: 'api.deepseek.com',
      models: 2,
      added: true,
    });
    expect(providerChoices(MODEL_CATALOG, [])[0]?.items[0]?.added).toBe(false);
  });

  it('搜索材料包含名字、中文名、域名和模型，统一转为小写', () => {
    const deepseek = MODEL_CATALOG.providers.find((p) => p.provider === 'deepseek');
    if (!deepseek) throw new Error('剧本里该有 DeepSeek');
    const hay = providerHaystack(providerLook(deepseek), deepseek.models);
    for (const term of ['深度求索', 'deepseek', 'api.deepseek.com', 'flash', 'pro']) expect(hay).toContain(term);
  });

  it('展示 DeepSeek 名称与域名；旧配置仍可辨认以便移除', () => {
    expect(
      providerLook({ provider: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic' }),
    ).toEqual({
      provider: 'deepseek',
      name: 'DeepSeek',
      cn: '深度求索',
      host: 'api.deepseek.com',
      group: 'official',
    });
    expect(providerLook({ provider: 'mystery' })).toEqual({ provider: 'mystery', name: 'mystery', group: 'official' });
    expect(
      lookOf(MODEL_CATALOG, {
        provider: 'ark',
        custom: { name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      }),
    ).toEqual({ provider: 'ark', name: '火山方舟', host: 'ark.cn-beijing.volces.com', group: 'custom' });
    expect(hostOf('http://127.0.0.1:8000/v1')).toBe('127.0.0.1:8000');
    expect(hostOf('not a url')).toBeUndefined();
    expect(hostOf('ftp://x.example')).toBeUndefined();
  });
});

describe('选择面板：加模型', () => {
  it('模型简介展示上下文与思考型，价格单独显示输入与输出费用', () => {
    const pro = MODEL_CATALOG.providers.find((p) => p.provider === 'deepseek')?.models[0];
    if (!pro) throw new Error('剧本里该有 deepseek-v4-pro');
    expect(modelBrief(pro)).toBe('上下文 12.8 万 · 思考型');
    expect(priceBrief(pro)).toBe('$0.56 / $1.68');
    expect(modelBrief({ model: 'bare' })).toBe('');
    expect(priceBrief({ model: 'bare' })).toBe('');
    expect(priceBrief({ model: 'x', price: { input: 0.075, output: 15 } })).toBe('$0.075 / $15');
  });
});

describe('配了目录里没有的', () => {
  it('提醒一句（保存时以 Melina 说的为准）；目录没取到不查', () => {
    const draft = {
      providers: [{ provider: 'deepseek' }, { provider: 'no-such' }],
      strong: [{ provider: 'deepseek', model: 'deepseek-v4-pro', tier: 'strong' as const }],
      fast: [
        { provider: 'deepseek', model: 'deepseek-flsh', tier: 'fast' as const },
        { provider: 'no-such', model: 'm', tier: 'fast' as const },
      ],
    };
    const issues = catalogIssues(draft, MODEL_CATALOG);
    expect(issues.every((i) => i.level === 'warn')).toBe(true);
    expect(issues.map((i) => i.text)).toEqual([
      'Melina 能用的模型目录里没有「no-such」这家，保存时会被拒：把它去掉，从「加一家供应商」里重新挑。',
      '模型目录里 deepseek 没有「deepseek-flsh」，保存时会被拒：把它从分档里去掉，用「加模型」重新挑。',
    ]);
    expect(catalogIssues(draft, undefined)).toEqual([]);
  });
});
