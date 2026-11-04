// 组装时的胶水（assemble.ts）和系统状态（status.ts）。

import { describe, expect, it, vi } from 'vitest';
import { shellCommand, shellQuote, workspaceExec } from '../../../src/api/assemble.ts';
import {
  containerNotices,
  diskFree,
  modelNotices,
  startStatusReporter,
  systemStatus,
} from '../../../src/api/status.ts';
import { DEFAULT_GLOBAL_CONFIG, DEFAULT_RUN_CONFIG, resolveGlobalConfig } from '../../../src/core/config.ts';
import type { ProviderStatus, SystemNotice, SystemStatus } from '../../../src/core/events.ts';
import type { ContainerExecRequest, ContainerRef, ContainerSpec } from '../../../src/core/interfaces/container.ts';
import type { ModelRef, Tier } from '../../../src/core/model-ref.ts';
import type { Run } from '../../../src/core/types.ts';

const RUN_ID = '01K6F1W3S2A8Q0Q6YH7J5M4N3P';
const KEY = '01K6F1W3S2A8Q0Q6YH7J5M4K01';
const run = {
  id: RUN_ID,
  seq: 1,
  goal: { statement: 'x', constraints: [], materials: [], domain: 'code' },
  workspace: { root: '/tmp/x', kind: 'dir-copy' },
  mode: 'direct',
  status: 'running',
  config: DEFAULT_RUN_CONFIG,
  createdAt: '2026-10-02T00:00:00.000Z',
} as Run;

function fakeContainers(running?: ContainerRef) {
  const calls: { op: string; spec?: ContainerSpec; req?: ContainerExecRequest; ref?: ContainerRef }[] = [];
  return {
    calls,
    forWorkspace: vi.fn((_path: string, _opts?: { writable?: boolean }) => running),
    ephemeral: vi.fn(async (spec: ContainerSpec) => {
      calls.push({ op: 'ephemeral', spec });
      return { id: 'tmp1', name: spec.name };
    }),
    exec: vi.fn(async (ref: ContainerRef, req: ContainerExecRequest) => {
      calls.push({ op: 'exec', ref, req });
      return { exitCode: 0, output: 'ok\n', timedOut: false, cancelled: false, durationMs: 5 };
    }),
    remove: vi.fn(async (ref: ContainerRef) => {
      calls.push({ op: 'remove', ref });
    }),
  };
}

