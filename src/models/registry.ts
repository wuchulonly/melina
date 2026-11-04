// 模型配置、分档和备用顺序。
// 配置以数据库为准：模型页存的 ModelsConfig 和 API key 由配置存储给，这里每次现读，模型页一改就生效。
// 一家可以配几个 API key，用哪个、哪个用不了由 keys.ts 记。
// 模型信息（上下文窗口、价格、接口类型）取 DeepSeek 目录，传输由官方 Harness 适配器处理，
// 默认是 builtin.ts 里的 DeepSeek；测试传 fauxProvider。
// 自定义供应商和其他厂商不再注册。

import type { ModelCatalogResponse } from '../core/api.ts';
import type { GlobalConfig, ModelsConfig } from '../core/config.ts';
import { invalid, MelinaError } from '../core/errors.ts';
import type { ResolvedProviderKey } from '../core/interfaces/config-store.ts';
import type { ModelRegistry } from '../core/interfaces/models.ts';
import { type ModelChoice, type ModelRef, modelKey, type Tier } from '../core/model-ref.ts';
import { type Breaker, createBreaker } from './breaker.ts';
import { createKeyPool, type KeyPool } from './keys.ts';
import type { Api, Model, Provider } from './protocol.ts';

/** 配置存储（interfaces/config-store.ts 的 ConfigStore）里模型层用到的部分 */
export interface ModelsSource {
  getModels(): ModelsConfig;
  /** 解密后的 API key，按顺序：第一个是首选，后面是备用；没配就是空的 */
  apiKeys(provider: string): ResolvedProviderKey[];
  global(): GlobalConfig;
}

/** registry 的实现：ModelRegistry 加上模型层自己用的几样 */
export interface MelinaModelRegistry extends ModelRegistry {
  readonly breaker: Breaker;
  readonly keys: KeyPool;
  /** 模型对象；这家用不了（和 unusable 同一套说法）或模型不在目录里就抛 invalid */
  model(ref: Pick<ModelRef, 'provider' | 'model'>): Model<Api>;
  provider(id: string): Provider | undefined;
  apiKeys(provider: string): ResolvedProviderKey[];
  /** 这家排在第一个的 key（只用来看配没配 key；真正用哪个由 melinaStream 按 keys 挑） */
  apiKey(provider: string): string | undefined;
  global(): GlobalConfig;
  /** 熔断时可以换的备用模型，按 models.fallback 的顺序，不管它们自己熔断没有（melinaStream 逐个看，到了试探时间的也能去试） */
  fallbacks(ref: ModelRef): ModelRef[];
  /** 模型页的配置有什么问题（给人看）：unusable 的那些，加上某一档是空的、供应商没有 key */
  problems(config?: ModelsConfig): string[];
  /** 不在 DeepSeek 目录里的供应商、模型及旧自定义接口拒绝保存。 */
  unusable(config: ModelsConfig): string[];
  /** DeepSeek 的模型、接口、上下文、价格及 Key 状态。 */
  catalog(): ModelCatalogResponse;
}

