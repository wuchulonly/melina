import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiError,
  type BranchDiffResponse,
  type DirsResponse,
  ModelCatalogResponse,
} from '../../../src/core/api.ts';
import type { ModelsConfig, Settings } from '../../../src/core/config.ts';
import { SystemStatus } from '../../../src/core/events.ts';
import { ROOT, sha256OfHandle } from '../../../src/core/ids.ts';
import { isValid } from '../../../src/core/validate.ts';
import { openRunStore } from '../../../src/storage/state.ts';
import { HOST, json, MODEL, ORIGIN, type TestMelina, tempDir, testMelina } from './kit.ts';

async function error(res: Response): Promise<ApiError['error']> {
  return (await json<ApiError>(res)).error;
}
describe('访问规则（§15）：Host 和 Origin', () => {
  let k: TestMelina;
  beforeAll(async () => {
    k = await testMelina();
  });
  afterAll(async () => k.close());

  it('Host 不是 127.0.0.1 或 localhost 加端口的拒绝（DNS 重绑定）', async () => {
    for (const host of ['evil.example:7474', '127.0.0.1:9999', 'localhost', '127.0.0.1.nip.io:7474']) {
      const res = await k.request('/api/runs', { host });
      expect(res.status, host).toBe(403);
      expect((await error(res)).code).toBe('forbidden');
    }
    expect((await k.request('/api/runs', { host: 'localhost:7474' })).status).toBe(200);
    expect((await k.request('/', { host: 'evil.example:7474' })).status).toBe(403);
  });

  it('带了 Origin 就必须是 Melina 自己的', async () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'null', 'http://localhost.evil:7474']) {
      const res = await k.request('/api/runs', { origin });
      expect(res.status, origin).toBe(403);
    }
    expect((await k.request('/api/runs', { origin: 'http://localhost:7474' })).status).toBe(200);
    expect((await k.request('/api/runs', { origin: ORIGIN })).status).toBe(200);
    const post = await k.request('/api/runs/01K6F1W3S2A8Q0Q6YH7J5M4N3P/cancel', {
      method: 'POST',
      origin: 'https://evil.example',
    });
    expect(post.status).toBe(403);
  });

  it('没带 Origin 的同源 GET 和命令行工具放行；别的网站拿 <img> 引用接口不行，点链接打开页面可以', async () => {
    expect((await k.request('/api/runs')).status).toBe(200);
    const sub = await k.request('/api/runs', {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
    });
    expect(sub.status).toBe(403);
    const nav = await k.request('/runs', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
    expect(nav.status).toBe(200);
    const navApi = await k.request('/api/runs', {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
    });
    expect(navApi.status).toBe(403);
    const same = await k.request('/api/runs', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(same.status).toBe(200);
  });
});

