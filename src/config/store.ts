// 配置存储：模型页和设置页，使用 providers、provider_keys、models、settings、credentials 五张表。
// 这里自己开一条连接，只碰这五张表。
//
// - API key 和凭证的值加密存（secret-box.ts），GET 只回 hasKey、hasValue。凭证的值 PUT 不带就保留原值，传空串就删掉。
// - 一家可以配几个 API key：PUT 不带 keys 就保留这家原来的；带了就整份替换，带 id 的是原有的
//   （不带 key 就保留原值），不带 id 的是新加的（要带 key），没列出的删掉。key 的 AAD 只认供应商（provider:<名字>），
//   同一家的几个 key 互相挪位置解得开，挪到别家解不开。
// - 自定义供应商的接口地址换了域名、端口或协议（URL 的 origin 变了）：原来存的 key 一律作废，只留这次带了 key 的
//   （ModelsConfig 的例外）。不然能调 PUT 的人只改地址、不碰 keys，下一次模型调用就把 key 原文发到他的地址，
//   「key 只写」形同虚设。自定义的和 内置目录的（地址由 内置目录定）之间互换也算换了地方；存着的地址认不出也算。
// - PUT 是整份替换：列表里没有的供应商、凭证删掉，顺序按 PUT 的顺序存，GET 原样按这个顺序回。
// - Settings.config（只能全局改的配置）PUT 不带就保留，带了就整份换掉；传 {} 是清掉覆盖、回到默认值。
// - SDK 的构造参数只在数据库从没配过时当初值（seed）。配过一次（seed 过，或者 PUT 过）就记下 seeded，
//   之后哪怕人把模型全删了，重启也不会被构造参数填回去。

import Database from 'better-sqlite3';
import type { MelinaOptions } from '../core/api.ts';
import {
  CustomProvider,
  credentialProblem,
  DEFAULT_SETTINGS,
  type GlobalConfig,
  GlobalConfigOverride,
  ModelsConfig,
  resolveGlobalConfig,
  Settings,
} from '../core/config.ts';
import { invalid, MelinaError } from '../core/errors.ts';
import { newId as defaultNewId, type Id } from '../core/ids.ts';
import type { ConfigStore, ResolvedProviderKey } from '../core/interfaces/config-store.ts';
import type { ResolvedCredential } from '../core/interfaces/container.ts';
import { type ModelRef, modelKey } from '../core/model-ref.ts';
import { check } from '../core/validate.ts';
import { SECRET_KEY_ENV, type SecretBox } from './secret-box.ts';

export interface ConfigStoreOptions {
  /** 和 RunStore 同一个 SQLite 文件（openRunStore 已经建好表），这里另开一条连接 */
  db: string;
  secrets: SecretBox;
  now?: () => Date;
  newId?: () => Id;
  /** 解不开的 key、存坏了的配置：提醒一次，不进模型上下文 */
  onWarn?: (message: string) => void;
}

type Change = 'models' | 'settings';

interface ProviderRow {
  provider: string;
  rpm: number | null;
  tpm: number | null;
  /** 自定义供应商的定义（CustomProvider 的 JSON）；内置目录的是 NULL */
  custom: string | null;
}

interface KeyRow {
  id: string;
  provider: string;
  name: string | null;
  api_key: Buffer;
  created_at: string;
}

interface ModelRow {
  tier: 'fast' | 'strong';
  provider: string;
  model: string;
}

/** 接口换了地方、原来存的 key 作废了几个（没重新填的） */
interface VoidedKeys {
  provider: string;
  count: number;
}

interface CredentialRow {
  id: string;
  name: string;
  as_env: string | null;
  as_file: string | null;
  value: Buffer | null;
  created_at: string;
}

const KEY_NOTIFY = 'notify';
const KEY_CONFIG = 'config';
const KEY_SEEDED = 'seeded';
const CONFIG_TABLES = ['providers', 'provider_keys', 'models', 'settings', 'credentials'] as const;

