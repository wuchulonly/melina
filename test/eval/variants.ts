import { readFileSync } from 'node:fs';
import type { Static } from 'typebox';
import { RunConfigOverride } from '../../src/core/config.ts';
import type { ModelRef } from '../../src/core/model-ref.ts';
import { Arr, Bool, Obj, Opt, Str } from '../../src/core/schema.ts';
import { check } from '../../src/core/validate.ts';

export const Variant = Obj({
  name: Str({ pattern: '^[a-z0-9][a-z0-9_-]*$' }), // 表格和存档目录里用
  title: Str(), // 给人看的名字
  question: Opt(Str()), // 它回答什么问题
  config: Opt(RunConfigOverride),
  scoper: Opt(Bool()), // true：不传固定的完成标准和领域，由 Scoper 起草；传了的时候 Scoper 也照样调，只是完成标准照给的用
});
// RunConfigOverride 的 schema 推不出精确的类型（core 里也是分开写的），config 这一项用 core 的类型
export type Variant = Omit<Static<typeof Variant>, 'config'> & { config?: RunConfigOverride };

export const BUILTIN_VARIANTS: readonly Variant[] = [
  { name: 'melina', title: 'Melina 三路直解与摘要接力', question: '整体成功率、耗时及用量' },
  { name: 'melina-scoper', title: 'Scoper 起草完成标准', scoper: true },
  { name: 'melina-nowatch', title: '关闭旁观者', config: { watch: { enabled: false } } },
  { name: 'melina-no-continuation', title: '关闭摘要接力', config: { continuation: { enabled: false } } },
];
export function singleBet0(model: ModelRef): Variant {
  return { name: 'melina-bet0-single', title: `单路直解（${model.model}）`, config: { bet0: { models: [model] } } };
}

/** JSON 文件：变体的数组，格式同 Variant */
export function loadVariants(path: string): Variant[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return check(Arr(Variant), parsed, `${path} 里的变体`) as Variant[];
}

/** 按名字挑，名字在内置的和文件里的都找；文件里的同名覆盖内置的 */
export function pickVariants(names: string, extra: readonly Variant[] = []): Variant[] {
  const all = new Map<string, Variant>();
  for (const v of [...BUILTIN_VARIANTS, ...extra]) all.set(v.name, v);
  const picked: Variant[] = [];
  for (const name of names
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const v = all.get(name);
    if (!v) throw new Error(`没有这个变体：${name}（有：${[...all.keys()].join('、')}）`);
    picked.push(v);
  }
  if (picked.length === 0) throw new Error('没指定变体');
  return picked;
}
