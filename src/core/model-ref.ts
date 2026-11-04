// 模型引用、档位选择和显示名称。
// 单独一个文件，是因为 config.ts 和 types.ts 都要用，放哪边都会循环 import。

import Type, { type Static } from 'typebox';
import { Enum, Obj, Str } from './schema.ts';

export const Tier = Enum(['fast', 'strong'], { description: '模型档位：fast 快而便宜，strong 强' });
export type Tier = Static<typeof Tier>;

/** provider、model 用 目录里的 id，例如 { provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' } */
export const ModelRef = Obj(
  {
    provider: Str({ description: '供应商，供应商 id，当前为 deepseek' }),
    model: Str({ description: '模型，DeepSeek 模型 id' }),
    tier: Tier,
  },
  { description: '用哪个模型' },
);
export type ModelRef = Static<typeof ModelRef>;

/**
 * 配置里写模型的方式：具体的模型，或者只写档位（取模型页里那一档的首选， ModelsConfig）。
 * RunManager 建 Run 时把档位换成具体的模型，Run.config 里存的是换完的。
 */
export const ModelChoice = Type.Union([ModelRef, Obj({ tier: Tier })]);
export type ModelChoice = Static<typeof ModelChoice>;

export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** 显示用的模型名，例如 deepseek/deepseek-flash */
export function modelKey(ref: Pick<ModelRef, 'provider' | 'model'>): string {
  return `${ref.provider}/${ref.model}`;
}