describe('workspace 的 exec（之间的胶水）', () => {
  const credentials = [{ id: RUN_ID, name: 't', as: { env: 'GH_TOKEN' }, value: 'secret-1' }];
  const queries = { getRun: (id: string) => (id === RUN_ID ? run : undefined) };
  const config = { credentials: () => credentials, global: () => DEFAULT_GLOBAL_CONFIG };

  it('有可写挂着这个 workspace、正在跑的容器就在里面跑', async () => {
    const containers = fakeContainers({ id: 'c1', name: 'melina-branch' });
    const exec = workspaceExec({ containers, queries, config });
    const r = await exec({ path: '/ws/1', runId: RUN_ID } as never, ['bash', '-lc', 'npm ci'], { timeoutMs: 1000 });
    expect(r).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, cancelled: false, durationMs: 5 });
    expect(containers.forWorkspace).toHaveBeenCalledWith('/ws/1', { writable: true });
    expect(containers.calls).toEqual([
      { op: 'exec', ref: { id: 'c1', name: 'melina-branch' }, req: { cmd: 'npm ci', timeoutMs: 1000 } },
    ]);
  });

  it('没有就按 Run 的领域和凭证起一个临时容器，跑完删掉', async () => {
    const containers = fakeContainers();
    const exec = workspaceExec({ containers, queries, config });
    await exec({ path: '/ws/2', runId: RUN_ID } as never, ['git', 'status'], { cwd: 'sub', env: { A: '1' } });
    const [created, ran, removed] = containers.calls;
    expect(created?.spec).toMatchObject({
      domain: 'code',
      workspace: { host: '/ws/2', container: '/workspace', readOnly: false },
      credentials,
    });
    expect(created?.spec?.name).toMatch(new RegExp(`^melina-${RUN_ID.toLowerCase()}-exec-`));
    expect(ran?.req).toMatchObject({ cmd: 'git status', cwd: 'sub', env: { A: '1' } });
    expect(removed?.op).toBe('remove');
  });

  it.each([
    { domain: 'ctf', domains: ['general', 'ctf'], expected: 'ctf' },
    { domain: undefined, domains: ['general', 'ctf'], expected: 'general' },
    { domain: 'missing', domains: ['general', 'ctf'], expected: 'general' },
    { domain: undefined, domains: ['ctf'], expected: 'ctf' },
  ])('setup 的临时容器遵循同一领域选择：$domain / $domains', async ({ domain, domains, expected }) => {
    const containers = fakeContainers();
    const task = { ...run, goal: { ...run.goal, domain } };
    const exec = workspaceExec({
      containers,
      queries: { getRun: () => task },
      config: { ...config, global: () => ({ ...DEFAULT_GLOBAL_CONFIG, domains }) },
    });
    await exec({ path: '/ws/setup', runId: RUN_ID } as never, ['true'], {});
    expect(containers.calls[0]?.spec?.domain).toBe(expected);
  });

  it('跑出错也删临时容器；认不出是哪个任务的就报错', async () => {
    const containers = fakeContainers();
    containers.exec.mockRejectedValueOnce(new Error('容器坏了'));
    const exec = workspaceExec({ containers, queries, config });
    await expect(exec({ path: '/ws/3', runId: RUN_ID } as never, ['true'], {})).rejects.toThrow('容器坏了');
    expect(containers.remove).toHaveBeenCalledTimes(1);
    await expect(exec({ path: '/ws/4' } as never, ['true'], {})).rejects.toThrow('是哪个任务的');
  });

  it('argv 变成一行 shell：bash -lc 加一条命令的直接取那条，其余加引号', () => {
    expect(shellCommand(['bash', '-lc', 'npm ci && npm test'])).toBe('npm ci && npm test');
    expect(shellCommand(['sh', '-c', 'echo hi'])).toBe('echo hi');
    expect(shellCommand(['git', 'commit', '-m', "it's done"])).toBe(`git commit -m 'it'\\''s done'`);
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('plain-1.0/x')).toBe('plain-1.0/x');
  });
});

