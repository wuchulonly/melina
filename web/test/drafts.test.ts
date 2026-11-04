// 模型页、设置页保存前的三方合并（pages/models/draft.ts、pages/settings/draft.ts）：
// 页面打开以后别处（另一个标签页、API）改过的，不被这次保存盖掉。

import { describe, expect, it } from 'vitest';
import type { CustomProvider } from '../../src/core/config.ts';
import {
  draftFrom,
  type KeyDraft,
  keysVoided,
  type ModelsDraft,
  mergeModels,
  type ProviderDraft,
  problems,
  toConfig,
  willHaveKey,
} from '../src/pages/models/draft.ts';
import { type CredentialDraft, mergeCredentials, toCredentials } from '../src/pages/settings/draft.ts';

const cred = (id: string, name: string, extra: Partial<CredentialDraft> = {}): CredentialDraft => ({
  id,
  name,
  as: { env: name.toUpperCase() },
  hasValue: true,
  local: id,
  ...extra,
});

describe('凭证的三方合并', () => {
  const base = [cred('A', 'a'), cred('B', 'b')];

  it('别处新加的留下，这里没动的取最新的', () => {
    const fresh = [cred('A', 'a', { hasValue: false }), cred('B', 'b'), cred('C', 'c')];
    const merged = mergeCredentials(base, base, fresh);
    expect(merged.map((c) => c.id)).toEqual(['A', 'B', 'C']);
    expect(merged[0]?.hasValue).toBe(false);
  });

  it('这里删掉的照删，这里新加的留着，这里改的值带上', () => {
    const draft = [
      cred('A', 'a', { newValue: 'v2' }),
      { name: 'n', as: { env: 'N' }, hasValue: false, newValue: 'x', local: 'new' },
    ];
    const fresh = [cred('A', 'a'), cred('B', 'b'), cred('C', 'c')];
    const merged = mergeCredentials(base, draft, fresh);
    expect(merged.map((c) => c.id ?? c.name)).toEqual(['A', 'n', 'C']);
    expect(toCredentials(merged)[0]).toEqual({ id: 'A', name: 'a', as: { env: 'A' }, value: 'v2' });
  });

  it('别处删掉的：这里没动就跟着删；这里改过就当新的一条加回去', () => {
    const fresh = [cred('B', 'b')];
    expect(mergeCredentials(base, base, fresh).map((c) => c.id)).toEqual(['B']);
    const draft = [cred('A', 'a', { newValue: 'kept' }), cred('B', 'b')];
    const merged = mergeCredentials(base, draft, fresh);
    expect(merged[0]).toMatchObject({ name: 'a', newValue: 'kept', hasValue: false });
    expect(merged[0]?.id).toBeUndefined();
  });
});

const ref = (provider: string, model: string, tier: 'strong' | 'fast' = 'strong') => ({ provider, model, tier });

