// 运行时的组装（src/api/runtime.ts）：建任务前的检查。整条链路的端到端在 test/integration/m0/。
import { describe, expect, it } from 'vitest';
import { domainInfos, missingKeys } from '../../../src/api/runtime.ts';
import { resolveGlobalConfig } from '../../../src/core/config.ts';
import type { ModelRef, Tier } from '../../../src/core/model-ref.ts';

const ref = (provider: string, model: string, tier: Tier): ModelRef => ({ provider, model, tier });

function registry(
  tiers: Record<Tier, ModelRef[]>,
  keys: Record<string, string>,
  fallback: 'next_in_tier' | 'none' = 'next_in_tier',
) {
  const global = resolveGlobalConfig({ models: { fallback } });
  return { tier: (t: Tier) => tiers[t], apiKey: (p: string) => keys[p], global: () => global };
}

describe('建任务前查 key', () => {
  it('每一档都有带 key 的模型：没问题', () => {
    const r = registry(
      { strong: [ref('deepseek', 'deepseek-flash', 'strong')], fast: [ref('deepseek', 'deepseek-flash', 'fast')] },
      { deepseek: 'sk-x' },
    );
    expect(missingKeys(r)).toEqual([]);
  });

  it('一档的模型都没有 key：说清楚是哪一档、哪几家', () => {
    const r = registry(
      {
        strong: [ref('anthropic', 'claude-x', 'strong'), ref('openai', 'gpt-x', 'strong')],
        fast: [ref('deepseek', 'deepseek-flash', 'fast')],
      },
      { deepseek: 'sk-x' },
    );
    expect(missingKeys(r)).toEqual(['strong 档的模型都没有 API key（anthropic、openai）']);
  });

  it('首选没有 key、备用有：不拦（熔断时会换到备用）；空的档不在这里管（registry.resolve 会报）', () => {
    const r = registry(
      { strong: [ref('anthropic', 'claude-x', 'strong'), ref('deepseek', 'deepseek-flash', 'strong')], fast: [] },
      { deepseek: 'sk-x' },
    );
    expect(missingKeys(r)).toEqual([]);
  });

  it('不许换备用模型（models.fallback 为 none）：首选没 key 就拦，备用有 key 也不算', () => {
    const tiers = {
      strong: [ref('anthropic', 'claude-x', 'strong'), ref('deepseek', 'deepseek-flash', 'strong')],
      fast: [ref('deepseek', 'deepseek-flash', 'fast')],
    };
    expect(missingKeys(registry(tiers, { deepseek: 'sk-x' }, 'none'))).toEqual([
      'strong 档的首选模型没有 API key（anthropic），又不许换备用模型',
    ]);
  });
});

describe('Scoper 看到的领域', () => {
  it('按配置的顺序，描述取 domains/<名字>/description.txt，没有的写空', () => {
    const infos = domainInfos(['general', 'code', 'nope']);
    expect(infos.map((d) => d.name)).toEqual(['general', 'code', 'nope']);
    expect(infos[0]?.description).not.toBe('');
    expect(infos[2]?.description).toBe('');
  });
});