describe('系统状态', () => {
  const registry = {
    providers: () => ['deepseek', 'anthropic'],
    breakers: () => [
      {
        provider: 'deepseek',
        breaker: 'open' as const,
        reason: '401：API key 无效',
        keys: [{ id: KEY, name: '公司账号', state: 'down' as const, reason: '401：API key 无效' }],
      },
      { provider: 'anthropic', breaker: 'ok' as const },
    ],
  };
  const queries = {
    listRuns: (filter?: { status?: string[] }) =>
      [{ status: 'running' }, { status: 'paused' }, { status: 'done' }].filter(
        (r) => !filter?.status || filter.status.includes(r.status),
      ) as Run[],
  };

  it('熔断和每个 key 的状况来自模型层，容量和排队来自 Scheduler，任务数从 RunStore 数', () => {
    const status = systemStatus({
      registry,
      queries,
      global: () => DEFAULT_GLOBAL_CONFIG,
      dataDir: '/',
      diskFree: () => 50 * 1024 ** 3,
      scheduler: {
        status: () => ({
          providers: [
            {
              provider: 'anthropic',
              limit: 6,
              inFlight: 6,
              queued: 2,
              episodes: { running: 2, queued: 1 },
              retryAt: '2026-10-02T00:00:00.000Z',
            },
          ],
          toolExec: { limit: 3, running: 3, queued: 1, auto: true },
          disk: { freeBytes: 7, minBytes: 10, ok: false },
        }),
      },
    });
    expect(status).toEqual({
      providers: [
        {
          provider: 'deepseek',
          breaker: 'open',
          reason: '401：API key 无效',
          limit: null,
          inFlight: 0,
          queued: 0,
          episodes: { running: 0, queued: 0 },
          keys: [{ id: KEY, name: '公司账号', state: 'down', reason: '401：API key 无效' }],
        },
        {
          provider: 'anthropic',
          breaker: 'ok',
          limit: 6,
          inFlight: 6,
          queued: 2,
          episodes: { running: 2, queued: 1 },
          retryAt: '2026-10-02T00:00:00.000Z',
        },
      ],
      toolExec: { limit: 3, running: 3, queued: 1, auto: true },
      disk: { freeBytes: 7, minBytes: 10, ok: false },
      runs: { running: 1, paused: 1 },
      // 磁盘不够是要人知道的事（C03）
      notices: [{ kind: 'disk', level: 'error', text: expect.stringContaining('新的路线先不开') }],
    } satisfies SystemStatus);
  });

  it('没有 Scheduler（运行时还没接上）：按空闲算，磁盘自己看', () => {
    const status = systemStatus({
      registry,
      queries,
      global: () => ({ ...DEFAULT_GLOBAL_CONFIG, limits: { ...DEFAULT_GLOBAL_CONFIG.limits, toolExec: 2 } }),
      dataDir: '/',
      diskFree: () => 5 * 1024 ** 3,
      cpus: 8,
    });
    expect(status.toolExec).toEqual({ limit: 2, running: 0, queued: 0, auto: false });
    expect(status.disk).toEqual({ freeBytes: 5 * 1024 ** 3, minBytes: 10 * 1024 ** 3, ok: false });
  });

  it('剩余磁盘：目录还没建就看上一级', () => {
    expect(diskFree('/definitely/not/here/melina')).toBeGreaterThan(0);
  });

  it('system.updated 变了才发；剩余磁盘的小抖动不算变', async () => {
    let free = 50 * 1024 ** 3;
    let breaker: 'ok' | 'open' = 'ok';
    const emitted: SystemStatus[] = [];
    const reporter = startStatusReporter({
      compute: () => ({
        providers: [
          { provider: 'x', breaker, limit: null, inFlight: 0, queued: 0, episodes: { running: 0, queued: 0 } },
        ],
        toolExec: { limit: 1, running: 0, queued: 0, auto: true },
        disk: { freeBytes: free, minBytes: 0, ok: true },
        runs: { running: 0, paused: 0 },
      }),
      emit: (s) => emitted.push(s),
      intervalMs: 20,
    });
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(emitted).toHaveLength(1);
      free -= 4096;
      await new Promise((r) => setTimeout(r, 60));
      expect(emitted).toHaveLength(1);
      breaker = 'open';
      reporter.poke();
      await new Promise((r) => setTimeout(r, 30));
      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.providers[0]?.breaker).toBe('open');
    } finally {
      reporter.stop();
    }
  });
});

// ── 系统状态里要人知道的事（SystemStatus.notices，C03） ────────────────────

const ref = (provider: string, model: string, tier: Tier): ModelRef => ({ provider, model, tier });

function models(
  tiers: Record<Tier, ModelRef[]>,
  keys: Record<string, string>,
  fallback: 'next_in_tier' | 'none' = 'next_in_tier',
) {
  const global = resolveGlobalConfig({ models: { fallback } });
  return { tier: (t: Tier) => tiers[t], apiKey: (p: string) => keys[p], global: () => global };
}

function provider(name: string, extra: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    provider: name,
    breaker: 'ok',
    limit: null,
    inFlight: 0,
    queued: 0,
    episodes: { running: 0, queued: 0 },
    ...extra,
  };
}

const texts = (list: readonly SystemNotice[]) => list.map((n) => `${n.kind}/${n.level}：${n.text}`);