export function createModelRegistry(input: {
  source: ModelsSource;
  providers: readonly Provider[];
  breaker?: Breaker;
  keys?: KeyPool;
}): MelinaModelRegistry {
  const { source } = input;
  const breaker = input.breaker ?? createBreaker();
  const keys = input.keys ?? createKeyPool();
  const builtin = new Map(input.providers.map((p) => [p.id, p]));

  const providerOf = (id: string): Provider | undefined => builtin.get(id);

  const tier = (t: Tier): ModelRef[] => source.getModels()[t];

  const allowed = (): ModelRef[] => {
    const config = source.getModels();
    const seen = new Set<string>();
    const out: ModelRef[] = [];
    for (const ref of [...config.strong, ...config.fast]) {
      const key = `${modelKey(ref)}#${ref.tier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
    return out;
  };

  const providers = (): string[] => {
    const config = source.getModels();
    const ids = [...config.providers.map((p) => p.provider), ...allowed().map((r) => r.provider)];
    return [...new Set(ids)];
  };

  const findModel = (ref: Pick<ModelRef, 'provider' | 'model'>): Model<Api> | undefined =>
    providerOf(ref.provider)
      ?.getModels()
      .find((m) => m.id === ref.model);

  /** 历史配置也不把 Key 发给已移除的供应商或自定义地址。 */
  const providerProblem = (id: string, config: ModelsConfig): string | undefined => {
    if (config.providers.some((p) => p.provider === id && p.custom))
      return `${id}：当前仅支持 DeepSeek 原生接口，不再支持自定义供应商`;
    if (!providerOf(id)) return `不支持供应商 ${id}；当前仅启用 DeepSeek`;
    return undefined;
  };

  const registry: MelinaModelRegistry = {
    breaker,
    keys,

    resolve(choice: ModelChoice): ModelRef {
      if ('provider' in choice) return choice;
      const first = tier(choice.tier)[0];
      if (!first) throw new MelinaError('unavailable', `模型页里 ${choice.tier} 档还没有模型`);
      return first;
    },

    tier,
    allowed,

    isAllowed(ref) {
      return allowed().some((r) => r.provider === ref.provider && r.model === ref.model);
    },

    fallback(ref) {
      return registry.fallbacks(ref).find((candidate) => !breaker.isOpen(candidate.provider));
    },

    fallbacks(ref) {
      if (source.global().models.fallback === 'none') return [];
      const config = source.getModels();
      const list = config[ref.tier];
      const start = list.findIndex((r) => r.provider === ref.provider && r.model === ref.model);
      // 同档位里排在后面的，到底了从头找；跳过同一家（熔断是按供应商的）、没 key 的、用不了的；每家只取第一个
      const out: ModelRef[] = [];
      const seen = new Set([ref.provider]);
      for (let i = 1; i <= list.length; i++) {
        const candidate = list[start < 0 ? i - 1 : (start + i) % list.length];
        if (!candidate || seen.has(candidate.provider)) continue;
        if (source.apiKeys(candidate.provider).length === 0) continue;
        if (providerProblem(candidate.provider, config) || !findModel(candidate)) continue;
        seen.add(candidate.provider);
        out.push(candidate);
      }
      return out;
    },

    contextWindow(ref) {
      const window = findModel(ref)?.contextWindow;
      return window && window > 0 ? window : undefined;
    },

    providers,

    breakers() {
      const listed = new Map(source.getModels().providers.map((p) => [p.provider, p.keys ?? []]));
      return breaker.status(providers()).map((status) => {
        const configured = listed.get(status.provider) ?? [];
        if (configured.length === 0) return status;
        const listedKeys = configured.flatMap((k) =>
          k.id === undefined ? [] : [{ id: k.id, ...(k.name !== undefined ? { name: k.name } : {}), hasKey: k.hasKey }],
        );
        return { ...status, keys: keys.status(listedKeys, source.apiKeys(status.provider)) };
      });
    },

    model(ref) {
      // 存着的配置也照存配置时（unusable）的规矩查：模型目录更新以后它可能对不上了，用不了的这家不发请求
      const config = source.getModels();
      const problem = providerProblem(ref.provider, config);
      if (problem) throw invalid(problem);
      const model = findModel(ref);
      if (!model) throw invalid(missingModel(ref));
      return model;
    },

    provider(id) {
      return providerOf(id);
    },

    apiKeys(provider) {
      return source.apiKeys(provider);
    },

    apiKey(provider) {
      return source.apiKeys(provider)[0]?.key;
    },

    global() {
      return source.global();
    },

    unusable(config) {
      const out: string[] = [];
      for (const p of config.providers) {
        const problem = providerProblem(p.provider, config);
        if (problem) out.push(problem);
      }
      for (const ref of [...config.strong, ...config.fast]) {
        const problem = providerProblem(ref.provider, config);
        if (problem) out.push(problem);
        else if (!findModel(ref)) out.push(missingModel(ref));
      }
      return [...new Set(out)];
    },

    problems(config = source.getModels()) {
      const out = registry.unusable(config);
      for (const t of ['strong', 'fast'] as const) {
        if (config[t].length === 0) out.push(`${t} 档还没有模型`);
        for (const ref of config[t]) {
          if (ref.tier !== t) out.push(`${modelKey(ref)} 放在 ${t} 档，tier 却写的是 ${ref.tier}`);
        }
      }
      // keys 不带的是保留原来的（PUT 的规则），看存着的
      const keyed = (provider: string) => {
        const p = config.providers.find((x) => x.provider === provider);
        if (p?.keys) return p.keys.some((k) => k.hasKey || k.key?.trim() || k.id !== undefined);
        return source.apiKeys(provider).length > 0;
      };
      for (const provider of new Set([...config.strong, ...config.fast].map((r) => r.provider))) {
        if (!keyed(provider)) out.push(`供应商 ${provider} 还没有 API key`);
      }
      return [...new Set(out)];
    },

    catalog() {
      const out: ModelCatalogResponse['providers'] = [];
      const add = (provider: string, modelProvider: Provider, custom: boolean) => {
        const models = modelsOf(modelProvider);
        if (models.length === 0) return;
        const baseUrl = baseUrlOf(modelProvider, models);
        out.push({
          provider,
          ...(modelProvider.name && modelProvider.name !== provider ? { name: modelProvider.name } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(custom ? { custom: true } : {}),
          hasKey: source.apiKeys(provider).length > 0,
          models: models.map(catalogEntry),
        });
      };
      for (const [provider, modelProvider] of builtin) add(provider, modelProvider, false);
      return { providers: out };
    },
  };
  return registry;
}

function missingModel(ref: Pick<ModelRef, 'provider' | 'model'>): string {
  return `模型目录里没有模型 ${modelKey(ref)}`;
}

/** Provider 约定 getModels 不抛错；真抛了就当这家没有模型 */
function modelsOf(modelProvider: Provider): readonly Model<Api>[] {
  try {
    return modelProvider.getModels();
  } catch {
    return [];
  }
}

/** 请求发到哪：这家写的地址，没写（各模型自己带地址的）就取第一个模型的；还没填的模板地址（带 {region} 这类）不算 */
function baseUrlOf(modelProvider: Provider, models: readonly Model<Api>[]): string | undefined {
  const usable = (url: string | undefined) => (url && /^https?:\/\//.test(url) && !url.includes('{') ? url : undefined);
  return usable(modelProvider.baseUrl) ?? usable(models[0]?.baseUrl);
}

/** 目录里的一个模型：目录没给（0、缺）的不写；价格是每百万 token 的美元（模型 cost 同一个口径），输入输出都是 0 的当不知道 */
function catalogEntry(m: Model<Api>): ModelCatalogResponse['providers'][number]['models'][number] {
  const count = (n: number | undefined) => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined);
  const contextWindow = count(m.contextWindow);
  const maxOutput = count(m.maxTokens);
  const cost = m.cost;
  const priced = cost && (cost.input > 0 || cost.output > 0);
  return {
    model: m.id,
    ...(m.name && m.name !== m.id ? { name: m.name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    reasoning: m.reasoning === true,
    ...(priced
      ? {
          price: {
            input: cost.input,
            output: cost.output,
            ...(cost.cacheRead > 0 ? { cacheRead: cost.cacheRead } : {}),
            ...(cost.cacheWrite > 0 ? { cacheWrite: cost.cacheWrite } : {}),
          },
        }
      : {}),
  };
}
