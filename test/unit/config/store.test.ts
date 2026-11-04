// 配置存储：模型页、设置页的读写，API key 和凭证只写不读、加密存，SDK 初值只在没配过时用。

import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSecretBox,
  loadOrCreateKeyFile,
  parseSecretKey,
  type SecretBox,
} from '../../../src/config/secret-box.ts';
import { SqliteConfigStore } from '../../../src/config/store.ts';
import {
  type CustomProvider,
  DEFAULT_GLOBAL_CONFIG,
  type ModelsConfig,
  type ProviderKey,
  type Settings,
} from '../../../src/core/config.ts';
import { MelinaError } from '../../../src/core/errors.ts';
import { openRunStore } from '../../../src/storage/state.ts';
import { tempDir } from '../api/kit.ts';

const DEEPSEEK = { provider: 'deepseek', model: 'deepseek-flash' } as const;
const SECRET = 'sk-test-0123456789abcdef';
const SECOND = 'sk-test-second-account-key';

function models(over: Partial<ModelsConfig> = {}): ModelsConfig {
  return {
    providers: [{ provider: 'deepseek', keys: [{ key: SECRET }] }],
    strong: [{ ...DEEPSEEK, tier: 'strong' }],
    fast: [{ ...DEEPSEEK, tier: 'fast' }],
    ...over,
  };
}

let dir: string;
let db: string;
let box: SecretBox;
const warnings: string[] = [];

function open(secrets: SecretBox = box): SqliteConfigStore {
  return new SqliteConfigStore({ db, secrets, onWarn: (m) => warnings.push(m) });
}