describe('模型的三方合并', () => {
  const deepseek = { provider: 'deepseek', keys: [{ ref: 'K1', id: 'K1', hasKey: true }] };
  const anthropic = { provider: 'anthropic', keys: [{ ref: 'K2', id: 'K2', hasKey: true }] };
  const pro = ref('deepseek', 'v4-pro');
  const opus = ref('anthropic', 'opus');
  const flash = ref('deepseek', 'flash', 'fast');
  const base: ModelsDraft = { providers: [deepseek, anthropic], strong: [pro, opus], fast: [flash] };

  it('别处加了一家、改了一档：这里只调了另一档的顺序，两边都留下', () => {
    const fresh: ModelsDraft = {
      providers: [deepseek, anthropic, { provider: 'openai', keys: [{ ref: 'K3', id: 'K3', hasKey: true }] }],
      strong: [pro, opus],
      fast: [flash, ref('openai', 'mini', 'fast')],
    };
    const draft: ModelsDraft = { ...base, strong: [opus, pro] };
    const merged = mergeModels(base, draft, fresh);
    expect(merged.providers.map((p) => p.provider)).toEqual(['deepseek', 'anthropic', 'openai']);
    expect(merged.strong.map((m) => m.model)).toEqual(['opus', 'v4-pro']);
    expect(merged.fast.map((m) => m.model)).toEqual(['flash', 'mini']);
  });

  it('别处删了一家：这里没动就跟着删，它的模型也从这里改过的档里去掉', () => {
    const fresh: ModelsDraft = { providers: [deepseek], strong: [pro], fast: [flash] };
    const draft: ModelsDraft = { ...base, strong: [opus, pro] };
    const merged = mergeModels(base, draft, fresh);
    expect(merged.providers.map((p) => p.provider)).toEqual(['deepseek']);
    expect(merged.strong.map((m) => m.model)).toEqual(['v4-pro']);
  });

  it('这里换的 key 带上，hasKey 取最新的', () => {
    const fresh: ModelsDraft = {
      ...base,
      providers: [{ provider: 'deepseek', keys: [{ ref: 'K1', id: 'K1', hasKey: false }] }, anthropic],
    };
    const draft: ModelsDraft = {
      ...base,
      providers: [{ provider: 'deepseek', keys: [{ ref: 'K1', id: 'K1', hasKey: true, newKey: 'sk-1' }] }, anthropic],
    };
    const merged = mergeModels(base, draft, fresh);
    expect(merged.providers[0]).toEqual({
      provider: 'deepseek',
      keys: [{ ref: 'K1', id: 'K1', hasKey: false, newKey: 'sk-1' }],
    });
  });

  it('这里没动的那家取最新的 key 列表（别处加了备用 key）', () => {
    const backup = { ref: 'K9', id: 'K9', name: '个人账号', hasKey: true };
    const fresh: ModelsDraft = {
      ...base,
      providers: [{ provider: 'deepseek', keys: [...deepseek.keys, backup] }, anthropic],
    };
    const draft: ModelsDraft = { ...base, strong: [opus, pro] };
    expect(mergeModels(base, draft, fresh).providers[0]?.keys).toEqual([...deepseek.keys, backup]);
  });

  it('这里改过的那家：别处删掉的 key 没重填就不带，重填了当新加的', () => {
    const fresh: ModelsDraft = { ...base, providers: [{ provider: 'deepseek', keys: [] }, anthropic] };
    const extra = { ref: 'new-1', hasKey: false, newKey: 'sk-new' };
    const draft: ModelsDraft = {
      ...base,
      providers: [{ provider: 'deepseek', keys: [...deepseek.keys, extra] }, anthropic],
    };
    expect(mergeModels(base, draft, fresh).providers[0]?.keys).toEqual([extra]);
    const refilled: ModelsDraft = {
      ...base,
      providers: [
        { provider: 'deepseek', keys: [{ ref: 'K1', id: 'K1', hasKey: true, newKey: 'sk-again' }] },
        anthropic,
      ],
    };
    expect(mergeModels(base, refilled, fresh).providers[0]?.keys).toEqual([
      { ref: 'K1', hasKey: false, newKey: 'sk-again' },
    ]);
  });
});

