// 模型页的草稿：在页面上改，点保存才 PUT /models。
// API key 只写：GET 只回 id、名字和 hasKey。一家可以配几个 key，按顺序：第一个是首选，后面是额度用完或失效时的备用。
// PUT 时每家的 key 整份带上：带 id 的是原有的（不带 key 就保留原值），不带 id 的是新加的，没列出的删掉。
// 例外：自定义供应商的接口地址换了域名、端口或协议，原来存的 key 保存时作废、不发到新地址，只留重新填了的。

import type { CustomProvider, ModelsConfig, ProviderKey } from '../../../../src/core/config.ts';
import type { ModelRef, Tier } from '../../../../src/core/model-ref.ts';

export interface KeyDraft {
  /** 页面上认它用的：存过的就是它的 id，新加的现编一个 */
  ref: string;
  /** 存过的才有 */
  id?: string;
  /** 给人看的名字，例如「公司账号」 */
  name?: string;
  /** 存着、解得开 */
  hasKey: boolean;
  /** 新填的 key；保存时发给 Melina，之后就看不到了。存过的填了就是换掉 */
  newKey?: string;
}

export interface ProviderDraft {
  provider: string;
  /** 自定义供应商的接口和模型；官方目录里的不带。改的时候可能是半截的（地址空着、模型名没填），problems 会拦 */
  custom?: CustomProvider;
  /** 存着的接口地址（自定义供应商，页面打开或保存回来时的）：和它比换没换地方，见 keysVoided */
  savedBaseUrl?: string;
  keys: KeyDraft[];
  rpm?: number;
  tpm?: number;
}

export interface ModelsDraft {
  providers: ProviderDraft[];
  strong: ModelRef[];
  fast: ModelRef[];
}

let fresh = 0;
/** 新加的 key 在页面上的 ref */
export function newKeyRef(): string {
  fresh += 1;
  return `new-${fresh}`;
}

function keyFrom(k: ProviderKey): KeyDraft {
  const ref = k.id ?? newKeyRef();
  return {
    ref,
    ...(k.id !== undefined ? { id: k.id } : {}),
    ...(k.name !== undefined ? { name: k.name } : {}),
    hasKey: k.hasKey ?? false,
  };
}

export function draftFrom(config: ModelsConfig): ModelsDraft {
  return {
    providers: config.providers.map((p) => ({
      provider: p.provider,
      ...(p.custom ? { custom: structuredClone(p.custom), savedBaseUrl: p.custom.baseUrl } : {}),
      keys: (p.keys ?? []).map(keyFrom),
      ...(p.rpm !== undefined ? { rpm: p.rpm } : {}),
      ...(p.tpm !== undefined ? { tpm: p.tpm } : {}),
    })),
    strong: config.strong.map((m) => ({ ...m })),
    fast: config.fast.map((m) => ({ ...m })),
  };
}

/** 要 PUT 的内容：每家的 key 整份带上，key 的值只在新填了的时候带 */
export function toConfig(d: ModelsDraft): ModelsConfig {
  return {
    providers: d.providers.map((p) => ({
      provider: p.provider,
      ...(p.custom ? { custom: cleanCustom(p.custom) } : {}),
      keys: p.keys.map((k) => ({
        ...(k.id !== undefined ? { id: k.id } : {}),
        ...(k.name?.trim() ? { name: k.name.trim() } : {}),
        ...(k.newKey ? { key: k.newKey } : {}),
      })),
      ...(p.rpm !== undefined ? { rpm: p.rpm } : {}),
      ...(p.tpm !== undefined ? { tpm: p.tpm } : {}),
    })),
    strong: d.strong.map(({ provider, model }) => ({ provider, model, tier: 'strong' as const })),
    fast: d.fast.map(({ provider, model }) => ({ provider, model, tier: 'fast' as const })),
  };
}

/** 要 PUT 的自定义供应商：前后空格去掉，空的名字不带 */
export function cleanCustom(c: CustomProvider): CustomProvider {
  const name = c.name?.trim();
  return {
    ...(name ? { name } : {}),
    baseUrl: c.baseUrl.trim(),
    api: c.api,
    models: c.models.map((m) => {
      const label = m.name?.trim();
      const { name: _drop, ...rest } = m;
      return { ...rest, model: m.model.trim(), ...(label ? { name: label } : {}) };
    }),
  };
}

