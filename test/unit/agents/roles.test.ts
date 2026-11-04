// 挑和作者不同家的模型：纯函数，用一个小的假 registry。
// 巡检器的供应商不可用时，按档位和配置顺序挑选其他供应商的可用模型（differentProviderModel）。

import { describe, expect, it } from 'vitest';
import { differentProviderModel } from '../../../src/agents/watcher.ts';
import { type ModelChoice, type ModelRef, sameModel } from '../../../src/core/model-ref.ts';

const DS_FLASH: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' };
const DS_PRO: ModelRef = { provider: 'deepseek', model: 'deepseek-pro', tier: 'strong' };
const CLAUDE: ModelRef = { provider: 'anthropic', model: 'claude-opus-5-5', tier: 'strong' };
const GPT_MINI: ModelRef = { provider: 'openai', model: 'gpt-mini', tier: 'fast' };

function registry(strong: ModelRef[], fast: ModelRef[], state: { noKey?: string[]; open?: string[] } = {}) {
  const all = [...strong, ...fast];
  return {
    tier: (t: 'fast' | 'strong') => (t === 'strong' ? strong : fast),
    allowed: () => all,
    breakers: () => (state.open ?? []).map((provider) => ({ provider, breaker: 'open' as const })),
    apiKey: (provider: string) => (state.noKey?.includes(provider) ? undefined : 'key'),
    isAllowed: (ref: Pick<ModelRef, 'provider' | 'model'>) =>
      all.some((m) => m.provider === ref.provider && m.model === ref.model),
    resolve: (choice: ModelChoice): ModelRef => {
      if ('provider' in choice) return choice;
      const first = (choice.tier === 'strong' ? strong : fast)[0];
      if (!first) throw new Error('这一档没有模型');
      return first;
    },
  };
}

describe('和作者不同家的模型（differentProviderModel）', () => {
  it('先在 strong 档里找别家的', () => {
    const r = differentProviderModel(registry([DS_PRO, CLAUDE], [DS_FLASH]), DS_PRO);
    expect(r).toEqual({ model: CLAUDE, sameProvider: false });
  });

  it('别家的只在 fast 档里也用：减少共同盲区更要紧', () => {
    const r = differentProviderModel(registry([DS_PRO], [DS_FLASH, GPT_MINI]), DS_FLASH);
    expect(r).toEqual({ model: GPT_MINI, sameProvider: false });
  });

  it('只配了一家：同家的另一个模型，标 sameProvider', () => {
    const r = differentProviderModel(registry([DS_PRO], [DS_FLASH]), DS_FLASH);
    expect(r).toEqual({ model: DS_PRO, sameProvider: true });
  });

  it('只有作者那一个模型：就用它', () => {
    const r = differentProviderModel(registry([DS_FLASH], []), DS_FLASH);
    expect(sameModel(r.model, DS_FLASH)).toBe(true);
    expect(r.sameProvider).toBe(true);
  });

  it('没配 key、正在熔断的供应商往后排：有能用的别家就用它，都不能用再按原来的顺序', () => {
    const three = [DS_PRO, CLAUDE, { provider: 'openai', model: 'gpt-big', tier: 'strong' as const }];
    expect(differentProviderModel(registry(three, [], { noKey: ['anthropic'] }), DS_PRO).model.provider).toBe('openai');
    expect(differentProviderModel(registry(three, [], { open: ['anthropic'] }), DS_PRO).model.provider).toBe('openai');
    // 别家的都不能用：退到同家的另一个模型（能用的），标 sameProvider
    const r = differentProviderModel(registry([DS_PRO, CLAUDE], [DS_FLASH], { noKey: ['anthropic'] }), DS_FLASH);
    expect(r).toEqual({ model: DS_PRO, sameProvider: true });
    // 全都不能用：照原来的偏好
    expect(
      differentProviderModel(registry([DS_PRO, CLAUDE], [], { open: ['deepseek', 'anthropic'] }), DS_PRO).model,
    ).toEqual(CLAUDE);
  });
});
