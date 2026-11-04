// 容器运行时对着假引擎测：建容器的参数（挂载、限额、凭证不进命令行）、启停删查、Melina 重启后找回老容器手里的凭证、
// 临时容器和网络隔离。exec 打开 hostExec，在宿主机上真跑那段 sh：超时、取消、结束标记、后台进程、长命令、脱敏。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMelinaError } from '../../../src/core/errors.ts';
import type { ContainerSpec, ResolvedCredential } from '../../../src/core/interfaces/container.ts';
import {
  AUTO_PIDS_MAX,
  autoMemoryMax,
  detectEngine,
  PodmanRuntime,
  type PodmanRuntimeOptions,
} from '../../../src/tools/container.ts';
import { SecretRedactor } from '../../../src/tools/redact.ts';
import { FakeEngine } from './fake-engine.ts';

const GiB = 1024 ** 3;
const root = mkdtempSync(join(tmpdir(), 'melina-container-'));
const ws = join(root, 'ws');
const state = join(root, 'state');
const logs = join(root, 'logs');
const artifacts = join(root, 'artifacts');
const materials = join(root, 'materials');
for (const d of [ws, state, logs, artifacts, materials]) mkdirSync(d, { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

const imageFor = (domain: string) => `localhost/melina-${domain}:test`;

function setup(options: Partial<PodmanRuntimeOptions> = {}, engine = new FakeEngine()) {
  for (const d of ['code', 'research', 'general']) engine.images.add(imageFor(d));
  const redactor = options.redactor ?? new SecretRedactor();
  const warnings: string[] = [];
  const runtime = new PodmanRuntime({
    engine,
    images: { imageFor },
    redactor,
    paths: { workspace: ws, state, logs },
    totalMemory: () => 16 * GiB,
    killGraceMs: 2000,
    onWarn: (m) => warnings.push(m),
    ...options,
  });
  return { engine, runtime, redactor, warnings };
}

const token: ResolvedCredential = {
  id: '01J00000000000000000000001',
  name: 'GitHub token',
  as: { env: 'GH_TOKEN' },
  value: 'ghp_supersecret_0123456789',
};
const keyFile: ResolvedCredential = {
  id: '01J00000000000000000000002',
  name: '部署私钥',
  as: { file: '/run/secrets/deploy_key' },
  value: '-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END KEY-----\n',
};

function spec(partial: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: 'melina-01JRUN-01JBRANCH',
    domain: 'code',
    workspace: { host: ws, container: ws, readOnly: false },
    artifactsDir: artifacts,
    materialsDir: materials,
    credentials: [],
    ...partial,
  };
}

async function rejects(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (isMelinaError(e)) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error('应该失败');
}

describe('start', () => {
  it('建容器：挂载、限额、标签、tmpfs，凭证的值不出现在命令行里', async () => {
    const { engine, runtime } = setup();
    const ref = await runtime.start(spec({ credentials: [token, keyFile], labels: { 'melina.run': '01JRUN' } }));
    const runCall = engine.calls.find((c) => c.args[0] === 'run');
    const args = runCall?.args ?? [];
    const joined = args.join(' ');
    expect(ref.name).toBe('melina-01JRUN-01JBRANCH');
    expect(ref.id).toBe(engine.containers.get(ref.name)?.id);
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', 'melina-01JRUN-01JBRANCH']);
    expect(args).toContain('--pull=never');
    expect(joined).toContain('--security-opt label=disable');
    expect(joined).toContain('--network slirp4netns:allow_host_loopback=false');
    expect(joined).toContain(`--tmpfs ${state}:rw,size=64m,mode=755`);
    expect(joined).toContain(`-v ${ws}:${ws}:rw`);
    expect(joined).toContain(`-v ${artifacts}:/melina/artifacts:ro`);
    expect(joined).toContain(`-v ${materials}:/melina/materials:ro`);
    expect(joined).toContain(`--memory ${8 * GiB} --memory-swap ${8 * GiB}`);
    expect(joined).toContain(`--pids-limit ${AUTO_PIDS_MAX}`);
    expect(joined).toContain('--label melina.managed=1');
    expect(joined).toContain('--label melina.network=slirp4netns:allow_host_loopback=false');
    expect(joined).toContain('--label melina.run=01JRUN');
    expect(args.slice(-3)).toEqual(['localhost/melina-code:test', 'sleep', 'infinity']);
    // 环境变量形式的凭证：命令行上只有名字，值在引擎进程自己的环境里
    expect(joined).toContain('--env GH_TOKEN');
    expect(joined).not.toContain(token.value);
    expect(runCall?.env).toEqual({ GH_TOKEN: token.value });
    expect(engine.containers.get(ref.name)?.env).toContain(`GH_TOKEN=${token.value}`);
    // 标签里只记凭证的名字和位置
    const labels = engine.containers.get(ref.name)?.labels ?? {};
    expect(JSON.parse(labels['melina.credentials'] ?? '[]')).toEqual([
      { name: 'GitHub token', env: 'GH_TOKEN' },
      { name: '部署私钥', file: '/run/secrets/deploy_key' },
    ]);
    // 文件形式的凭证建好后写进容器自己的文件系统，经 stdin 传，不在参数里
    const write = engine.calls.find((c) => c.args.includes('melina-write'));
    expect(write?.args.slice(0, 3)).toEqual(['exec', '-i', 'melina-01JRUN-01JBRANCH']);
    expect(write?.input).toBe(keyFile.value);
    expect(engine.containers.get(ref.name)?.files.get('/run/secrets/deploy_key')).toBe(keyFile.value);
  });

  it('人选的工作目录只读挂到 /melina/origin；没给就不挂，路径里有冒号的拒收', async () => {
    const origin = join(root, 'origin');
    mkdirSync(origin, { recursive: true });
    const { engine, runtime } = setup();
    await runtime.start(spec({ originDir: origin }));
    const joined = (engine.calls.find((c) => c.args[0] === 'run')?.args ?? []).join(' ');
    expect(joined).toContain(`-v ${origin}:/melina/origin:ro`);
    const other = setup();
    await other.runtime.start(spec());
    expect((other.engine.calls.find((c) => c.args[0] === 'run')?.args ?? []).join(' ')).not.toContain('/melina/origin');
    const bad = setup();
    expect((await rejects(bad.runtime.start(spec({ originDir: '/home/me/a:b' })))).code).toBe('invalid');
  });

  it('环境变量形式的凭证可以有换行（值不经过文件和命令行）', async () => {
    const { engine, runtime } = setup();
    const multiline = { ...token, value: 'line-one-secret\nline-two-secret' };
    await runtime.start(spec({ credentials: [multiline] }));
    expect(engine.containers.get('melina-01JRUN-01JBRANCH')?.env).toContain(`GH_TOKEN=${multiline.value}`);
  });

  it('只读的角色只读挂载 workspace', async () => {
    const { engine, runtime } = setup();
    await runtime.start(spec({ workspace: { host: ws, container: ws, readOnly: true } }));
    expect(engine.callsOf('run')[0]?.join(' ')).toContain(`-v ${ws}:${ws}:ro`);
  });

  it('同名的停着就启动，在跑就直接返回，都不重建', async () => {
    const { engine, runtime } = setup();
    engine.add('melina-01JRUN-01JBRANCH', {
      running: false,
      labels: {
        'melina.managed': '1',
        'melina.domain': 'code',
        'melina.network': 'slirp4netns:allow_host_loopback=false',
      },
    });
    await runtime.start(spec());
    expect(engine.callsOf('run')).toHaveLength(0);
    expect(engine.callsOf('start')).toEqual([['start', 'melina-01JRUN-01JBRANCH']]);
    await runtime.start(spec());
    expect(engine.callsOf('start')).toHaveLength(1);
  });

  it('Scoper 后定领域：同名容器换成所选镜像，旧的凭证缓存一起清理', async () => {
    const { engine, runtime, redactor } = setup();
    const first = await runtime.start(spec({ domain: 'general', credentials: [token] }));
    const next = await runtime.start(spec({ domain: 'code', credentials: [keyFile] }));
    expect(next.name).toBe(first.name);
    expect(next.id).not.toBe(first.id);
    const current = engine.containers.get(next.name);
    expect(current?.labels['melina.domain']).toBe('code');
    expect(current?.args).toContain(imageFor('code'));
    expect(current?.files.get('/run/secrets/deploy_key')).toBe(keyFile.value);
    expect(current?.env.some((value) => value.includes(token.value))).toBe(false);
    expect(redactor.redact(token.value)).toBe(token.value);
    expect(redactor.redact('MIIEvQIBADANBgkqhkiG9w0B')).toContain('已隐藏');
  });

  it('后定的领域镜像不存在时保留旧容器，报清楚缺镜像', async () => {
    const { engine, runtime } = setup();
    const first = await runtime.start(spec({ domain: 'general' }));
    engine.images.delete(imageFor('code'));
    await expect(runtime.start(spec({ domain: 'code' }))).rejects.toMatchObject({ code: 'unavailable' });
    expect(engine.containers.get(first.name)?.id).toBe(first.id);
    expect(engine.containers.get(first.name)?.running).toBe(true);
    expect(engine.callsOf('rm')).toEqual([]);
  });

  it('建出来却没起来：删掉半成品再报错，下次重建、凭证照样写进去', async () => {
    const { engine, runtime } = setup();
    engine.failStartAfterCreate = true;
    const err = await rejects(runtime.start(spec({ credentials: [keyFile] })));
    expect(err.code).toBe('internal');
    expect(engine.containers.size).toBe(0);
    engine.failStartAfterCreate = false;
    await runtime.start(spec({ credentials: [keyFile] }));
    expect(engine.containers.get('melina-01JRUN-01JBRANCH')?.files.get('/run/secrets/deploy_key')).toBe(keyFile.value);
  });

  it('Melina 重启后再启动老容器：找回它手里的凭证值，照样脱敏', async () => {
    const engine = new FakeEngine();
    const first = setup({}, engine);
    await first.runtime.start(spec({ credentials: [token, keyFile] }));
    await first.runtime.stop({ id: '', name: 'melina-01JRUN-01JBRANCH' });

    // 新进程：设置里的凭证已经换了新值
    const redactor = new SecretRedactor();
    redactor.update([{ ...token, value: 'ghp_brand_new_value_99999' }]);
    const second = setup({ redactor }, engine);
    await second.runtime.start(spec({ credentials: [] }));
    expect(redactor.redact(`old ${token.value}`)).toBe('old [凭证「GitHub token」已隐藏]');
    expect(redactor.redact('MIIEvQIBADANBgkqhkiG9w0B')).toBe('[凭证「部署私钥」已隐藏]');
    expect(engine.calls.some((c) => c.args[0] === 'exec' && c.args.includes('cat'))).toBe(true);
  });

  it('凭证写不进容器：删掉刚建的容器再报错', async () => {
    const { engine, runtime } = setup();
    engine.failWrite = true;
    const err = await rejects(runtime.start(spec({ credentials: [keyFile] })));
    expect(err.message).toContain('部署私钥');
    expect(engine.containers.size).toBe(0);
  });

  it('不合法的 spec 直接拒绝', async () => {
    const { runtime } = setup();
    const bad: [string, Partial<ContainerSpec>][] = [
      ['名字', { name: '-bad name' }],
      ['挂载点', { workspace: { host: ws, container: '/elsewhere', readOnly: false } }],
      ['相对路径', { workspace: { host: 'relative/ws', container: ws, readOnly: false } }],
      ['冒号', { artifactsDir: '/tmp/a:b' }],
      ['覆盖 workspace 标签', { labels: { 'melina.workspace': '/elsewhere' } }],
      ['覆盖网络标签', { labels: { 'melina.network': 'host' } }],
    ];
    for (const [what, partial] of bad) {
      const err = await rejects(runtime.start(spec(partial)));
      expect(err.code, what).toBe('invalid');
    }
  });

  it('无效凭证直接拒绝启动，不跳过凭证继续创建容器', async () => {
    const bad: [string, ResolvedCredential][] = [
      ['会改掉引擎行为的环境变量名', { ...token, id: '01J00000000000000000000003', name: '路径', as: { env: 'PATH' } }],
      [
        '包装脚本用的环境变量名',
        { ...token, id: '01J00000000000000000000004', name: '包装', as: { env: 'MELINA_EXEC' } },
      ],
      [
        'NUL',
        {
          ...token,
          id: '01J00000000000000000000005',
          name: '带 NUL',
          as: { env: 'GITHUB_TOKEN' },
          value: 'abc\0defghij',
        },
      ],
      [
        '文件放进 workspace',
        { ...keyFile, id: '01J00000000000000000000006', name: '放错地方', as: { file: `${ws}/key` } },
      ],
      [
        '文件放进 /melina',
        { ...keyFile, id: '01J00000000000000000000007', name: '放进 melina', as: { file: '/melina/key' } },
      ],
    ];
    for (const [what, credential] of bad) {
      const { engine, runtime } = setup();
      const error = await rejects(runtime.start(spec({ name: 'melina-x', credentials: [token, credential] })));
      expect(error.code, what).toBe('invalid');
      expect(error.message, what).toContain(credential.name);
      expect(engine.callsOf('run'), what).toHaveLength(0);
      expect(engine.containers.size, what).toBe(0);
    }
  });

  it('内存上限：auto 按本机内存和在跑的容器数分；spec 和配置给了数就用给的', async () => {
    expect(autoMemoryMax(16 * GiB, 1)).toBe(8 * GiB); // 最多一半
    expect(autoMemoryMax(16 * GiB, 4)).toBe(Math.floor((16 * GiB * 0.8) / 4));
    expect(autoMemoryMax(16 * GiB, 100)).toBe(GiB); // 最少 1 GiB
    expect(autoMemoryMax(1 * GiB, 1)).toBe(GiB / 2); // 小机器上限照样是一半

    const { engine, runtime } = setup();
    await runtime.start(spec({ name: 'melina-a' }));
    await runtime.start(spec({ name: 'melina-b' }));
    await runtime.start(spec({ name: 'melina-c', memoryMax: 2 * GiB, pidsMax: 100 }));
    const runs = engine.callsOf('run').map((a) => a.join(' '));
    expect(runs[1]).toContain(`--memory ${Math.floor((16 * GiB * 0.8) / 2)}`);
    expect(runs[2]).toContain(`--memory ${2 * GiB}`);
    expect(runs[2]).toContain('--pids-limit 100');

    const fixed = setup({ memoryMax: 3 * GiB, pidsMax: 500 });
    await fixed.runtime.start(spec());
    expect(fixed.engine.callsOf('run')[0]?.join(' ')).toContain(`--memory ${3 * GiB}`);
    expect(fixed.engine.callsOf('run')[0]?.join(' ')).toContain('--pids-limit 500');
  });

  it('cgroup 控制器没委派，或 rootless 没有 systemd 管 cgroup：不加上限，提醒一次', async () => {
    for (const info of [
      { memoryLimit: false, pidsLimit: false, rootless: true, cgroupManager: 'systemd' },
      { memoryLimit: true, pidsLimit: true, rootless: true, cgroupManager: 'cgroupfs' },
    ]) {
      const engine = new FakeEngine();
      engine.info = info;
      const { runtime, warnings } = setup({}, engine);
      await runtime.start(spec({ name: 'melina-a' }));
      await runtime.start(spec({ name: 'melina-b' }));
      const run = engine.callsOf('run')[0]?.join(' ') ?? '';
      expect(run).not.toContain('--memory');
      expect(run).not.toContain('--pids-limit');
      expect(warnings).toHaveLength(2);
      expect(await runtime.probe()).toMatchObject({ kind: 'podman', rootless: true, memoryLimit: false });
    }
  });

  it('docker 的 info 也认得；守护进程没起时报 unavailable', async () => {
    const engine = new FakeEngine('docker');
    const { runtime } = setup({}, engine);
    expect(await runtime.probe()).toEqual({
      kind: 'docker',
      version: '27.0.0',
      rootless: true,
      memoryLimit: true,
      pidsLimit: true,
    });
    const down = new FakeEngine('docker');
    down.info = { ...down.info, serverErrors: ['Cannot connect to the Docker daemon'] };
    const err = await rejects(setup({}, down).runtime.probe());
    expect(err.code).toBe('unavailable');
    expect(err.message).toContain('Cannot connect');
  });

  it('镜像还没构建：提示先跑 pnpm images', async () => {
    const { engine, runtime } = setup();
    engine.images.clear();
    const err = await rejects(runtime.start(spec()));
    expect(err.code).toBe('unavailable');
    expect(err.message).toContain('pnpm images');
  });

  it.each([
    ['podman', 'slirp4netns:allow_host_loopback=false'],
    ['podman', 'none'],
    ['docker', 'bridge'],
    ['docker', 'none'],
  ] as const)('%s 的容器自定义标签不能改变网络模式 %s', async (kind, network) => {
    const { engine, runtime } = setup({ network }, new FakeEngine(kind));
    const branch = await runtime.start(spec({ name: 'melina-branch' }));
    const labels = { 'melina.owner': branch.name };
    await runtime.start(spec({ name: 'melina-other', labels }));
    await runtime.ephemeral(spec({ name: 'melina-scoper', labels }));
    for (const args of engine.callsOf('run')) {
      expect(args[args.indexOf('--network') + 1]).toBe(network);
    }
  });

  it('Linux 上 rootful 引擎不能新建、恢复或启动临时容器', async () => {
    if (process.platform !== 'linux') return;
    for (const kind of ['podman', 'docker'] as const) {
      const engine = new FakeEngine(kind);
      engine.info.rootless = false;
      const { runtime } = setup({}, engine);
      await expect(runtime.start(spec())).rejects.toMatchObject({ code: 'unavailable' });
      engine.add('melina-existing', { running: false });
      await expect(runtime.start(spec({ name: 'melina-existing' }))).rejects.toMatchObject({ code: 'unavailable' });
      await expect(runtime.ephemeral(spec())).rejects.toMatchObject({ code: 'unavailable' });
      expect(engine.callsOf('run')).toEqual([]);
      expect(engine.callsOf('start')).toEqual([]);
    }
  });

  it('拒绝可能连到宿主机回环地址的网络配置', () => {
    for (const network of ['host', 'slirp4netns:allow_host_loopback=true', 'pasta:--map-gw', 'container:foreign']) {
      expect(() => setup({ network })).toThrow(/隔离宿主机/);
    }
  });

  it('旧容器没有确认过网络配置时，不能恢复或直接 exec', async () => {
    const { engine, runtime } = setup();
    const old = engine.add('melina-old-network', { labels: { 'melina.managed': '1' } });
    await expect(runtime.start(spec({ name: old.name }))).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      runtime.exec({ id: old.id, name: old.name }, { cmd: 'echo unsafe', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(engine.callsOf('exec')).toEqual([]);
    expect(engine.callsOf('run')).toEqual([]);
  });

  it('崩溃时留下的已验证容器被冻结，恢复时先 unpause', async () => {
    const { engine, runtime } = setup();
    const ref = await runtime.start(spec());
    engine.containers.get(ref.name)!.paused = true;
    const recovered = setup({}, engine).runtime;
    await recovered.start(spec());
    expect(engine.callsOf('unpause')).toEqual([['unpause', ref.name]]);
    expect(engine.containers.get(ref.name)?.paused).toBe(false);
  });
});

describe('snapshot 时冻结容器', () => {
  it('找全同一个 workspace 的容器，含重启前留下的；别的 workspace、停着的和已冻结的不动', async () => {
    const { engine, runtime } = setup();
    const owner = await runtime.start(spec({ name: 'melina-owner' }));
    const old = engine.add('melina-old', { labels: { 'melina.managed': '1', 'melina.workspace': ws } });
    engine.add('melina-other', { labels: { 'melina.managed': '1', 'melina.workspace': `${ws}-other` } });
    engine.add('melina-stopped', { running: false, labels: { 'melina.managed': '1', 'melina.workspace': ws } });
    const already = engine.add('melina-paused', {
      paused: true,
      labels: { 'melina.managed': '1', 'melina.workspace': ws },
    });
    const result = await runtime.withWorkspaceFrozen(ws, async () => {
      expect(engine.containers.get(owner.name)?.paused).toBe(true);
      expect(old.paused).toBe(true);
      expect(engine.containers.get('melina-other')?.paused).toBe(false);
      return 'snapshot';
    });
    expect(result).toBe('snapshot');
    expect(old.paused).toBe(false);
    expect(engine.containers.get(owner.name)?.paused).toBe(false);
    expect(already.paused).toBe(true);
    expect(engine.callsOf('pause')).toHaveLength(2);
    expect(engine.callsOf('unpause')).toHaveLength(2);
  });

  it('复制失败也恢复容器；部分冻结失败时不读 workspace，并恢复已冻结的容器', async () => {
    const { engine, runtime } = setup();
    const a = await runtime.start(spec({ name: 'melina-a' }));
    const b = await runtime.start(spec({ name: 'melina-b' }));
    await expect(
      runtime.withWorkspaceFrozen(ws, async () => {
        throw new Error('copy failed');
      }),
    ).rejects.toThrow('copy failed');
    expect(engine.containers.get(a.name)?.paused).toBe(false);
    expect(engine.containers.get(b.name)?.paused).toBe(false);
    engine.failPause = b.name;
    const copy = vi.fn(async () => 'snapshot');
    await expect(runtime.withWorkspaceFrozen(ws, copy)).rejects.toThrow('冻结容器');
    expect(copy).not.toHaveBeenCalled();
    expect(engine.containers.get(a.name)?.paused).toBe(false);
  });

  it('一个容器恢复失败时仍恢复其他容器，并报告错误', async () => {
    const { engine, runtime } = setup();
    const a = await runtime.start(spec({ name: 'melina-a' }));
    const b = await runtime.start(spec({ name: 'melina-b' }));
    engine.failUnpause = b.name;
    await expect(runtime.withWorkspaceFrozen(ws, async () => 'snapshot')).rejects.toThrow('恢复容器失败');
    expect(engine.containers.get(a.name)?.paused).toBe(false);
    expect(engine.containers.get(b.name)?.paused).toBe(true);
  });

  it('冻结期间，新的写入容器、stop、remove 和另一次 snapshot 都等到恢复后再执行', async () => {
    const { engine, runtime } = setup();
    const ref = await runtime.start(spec({ name: 'melina-owner' }));
    let started!: () => void;
    const frozen = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume!: () => void;
    const hold = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const snapshot = runtime.withWorkspaceFrozen(ws, async () => {
      started();
      await hold;
    });
    await frozen;
    const writer = runtime.ephemeral(spec({ name: 'melina-new-writer' }));
    const stop = runtime.stop(ref);
    const remove = runtime.remove(ref);
    const capture = vi.fn(async () => 'snapshot-2');
    const second = runtime.withWorkspaceFrozen(ws, capture);
    expect(engine.callsOf('run')).toHaveLength(1);
    expect(engine.callsOf('stop')).toEqual([]);
    expect(engine.callsOf('rm')).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
    resume();
    await Promise.all([snapshot, writer, stop, remove, second]);
    expect(engine.containers.has(ref.name)).toBe(false);
    expect(engine.containers.has('melina-new-writer')).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
  });
});

describe('冻结闸门', () => {
  it('冻结期间在同一个 workspace 上起的命令：等解冻再跑，照常跑完，不当成容器没在运行', async () => {
    const { engine, runtime } = setup();
    const ref = await runtime.start(spec({ name: 'melina-owner' }));
    let started!: () => void;
    const frozen = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume!: () => void;
    const hold = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const snapshot = runtime.withWorkspaceFrozen(ws, async () => {
      started();
      await hold;
    });
    await frozen;
    expect(engine.containers.get(ref.name)?.paused).toBe(true);
    let done = false;
    const run = runtime.exec(ref, { cmd: 'echo hi', timeoutMs: 10_000 }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    resume();
    await snapshot;
    const r = await run;
    expect(r.exitCode).toBe(0);
    expect(engine.containers.get(ref.name)?.paused).toBe(false);
  });

  it('真停掉的容器照旧报没在运行，不空等', async () => {
    const { engine, runtime } = setup();
    const ref = await runtime.start(spec({ name: 'melina-owner' }));
    const c = engine.containers.get(ref.name);
    if (c) c.running = false;
    await expect(runtime.exec(ref, { cmd: 'echo hi', timeoutMs: 10_000 })).rejects.toThrow('没在运行');
  });
});

describe('真冻一次', () => {
  it('冻得住：用第一个建好的镜像起不挂目录的测试容器，pause、unpause 后删掉；结论记住，再问不再起容器', async () => {
    const { engine, runtime } = setup();
    engine.images.delete(imageFor('general'));
    const [first, second] = await Promise.all([
      runtime.checkFreeze(['general', 'code']),
      runtime.checkFreeze(['general', 'code']),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    const run = engine.callsOf('run');
    expect(run).toHaveLength(1);
    expect(run[0]).toContain(imageFor('code'));
    expect(run[0]).toContain('--rm');
    expect(run[0]).not.toContain('-v');
    expect(run[0]).not.toContain('--label');
    expect(engine.callsOf('pause')).toHaveLength(1);
    expect(engine.callsOf('unpause')).toHaveLength(1);
    expect(engine.containers.size).toBe(0);
    expect(await runtime.checkFreeze(['code'])).toEqual({ ok: true });
    expect(engine.callsOf('run')).toHaveLength(1);
  });

  it('测试容器和分支容器的沙箱参数是同一份：网络、tmpfs、cap、上限一样带，上限没委派时两边都不带', async () => {
    /** 只看沙箱那几样，上限只看带没带（值不一样：测试容器只跑 sleep） */
    const sandbox = (args: string[]) =>
      args.flatMap((a, i) =>
        a === '--security-opt' || a === '--tmpfs' || a === '--network'
          ? [`${a} ${args[i + 1]}`]
          : a === '--pull=never' || a === '--cap-add=SYS_PTRACE' || a.startsWith('--memory') || a === '--pids-limit'
            ? [a]
            : [],
      );
    for (const limits of [true, false]) {
      const engine = new FakeEngine();
      engine.info = { ...engine.info, memoryLimit: limits, pidsLimit: limits };
      const { runtime } = setup({}, engine);
      await runtime.start(spec());
      await runtime.checkFreeze(['code']);
      const [branch = [], probe = []] = engine.callsOf('run');
      expect(sandbox(probe)).toEqual(sandbox(branch));
      expect(sandbox(probe)).toContain('--network slirp4netns:allow_host_loopback=false');
      expect(sandbox(probe).includes('--pids-limit')).toBe(limits);
    }
  });

  it('没装 slirp4netns（Podman 5 默认用 pasta）：测试容器起不来，开工前就报、说清楚装什么；分支容器起不来时也这样说', async () => {
    const { engine, runtime } = setup();
    engine.noSlirp4netns = true;
    const err = await rejects(runtime.checkFreeze(['code']));
    expect(err.code).toBe('unavailable');
    expect(err.message).toContain('按分支容器的参数起不来容器');
    expect(err.message).toContain('could not find slirp4netns');
    expect(err.message).toContain('装上 slirp4netns 这个包');
    expect(engine.containers.size).toBe(0);
    const started = await rejects(runtime.start(spec()));
    expect(started.message).toContain('装上 slirp4netns 这个包');
    expect(engine.containers.size).toBe(0);
  });

  it('容器没有 cgroup：冻不住，带引擎的原话，测试容器照样删掉；冻不住的结论过一阵才重新试', async () => {
    let now = 1000;
    const { engine, runtime } = setup({ freezeRetryMs: 50, now: () => now });
    engine.noCgroup = true;
    const result = await runtime.checkFreeze(['code']);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('cannot pause the container without a cgroup'),
    });
    expect(result?.ok === false && result.error.startsWith('pause：')).toBe(true);
    expect(engine.containers.size).toBe(0);
    expect(engine.callsOf('unpause')).toHaveLength(0);
    now += 49;
    expect(await runtime.checkFreeze(['code'])).toEqual(result);
    expect(engine.callsOf('run')).toHaveLength(1);
    // 环境修好了：恰好到重试间隔才真试，结论跟着变。
    engine.noCgroup = false;
    now += 1;
    expect(await runtime.checkFreeze(['code'])).toEqual({ ok: true });
    expect(engine.callsOf('run')).toHaveLength(2);
    now += 50;
    expect(await runtime.checkFreeze(['code'])).toEqual({ ok: true });
    expect(engine.callsOf('run')).toHaveLength(2);
  });

  it('镜像一个都没建：试不了，返回 undefined；测试容器起不来：抛 unavailable，半成品删掉', async () => {
    const { engine, runtime } = setup();
    engine.images.clear();
    expect(await runtime.checkFreeze(['code'])).toBeUndefined();
    expect(engine.callsOf('run')).toHaveLength(0);
    engine.images.add(imageFor('code'));
    engine.failStartAfterCreate = true;
    const err = await rejects(runtime.checkFreeze(['code']));
    expect(err.code).toBe('unavailable');
    expect(err.message).toContain('按分支容器的参数起不来容器');
    expect(err.message).not.toContain('slirp4netns');
    expect(engine.containers.size).toBe(0);
  });

  it('snapshot 时真冻结失败：之前冻得住的结论作废，告诉进程入口；已经知道冻不住时不再重复告诉', async () => {
    const failed = vi.fn();
    const { engine, runtime } = setup({ onFreezeFailed: failed });
    expect(await runtime.checkFreeze(['code'])).toEqual({ ok: true });
    await runtime.start(spec({ name: 'melina-a' }));
    engine.noCgroup = true;
    const copy = vi.fn(async () => 'snapshot');
    await expect(runtime.withWorkspaceFrozen(ws, copy)).rejects.toThrow('cannot pause the container without a cgroup');
    expect(copy).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(await runtime.checkFreeze(['code'])).toMatchObject({ ok: false });
    await expect(runtime.withWorkspaceFrozen(ws, copy)).rejects.toThrow('冻结容器 melina-a');
    expect(failed).toHaveBeenCalledTimes(1);
  });
});

describe('stop、remove、find、checkImages', () => {
  it('停、删不在的容器不报错；删掉后它手里的值不再脱敏', async () => {
    const { engine, runtime, redactor } = setup();
    const ref = await runtime.start(spec({ credentials: [token] }));
    expect(redactor.redact(token.value)).not.toContain(token.value);
    await runtime.stop(ref);
    expect(engine.containers.get(ref.name)?.running).toBe(false);
    await runtime.remove(ref);
    expect(engine.containers.has(ref.name)).toBe(false);
    expect(redactor.redact(token.value)).toBe(token.value);
    await runtime.stop(ref);
    await runtime.remove(ref);
  });

  it('删除分支容器不影响临时容器，旧标签不再建立依赖', async () => {
    const { engine, runtime } = setup();
    const branch = await runtime.start(spec({ name: 'melina-branch' }));
    const temporary = await runtime.ephemeral(spec({ name: 'melina-scoper', labels: { 'melina.owner': branch.name } }));
    await runtime.remove(branch);
    expect([...engine.containers.keys()]).toEqual([temporary.name]);
    await runtime.remove(temporary);
    expect([...engine.containers.keys()]).toEqual([]);
  });

  it('find：按名字找回，没有就是 undefined', async () => {
    const { engine, runtime } = setup();
    const c = engine.add('melina-x');
    expect(await runtime.find('melina-x')).toEqual({ id: c.id, name: 'melina-x' });
    expect(await runtime.find('melina-nope')).toBeUndefined();
  });

  it('checkImages：按领域报镜像在不在', async () => {
    const { engine, runtime } = setup();
    engine.images.delete(imageFor('research'));
    expect(await runtime.checkImages(['code', 'research'])).toEqual([
      { domain: 'code', image: imageFor('code'), present: true },
      { domain: 'research', image: imageFor('research'), present: false },
    ]);
  });

  it('removeEphemeral：只删上次留下的临时容器', async () => {
    const { engine, runtime } = setup();
    engine.add('melina-branch', { labels: { 'melina.managed': '1', 'melina.ephemeral': '0' } });
    engine.add('melina-scoper', { labels: { 'melina.managed': '1', 'melina.ephemeral': '1' } });
    engine.add('someone-else', { labels: {} });
    expect(await runtime.removeEphemeral()).toEqual(['melina-scoper']);
    expect([...engine.containers.keys()].sort()).toEqual(['melina-branch', 'someone-else']);
  });

  it('forWorkspace：这个进程启动过、在跑、挂着这个 workspace 的容器', async () => {
    const { runtime } = setup();
    const ro = await runtime.start(spec({ name: 'melina-ro', workspace: { host: ws, container: ws, readOnly: true } }));
    expect(runtime.forWorkspace(ws)).toEqual(ro);
    expect(runtime.forWorkspace(ws, { writable: true })).toBeUndefined();
    const rw = await runtime.start(spec({ name: 'melina-rw' }));
    expect(runtime.forWorkspace(ws, { writable: true })).toEqual(rw);
    await runtime.stop(rw);
    expect(runtime.forWorkspace(ws, { writable: true })).toBeUndefined();
  });
});

// 真起 sh 进程：机器忙、进程数快满时一条要好几秒，默认 5 秒的上限偶尔挂
describe('容器引用的 Run 归属', () => {
  it.each(['start', 'ephemeral'] as const)('新建和复用 %s 都携带标签中的 runId', async (method) => {
    const { engine, runtime } = setup();
    const input = spec({ name: 'sandbox-owner', labels: { 'melina.run': 'run-owner' } });
    const first = await runtime[method](input);
    expect(first.runId).toBe('run-owner');
    expect(runtime.forWorkspace(ws)).toEqual(first);

    // 新进程从持久标签找回归属；无需依赖容器名的格式。
    const restarted = setup({}, engine).runtime;
    expect(await restarted.find(input.name)).toEqual(first);
    expect((await restarted.managed()).find((c) => c.ref.name === input.name)?.ref).toEqual(first);
    expect((await restarted[method](input)).runId).toBe('run-owner');
  });

  it('缺少归属标签的旧容器保持可用，不从名字猜测 Run', async () => {
    const { runtime } = setup();
    const first = await runtime.start(spec());
    expect(first).not.toHaveProperty('runId');
    expect(await runtime.find(first.name)).toEqual(first);
  });
});

describe('exec（宿主机上真跑那段 sh）', { timeout: 30_000 }, () => {
  let ctx: ReturnType<typeof setup>;
  const ref = { id: '', name: 'melina-01JRUN-01JBRANCH' };

  beforeEach(async () => {
    const engine = new FakeEngine();
    engine.hostExec = true;
    ctx = setup({ outputMaxBytes: 4096 }, engine);
    await ctx.runtime.start(spec({ credentials: [token] }));
  });

  const exec = (cmd: string, more: Partial<Parameters<PodmanRuntime['exec']>[1]> = {}) =>
    ctx.runtime.exec(ref, { cmd, timeoutMs: 10_000, ...more });

  it('输出按顺序合在一起，带退出码和耗时；命令从 stdin 传，不在参数里', async () => {
    const r = await exec('echo out; echo err >&2; exit 7');
    expect(r).toMatchObject({ exitCode: 7, output: 'out\nerr\n', timedOut: false, cancelled: false });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    const call = ctx.engine.calls.find((c) => c.args.includes('melina-exec'));
    expect(call?.args.slice(0, 2)).toEqual(['exec', '-i']);
    expect(call?.args.join(' ')).not.toContain('exit 7');
  });

  it('cwd 相对 workspace，env 传进去', async () => {
    mkdirSync(join(ws, 'sub'), { recursive: true });
    const r = await exec('pwd; echo "$HELLO"', { cwd: 'sub', env: { HELLO: '你好' } });
    expect(r.output).toBe(`${join(ws, 'sub')}\n你好\n`);
  });

  it('超过 128 KiB 的长命令也能跑（一个参数放不下）', async () => {
    const big = 'x'.repeat(200 * 1024);
    const r = await exec(`printf %s '${big}' | wc -c`);
    expect(r).toMatchObject({ exitCode: 0, output: `${200 * 1024}\n` });
  });

  it('输出里的凭证值换掉（容器的环境变量里就有它）', async () => {
    const r = await exec('echo "token=$GH_TOKEN"');
    expect(r.output).toBe('token=[凭证「GitHub token」已隐藏]\n');
  });

  it('私有捕获拿到脱敏前的完整值，普通结果不回传；截断、失败和后台不能误登记', async () => {
    const capturePrivate = vi.fn();
    const result = await exec('printf "%s" "$GH_TOKEN"', { capturePrivate });
    expect(capturePrivate).toHaveBeenCalledExactlyOnceWith(token.value);
    expect(result.output).not.toContain(token.value);
    expect(result.output).toContain('未回传');
    capturePrivate.mockClear();
    await exec("printf '%9000s' x", { capturePrivate });
    await exec('printf secret; exit 1', { capturePrivate });
    expect(capturePrivate).not.toHaveBeenCalled();
    await expect(exec('true', { capturePrivate, background: true })).rejects.toThrow('前台');
  });

  it('被动检查先获得完整原值，再返回受控的正常输出；不与私有捕获并用', async () => {
    const inspectPrivate = vi.fn((output: string) => output.replace(token.value, '[私有凭据]'));
    const result = await exec('printf "user=alice password=%s" "$GH_TOKEN"', { inspectPrivate });
    expect(inspectPrivate).toHaveBeenCalledExactlyOnceWith(`user=alice password=${token.value}`);
    expect(result.output).toBe('user=alice password=[私有凭据]');
    inspectPrivate.mockClear();
    await exec("printf '%9000s' x", { inspectPrivate });
    await exec('printf unknown; exit 1', { inspectPrivate });
    expect(inspectPrivate).not.toHaveBeenCalled();
    await expect(exec('true', { inspectPrivate, background: true })).rejects.toThrow('前台');
    await expect(exec('true', { inspectPrivate, capturePrivate: () => {} })).rejects.toThrow('不能同时');
    await expect(
      exec('echo private', {
        inspectPrivate: () => {
          throw new Error('secret');
        },
      }),
    ).rejects.toThrow('原输出没有交给模型');
  });

  it('超时：杀掉整个进程组，返回时都已经没了，退出码是 null', async () => {
    const t0 = Date.now();
    const r = await exec('sleep 401 & setsid sleep 402 & sleep 403', { timeoutMs: 500 });
    expect(r).toMatchObject({ exitCode: null, timedOut: true, cancelled: false });
    expect(Date.now() - t0).toBeLessThan(3000);
    const left = await exec('ps -eo args | grep -E "^sleep 40[123]$" || true');
    expect(left.output).toBe('');
  });

  it('timeoutMs 大得离谱也不会一起来就超时', async () => {
    const r = await exec('echo ok', { timeoutMs: 9_999_999_999 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, output: 'ok\n' });
  });

  it('取消：AbortSignal 一到就杀；已经取消的直接返回', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await exec('sleep 404', { signal: controller.signal });
    expect(r).toMatchObject({ exitCode: null, cancelled: true, timedOut: false });
    const again = await exec('echo never', { signal: controller.signal });
    expect(again).toMatchObject({ cancelled: true, output: '' });
  });

  it('命令留下的子进程占着输出管道：不等它，一秒多就返回', async () => {
    const t0 = Date.now();
    const r = await exec('sleep 405 & echo "started $!"');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^started \d+\n$/);
    expect(Date.now() - t0).toBeLessThan(4000);
    process.kill(Number(r.output.split(' ')[1]), 'SIGKILL');
  });

  it('命令把自己的包装脚本杀了：照常返回，看得到输出', async () => {
    const r = await exec('echo before; kill -9 $PPID; sleep 1');
    expect(r.output).toContain('before');
    expect(r.timedOut).toBe(false);
  });

  it('输出太长：只留开头和结尾，写明省略了多少', async () => {
    const r = await exec('seq 1 5000');
    expect(r.exitCode).toBe(0);
    expect(r.output.startsWith('1\n2\n3\n')).toBe(true);
    expect(r.output.endsWith('4999\n5000\n')).toBe(true);
    expect(r.output).toMatch(/…（中间省略了 \d+ 字节）…/);
  });

  it('工作目录不在：退出码 2，说清楚', async () => {
    const r = await exec('echo hi', { cwd: 'missing' });
    expect(r).toMatchObject({ exitCode: 2, output: `工作目录不存在：${join(ws, 'missing')}\n` });
  });

  it('容器没在跑：conflict', async () => {
    await ctx.runtime.stop(ref);
    const err = await rejects(exec('echo hi'));
    expect(err.code).toBe('conflict');
  });

  it('这个进程没启动过的老容器（恢复时 find 回来的）：第一次 exec 前找回它手里的凭证', async () => {
    const engine = new FakeEngine();
    engine.hostExec = true;
    engine.add('melina-old', {
      env: ['PATH=/usr/bin:/bin', `GH_TOKEN=${token.value}`],
      labels: {
        'melina.managed': '1',
        'melina.network': 'slirp4netns:allow_host_loopback=false',
        'melina.credentials': JSON.stringify([{ name: 'GitHub token', env: 'GH_TOKEN' }]),
      },
    });
    const fresh = setup({}, engine);
    const r = await fresh.runtime.exec({ id: '', name: 'melina-old' }, { cmd: 'echo "$GH_TOKEN"', timeoutMs: 5000 });
    expect(r.output).toBe('[凭证「GitHub token」已隐藏]\n');
  });

  it('后台进程：立即返回 pid 和日志，跨调用活着，满了拒绝，死了的不再算', async () => {
    const bg = (cmd: string) => ctx.runtime.exec(ref, { cmd, timeoutMs: 10_000, background: true });
    const first = await bg('echo hi; sleep 406');
    expect(first.exitCode).toBe(0);
    expect(first.background?.log).toBe(join(logs, `bg-${first.background?.pid}.log`));
    const second = await bg('sleep 407');
    const third = await bg('sleep 408');
    const fourth = await bg('sleep 409');
    expect([second, third, fourth].every((r) => r.background)).toBe(true);
    const full = await rejects(bg('sleep 410'));
    expect(full.code).toBe('conflict');
    expect(full.message).toContain('上限 4 个');
    const pids = [first, second, third, fourth].map((r) => r.background?.pid ?? 0);
    expect(pids.every((pid) => existsSync(`/proc/${pid}`))).toBe(true);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    const again = await bg('sleep 411');
    expect(again.background?.pid).toBeGreaterThan(0);
    process.kill(again.background?.pid ?? 0, 'SIGKILL');
  });

  it('后台进程数按容器查（sh.maxBackground 可以按 Run 覆盖）', async () => {
    const engine = new FakeEngine();
    engine.hostExec = true;
    const one = setup({ maxBackground: () => 1 }, engine);
    const r = await one.runtime.start(spec({ name: 'melina-one' }));
    const first = await one.runtime.exec(r, { cmd: 'sleep 411', timeoutMs: 5000, background: true });
    const err = await rejects(one.runtime.exec(r, { cmd: 'sleep 412', timeoutMs: 5000, background: true }));
    expect(err.message).toContain('上限 1 个');
    process.kill(first.background?.pid ?? 0, 'SIGKILL');
  });
});

describe('命令跑的时候撞到的资源上限', () => {
  it('结束标记里带了容器里读的 cgroup 计数：照实给出，scope 是这个容器', async () => {
    const engine = new FakeEngine();
    engine.execReply = () => ({ output: 'boom\n', code: 1, counters: '37 0 -' });
    const { runtime } = setup({}, engine);
    const ref = await runtime.start(spec());
    const r = await runtime.exec(ref, { cmd: 'make -j64', timeoutMs: 5000 });
    expect(r).toMatchObject({ exitCode: 1, contention: { scope: 'container', pidsMax: 37, oomKills: 0 } });
    expect(r.contention?.cpuWait).toBeUndefined();
  });

  it('没带计数（老的包装脚本、命令没起来）：不给', async () => {
    const engine = new FakeEngine();
    engine.execReply = () => ({ output: '', code: 0 });
    const { runtime } = setup({}, engine);
    const ref = await runtime.start(spec());
    expect((await runtime.exec(ref, { cmd: 'true', timeoutMs: 5000 })).contention).toBeUndefined();
  });
});

describe('杀不掉的时候', () => {
  it('连杀进程的命令都起不来（进程数满了这类）：重启容器', async () => {
    const engine = new FakeEngine();
    engine.execHang = true;
    engine.killReply = { code: 126, stderr: 'Error: OCI runtime error: fork/exec: resource temporarily unavailable' };
    const { runtime, warnings } = setup({ killGraceMs: 300 }, engine);
    const ref = await runtime.start(spec());
    const r = await runtime.exec(ref, { cmd: ':(){ :|:& };:', timeoutMs: 100 });
    expect(r).toMatchObject({ timedOut: true, exitCode: null });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(engine.callsOf('restart')).toEqual([['restart', '-t', '0', ref.name]]);
    expect(warnings.some((w) => w.includes('重启'))).toBe(true);
  });

  it('容器已经停了：不重启', async () => {
    const engine = new FakeEngine();
    engine.execHang = true;
    engine.killReply = { code: 125, stderr: 'Error: container state improper' };
    const { runtime } = setup({ killGraceMs: 300 }, engine);
    const ref = await runtime.start(spec());
    await runtime.exec(ref, { cmd: 'sleep 1000', timeoutMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(engine.callsOf('restart')).toEqual([]);
  });
});

describe('detectEngine', () => {
  it('环境变量优先，其次 PATH 里先 podman 后 docker，都没有是 undefined', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    expect(detectEngine({ PATH: bin })).toBeUndefined();
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\n');
    chmodSync(join(bin, 'docker'), 0o755);
    expect(detectEngine({ PATH: bin })?.kind).toBe('docker');
    writeFileSync(join(bin, 'podman'), '#!/bin/sh\n');
    chmodSync(join(bin, 'podman'), 0o755);
    expect(detectEngine({ PATH: bin })?.kind).toBe('podman');
    expect(detectEngine({ PATH: bin, MELINA_CONTAINER_ENGINE: '/usr/local/bin/docker' })).toMatchObject({
      kind: 'docker',
      bin: '/usr/local/bin/docker',
    });
    expect(existsSync(bin)).toBe(true);
  });
});