describe('新建任务（POST /runs）', () => {
  let k: TestMelina;
  let home: string;
  beforeAll(async () => {
    home = tempDir('melina-home-');
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    writeFileSync(join(home, 'file.txt'), 'x');
    k = await testMelina({ home });
  });
  afterAll(async () => {
    await k.close();
    rmSync(home, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    k.request('/api/runs', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      origin: ORIGIN,
    });

  it('JSON：回 201 和 runId；工作目录按 home 展开成绝对路径交给 RunManager', async () => {
    const res = await post({
      statement: '把测试修好',
      workspace: '~/repo',
      config: { continuation: { enabled: true } },
    });
    expect(res.status).toBe(201);
    const { runId } = await json<{ runId: string }>(res);
    expect(k.melina.run(runId).get().goal.statement).toBe('把测试修好');
    const call = k.runs.calls.findLast((c) => c.method === 'create');
    expect(call?.method === 'create' && call.input).toMatchObject({
      statement: '把测试修好',
      workspace: join(home, 'repo'),
      config: { continuation: { enabled: true } },
      materials: [],
    });
  });

  it('不给工作目录就不传（RunManager 自己建空目录）', async () => {
    expect((await post({ statement: '写个报告' })).status).toBe(201);
    const call = k.runs.calls.findLast((c) => c.method === 'create');
    expect(call?.method === 'create' && 'workspace' in call.input && call.input.workspace).toBeFalsy();
  });

  it('工作目录不存在、不是目录、在数据目录里或包含数据目录都拒绝', async () => {
    const cases: [string, string][] = [
      ['~/nope', '不存在'],
      ['~/file.txt', '不是目录'],
      [k.melina.paths.dataDir, '在 Melina 的数据目录里'],
      [join(k.melina.paths.artifacts, '..'), '包含 Melina 的数据目录'],
    ];
    for (const [workspace, message] of cases) {
      const res = await post({ statement: 'x', workspace });
      expect(res.status, workspace).toBe(400);
      expect((await error(res)).message).toContain(message);
    }
  });

  it('接着做：不许同时给工作目录；接着的任务要存在', async () => {
    const res = await post({ statement: 'x', workspace: '~/repo', continueFrom: '01K6F1W3S2A8Q0Q6YH7J5M4N3P' });
    expect(res.status).toBe(400);
    const missing = await post({ statement: 'x', continueFrom: '01K6F1W3S2A8Q0Q6YH7J5M4N3P' });
    expect(missing.status).toBe(400); // 引用的 id 不存在算 invalid（core/errors.ts）
    expect((await error(missing)).message).toContain('接着做的任务不存在');
  });

  it('multipart：run 字段放 JSON，附件保留原文件名（只取最后一段），交给 RunManager 时文件还在，之后删掉', async () => {
    const form = new FormData();
    form.append('run', JSON.stringify({ statement: '看看这两份材料' }));
    form.append('materials', new Blob(['第一份']), '需求说明.md');
    form.append('materials', new Blob([new Uint8Array([1, 2, 3])]), '../../etc/data.bin');
    form.append('other', new Blob(['丢掉']), 'ignored.txt');
    const res = await k.request('/api/runs', { method: 'POST', body: form, origin: ORIGIN });
    expect(res.status).toBe(201);
    const call = k.runs.calls.findLast((c) => c.method === 'create');
    if (call?.method !== 'create') throw new Error('没调 create');
    expect(call.input.materials.map((f) => f.name)).toEqual(['需求说明.md', 'data.bin']);
    expect(call.contents[0]).toBe('第一份');
    const { runId } = await json<{ runId: string }>(res);
    expect(
      k.melina
        .run(runId)
        .get()
        .goal.materials.map((m) => m.name),
    ).toEqual(['需求说明.md', 'data.bin']);
    expect(readdirSync(k.melina.paths.uploads)).toEqual([]);
  });

  it('multipart 缺 run 字段、run 不是 JSON 都拒绝，临时文件也删掉', async () => {
    const noRun = new FormData();
    noRun.append('materials', new Blob(['x']), 'a.txt');
    const a = await k.request('/api/runs', { method: 'POST', body: noRun, origin: ORIGIN });
    expect(a.status).toBe(400);
    expect((await error(a)).message).toContain('run 字段');
    const badRun = new FormData();
    badRun.append('run', '{');
    const b = await k.request('/api/runs', { method: 'POST', body: badRun, origin: ORIGIN });
    expect(b.status).toBe(400);
    expect(readdirSync(k.melina.paths.uploads)).toEqual([]);
  });

  it('运行时出错（比如还没接上）原样回给前端，临时文件照样删', async () => {
    const original = k.runs.create.bind(k.runs);
    k.runs.create = async () => {
      const { MelinaError } = await import('../../../src/core/errors.ts');
      throw new MelinaError('unavailable', '运行时还没接上');
    };
    try {
      const form = new FormData();
      form.append('run', JSON.stringify({ statement: 'x' }));
      form.append('materials', new Blob(['x']), 'a.txt');
      const res = await k.request('/api/runs', { method: 'POST', body: form, origin: ORIGIN });
      expect(res.status).toBe(503);
      expect((await error(res)).code).toBe('unavailable');
      expect(readdirSync(k.melina.paths.uploads)).toEqual([]);
    } finally {
      k.runs.create = original;
    }
  });
});

describe('附件的上限', () => {
  it('个数、单个大小、总大小超了都拒绝，已经收下的临时文件删掉', async () => {
    const k = await testMelina();
    const app = k.melina.app({
      port: 7474,
      access: (await import('../../../src/api/access.ts')).accessPolicy(7474),
      uploadLimits: { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15, maxFieldBytes: 1000 },
    });
    const send = (form: FormData) =>
      app.request(`http://${HOST}/api/runs`, { method: 'POST', body: form, headers: { host: HOST, origin: ORIGIN } });
    const make = (...files: string[]) => {
      const form = new FormData();
      form.append('run', JSON.stringify({ statement: 'x' }));
      files.forEach((c, i) => {
        form.append('materials', new Blob([c]), `f${i}.txt`);
      });
      return form;
    };
    try {
      const tooMany = await send(make('a', 'b', 'c'));
      expect(tooMany.status).toBe(400);
      expect((await error(tooMany)).message).toContain('最多 2 个');
      const tooBig = await send(make('0123456789AB'));
      expect(tooBig.status).toBe(400);
      expect((await error(tooBig)).message).toContain('太大');
      const tooMuch = await send(make('0123456789', '0123456789'));
      expect(tooMuch.status).toBe(400);
      expect((await error(tooMuch)).message).toContain('加起来太大');
      expect(readdirSync(k.melina.paths.uploads)).toEqual([]);
      expect((await send(make('ok', 'fine'))).status).toBe(201);
    } finally {
      await k.close();
    }
  });
});

describe('模型和设置（§15）：key 和凭证只写，加密存', () => {
  let k: TestMelina;
  beforeAll(async () => {
    k = await testMelina();
  });
  afterAll(async () => k.close());

  const put = (path: string, body: unknown) =>
    k.request(path, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      origin: ORIGIN,
    });

  it('模型页：存完回 hasKey，不回 key；数据库里也找不到明文', async () => {
    expect(await json(await k.request('/api/models'))).toEqual({ providers: [], strong: [], fast: [] });
    const config: ModelsConfig = {
      providers: [{ provider: 'deepseek', keys: [{ name: '公司账号', key: 'sk-very-secret-key-123' }] }],
      strong: [{ provider: 'deepseek', model: 'deepseek-flash', tier: 'strong' }],
      fast: [{ provider: 'deepseek', model: 'deepseek-flash', tier: 'fast' }],
    };
    const res = await put('/api/models', config);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-very-secret-key-123');
    expect(JSON.parse(text).providers).toEqual([
      { provider: 'deepseek', keys: [{ id: expect.any(String), name: '公司账号', hasKey: true }] },
    ]);
    expect(await (await k.request('/api/models')).text()).not.toContain('sk-very-secret-key-123');
    const raw = new Database(join(k.dir, 'melina.db'), { readonly: true });
    const dump = JSON.stringify([
      raw.prepare('SELECT * FROM providers').all(),
      raw.prepare('SELECT * FROM provider_keys').all(),
    ]);
    raw.close();
    expect(dump).not.toContain('sk-very-secret-key-123');
  });

  it('模型页：pi 的目录里没有的供应商、模型拒绝，说清楚是哪个', async () => {
    const res = await put('/api/models', {
      providers: [{ provider: 'no-such-provider' }],
      strong: [{ provider: 'deepseek', model: 'no-such-model', tier: 'strong' }],
      fast: [],
    });
    expect(res.status).toBe(400);
    const e = await error(res);
    expect(e.message).toContain('no-such-provider');
    expect(e.details).toEqual([
      '不支持供应商 no-such-provider；当前仅启用 DeepSeek',
      '模型目录里没有模型 deepseek/no-such-model',
    ]);
  });

  it('设置页：凭证只回 hasValue；数据库里是密文', async () => {
    const settings: Settings = {
      credentials: [{ name: 'GitHub token', as: { env: 'GITHUB_TOKEN' }, value: 'ghp_topsecret_value' }],
      notify: false,
    };
    const res = await put('/api/settings', settings);
    expect(res.status).toBe(200);
    const saved = await json<Settings>(res);
    expect(saved.credentials[0]).toMatchObject({ name: 'GitHub token', hasValue: true });
    expect(saved.notify).toBe(false);
    expect(JSON.stringify(await json(await k.request('/api/settings')))).not.toContain('ghp_topsecret_value');
    const raw = new Database(join(k.dir, 'melina.db'), { readonly: true });
    const dump = JSON.stringify(raw.prepare('SELECT * FROM credentials').all());
    raw.close();
    expect(dump).not.toContain('ghp_topsecret_value');
    const bad = await put('/api/settings', { credentials: [{ name: 'x', as: { env: '1BAD' } }], notify: true });
    expect(bad.status).toBe(400);
  });

  it('设置页：给不进容器的凭证保存时就拒（400），原因写人话，原来的不动（C02）', async () => {
    const before = await json<Settings>(await k.request('/api/settings'));
    const res = await put('/api/settings', {
      credentials: [{ name: '部署 key', as: { file: '/workspace/.ssh/id_ed25519' }, value: 'k' }],
      notify: true,
    });
    expect(res.status).toBe(400);
    const e = await error(res);
    expect(e.code).toBe('invalid');
    expect(e.message).toContain('凭证「部署 key」的文件不能放在');
    expect(await json<Settings>(await k.request('/api/settings'))).toEqual(before);
  });

  it('模型目录只列出 DeepSeek，上下文、价格与 Key 状态正常且不泄露密钥', async () => {
    const catalog = await json<ModelCatalogResponse>(await k.request('/api/models/catalog'));
    expect(isValid(ModelCatalogResponse, catalog)).toBe(true);
    expect(catalog.providers.map((p) => p.provider)).toEqual(['deepseek']);
    expect(catalog.providers[0]).toMatchObject({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      hasKey: true,
    });
    const flash = catalog.providers[0]?.models.find((m) => m.model === 'deepseek-flash');
    expect(flash?.contextWindow).toBeGreaterThan(0);
    expect(flash?.price?.input).toBeGreaterThan(0);
    const saved = await put('/api/models', {
      providers: [{ provider: 'deepseek', keys: [{ key: 'sk-deepseek-test' }] }],
      strong: [],
      fast: [],
    });
    expect(saved.status).toBe(200);
    const after = await json<ModelCatalogResponse>(await k.request('/api/models/catalog'));
    expect(after.providers[0]?.hasKey).toBe(true);
    expect(JSON.stringify(after)).not.toContain('sk-deepseek-test');
  });

  it('其他供应商及旧自定义接口明确拒绝，不进入模型目录', async () => {
    const custom = {
      name: 'legacy',
      baseUrl: 'https://legacy.invalid',
      api: 'openai-completions',
      models: [{ model: 'old' }],
    };
    for (const provider of ['ark', 'deepseek']) {
      const saved = await put('/api/models', { providers: [{ provider, custom }], strong: [], fast: [] });
      expect(saved.status).toBe(400);
      expect((await error(saved)).message).toContain('不再支持自定义供应商');
    }
    const removed = await put('/api/models', { providers: [{ provider: 'openai' }], strong: [], fast: [] });
    expect(removed.status).toBe(400);
    expect((await error(removed)).message).toContain('当前仅启用 DeepSeek');
  });
});

describe('在跑路线的改动（GET /runs/:id/branches/:branchId/diff，C07）', () => {
  let k: TestMelina;
  let root: string;
  beforeAll(async () => {
    k = await testMelina();
    root = join(k.dir, 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'a.txt'), 'one\n');
  });
  afterAll(async () => k.close());

  /** 一个 dir-copy 的 Run，打好根 snapshot，带一条还没收过尾的路线 */
  async function liveRoute() {
    const run = await k.runs.create({ statement: '把 a.txt 改成 two', workspace: root, materials: [] });
    const deps = k.runs.deps;
    const provider = deps.workspaces.forRun(run);
    await provider.init(run);
    const bet = deps.writer.createBet({
      runId: run.id,
      kind: 'direct',
      label: '主干直解路线',
      startFrom: { snapshot: ROOT },
      model: MODEL,
      source: { kind: 'template' },
    });
    const created = deps.writer.createBranch({ runId: run.id, betId: bet.id, lastSnapshot: ROOT });
    const branch = deps.writer.updateBranch(created.id, { state: 'running', queued: false });
    /** 路线收一次尾，lastSnapshot 换成这一版；RunStore 中需有对应的 snapshot 记录。 */
    const close = (snapshot: string) => {
      const current = deps.queries.getBranch(branch.id);
      if (!current) throw new Error('路线不见了');
      deps.writer.closeEpisode({
        branchId: branch.id,
        episode: current.episode,
        outcome: 'failed',
        failure: 'no_close',
        snapshot: { id: snapshot },
      });
    };
    return { run, provider, branch, close };
  }

  const diff = async (runId: string, branchId: string) => {
    const res = await k.request(`/api/runs/${runId}/branches/${branchId}/diff`);
    expect(res.status).toBe(200);
    return json<BranchDiffResponse>(res);
  };

  it('还没收过尾只回 snapshot；没改文件不带 patch；改了回相对起点的 patch，内容照产物取', async () => {
    const { run, provider, branch, close } = await liveRoute();
    expect(await diff(run.id, branch.id)).toEqual({ snapshot: ROOT });
    const ws = await provider.create(ROOT);
    const same = await provider.snapshot(ws);
    close(same);
    expect(await diff(run.id, branch.id)).toEqual({ snapshot: same });
    writeFileSync(join(ws.path, 'a.txt'), 'two\n');
    const changed = await provider.snapshot(ws);
    close(changed);
    const got = await diff(run.id, branch.id);
    expect(got.snapshot).toBe(changed);
    expect(got.patch).toBeDefined();
    const text = await (
      await k.request(`/api/runs/${run.id}/artifacts/${sha256OfHandle(got.patch ?? 'art://x')}`)
    ).text();
    expect(text).toContain('-one');
    expect(text).toContain('+two');
  });

  it('同一版只算一次：并发的请求等同一次，之后的直接用', async () => {
    const { run, provider, branch, close } = await liveRoute();
    const ws = await provider.create(ROOT);
    writeFileSync(join(ws.path, 'b.txt'), 'new\n');
    const snap = await provider.snapshot(ws);
    close(snap);
    let calls = 0;
    const original = provider.diffSnapshots.bind(provider);
    provider.diffSnapshots = async (base, target) => {
      calls++;
      return original(base, target);
    };
    const [a, b] = await Promise.all([diff(run.id, branch.id), diff(run.id, branch.id)]);
    const c = await diff(run.id, branch.id);
    expect(calls).toBe(1);
    expect(a.patch).toBeDefined();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('读到的那一版刚被清理（路线又收了一次尾）：按新的那版再算', async () => {
    const { run, provider, branch, close } = await liveRoute();
    const ws = await provider.create(ROOT);
    writeFileSync(join(ws.path, 'a.txt'), 'first\n');
    const old = await provider.snapshot(ws);
    close(old);
    writeFileSync(join(ws.path, 'a.txt'), 'second\n');
    const next = await provider.snapshot(ws);
    const original = provider.diffSnapshots.bind(provider);
    provider.diffSnapshots = async (base, target) => {
      if (target === old) {
        // 正要算的时候路线收了尾、老的那版被清理
        close(next);
        await provider.prune(ws, [next]);
      }
      return original(base, target);
    };
    const got = await diff(run.id, branch.id);
    expect(got.snapshot).toBe(next);
    const text = await (
      await k.request(`/api/runs/${run.id}/artifacts/${sha256OfHandle(got.patch ?? 'art://x')}`)
    ).text();
    expect(text).toContain('+second');
  });

  it('没有的任务、没有的路线、别的任务的路线、不是 id 的都是 404', async () => {
    const one = await liveRoute();
    const other = await liveRoute();
    for (const path of [
      `/api/runs/01K6F1W3S2A8Q0Q6YH7J5M4N3P/branches/${one.branch.id}/diff`,
      `/api/runs/${one.run.id}/branches/01K6F1W3S2A8Q0Q6YH7J5M4N3P/diff`,
      `/api/runs/${one.run.id}/branches/${other.branch.id}/diff`,
      `/api/runs/${one.run.id}/branches/not-an-id/diff`,
    ]) {
      const res = await k.request(path);
      expect(res.status, path).toBe(404);
      expect((await error(res)).code).toBe('not_found');
    }
  });
});

describe('系统状态、用量、目录补全', () => {
  let k: TestMelina;
  let home: string;
  beforeAll(async () => {
    home = tempDir('melina-home-');
    for (const d of ['alpha/.git', 'Alpine', 'beta', '.hidden']) mkdirSync(join(home, d), { recursive: true });
    k = await testMelina({ home });
  });
  afterAll(async () => {
    await k.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('GET /api/status 合 SystemStatus 的格式', async () => {
    const status = await json(await k.request('/api/status'));
    expect(isValid(SystemStatus, status)).toBe(true);
  });

  it('GET /api/usage 是账本按模型、按天的汇总', async () => {
    const usage = await json<{ total: { input: number } }>(await k.request('/api/usage'));
    const runStore = openRunStore({ db: join(k.dir, 'melina.db') });
    try {
      expect(usage).toEqual(JSON.parse(JSON.stringify(runStore.queries.usageReport())));
    } finally {
      runStore.close();
    }
  });

  it('GET /api/dirs：~ 展开、前缀不分大小写、标出 git 仓库、隐藏目录要以「.」开头才列', async () => {
    const all = await json<DirsResponse>(await k.request(`/api/dirs?prefix=${encodeURIComponent('~/')}`));
    expect(all.dir).toBe(home);
    expect(all.entries.map((e) => [e.name, e.git])).toEqual([
      ['alpha', true],
      ['Alpine', false],
      ['beta', false],
    ]);
    const al = await json<DirsResponse>(await k.request(`/api/dirs?prefix=${encodeURIComponent('~/al')}`));
    expect(al.entries.map((e) => e.name)).toEqual(['alpha', 'Alpine']);
    const hidden = await json<DirsResponse>(await k.request(`/api/dirs?prefix=${encodeURIComponent('~/.h')}`));
    expect(hidden.entries.map((e) => e.name)).toEqual(['.hidden']);
    const empty = await json<DirsResponse>(await k.request('/api/dirs'));
    expect(empty.entries).toEqual([]);
  });

  it('GET /api/dirs 不列 Melina 的数据目录', async () => {
    const parent = join(k.melina.paths.artifacts, '..');
    const res = await json<DirsResponse>(await k.request(`/api/dirs?prefix=${encodeURIComponent(`${parent}/`)}`));
    const listed = res.entries.map((e) => e.path);
    expect(listed).not.toContain(k.melina.paths.artifacts);
    expect(listed).not.toContain(k.melina.paths.dataDir);
    const inside = await json<DirsResponse>(
      await k.request(`/api/dirs?prefix=${encodeURIComponent(`${k.melina.paths.dataDir}/`)}`),
    );
    expect(inside.entries).toEqual([]);
  });
});

describe('托管前端', () => {
  let web: string;
  let k: TestMelina;
  beforeAll(async () => {
    web = tempDir('melina-web-');
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(web, 'assets', 'index-abc.js'), 'console.log(1)');
    writeFileSync(join(web, 'favicon.svg'), '<svg/>');
    k = await testMelina({ web });
  });
  afterAll(async () => {
    await k.close();
    rmSync(web, { recursive: true, force: true });
  });

  it('首页和前端自己的路由都回 index.html，带 CSP、不许被 iframe 套', async () => {
    for (const path of ['/', '/runs/01K6F1W3S2A8Q0Q6YH7J5M4N3P', '/models', '/settings']) {
      const res = await k.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  it('/assets 下的长缓存；找不到的文件是 404，不回 index.html', async () => {
    const js = await k.request('/assets/index-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await k.request('/assets/missing.js')).status).toBe(404);
    expect((await k.request('/missing.png')).status).toBe(404);
    expect((await k.request('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');
  });

  it('跳不出前端目录', async () => {
    for (const path of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2findex.html']) {
      const res = await k.request(path);
      const text = await res.text();
      expect(text, path).not.toContain('root:');
    }
  });

  it('前端还没打包时首页放一段说明', async () => {
    const bare = await testMelina();
    try {
      const res = await bare.request('/');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('pnpm --dir web build');
    } finally {
      await bare.close();
    }
  });
});