describe('系统状态的提示：容器引擎和镜像', () => {
  it('找不到引擎、引擎用不了是 sandbox 的 error（前端开工清单认这一条）', () => {
    const missing = containerNotices({ engine: 'missing' });
    expect(missing).toEqual([{ kind: 'sandbox', level: 'error', text: expect.stringContaining('建任务会被拒') }]);
    const broken = containerNotices({ engine: 'broken', error: 'podman 用不了：cannot connect' });
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ kind: 'sandbox', level: 'error' });
    expect(broken[0]?.text).toContain('podman 用不了：cannot connect');
    expect(broken[0]?.text).toContain('不用重启');
  });

  it('Linux 上不是 rootless 的引擎阻止开工；资源上限不生效是 warning，镜像没建是 error', () => {
    const list = containerNotices({
      engine: 'ok',
      kind: 'docker',
      rootless: false,
      memoryLimit: false,
      pidsLimit: true,
      missingImages: ['code', 'research'],
    });
    expect(list.map((n) => [n.kind, n.level])).toEqual([
      ['sandbox', process.platform === 'linux' ? 'error' : 'warning'],
      ['sandbox', 'warning'],
      ['images', 'error'],
    ]);
    expect(list[0]?.text).toContain('不是 rootless');
    expect(list[1]?.text).toContain('内存上限不生效');
    expect(list[1]?.text).not.toContain('进程数');
    expect(list[2]?.text).toContain('pnpm images code research');
    // 一切都好：什么都不说
    expect(
      containerNotices({
        engine: 'ok',
        kind: 'podman',
        rootless: true,
        memoryLimit: true,
        pidsLimit: true,
        missingImages: [],
        freeze: { ok: true },
      }),
    ).toEqual([]);
  });

  it('冻不住容器：sandbox 的 error，带引擎原话和修法；上限不生效是同一个原因，并进这一条', () => {
    const ok = { engine: 'ok', kind: 'podman', rootless: true, missingImages: [] } as const;
    const error = 'pause：Error: crun: cannot pause the container without a cgroup';
    const both = containerNotices({ ...ok, memoryLimit: false, pidsLimit: false, freeze: { ok: false, error } });
    expect(both).toEqual([{ kind: 'sandbox', level: 'error', text: expect.stringContaining(error) }]);
    for (const part of [
      '建任务会被拒',
      '内存和进程数上限不生效也是这个原因',
      'systemd 管 cgroup',
      '容器冻不住',
      '不用重启',
    ]) {
      expect(both[0]?.text).toContain(part);
    }
    // 冻不住、上限却都生效（比如 cgroup v1）：只说冻不住
    const alone = containerNotices({ ...ok, memoryLimit: true, pidsLimit: true, freeze: { ok: false, error } });
    expect(alone).toHaveLength(1);
    expect(alone[0]?.text).not.toContain('上限');
    // 冻得住、上限没委派：照旧是 warning
    expect(
      containerNotices({ ...ok, memoryLimit: false, pidsLimit: true, freeze: { ok: true } }).map((n) => n.level),
    ).toEqual(['warning']);
  });
});

describe('系统状态的提示：模型', () => {
  const ds = ref('deepseek', 'deepseek-flash', 'strong');
  const dsFast = ref('deepseek', 'deepseek-flash', 'fast');
  const oa = ref('openai', 'gpt-x', 'strong');

  it('两档都有能用的模型：不说话', () => {
    expect(modelNotices(models({ strong: [ds], fast: [dsFast] }, { deepseek: 'sk' }), [provider('deepseek')])).toEqual(
      [],
    );
  });

  it('一档是空的、一档的模型都没 key：error；没 key 的那种和建任务前的检查同一个口径（会被拒）', () => {
    const list = modelNotices(models({ strong: [oa], fast: [] }, {}), [provider('openai')]);
    expect(texts(list)).toEqual([
      expect.stringMatching(/^models\/error：strong 档的模型现在都用不了：openai 没有 API key。建任务会被拒/),
      expect.stringMatching(/^models\/error：fast 档还没有模型/),
    ]);
  });

  it('同一档里有别家顶着：没 key、key 都用不了的那家是 warning', () => {
    const list = modelNotices(models({ strong: [oa, ds], fast: [dsFast] }, { deepseek: 'sk', openai: 'sk-o' }), [
      provider('openai', { keys: [{ id: '01K6F1W3S2A8Q0Q6YH7J5M4K02', state: 'down', reason: '402：余额不足' }] }),
      provider('deepseek'),
    ]);
    expect(texts(list)).toEqual([
      'models/warning：openai 的 API key 都用不了（402：余额不足）：用到它的模型先换同一档里别家的，到模型页换个 key 就恢复',
    ]);
    const noKey = modelNotices(models({ strong: [oa, ds], fast: [dsFast] }, { deepseek: 'sk' }), [
      provider('deepseek'),
    ]);
    expect(texts(noKey)).toEqual([
      'models/warning：openai 没有 API key：用到它的模型先换同一档里别家的，到模型页填上 key 就能用',
    ]);
  });

  it('一档的 key 都用不了、或者都熔断了：error，说调用会排着', () => {
    const down = modelNotices(models({ strong: [ds], fast: [dsFast] }, { deepseek: 'sk' }), [
      provider('deepseek', {
        keys: [{ id: '01K6F1W3S2A8Q0Q6YH7J5M4K03', state: 'down', reason: '401：API key 无效' }],
      }),
    ]);
    expect(texts(down)).toEqual([
      expect.stringMatching(
        /^models\/error：strong 档的模型现在都用不了：deepseek 的 API key 都用不了（401：API key 无效）。调用会一直排队/,
      ),
      expect.stringMatching(/^models\/error：fast 档的模型现在都用不了/),
    ]);
    const tripped = modelNotices(models({ strong: [ds], fast: [dsFast] }, { deepseek: 'sk' }), [
      provider('deepseek', { breaker: 'open', reason: '连续 3 次超时' }),
    ]);
    expect(tripped).toHaveLength(2);
    expect(tripped[0]?.text).toContain('deepseek 暂时连不上（连续 3 次超时）。调用先排着');
    // 熔断了但同一档有别家：不单独说（系统状态里各家的状况写着）
    expect(
      modelNotices(models({ strong: [ds, oa], fast: [dsFast] }, { deepseek: 'sk', openai: 'sk-o' }), [
        provider('deepseek', { breaker: 'open' }),
        provider('openai'),
      ]).filter((n) => n.text.includes('strong')),
    ).toEqual([]);
  });

  it('不许换备用模型：只看首选；排在后面的没 key 不用说', () => {
    const list = modelNotices(models({ strong: [oa, ds], fast: [dsFast] }, { deepseek: 'sk' }, 'none'), [
      provider('deepseek'),
    ]);
    expect(texts(list)).toEqual([
      expect.stringMatching(/^models\/error：strong 档的首选模型（又不许换备用模型）现在都用不了：openai 没有 API key/),
    ]);
    expect(modelNotices(models({ strong: [ds, oa], fast: [dsFast] }, { deepseek: 'sk' }, 'none'), [])).toEqual([]);
  });
});

