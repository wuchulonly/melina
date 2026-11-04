// DeepSeek 模型目录（GET /models/catalog），供模型页的选择面板使用。
// 旧配置的自定义供应商仍可显示名称，方便移除。

import type { ModelCatalogResponse } from '../../../../src/core/api.ts';
import type { CustomProvider } from '../../../../src/core/config.ts';
import type { ModelRef } from '../../../../src/core/model-ref.ts';
import { formatTokens } from '../../lib/format.ts';
import type { DraftProblem } from './draft.ts';

export type CatalogProvider = ModelCatalogResponse['providers'][number];
export type CatalogModel = CatalogProvider['models'][number];

export type ProviderGroup = 'official' | 'custom';

export const GROUP_TITLES: Readonly<Record<ProviderGroup, string>> = {
  official: '官方接口',
  custom: '自定义',
};

/** 一家供应商给人看的样子 */
export interface ProviderLook {
  provider: string;
  /** 目录里的名字（旧自定义配置用保存的名称）；都没有就是 id */
  name: string;
  /** 中文名 */
  cn?: string;
  /** 接口的域名（带非默认端口），从 baseUrl 取 */
  host?: string;
  group: ProviderGroup;
}

/** 接口地址的域名：https://open.bigmodel.cn/api/coding/paas/v4 → open.bigmodel.cn；不像网址的是 undefined */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : undefined;
  } catch {
    return undefined;
  }
}

export function providerLook(p: Pick<CatalogProvider, 'provider' | 'name' | 'baseUrl' | 'custom'>): ProviderLook {
  const cn = p.provider === 'deepseek' ? '深度求索' : undefined;
  const host = hostOf(p.baseUrl);
  return {
    provider: p.provider,
    name: p.name?.trim() || p.provider,
    ...(cn ? { cn } : {}),
    ...(host ? { host } : {}),
    group: p.custom ? 'custom' : 'official',
  };
}

/** 模型页上一家供应商怎么叫：目录里有就用目录的，草稿里的自定义供应商用人填的名字，都没有就是 id */
export function lookOf(
  catalog: ModelCatalogResponse | undefined,
  p: { provider: string; custom?: Pick<CustomProvider, 'name' | 'baseUrl'> },
): ProviderLook {
  if (p.custom) return providerLook({ provider: p.provider, ...p.custom, custom: true });
  const listed = catalog?.providers.find((x) => x.provider === p.provider);
  return providerLook(listed ?? { provider: p.provider });
}

/** 每百万 token 的美元：$15 · $0.56 · $0.075 */
function usd(n: number): string {
  return `$${Number(n.toFixed(n >= 0.1 ? 2 : 3))}`;
}

/** 加模型面板里每个模型下面那行：上下文、是不是思考型（价格放在右边，见 priceBrief） */
export function modelBrief(m: CatalogModel): string {
  const parts: string[] = [];
  if (m.contextWindow) parts.push(`上下文 ${formatTokens(m.contextWindow)}`);
  if (m.reasoning) parts.push('思考型');
  return parts.join(' · ');
}

/** 「$0.56 / $1.68」：每百万 token 输入 / 输出的美元；不知道价格是空串 */
export function priceBrief(m: CatalogModel): string {
  return m.price ? `${usd(m.price.input)} / ${usd(m.price.output)}` : '';
}

/** 搜索用的一串字：id、名字、中文名、域名，加上这家每个模型的 id 和名字 */
export function providerHaystack(look: ProviderLook, models: readonly CatalogModel[]): string {
  return [look.provider, look.name, look.cn, look.host, ...models.flatMap((m) => [m.model, m.name])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 「加一家供应商」面板里的一家 */
export interface ProviderChoice extends ProviderLook {
  models: number;
  /** 模型页上已经有这家了 */
  added: boolean;
  haystack: string;
}

/** 「加一家供应商」面板只提供 DeepSeek 官方接口。 */
export function providerChoices(
  catalog: ModelCatalogResponse,
  added: readonly string[],
): { group: Exclude<ProviderGroup, 'custom'>; items: ProviderChoice[] }[] {
  const items = catalog.providers
    .filter((p) => p.provider === 'deepseek' && !p.custom)
    .map((p) => {
      const look = providerLook(p);
      return {
        ...look,
        models: p.models.length,
        added: added.includes(p.provider),
        haystack: providerHaystack(look, p.models),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return [{ group: 'official', items }];
}

/**
 * 页面上配的供应商、模型有哪些不在目录里：提醒移除旧配置或重新选择模型；目录没取到不查。
 */
export function catalogIssues(
  d: { providers: readonly { provider: string }[]; strong: readonly ModelRef[]; fast: readonly ModelRef[] },
  catalog: ModelCatalogResponse | undefined,
): DraftProblem[] {
  if (!catalog) return [];
  const known = new Map(catalog.providers.map((p) => [p.provider, new Set(p.models.map((m) => m.model))]));
  const out: DraftProblem[] = [];
  for (const p of d.providers)
    if (p.provider && !known.has(p.provider))
      out.push({
        level: 'warn',
        text: `Melina 能用的模型目录里没有「${p.provider}」这家，保存时会被拒：把它去掉，从「加一家供应商」里重新挑。`,
      });
  const seen = new Set<string>();
  for (const m of [...d.strong, ...d.fast]) {
    const models = known.get(m.provider);
    const key = `${m.provider}/${m.model}`;
    if (!models || models.has(m.model) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      level: 'warn',
      text: `模型目录里 ${m.provider} 没有「${m.model}」，保存时会被拒：把它从分档里去掉，用「加模型」重新挑。`,
    });
  }
  return out;
}