describe('模型页的 key 草稿（§12「一家配几个 key」）', () => {
  const config = {
    providers: [
      {
        provider: 'deepseek',
        keys: [
          { id: 'K1', name: '公司账号', hasKey: true },
          { id: 'K2', hasKey: true },
        ],
      },
    ],
    strong: [ref('deepseek', 'flash')],
    fast: [ref('deepseek', 'flash', 'fast')],
  };

  it('PUT 时每家的 key 整份带上：原有的只带 id 和名字，新填的带值，顺序照页面上的', () => {
    const d = draftFrom(config);
    const [k1, k2] = d.providers[0]?.keys ?? [];
    if (!k1 || !k2) throw new Error('缺 key');
    const edited: ModelsDraft = {
      ...d,
      providers: [
        {
          provider: 'deepseek',
          keys: [{ ...k2, newKey: 'sk-2' }, k1, { ref: 'new-x', hasKey: false, name: ' 备用 ', newKey: 'sk-3' }],
        },
      ],
    };
    expect(toConfig(edited).providers).toEqual([
      {
        provider: 'deepseek',
        keys: [
          { id: 'K2', key: 'sk-2' },
          { id: 'K1', name: '公司账号' },
          { name: '备用', key: 'sk-3' },
        ],
      },
    ]);
  });

  it('新加的 key 没填值不让存；同一个值填两次也不让存；一个能用的都没有就提醒', () => {
    const d = draftFrom(config);
    const p = d.providers[0];
    if (!p) throw new Error('缺供应商');
    const blank = { ...d, providers: [{ ...p, keys: [...p.keys, { ref: 'new-y', hasKey: false }] }] };
    expect(
      problems(blank)
        .filter((x) => x.level === 'error')
        .map((x) => x.text),
    ).toEqual(['deepseek 新加的 API key（第 3 个）还没填值：填上，或者把它去掉。']);
    const twice = {
      ...d,
      providers: [
        {
          ...p,
          keys: [
            { ref: 'a', hasKey: false, newKey: 'sk-same' },
            { ref: 'b', hasKey: false, newKey: 'sk-same' },
          ],
        },
      ],
    };
    expect(problems(twice).some((x) => x.text.includes('同一个'))).toBe(true);
    const none = { ...d, providers: [{ ...p, keys: [] }] };
    expect(willHaveKey(none.providers[0] as (typeof none.providers)[number])).toBe(false);
    expect(problems(none).map((x) => x.text)).toContain('deepseek 还没有 API key，用它的调用会失败。');
  });
});