describe('系统状态的提示：拼在一起', () => {
  const registry = { providers: () => ['deepseek'], breakers: () => [] };
  const queries = { listRuns: () => [] as Run[] };

  it('按容器、镜像、模型、磁盘排，同一类里 error 在前；没什么要说的就没有 notices', () => {
    const status = systemStatus({
      registry,
      queries,
      global: () => DEFAULT_GLOBAL_CONFIG,
      dataDir: '/',
      diskFree: () => 3 * 1024 ** 3,
      models: models({ strong: [ref('deepseek', 'deepseek-flash', 'strong')], fast: [] }, { deepseek: 'sk' }),
      notices: () => [
        { kind: 'sandbox', level: 'warning', text: '不是 rootless' },
        { kind: 'images', level: 'error', text: '镜像' },
        { kind: 'sandbox', level: 'warning', text: '不是 rootless' },
      ],
    });
    expect(status.notices?.map((n) => `${n.kind}/${n.level}`)).toEqual([
      'sandbox/warning',
      'images/error',
      'models/error',
      'disk/error',
    ]);
    expect(status.notices?.at(-1)?.text).toBe(
      '数据目录所在的盘只剩 3.0 GB，不到下限 10 GB：新的路线先不开，清出空间后自己接着跑',
    );
    const quiet = systemStatus({
      registry,
      queries,
      global: () => DEFAULT_GLOBAL_CONFIG,
      dataDir: '/',
      diskFree: () => 50 * 1024 ** 3,
      models: models(
        { strong: [ref('deepseek', 'deepseek-flash', 'strong')], fast: [ref('deepseek', 'deepseek-flash', 'fast')] },
        { deepseek: 'sk' },
      ),
      notices: () => [],
    });
    expect(quiet).not.toHaveProperty('notices');
  });

  it('磁盘那条提示里剩多少的小变化不算变，不发 system.updated', async () => {
    let free = 3 * 1024 ** 3;
    const emitted: SystemStatus[] = [];
    const reporter = startStatusReporter({
      compute: () =>
        systemStatus({ registry, queries, global: () => DEFAULT_GLOBAL_CONFIG, dataDir: '/', diskFree: () => free }),
      emit: (s) => emitted.push(s),
      intervalMs: 20,
    });
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(emitted).toHaveLength(1);
      free -= 60 * 1024 ** 2; // 3.0 GB → 2.9 GB：提示的字变了，按 256 MiB 取整没变
      await new Promise((r) => setTimeout(r, 60));
      expect(emitted).toHaveLength(1);
    } finally {
      reporter.stop();
    }
  });
});