beforeEach(() => {
  dir = tempDir('melina-config-');
  db = join(dir, 'melina.db');
  openRunStore({ db }).close(); // 建表
  box = createSecretBox(randomBytes(32));
  warnings.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('模型页', () => {
  it('API key 只写：GET 只回 id、名字和 hasKey，apiKeys() 按顺序给 melinaStream 解密后的值', () => {
    const store = open();
    const saved = store.putModels(
      models({
        providers: [
          {
            provider: 'deepseek',
            keys: [{ name: '公司账号', key: SECRET }, { key: SECOND }],
          },
        ],
      }),
    );
    expect(saved.providers).toEqual([
      {
        provider: 'deepseek',
        keys: [
          { id: expect.any(String), name: '公司账号', hasKey: true },
          { id: expect.any(String), hasKey: true },
        ],
      },
    ]);
    expect(JSON.stringify(store.getModels())).not.toContain(SECRET);
    const ids = saved.providers[0]?.keys?.map((k) => k.id);
    expect(store.apiKeys('deepseek')).toEqual([
      { id: ids?.[0], name: '公司账号', key: SECRET },
      { id: ids?.[1], key: SECOND },
    ]);
    expect(store.apiKeys('anthropic')).toEqual([]);
    store.close();
  });

  it('数据库里存的是密文，换个密钥解不开', () => {
    const store = open();
    store.putModels(models());
    store.close();
    const raw = new Database(db);
    const row = raw.prepare('SELECT api_key FROM provider_keys').get() as { api_key: Buffer };
    raw.close();
    expect(row.api_key.includes(Buffer.from(SECRET))).toBe(false);
    for (const f of ['melina.db', 'melina.db-wal']) {
      try {
        expect(readFileSync(join(dir, f)).includes(Buffer.from(SECRET))).toBe(false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const other = open(createSecretBox(randomBytes(32)));
    expect(other.apiKeys('deepseek')).toEqual([]);
    expect(other.getModels().providers[0]?.keys?.[0]?.hasKey).toBe(false);
    expect(warnings.some((w) => w.includes('解不开'))).toBe(true);
    other.close();
  });

  it('PUT 不带 keys 保留原来的；带了整份替换：带 id 的保留原值或换掉，不带 id 的新加，没列的删掉', () => {
    const store = open();
    const first = store.putModels(models());
    const id = first.providers[0]?.keys?.[0]?.id as string;
    store.putModels(models({ providers: [{ provider: 'deepseek', rpm: 100 }] }));
    expect(store.apiKeys('deepseek').map((k) => k.key)).toEqual([SECRET]);
    expect(store.getModels().providers).toEqual([{ provider: 'deepseek', keys: [{ id, hasKey: true }], rpm: 100 }]);
    // 原有的改个名字、排到后面，前面新加一个（带空白的去掉首尾空白）
    store.putModels(
      models({
        providers: [
          {
            provider: 'deepseek',
            keys: [
              { key: '  sk-new-key \n', name: '新账号' },
              { id, name: '老账号' },
            ],
          },
        ],
      }),
    );
    expect(store.apiKeys('deepseek')).toEqual([
      { id: expect.any(String), name: '新账号', key: 'sk-new-key' },
      { id, name: '老账号', key: SECRET },
    ]);
    // 带 id 也带 key：换掉这个 key 的值，id 不变
    store.putModels(models({ providers: [{ provider: 'deepseek', keys: [{ id, key: SECOND }] }] }));
    expect(store.apiKeys('deepseek')).toEqual([{ id, key: SECOND }]);
    // 空列表：这家的 key 全删
    store.putModels(models({ providers: [{ provider: 'deepseek', keys: [] }] }));
    expect(store.apiKeys('deepseek')).toEqual([]);
    expect(store.getModels().providers).toEqual([{ provider: 'deepseek', keys: [] }]);
    store.close();
  });

  it('PUT 的 key 列表不对就整份拒绝，原来的不动', () => {
    const store = open();
    const id = store.putModels(models()).providers[0]?.keys?.[0]?.id as string;
    const bad: [ModelsConfig['providers'][number]['keys'], RegExp][] = [
      [[{ name: '新账号' }], /还没填 key/],
      [[{ id, key: '  ' }], /是空的/],
      [[{ id }, { key: SECRET }], /同一个 key/],
      [[{ id }, { id }], /出现了两次/],
      [[{ id: '01K6F1W3S2A8Q0Q6YH7J5M4N3Z', key: SECOND }], /已经不在了/],
    ];
    for (const [keys, message] of bad) {
      expect(() =>
        store.putModels(models({ providers: [{ provider: 'deepseek', ...(keys ? { keys } : {}) }] })),
      ).toThrow(message);
    }
    expect(store.apiKeys('deepseek')).toEqual([{ id, key: SECRET }]);
    store.close();
  });

  it('key 的 id 不能挪到别家用', () => {
    const store = open();
    const id = store.putModels(models()).providers[0]?.keys?.[0]?.id as string;
    expect(() =>
      store.putModels(models({ providers: [{ provider: 'deepseek' }, { provider: 'anthropic', keys: [{ id }] }] })),
    ).toThrow(/已经不在了/);
    store.close();
  });

  it('PUT 是整份替换：没列的供应商连 key 一起删，顺序照 PUT 的', () => {
    const store = open();
    store.putModels(
      models({
        providers: [
          { provider: 'deepseek', keys: [{ key: SECRET }] },
          { provider: 'anthropic', keys: [{ key: 'sk-ant-xxxxxxxx' }] },
        ],
      }),
    );
    store.putModels(models({ providers: [{ provider: 'anthropic' }, { provider: 'deepseek' }] }));
    expect(store.getModels().providers.map((p) => p.provider)).toEqual(['anthropic', 'deepseek']);
    expect(store.apiKeys('anthropic').map((k) => k.key)).toEqual(['sk-ant-xxxxxxxx']);
    store.putModels(models({ providers: [{ provider: 'deepseek' }] }));
    expect(store.apiKeys('anthropic')).toEqual([]);
    store.close();
  });

  it('自定义供应商（§12）：接口和模型原样存、原样回，key 照常只写', () => {
    const store = open();
    const custom: CustomProvider = {
      name: '火山方舟',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      api: 'openai-completions',
      models: [{ model: 'doubao-pro', contextWindow: 256_000, reasoning: true, price: { input: 0.5, output: 2 } }],
    };
    const saved = store.putModels(
      models({
        providers: [
          { provider: 'deepseek', keys: [{ key: SECRET }] },
          { provider: 'ark', custom, keys: [{ key: SECOND }] },
        ],
      }),
    );
    expect(saved.providers[1]).toEqual({ provider: 'ark', custom, keys: [{ id: expect.any(String), hasKey: true }] });
    expect(saved.providers[0]).not.toHaveProperty('custom');
    expect(store.apiKeys('ark')).toEqual([{ id: expect.any(String), key: SECOND }]);
    // 原样留着：不带 custom 的 PUT 就是 pi 自带的了
    store.putModels(models({ providers: [{ provider: 'ark', keys: [] }] }));
    expect(store.getModels().providers[0]).toEqual({ provider: 'ark', keys: [] });
    store.close();
  });

  it('自定义供应商写得不像样就拒：英文短名、地址、同一个模型写两次', () => {
    const store = open();
    const base: CustomProvider = {
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      models: [{ model: 'm' }],
    };
    const put = (provider: string, custom: CustomProvider) => () =>
      store.putModels(models({ providers: [{ provider, custom }], strong: [], fast: [] }));
    expect(put('Volc Engine', base)).toThrow('英文短名「Volc Engine」只能用小写字母、数字、- 和 _');
    expect(put('ark', { ...base, baseUrl: 'https://user:pass@api.example.com/v1' })).toThrow('接口地址不像一个网址');
    expect(put('ark', { ...base, baseUrl: 'https://exa mple.com' })).toThrow(MelinaError);
    expect(put('ark', { ...base, models: [{ model: 'm' }, { model: 'm' }] })).toThrow('的模型 m 写了两次');
    expect(put('ark', { ...base, name: '方舟', models: [{ model: ' m' }] })).toThrow(
      '自定义供应商「方舟」的模型名「 m」前后有空格',
    );
    expect(store.getModels()).toEqual({ providers: [], strong: [], fast: [] });
    store.close();
  });

  it('自定义供应商存储格式无效时拒绝读取或覆写，不降级为空配置', () => {
    const raw = new Database(db);
    raw
      .prepare('INSERT INTO providers (provider, rpm, tpm, custom, updated_at) VALUES (?, NULL, NULL, ?, ?)')
      .run(
        'ark',
        JSON.stringify({ baseUrl: 'https://x.example/v1', api: 'grpc', models: [] }),
        '2026-10-01T00:00:00.000Z',
      );
    raw.close();
    const store = open();
    expect(() => store.getModels()).toThrow('存储的自定义供应商 ark不合格式');
    expect(() => store.putModels(models())).toThrow('存储的自定义供应商不合格式');
    store.close();
  });

  it('自定义供应商换了接口地址的域名、端口或协议：原来存的 key 作废、不发到新地址，照样保存；只改路径不受影响', () => {
    const store = open();
    const ark = (baseUrl: string): CustomProvider => ({ baseUrl, api: 'openai-completions', models: [{ model: 'm' }] });
    const put = (baseUrl: string, keys?: ProviderKey[]) =>
      store.putModels(models({ providers: [{ provider: 'ark', custom: ark(baseUrl), ...(keys ? { keys } : {}) }] }));
    put('https://ark.cn-beijing.volces.com/api/v3', [{ name: '公司账号', key: SECRET }, { key: SECOND }]);
    // 同一个 origin：只改路径、写明默认端口、域名换大小写，key 照留
    for (const url of [
      'https://ark.cn-beijing.volces.com/api/v4',
      'https://ark.cn-beijing.volces.com:443/api/v3',
      'https://ARK.cn-beijing.volces.com/api/v3',
    ]) {
      put(url);
      expect(store.apiKeys('ark').map((k) => k.key)).toEqual([SECRET, SECOND]);
    }
    expect(warnings).toEqual([]);
    // 只改地址、不带 keys：原来的两个都作废，照样存下，这家显示没有 key
    const saved = put('https://evil.example.com/api/v3');
    expect(saved.providers).toEqual([{ provider: 'ark', custom: ark('https://evil.example.com/api/v3'), keys: [] }]);
    expect(store.apiKeys('ark')).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining('ark 的接口换了域名、端口或协议，原来存的 2 个 API key 作废了、不发到新地址'),
    ]);
    store.close();
  });

  it('换了地方时 PUT 带的 key：带 id 不带 key 的去掉，带了 key 的换成新值（id 不变），新加的照加；列表不对照样整份拒绝', () => {
    const store = open();
    const ark = (host: string): CustomProvider => ({
      baseUrl: `https://${host}/v1`,
      api: 'openai-completions',
      models: [{ model: 'm' }],
    });
    const put = (host: string, keys: ProviderKey[]) =>
      store.putModels(models({ providers: [{ provider: 'ark', custom: ark(host), keys }] }));
    const first = put('a.example.com', [
      { name: '公司账号', key: SECRET },
      { name: '个人账号', key: SECOND },
    ]);
    const [company, personal] = (first.providers[0]?.keys ?? []).map((k) => k.id as string);
    // 模型页那样带上原有的 id：没重新填的作废
    put('b.example.com', [
      { id: company, name: '公司账号' },
      { id: personal, name: '个人账号', key: 'sk-personal-new' },
      { name: '新账号', key: 'sk-third' },
    ]);
    expect(store.apiKeys('ark')).toEqual([
      { id: personal, name: '个人账号', key: 'sk-personal-new' },
      { id: expect.any(String), name: '新账号', key: 'sk-third' },
    ]);
    expect(warnings).toEqual([expect.stringContaining('原来存的 1 个 API key 作废了')]);
    // 换了地方也照样查：新加的没填、填了空的、同一个 key 填两次都整份拒绝，原来的不动、不提醒
    const bad: [ProviderKey[], RegExp][] = [
      [[{ name: '新账号' }], /还没填 key/],
      [[{ id: personal, key: '  ' }], /是空的/],
      [[{ key: 'sk-x' }, { key: 'sk-x' }], /同一个 key/],
    ];
    for (const [keys, message] of bad) expect(() => put('c.example.com', keys)).toThrow(message);
    expect(store.apiKeys('ark').map((k) => k.key)).toEqual(['sk-personal-new', 'sk-third']);
    expect(store.getModels().providers[0]?.custom).toEqual(ark('b.example.com'));
    expect(warnings).toHaveLength(1);
    store.close();
  });

  it('端口、协议变化，以及自定义供应商与内置供应商互换时清除原有 key', () => {
    const store = open();
    const mine = (baseUrl: string): CustomProvider => ({
      baseUrl,
      api: 'openai-completions',
      models: [{ model: 'm' }],
    });
    const put = (custom: CustomProvider | undefined, keys?: ProviderKey[]) =>
      store.putModels(
        models({ providers: [{ provider: 'mine', ...(custom ? { custom } : {}), ...(keys ? { keys } : {}) }] }),
      );
    const keys = () => store.apiKeys('mine').map((k) => k.key);
    const moves: [CustomProvider | undefined, CustomProvider | undefined][] = [
      [mine('http://127.0.0.1:8000/v1'), mine('http://127.0.0.1:8001/v1')], // 端口
      [mine('http://127.0.0.1:8001/v1'), mine('https://127.0.0.1:8001/v1')], // 协议
      [mine('https://127.0.0.1:8001/v1'), undefined], // 换成 pi 自带的：地址由 pi 的目录定
      [undefined, mine('https://127.0.0.1:8001/v1')], // pi 自带的换成自定义的
    ];
    for (const [from, to] of moves) {
      put(from, [{ key: SECRET }]);
      put(to);
      expect(keys()).toEqual([]);
    }
    store.close();
  });

  it('档位按顺序存：第一个是首选，后面是备用', () => {
    const store = open();
    const strong = [
      { provider: 'anthropic', model: 'claude-opus-5-5', tier: 'strong' as const },
      { ...DEEPSEEK, tier: 'strong' as const },
    ];
    store.putModels(models({ strong }));
    expect(store.getModels().strong).toEqual(strong);
    store.putModels(models({ strong: [...strong].reverse() }));
    expect(store.getModels().strong).toEqual([...strong].reverse());
    store.close();
  });

  it('重复的供应商、档位里重复的模型、tier 和档位不一致都拒绝', () => {
    const store = open();
    const bad: ModelsConfig[] = [
      models({ providers: [{ provider: 'deepseek' }, { provider: 'deepseek' }] }),
      models({
        fast: [
          { ...DEEPSEEK, tier: 'fast' },
          { ...DEEPSEEK, tier: 'fast' },
        ],
      }),
      models({ fast: [{ ...DEEPSEEK, tier: 'strong' }] }),
    ];
    for (const config of bad) expect(() => store.putModels(config)).toThrow(MelinaError);
    expect(() => store.putModels({ providers: [], strong: 'x' } as unknown as ModelsConfig)).toThrow(/不合格式/);
    store.close();
  });
});

describe('设置页', () => {
  const credential = { name: 'GitHub token', as: { env: 'GITHUB_TOKEN' }, value: 'ghp_secretvalue123' };

  it('凭证只写：GET 只回 hasValue，credentials() 给容器启动用', () => {
    const store = open();
    const saved = store.putSettings({ credentials: [credential], notify: true });
    expect(saved.credentials).toHaveLength(1);
    const c = saved.credentials[0];
    expect(c).toMatchObject({ name: 'GitHub token', as: { env: 'GITHUB_TOKEN' }, hasValue: true });
    expect(c?.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(JSON.stringify(saved)).not.toContain('ghp_secretvalue123');
    expect(store.credentials()).toEqual([
      { id: c?.id, name: 'GitHub token', as: { env: 'GITHUB_TOKEN' }, value: 'ghp_secretvalue123' },
    ]);
    store.close();
  });

  it('带 id 改名字和位置、不带 value 保留原值、空串删掉值、没列的删掉', () => {
    const store = open();
    const first = store.putSettings({
      credentials: [credential, { name: '测试库', as: { file: '/run/secrets/db.url' }, value: 'postgres://x' }],
      notify: true,
    });
    const [gh, testDb] = first.credentials;
    if (!gh?.id || !testDb?.id) throw new Error('没分配 id');
    const second = store.putSettings({
      credentials: [{ id: gh.id, name: 'GitHub 只读 token', as: { env: 'GH_TOKEN' } }],
      notify: false,
    });
    expect(second).toEqual({
      credentials: [{ id: gh.id, name: 'GitHub 只读 token', as: { env: 'GH_TOKEN' }, hasValue: true }],
      notify: false,
    });
    expect(store.credentials()[0]?.value).toBe('ghp_secretvalue123');
    store.putSettings({ credentials: [{ id: gh.id, name: 'x', as: { env: 'GH_TOKEN' }, value: '' }], notify: false });
    expect(store.getSettings().credentials[0]?.hasValue).toBe(false);
    expect(store.credentials()).toEqual([]);
    store.close();
  });

  it('不存在的 id、重复的 id、两个凭证放同一个位置都拒绝', () => {
    const store = open();
    const saved = store.putSettings({ credentials: [credential], notify: true });
    const id = saved.credentials[0]?.id as string;
    const bad: Settings[] = [
      { credentials: [{ ...credential, id: '01K6F1W3S2A8Q0Q6YH7J5M4N3P' }], notify: true },
      {
        credentials: [
          { ...credential, id },
          { ...credential, id },
        ],
        notify: true,
      },
      { credentials: [credential, { ...credential, name: '另一个' }], notify: true },
    ];
    for (const s of bad) expect(() => store.putSettings(s)).toThrow(MelinaError);
    expect(store.getSettings().credentials).toHaveLength(1); // 拒绝时整个不动
    store.close();
  });

  it('给不进容器的凭证保存时就拒，原因写人话（§11：以前要到起容器时才报错）', () => {
    const store = open();
    const bad: Settings['credentials'][number][] = [
      { ...credential, as: { env: 'PATH' } },
      { ...credential, as: { env: 'MELINA_EXEC' } },
      { ...credential, as: { env: 'LD_PRELOAD' } },
      { ...credential, as: { env: 'NODE_OPTIONS' } },
      { ...credential, as: { env: 'CUSTOM_TOKEN' } },
      { ...credential, value: 'a\0b' },
      { ...credential, as: { file: '/workspace/.env' } },
      { ...credential, as: { file: '/melina/materials/key' } },
    ];
    for (const c of bad) {
      let error: unknown;
      try {
        store.putSettings({ credentials: [c], notify: true });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MelinaError);
      expect((error as MelinaError).code).toBe('invalid');
      expect((error as MelinaError).message).toContain(credential.name);
    }
    expect(store.getSettings().credentials).toHaveLength(0);
    store.close();
  });

  it('凭证的密文绑在自己那一行：挪到别的行解不开', () => {
    const store = open();
    store.putSettings({
      credentials: [
        { name: 'a', as: { env: 'GH_TOKEN' }, value: 'value-of-a-123' },
        { name: 'b', as: { env: 'GITLAB_TOKEN' }, value: 'value-of-b-456' },
      ],
      notify: true,
    });
    store.close();
    const raw = new Database(db);
    const rows = raw.prepare('SELECT id, value FROM credentials ORDER BY rowid').all() as {
      id: string;
      value: Buffer;
    }[];
    raw.prepare('UPDATE credentials SET value = ? WHERE id = ?').run(rows[0]?.value, rows[1]?.id);
    raw.close();
    const again = open();
    expect(again.credentials().map((c) => c.name)).toEqual(['a']);
    again.close();
  });

  it('全局配置：不带 config 保留，带了整份换，{} 清掉回默认值', () => {
    const store = open();
    expect(store.global()).toEqual(DEFAULT_GLOBAL_CONFIG);
    store.putSettings({ credentials: [], notify: true, config: { limits: { toolExec: 2 } } });
    expect(store.global().limits).toEqual({ ...DEFAULT_GLOBAL_CONFIG.limits, toolExec: 2 });
    store.putSettings({ credentials: [], notify: false });
    expect(store.getSettings().config).toEqual({ limits: { toolExec: 2 } });
    expect(store.global().limits.toolExec).toBe(2);
    store.putSettings({ credentials: [], notify: false, config: {} });
    expect(store.getSettings().config).toBeUndefined();
    expect(store.global()).toEqual(DEFAULT_GLOBAL_CONFIG);
    store.close();
  });

  it('全局配置存储格式无效时拒绝读取，不回退到默认配置', () => {
    const raw = new Database(db);
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('config', JSON.stringify({ removed: true }));
    raw.close();
    const store = open();
    try {
      expect(() => store.getSettings()).toThrow('存储的全局配置不合格式');
      expect(() => store.global()).toThrow('存储的全局配置不合格式');
    } finally {
      store.close();
    }
  });

  it('通知默认开着', () => {
    const store = open();
    expect(store.getSettings()).toEqual({ credentials: [], notify: true });
    store.close();
  });
});

describe('初值和通知', () => {
  it('SDK 的构造参数只在没配过时用；配过以后哪怕全删了也不再填回去', () => {
    const store = open();
    store.seed({
      models: { strong: [{ ...DEEPSEEK, tier: 'strong' }], fast: [{ ...DEEPSEEK, tier: 'fast' }] },
      sandbox: { credentials: [{ name: 'token', as: { env: 'GH_TOKEN' }, value: 'tok-123456' }] },
    });
    expect(store.getModels()).toEqual({
      providers: [{ provider: 'deepseek', keys: [] }],
      strong: [{ ...DEEPSEEK, tier: 'strong' }],
      fast: [{ ...DEEPSEEK, tier: 'fast' }],
    });
    expect(store.credentials().map((c) => c.value)).toEqual(['tok-123456']);
    store.putModels({ providers: [], strong: [], fast: [] });
    store.close();
    const again = open();
    again.seed({ models: { strong: [{ ...DEEPSEEK, tier: 'strong' }], fast: [] } });
    expect(again.getModels()).toEqual({ providers: [], strong: [], fast: [] });
    again.close();
  });

  it('什么初值都没给（melina serve）不算配过：之后 SDK 给的初值照用', () => {
    const store = open();
    store.seed({});
    store.seed({ models: { strong: [{ ...DEEPSEEK, tier: 'strong' }], fast: [] } });
    expect(store.getModels().strong).toEqual([{ ...DEEPSEEK, tier: 'strong' }]);
    store.close();
  });

  it('先用页面配过的，SDK 的初值不覆盖', () => {
    const store = open();
    store.putModels(models());
    store.seed({ models: { strong: [], fast: [] }, sandbox: { credentials: [] } });
    expect(store.getModels().strong).toHaveLength(1);
    store.close();
  });

  it('SDK 初值里的 key 和自带 id 的凭证照存', () => {
    const store = open();
    store.seed({
      models: {
        strong: [{ ...DEEPSEEK, tier: 'strong' }],
        fast: [],
        providers: [{ provider: 'deepseek', keys: [{ name: '公司账号', key: SECRET }, { key: '' }] }],
      },
      sandbox: {
        credentials: [{ id: '01K6F1W3S2A8Q0Q6YH7J5M4N3P', name: 't', as: { env: 'GH_TOKEN' }, value: 'v-123456' }],
      },
    });
    // 构造参数里没设的 key（process.env.X 是空的）跳过
    expect(store.apiKeys('deepseek')).toEqual([{ id: expect.any(String), name: '公司账号', key: SECRET }]);
    expect(store.getSettings().credentials[0]?.id).toBe('01K6F1W3S2A8Q0Q6YH7J5M4N3P');
    store.close();
  });

  it('改了就通知：模型、设置分开', () => {
    const store = open();
    const seen: string[] = [];
    const off = store.onChange((what) => seen.push(what));
    store.putModels(models());
    store.putSettings({ credentials: [], notify: true });
    off();
    store.putModels(models());
    expect(seen).toEqual(['models', 'settings']);
    store.close();
  });

  it('数据库还没建表就打不开，说清楚原因', () => {
    const empty = join(dir, 'empty.db');
    expect(() => new SqliteConfigStore({ db: empty, secrets: box })).toThrow(/openRunStore/);
  });
});

describe('密钥', () => {
  it('密钥文件第一次用时生成，0600，之后读同一个', () => {
    const file = join(dir, 'sub', 'melina.key');
    const a = loadOrCreateKeyFile(file);
    expect(a).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateKeyFile(file).equals(a)).toBe(true);
  });

  it('密钥文件坏了就报错，不悄悄换一个新的', () => {
    const file = join(dir, 'melina.key');
    writeFileSync(file, 'not a key\n');
    expect(() => loadOrCreateKeyFile(file)).toThrow(/坏了/);
  });

  it('环境变量里的密钥认 base64 和 hex，长度不对就拒绝', () => {
    const key = randomBytes(32);
    expect(parseSecretKey(key.toString('base64')).equals(key)).toBe(true);
    expect(parseSecretKey(key.toString('hex')).equals(key)).toBe(true);
    expect(() => parseSecretKey('short')).toThrow(/32 字节/);
  });

  it('密文带版本、随机 IV，同样的明文每次不一样；改一个字节就解不开', () => {
    const one = box.seal('hello', 'a');
    const two = box.seal('hello', 'a');
    expect(one.equals(two)).toBe(false);
    expect(box.open(one, 'a')).toBe('hello');
    expect(box.open(one, 'b')).toBeUndefined();
    const broken = Buffer.from(one);
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 1;
    expect(box.open(broken, 'a')).toBeUndefined();
  });
});