describe('自定义供应商的草稿（§12）', () => {
  const ark: CustomProvider = {
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    api: 'openai-completions',
    models: [{ model: 'doubao-pro', contextWindow: 256_000 }],
  };
  const config = {
    providers: [{ provider: 'ark', custom: ark, keys: [{ id: 'K1', hasKey: true }] }],
    strong: [ref('ark', 'doubao-pro')],
    fast: [],
  };

  it('接口和模型原样进草稿、原样 PUT；前后空格去掉，空的名字不带', () => {
    const d = draftFrom(config);
    expect(d.providers[0]?.custom).toEqual(ark);
    const p = d.providers[0];
    if (!p?.custom) throw new Error('缺自定义供应商');
    const edited: ModelsDraft = {
      ...d,
      providers: [
        {
          ...p,
          custom: {
            ...p.custom,
            name: '  ',
            baseUrl: ' https://ark.cn-beijing.volces.com/api/v3 ',
            models: [{ model: ' doubao-pro ', name: ' 豆包 ' }],
          },
        },
      ],
    };
    expect(toConfig(edited).providers[0]?.custom).toEqual({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      api: 'openai-completions',
      models: [{ model: 'doubao-pro', name: '豆包' }],
    });
  });

  it('没填好的不让存：地址空着或不像网址（key 写进地址也算）、模型没名字、同一个模型写两次', () => {
    const d = draftFrom(config);
    const p = d.providers[0];
    if (!p?.custom) throw new Error('缺自定义供应商');
    const with_ = (custom: CustomProvider) => ({ ...d, providers: [{ ...p, custom }] });
    const errors = (x: ModelsDraft) =>
      problems(x)
        .filter((i) => i.level === 'error')
        .map((i) => i.text);
    expect(errors(with_({ ...ark, baseUrl: '' }))).toEqual(['自定义的「火山方舟」还没填接口地址。']);
    expect(errors(with_({ ...ark, baseUrl: 'https://user:sk@ark.example/v1' }))[0]).toContain('不像一个网址');
    expect(errors(with_({ ...ark, models: [{ model: 'a' }, { model: ' ' }, { model: 'a' }] }))).toEqual([
      '自定义的「火山方舟」有模型还没写名字。',
      '自定义的「火山方舟」的模型 a 写了两次。',
    ]);
    expect(errors(d)).toEqual([]);
    // http 不拦，只提醒（本机的不提醒）
    const warns = (x: ModelsDraft) =>
      problems(x)
        .filter((i) => i.level === 'warn')
        .map((i) => i.text);
    expect(warns(with_({ ...ark, baseUrl: 'http://10.0.0.5:8000/v1' }))).toContain(
      '自定义的「火山方舟」用的是 http：API key 和对话内容都不加密地发出去，只在本机或信得过的内网这样用。',
    );
    expect(warns(with_({ ...ark, baseUrl: 'http://127.0.0.1:8000/v1' })).some((t) => t.includes('http'))).toBe(false);
    expect(errors(with_({ ...ark, baseUrl: 'http://10.0.0.5:8000/v1' }))).toEqual([]);
  });

  it('三方合并：这里改过接口的那家算改过，用这里的；别处改的接口、这里没动就取最新的', () => {
    const base = draftFrom(config);
    const p = base.providers[0];
    if (!p?.custom) throw new Error('缺自定义供应商');
    const freshCustom = { ...ark, models: [...ark.models, { model: 'doubao-lite' }] };
    const fresh: ModelsDraft = { ...base, providers: [{ ...p, custom: freshCustom }] };
    expect(mergeModels(base, base, fresh).providers[0]?.custom).toEqual(freshCustom);
    const mine = { ...ark, baseUrl: 'https://ark.cn-shanghai.volces.com/api/v3' };
    const draft: ModelsDraft = { ...base, providers: [{ ...p, custom: mine }] };
    expect(mergeModels(base, draft, fresh).providers[0]?.custom).toEqual(mine);
  });

  it('接口地址换了域名、端口或协议：存过的 key 保存时作废，没重新填的不算有 key，保存前提醒；只改路径不算', () => {
    const d = draftFrom(config);
    const p = d.providers[0];
    if (!p?.custom) throw new Error('缺自定义供应商');
    expect(p.savedBaseUrl).toBe(ark.baseUrl);
    expect(toConfig(d).providers[0]).not.toHaveProperty('savedBaseUrl');
    const at = (baseUrl: string, keys: KeyDraft[] = p.keys): ProviderDraft => ({
      ...p,
      custom: { ...ark, baseUrl },
      keys,
    });
    // 只改路径、写明默认端口、域名换大小写：不算换
    for (const url of [
      'https://ark.cn-beijing.volces.com/api/v4',
      'https://ark.cn-beijing.volces.com:443/api/v3',
      'https://ARK.cn-beijing.volces.com/api/v3',
    ]) {
      expect(keysVoided(at(url))).toBe(false);
      expect(willHaveKey(at(url))).toBe(true);
    }
    // 换了域名、端口、协议都算；还没打完、不像网址的不算（那时另有报错挡着不让存）
    for (const url of [
      'https://ark.cn-shanghai.volces.com/api/v3',
      'https://ark.cn-beijing.volces.com:8443/api/v3',
      'http://ark.cn-beijing.volces.com/api/v3',
    ])
      expect(keysVoided(at(url))).toBe(true);
    expect(keysVoided(at('https://'))).toBe(false);
    // 新加的自定义供应商（没存过）不算
    expect(keysVoided({ provider: 'mine', custom: ark, keys: [] })).toBe(false);

    const warns = (x: ProviderDraft) =>
      problems({ ...d, providers: [x], fast: [ref('ark', 'doubao-pro', 'fast')] })
        .filter((i) => i.level === 'warn')
        .map((i) => i.text);
    const moved = at('https://evil.example.com/v1');
    expect(willHaveKey(moved)).toBe(false);
    expect(warns(moved)).toEqual([
      '自定义的「火山方舟」换了接口地址的域名、端口或协议：原来存的 key 保存时作废，不会发到新地址；重新填一个，不然用它的调用会失败。',
    ]);
    // 重新填了一个：算有 key；另一个没重填的照样提醒
    const refilled = at('https://evil.example.com/v1', [
      { ref: 'K1', id: 'K1', hasKey: true, newKey: 'sk-new' },
      { ref: 'K2', id: 'K2', hasKey: true },
    ]);
    expect(willHaveKey(refilled)).toBe(true);
    expect(warns(refilled)).toEqual([
      '自定义的「火山方舟」换了接口地址的域名、端口或协议：没重新填的 key 保存时作废，不会发到新地址。',
    ]);
    // 全都重填了：不再提醒
    expect(warns(at('https://evil.example.com/v1', [{ ref: 'K1', id: 'K1', hasKey: true, newKey: 'sk-new' }]))).toEqual(
      [],
    );
  });
});