/** 自定义供应商的英文短名：用配置存储的 provider id 格式（Melina 的配置存储照这个查） */
export const CUSTOM_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** 接口地址像不像一个网址：http(s)、带域名，key 不写在地址里 */
export function validBaseUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** http（不加密）而且不是本机的地址：key 和对话内容是明文出去的，提醒一句（不拦，内网自己部署的常这样） */
export function plainRemote(url: string): boolean {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:') return false;
    return !(u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\./.test(u.hostname));
  } catch {
    return false;
  }
}

/** 自定义供应商哪里还没填好（都是挡着不让存的）；label 是给人看的叫法 */
export function customProblems(label: string, c: CustomProvider): string[] {
  const out: string[] = [];
  if (!c.baseUrl.trim()) out.push(`${label}还没填接口地址。`);
  else if (!validBaseUrl(c.baseUrl))
    out.push(`${label}的接口地址不像一个网址：写成 https:// 开头的完整地址，key 不要写在里面。`);
  if (c.models.length === 0) out.push(`${label}还没有模型：至少写一个模型名。`);
  const names = c.models.map((m) => m.model.trim());
  if (names.some((n) => !n)) out.push(`${label}有模型还没写名字。`);
  const dup = names.find((n, i) => n && names.indexOf(n) !== i);
  if (dup) out.push(`${label}的模型 ${dup} 写了两次。`);
  return out;
}

export function sameDraft(a: ModelsDraft, b: ModelsDraft): boolean {
  return JSON.stringify(toConfig(a)) === JSON.stringify(toConfig(b));
}

/** 地址的 origin（协议、域名、端口）；不像网址是 undefined */
export function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url.trim());
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * 自定义供应商的接口地址比存着的换了域名、端口或协议：原来存的 key 保存时作废、不发到新地址，要重新填
 * （ModelsConfig 的例外，；Melina 那边照同样的规则删）。只改路径不算；新地址还不像网址时不算，那时另有报错挡着不让存
 */
export function keysVoided(p: ProviderDraft): boolean {
  if (!p.custom || p.savedBaseUrl === undefined) return false;
  const now = originOf(p.custom.baseUrl);
  return now !== undefined && now !== originOf(p.savedBaseUrl);
}

/** 供应商有没有可用的 key（考虑草稿里的改动；接口换了地方，只算重新填了的） */
export function willHaveKey(p: ProviderDraft): boolean {
  const voided = keysVoided(p);
  return p.keys.some((k) => Boolean(k.newKey) || (k.hasKey && !voided));
}

/** key 给人看的叫法：有名字用名字，没有就说排第几 */
export function keyLabel(k: Pick<KeyDraft, 'name'>, index: number): string {
  return k.name?.trim() || `第 ${index + 1} 个 key`;
}

export interface DraftProblem {
  level: 'error' | 'warn';
  text: string;
}

/** 保存前看一眼：错的不让存，提醒的只提一句 */
export function problems(d: ModelsDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  const names = d.providers.map((p) => p.provider);
  if (d.providers.length === 0) out.push({ level: 'warn', text: '还没有供应商：加一家，填上它的 API key。' });
  for (const tier of ['strong', 'fast'] as const) {
    for (const m of d[tier])
      if (!names.includes(m.provider))
        out.push({ level: 'error', text: `${tierName(tier)}档的 ${m.provider}/${m.model} 用的供应商没配。` });
  }
  if (d.providers.length > 0 && d.strong.length === 0)
    out.push({ level: 'warn', text: 'strong 档还没有模型：做主要的活要用它，没有它建不了任务。' });
  if (d.providers.length > 0 && d.fast.length === 0)
    out.push({ level: 'warn', text: 'fast 档还没有模型：可在这里配置用于轻量调用的模型。' });
  for (const p of d.providers) {
    const label = p.custom?.name?.trim() ? `自定义的「${p.custom.name.trim()}」` : `自定义的 ${p.provider} `;
    if (p.custom) {
      for (const text of customProblems(label, p.custom)) out.push({ level: 'error', text });
      if (plainRemote(p.custom.baseUrl))
        out.push({
          level: 'warn',
          text: `${label}用的是 http：API key 和对话内容都不加密地发出去，只在本机或信得过的内网这样用。`,
        });
    }
    p.keys.forEach((k, i) => {
      if (!k.id && !k.newKey)
        out.push({
          level: 'error',
          text: `${p.provider} 新加的 API key（${k.name?.trim() || `第 ${i + 1} 个`}）还没填值：填上，或者把它去掉。`,
        });
    });
    const values = p.keys.map((k) => k.newKey).filter((v): v is string => Boolean(v));
    if (new Set(values).size < values.length)
      out.push({ level: 'error', text: `${p.provider} 有两个 key 填的是同一个。` });
    // 接口换了地方：存过、没重新填的 key 保存时作废（keysVoided）
    const stale = keysVoided(p) ? p.keys.filter((k) => k.id !== undefined && !k.newKey).length : 0;
    if (stale > 0)
      out.push({
        level: 'warn',
        text: willHaveKey(p)
          ? `${label}换了接口地址的域名、端口或协议：没重新填的 key 保存时作废，不会发到新地址。`
          : `${label}换了接口地址的域名、端口或协议：原来存的 key 保存时作废，不会发到新地址；重新填一个，不然用它的调用会失败。`,
      });
    else if (!willHaveKey(p)) out.push({ level: 'warn', text: `${p.provider} 还没有 API key，用它的调用会失败。` });
  }
  return out;
}