export class SqliteConfigStore implements ConfigStore {
  readonly #db: Database.Database;
  readonly #secrets: SecretBox;
  readonly #now: () => Date;
  readonly #newId: () => Id;
  readonly #onWarn: (message: string) => void;
  readonly #listeners = new Set<(what: Change) => void>();
  readonly #warned = new Set<string>();
  #global: GlobalConfig | undefined;

  constructor(options: ConfigStoreOptions) {
    this.#secrets = options.secrets;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? defaultNewId;
    this.#onWarn = options.onWarn ?? ((message) => console.warn(`[配置] ${message}`));
    this.#db = new Database(options.db);
    this.#db.pragma('busy_timeout = 5000');
    const missing = CONFIG_TABLES.filter(
      (t) => !this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t),
    );
    if (missing.length > 0) {
      this.#db.close();
      throw new MelinaError('internal', `数据库里没有配置表（${missing.join('、')}）：先用 openRunStore 打开它建表`);
    }
  }

  // ── 模型页 ──────────────────────────────────────────────────────────────

  getModels(): ModelsConfig {
    const keys = this.#keysByProvider();
    const providers = this.#providerRows().map((row) => ({
      provider: row.provider,
      ...this.#customOf(row),
      keys: (keys.get(row.provider) ?? []).map((k) => ({
        id: k.id,
        ...(k.name !== null ? { name: k.name } : {}),
        hasKey: this.#open(k.api_key, providerAad(row.provider)) !== undefined,
      })),
      ...(row.rpm !== null ? { rpm: row.rpm } : {}),
      ...(row.tpm !== null ? { tpm: row.tpm } : {}),
    }));
    const rows = this.#db
      .prepare('SELECT tier, provider, model FROM models ORDER BY tier, position')
      .all() as ModelRow[];
    const tier = (t: ModelRow['tier']): ModelRef[] =>
      rows.filter((r) => r.tier === t).map((r) => ({ provider: r.provider, model: r.model, tier: t }));
    return { providers, strong: tier('strong'), fast: tier('fast') };
  }

  putModels(config: ModelsConfig): ModelsConfig {
    const value = check(ModelsConfig, config, '模型配置');
    checkModelsShape(value);
    const voided = this.#db.transaction(() => this.#writeModels(value))();
    for (const { provider, count } of voided)
      this.#onWarn(
        `${provider} 的接口换了域名、端口或协议，原来存的 ${count} 个 API key 作废了、不发到新地址；要用就在模型页重新填`,
      );
    this.#emit('models');
    return this.getModels();
  }

  apiKeys(provider: string): ResolvedProviderKey[] {
    return this.#keyRows(provider).flatMap((row) => {
      const key = this.#open(row.api_key, providerAad(provider));
      if (key === undefined) return [];
      return [{ id: row.id, ...(row.name !== null ? { name: row.name } : {}), key }];
    });
  }

  // ── 设置页 ──────────────────────────────────────────────────────────────

  getSettings(): Settings {
    const credentials = this.#credentialRows().map((row) => ({
      id: row.id,
      name: row.name,
      as: row.as_env !== null ? { env: row.as_env } : { file: row.as_file ?? '' },
      hasValue: row.value !== null && this.#open(row.value, credentialAad(row.id)) !== undefined,
    }));
    const notify = this.#setting(KEY_NOTIFY);
    const config = this.#configOverride();
    return {
      credentials,
      notify: typeof notify === 'boolean' ? notify : DEFAULT_SETTINGS.notify,
      ...(config ? { config } : {}),
    };
  }

  putSettings(settings: Settings): Settings {
    const value = check(Settings, settings, '设置');
    this.#db.transaction(() => this.#writeSettings(value))();
    this.#global = undefined;
    this.#emit('settings');
    return this.getSettings();
  }

  credentials(): ResolvedCredential[] {
    return this.#credentialRows().flatMap((row) => {
      if (row.value === null) return [];
      const value = this.#open(row.value, credentialAad(row.id));
      if (value === undefined) return [];
      const as = row.as_env !== null ? { env: row.as_env } : { file: row.as_file ?? '' };
      const credential = { id: row.id, name: row.name, as, value };
      const problem = credentialProblem(credential);
      if (problem) throw invalid(problem);
      return [credential];
    });
  }

  global(): GlobalConfig {
    this.#global ??= resolveGlobalConfig(this.#configOverride() ?? {});
    return this.#global;
  }

  // ── 初值和通知 ──────────────────────────────────────────────────────────

  seed(initial: Pick<MelinaOptions, 'models' | 'sandbox'>): void {
    if (!initial.models && !initial.sandbox) return; // 什么都没给（melina serve）：不算配过
    const changed: Change[] = [];
    this.#db.transaction(() => {
      if (this.#setting(KEY_SEEDED) === true) return;
      if (!this.#isEmpty()) {
        this.#markSeeded();
        return;
      }
      if (initial.models) {
        const refs = [...initial.models.strong, ...initial.models.fast];
        // 构造参数里的 key 常写成 process.env.X：没设的那条（JSON 走一遍后成了空对象）跳过，不算错
        const given: ModelsConfig['providers'] =
          initial.models.providers ?? [...new Set(refs.map((r) => r.provider))].map((provider) => ({ provider }));
        const providers = given.map((p) => (p.keys ? { ...p, keys: p.keys.filter((k) => k.key?.trim()) } : p));
        const value = check(
          ModelsConfig,
          { providers, strong: initial.models.strong, fast: initial.models.fast },
          'SDK 构造参数里的 models',
        );
        checkModelsShape(value);
        this.#writeModels(value, { keepIds: true });
        changed.push('models');
      }
      if (initial.sandbox) {
        const value = check(
          Settings,
          { credentials: initial.sandbox.credentials, notify: DEFAULT_SETTINGS.notify },
          'SDK 构造参数里的 sandbox',
        );
        this.#writeCredentials(value.credentials, { keepIds: true });
        changed.push('settings');
      }
      this.#markSeeded();
    })();
    if (changed.includes('settings')) this.#global = undefined;
    for (const what of changed) this.#emit(what);
  }

  onChange(listener: (what: Change) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#listeners.clear();
    if (this.#db.open) this.#db.close();
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * keepIds：SDK 的初值可以自带 key 的 id，照用；PUT 时带的 id 必须是这家已有的。
   * 返回接口换了地方、原来的 key 作废了的那几家（事务提交以后再提醒）
   */
  #writeModels(value: ModelsConfig, opts: { keepIds?: boolean } = {}): VoidedKeys[] {
    const now = this.#now().toISOString();
    const oldKeys = this.#keysByProvider();
    const oldOrigins = new Map(this.#providerRows().map((row) => [row.provider, storedOrigin(row.custom)]));
    this.#db.prepare('DELETE FROM providers').run();
    const insertProvider = this.#db.prepare(
      'INSERT INTO providers (provider, rpm, tpm, custom, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const p of value.providers) {
      const custom = p.custom ? JSON.stringify(p.custom) : null;
      insertProvider.run(p.provider, p.rpm ?? null, p.tpm ?? null, custom, now);
    }

    // key：不带 keys 的供应商原样留着；带了的整份替换；不在列表里的供应商，key 跟着删
    const listed = new Set(value.providers.map((p) => p.provider));
    const deleteKeys = this.#db.prepare('DELETE FROM provider_keys WHERE provider = ?');
    for (const provider of oldKeys.keys()) if (!listed.has(provider)) deleteKeys.run(provider);
    const insertKey = this.#db.prepare(
      'INSERT INTO provider_keys (id, provider, name, api_key, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const voided: VoidedKeys[] = [];
    for (const p of value.providers) {
      const old = oldKeys.get(p.provider) ?? [];
      let keys = p.keys;
      // 接口换了地方：原来存的 key 不跟过去，不带 keys 的整份删掉，带 id 不带 key 的去掉（见文件头）
      if (oldOrigins.has(p.provider) && !sameOrigin(oldOrigins.get(p.provider), originOf(p.custom))) {
        keys = (p.keys ?? []).filter((k) => k.id === undefined || k.key !== undefined);
        const count = p.keys ? p.keys.length - keys.length : old.length;
        if (count > 0) voided.push({ provider: p.provider, count });
      }
      if (keys === undefined) continue;
      const rows = this.#resolveKeys(p.provider, keys, old, opts);
      deleteKeys.run(p.provider);
      rows.forEach((row, i) => {
        insertKey.run(row.id, p.provider, row.name, row.api_key, i, row.created_at, now);
      });
    }
    this.#db.prepare('DELETE FROM models').run();
    const insertModel = this.#db.prepare('INSERT INTO models (tier, provider, model, position) VALUES (?, ?, ?, ?)');
    for (const tier of ['strong', 'fast'] as const) {
      value[tier].forEach((ref, i) => {
        insertModel.run(tier, ref.provider, ref.model, i);
      });
    }
    this.#markSeeded();
    return voided;
  }

  #writeSettings(value: Settings): void {
    this.#writeCredentials(value.credentials);
    this.#putSetting(KEY_NOTIFY, value.notify);
    if (value.config !== undefined) {
      if (Object.keys(value.config).length === 0)
        this.#db.prepare('DELETE FROM settings WHERE key = ?').run(KEY_CONFIG);
      else this.#putSetting(KEY_CONFIG, value.config);
    }
    this.#markSeeded();
  }

  /** keepIds：SDK 的初值可以自带 id，照用；PUT 时带的 id 必须是已有的 */
  #writeCredentials(list: Settings['credentials'], opts: { keepIds?: boolean } = {}): void {
    const now = this.#now().toISOString();
    const old = new Map(this.#credentialRows().map((row) => [row.id, row]));
    const ids = new Set<string>();
    const places = new Map<string, string>();
    for (const c of list) {
      if (c.id !== undefined) {
        if (ids.has(c.id)) throw invalid(`凭证 ${c.id} 在列表里出现了两次`);
        if (!old.has(c.id) && !opts.keepIds)
          throw invalid(`凭证「${c.name}」已经不在了（可能在别处删掉了），刷新一下再改`);
        ids.add(c.id);
      }
      // 保留的环境变量名、NUL、/workspace 和 /melina 下的文件：保存时就拒（以前要到起容器时才报错，一条坏凭证让所有分支都起不来）
      const problem = credentialProblem(c);
      if (problem) throw invalid(problem);
      const place = 'env' in c.as ? `环境变量 ${c.as.env}` : `文件 ${c.as.file}`;
      const clash = places.get(place);
      if (clash !== undefined) throw invalid(`「${clash}」和「${c.name}」都给成了${place}，容器里只能放一个`);
      places.set(place, c.name);
    }
    this.#db.prepare('DELETE FROM credentials').run();
    const insert = this.#db.prepare(
      'INSERT INTO credentials (id, name, as_env, as_file, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const c of list) {
      const prev = c.id !== undefined ? old.get(c.id) : undefined;
      const id = prev?.id ?? c.id ?? this.#newId();
      let value: Buffer | null = prev?.value ?? null;
      if (c.value !== undefined) value = c.value === '' ? null : this.#secrets.seal(c.value, credentialAad(id));
      const asEnv = 'env' in c.as ? c.as.env : null;
      const asFile = 'file' in c.as ? c.as.file : null;
      insert.run(id, c.name, asEnv, asFile, value, prev?.created_at ?? now, now);
    }
  }

  /** PUT 带来的一家的 key 列表，对上原有的：带 id 的保留原值（带了 key 就换掉），不带 id 的新加 */
  #resolveKeys(
    provider: string,
    list: NonNullable<ModelsConfig['providers'][number]['keys']>,
    old: readonly KeyRow[],
    opts: { keepIds?: boolean },
  ): KeyRow[] {
    const oldById = new Map(old.map((row) => [row.id, row]));
    const ids = new Set<string>();
    const values = new Map<string, string>(); // 明文 → 是哪一个，查同一个 key 填了两次
    const now = this.#now().toISOString();
    return list.map((k, i) => {
      const label = k.name?.trim() ? `「${k.name.trim()}」` : `第 ${i + 1} 个 key`;
      const prev = k.id !== undefined ? oldById.get(k.id) : undefined;
      if (k.id !== undefined) {
        if (ids.has(k.id)) throw invalid(`${provider} 的${label}在列表里出现了两次`);
        if (!prev && !opts.keepIds) throw invalid(`${provider} 的${label}已经不在了（可能在别处删掉了），刷新一下再改`);
        ids.add(k.id);
      }
      const typed = k.key?.trim(); // 粘贴的 key 常带换行
      if (k.key !== undefined && !typed)
        throw invalid(`${provider} 的${label}是空的：要删掉这个 key，就把它从列表里拿掉`);
      if (!prev && !typed) throw invalid(`${provider} 新加的${label}还没填 key`);
      const plain = typed ?? (prev ? this.#open(prev.api_key, providerAad(provider)) : undefined);
      if (plain !== undefined) {
        const clash = values.get(plain);
        if (clash !== undefined) throw invalid(`${provider} 的${clash}和${label}是同一个 key`);
        values.set(plain, label);
      }
      const name = k.name?.trim() ? k.name.trim() : null;
      if (prev) {
        const api_key = typed ? this.#secrets.seal(typed, providerAad(provider)) : prev.api_key;
        return { id: prev.id, provider, name, api_key, created_at: prev.created_at };
      }
      return {
        id: k.id ?? this.#newId(),
        provider,
        name,
        api_key: this.#secrets.seal(typed as string, providerAad(provider)),
        created_at: now,
      };
    });
  }

  #providerRows(): ProviderRow[] {
    return this.#db.prepare('SELECT provider, rpm, tpm, custom FROM providers ORDER BY rowid').all() as ProviderRow[];
  }

  /** 读取自定义供应商，必须符合当前格式。 */
  #customOf(row: ProviderRow): { custom?: CustomProvider } {
    if (row.custom === null) return {};
    return { custom: check(CustomProvider, JSON.parse(row.custom), `存储的自定义供应商 ${row.provider}`) };
  }

  #keyRows(provider: string): KeyRow[] {
    return this.#db
      .prepare(
        'SELECT id, provider, name, api_key, created_at FROM provider_keys WHERE provider = ? ORDER BY position, rowid',
      )
      .all(provider) as KeyRow[];
  }

  #keysByProvider(): Map<string, KeyRow[]> {
    const rows = this.#db
      .prepare('SELECT id, provider, name, api_key, created_at FROM provider_keys ORDER BY provider, position, rowid')
      .all() as KeyRow[];
    const out = new Map<string, KeyRow[]>();
    for (const row of rows) {
      const list = out.get(row.provider);
      if (list) list.push(row);
      else out.set(row.provider, [row]);
    }
    return out;
  }

  #credentialRows(): CredentialRow[] {
    return this.#db
      .prepare('SELECT id, name, as_env, as_file, value, created_at FROM credentials ORDER BY rowid')
      .all() as CredentialRow[];
  }

  #setting(key: string): unknown {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }

  #putSetting(key: string, value: unknown): void {
    this.#db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  #markSeeded(): void {
    this.#putSetting(KEY_SEEDED, true);
  }

  #isEmpty(): boolean {
    for (const table of CONFIG_TABLES) {
      if (this.#db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return false;
    }
    return true;
  }

  /** 读取全局配置覆盖，必须符合当前格式。 */
  #configOverride(): Settings['config'] {
    const stored = this.#setting(KEY_CONFIG);
    return stored === undefined ? undefined : check(GlobalConfigOverride, stored, '存储的全局配置');
  }

  #open(sealed: Uint8Array, aad: string): string | undefined {
    const plain = this.#secrets.open(sealed, aad);
    if (plain === undefined) {
      this.#warnOnce(
        `open:${aad}`,
        `解不开 ${aad} 存的值：密钥换过（${SECRET_KEY_ENV} 或密钥文件），要在模型页或设置页重新填`,
      );
    }
    return plain;
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#onWarn(message);
  }

  #emit(what: Change): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(what);
      } catch (error) {
        this.#onWarn(`配置改动的监听函数出错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** 自定义供应商的英文短名：和 provider id 一个样子（小写、数字、- 和 _），模型名前面要拼上它 */
const CUSTOM_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** 同一份配置里不许重复，每档里的 tier 要和档位一致；自定义供应商的名字、地址、模型要像样（和 内置目录的重没重名由 registry 查） */
function checkModelsShape(value: ModelsConfig): void {
  const providers = new Set<string>();
  for (const p of value.providers) {
    if (providers.has(p.provider)) throw invalid(`供应商 ${p.provider} 写了两次`);
    providers.add(p.provider);
    if (p.custom) checkCustom(p.provider, p.custom);
  }
  for (const tier of ['strong', 'fast'] as const) {
    const seen = new Set<string>();
    for (const ref of value[tier]) {
      if (ref.tier !== tier) throw invalid(`${modelKey(ref)} 放在 ${tier} 档，tier 却写的是 ${ref.tier}`);
      if (seen.has(modelKey(ref))) throw invalid(`${tier} 档里 ${modelKey(ref)} 写了两次`);
      seen.add(modelKey(ref));
    }
  }
}

function checkCustom(id: string, custom: CustomProvider): void {
  const label = custom.name?.trim() ? `自定义供应商「${custom.name.trim()}」` : `自定义供应商 ${id}`;
  if (!CUSTOM_ID.test(id))
    throw invalid(`${label}的英文短名「${id}」只能用小写字母、数字、- 和 _，以字母或数字开头，最长 40 个字`);
  let url: URL | undefined;
  try {
    url = new URL(custom.baseUrl.trim());
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password)
    throw invalid(`${label}的接口地址不像一个网址：${custom.baseUrl}（写成 https://…，key 不要写在地址里）`);
  const seen = new Set<string>();
  for (const m of custom.models) {
    if (m.model !== m.model.trim()) throw invalid(`${label}的模型名「${m.model}」前后有空格`);
    if (seen.has(m.model)) throw invalid(`${label}的模型 ${m.model} 写了两次`);
    seen.add(m.model);
  }
}

/**
 * 一家的 key 发到哪：自定义供应商是接口地址的 origin（协议、域名、端口，同一个 origin 下只改路径不算换），
 * 内置目录的是 null（地址由 内置目录定）；认不出是 undefined
 */
function originOf(custom: CustomProvider | undefined): string | null | undefined {
  return custom ? urlOrigin(custom.baseUrl) : null;
}

/** 从当前格式的自定义供应商配置读取接口地址。 */
function storedOrigin(custom: string | null): string | null | undefined {
  if (custom === null) return null;
  return originOf(check(CustomProvider, JSON.parse(custom), '存储的自定义供应商'));
}

function urlOrigin(url: string): string | undefined {
  try {
    const { origin } = new URL(url.trim());
    return origin === 'null' ? undefined : origin; // 不是 http(s) 的地址没有 origin
  } catch {
    return undefined;
  }
}

/** 两头都认得出、是同一个地方；认不出的算换了 */
function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  return a !== undefined && b !== undefined && a === b;
}

function providerAad(provider: string): string {
  return `provider:${provider}`;
}

function credentialAad(id: string): string {
  return `credential:${id}`;
}