/**
 * 三方合并（保存前先拿最新的，别处改过的不被这次保存盖掉）：base 是页面打开时的，draft 是这里改过的，fresh 是现在的。
 * 供应商按名字：这里没动的取最新的，这里删掉的照删，别处新加的留下，别处删掉、这里又改过的加回去（只带这里新填的 key）。
 * 这里改过的那家用这里的 key 列表；别处已经删掉、这里也没重填的 key 不再带（带了 Melina 会说它不在了）。
 * 分档：这里动过的那一档用这里的顺序，没动的取最新的；供应商已经不在的模型去掉。
 */
export function mergeModels(base: ModelsDraft, draft: ModelsDraft, fresh: ModelsDraft): ModelsDraft {
  const baseBy = new Map(base.providers.map((p) => [p.provider, p]));
  const freshBy = new Map(fresh.providers.map((p) => [p.provider, p]));
  const inDraft = new Set(draft.providers.map((p) => p.provider));
  const providers: ProviderDraft[] = [];
  for (const d of draft.providers) {
    const b = baseBy.get(d.provider);
    const f = freshBy.get(d.provider);
    const touched =
      !b ||
      sameKeys(d.keys, b.keys) === false ||
      d.rpm !== b.rpm ||
      d.tpm !== b.tpm ||
      JSON.stringify(d.custom ?? null) !== JSON.stringify(b.custom ?? null);
    if (!touched) {
      if (f) providers.push(f);
      continue;
    }
    const freshKeys = new Map((f?.keys ?? []).map((k) => [k.id, k]));
    const keys = d.keys.flatMap((k): KeyDraft[] => {
      if (k.id === undefined) return [k];
      const now = freshKeys.get(k.id);
      if (now) return [{ ...k, hasKey: now.hasKey }];
      // 别处删掉了：这里重填过就当新加的，没重填就不带
      if (!k.newKey) return [];
      const { id: _id, ...rest } = k;
      return [{ ...rest, hasKey: false }];
    });
    providers.push({ ...d, keys });
  }
  for (const f of fresh.providers) if (!baseBy.has(f.provider) && !inDraft.has(f.provider)) providers.push(f);
  const names = new Set(providers.map((p) => p.provider));
  const tier = (t: Tier) =>
    (JSON.stringify(draft[t]) === JSON.stringify(base[t]) ? fresh[t] : draft[t]).filter((m) => names.has(m.provider));
  return { providers, strong: tier('strong'), fast: tier('fast') };
}

function sameKeys(a: readonly KeyDraft[], b: readonly KeyDraft[]): boolean {
  const plain = (list: readonly KeyDraft[]) =>
    JSON.stringify(list.map((k) => [k.id ?? k.ref, k.name?.trim() ?? '', k.newKey ?? '']));
  return plain(a) === plain(b);
}

export function tierName(tier: Tier): string {
  return tier === 'strong' ? 'strong（强）' : 'fast（快）';
}

export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item !== undefined) out.splice(to, 0, item);
  return out;
}
