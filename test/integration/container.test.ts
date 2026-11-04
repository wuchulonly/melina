// 容器的集成测试（plan 「做完的标准」）：用真的 podman（或 docker）跑 general 领域镜像，没有就先构建。
// 默认找不到引擎时跳过；MELINA_REQUIRE_CONTAINER_TESTS=1 要求可用的 rootless 引擎和 memory、pids 上限，缺条件就失败。
//
// 覆盖：冻得住容器；只读挂载写不进；看不到宿主机的其他目录和别的分支；后台进程跨调用存活；停了再起装过的东西还在；
// 取消和超时杀得干净；凭证不出现在输出里；超内存只杀这一个容器；容器连不到宿主机 127.0.0.1 上的服务（Melina 的 API）；
// 临时容器与分支容器的网络和生命周期独立；写进 workspace 的文件属于宿主机用户；长命令。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContainerRef, ContainerSpec, ResolvedCredential } from '../../src/core/interfaces/container.ts';
import { detectEngine, type EngineInfo, PodmanRuntime, runEngine } from '../../src/tools/container.ts';
import { buildImages, DomainImages } from '../../src/tools/container-images.ts';
import { SecretRedactor } from '../../src/tools/redact.ts';
import { createWorkspaceProviders } from '../../src/workspace/provider.ts';
import { sh as hostSh, makeRun, memoryArtifacts, treeOf } from './workspace/helpers.ts';

const engine = detectEngine();
const required = process.env.MELINA_REQUIRE_CONTAINER_TESTS === '1';
const run = randomBytes(3).toString('hex');
const root = mkdtempSync(join(tmpdir(), 'melina-it-container-'));
const images = new DomainImages();
const redactor = new SecretRedactor();
const runtime = engine ? new PodmanRuntime({ engine, images, redactor }) : undefined;
const created: ContainerRef[] = [];
let info: EngineInfo | undefined;
let unusable = '';

function dir(name: string, files: Record<string, string> = {}): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  for (const [f, content] of Object.entries(files)) writeFileSync(join(d, f), content);
  return d;
}

function spec(name: string, partial: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: `melina-it-${run}-${name}`,
    domain: 'general',
    workspace: { host: dir(`ws-${name}`), container: '/workspace', readOnly: false },
    credentials: [],
    ...partial,
  };
}

async function start(s: ContainerSpec): Promise<ContainerRef> {
  const ref = await (runtime as PodmanRuntime).start(s);
  created.push(ref);
  return ref;
}

const sh = (ref: ContainerRef, cmd: string, more: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  (runtime as PodmanRuntime).exec(ref, { cmd, timeoutMs: more.timeoutMs ?? 60_000, signal: more.signal });

beforeAll(async () => {
  if (!runtime || !engine) {
    if (required) throw new Error('要求运行真容器测试，但没有找到容器引擎');
    return;
  }
  try {
    info = await runtime.probe();
    if (required && (!info.rootless || !info.memoryLimit || !info.pidsLimit)) {
      throw new Error('要求 rootless 引擎和有效的 memory、pids 上限，不能跳过沙箱检查');
    }
  } catch (error) {
    unusable = error instanceof Error ? error.message : String(error);
    if (required) throw error;
    return;
  }
  const [general] = await runtime.checkImages(['general']);
  if (!general?.present) await buildImages({ engine, images, domains: ['general'] });
}, 1_800_000);

afterAll(async () => {
  for (const ref of created) await runtime?.remove(ref).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}, 120_000);

describe.skipIf(!engine && !required)('真容器', () => {
  it('引擎能用', () => {
    expect(unusable, `容器引擎用不了：${unusable}`).toBe('');
    expect(info?.rootless, 'Linux 上要用 rootless 模式（§11）').toBe(true);
  });

  it('镜像按内容打的标签在', async () => {
    expect(await runtime?.checkImages(['general'])).toEqual([
      { domain: 'general', image: images.imageFor('general'), present: true },
    ]);
  });

  it('冻得住容器：snapshot 前要冻结，冻不住时路线什么都交不上；测试容器测完就删', async () => {
    const result = await runtime?.checkFreeze(['general']);
    expect(result, '冻不住容器：rootless 引擎要 cgroup v2 并由 systemd 管 cgroup，见 README「容器冻不住」').toEqual({
      ok: true,
    });
    const left = await runEngine(engine as NonNullable<typeof engine>, [
      'ps',
      '-a',
      '-q',
      '--filter',
      'name=melina-freeze-check-',
    ]);
    expect(left.stdout.trim()).toBe('');
  });

  it('只读挂载写不进', async () => {
    const s = spec('ro');
    const ref = await start({ ...s, workspace: { ...s.workspace, readOnly: true } });
    const r = await sh(ref, 'touch /workspace/x; echo "rc=$?"');
    expect(r.output).toMatch(/Read-only file system/);
    expect(r.output).toMatch(/rc=[1-9]/);
    expect(existsSync(join(s.workspace.host, 'x'))).toBe(false);
  });

  it('看不到宿主机的其他目录和别的分支', async () => {
    const mine = dir('ws-mine', { 'mine.txt': 'a' });
    const other = dir('ws-other', { 'other.txt': 'b' });
    const ref = await start(spec('vis', { workspace: { host: mine, container: '/workspace', readOnly: false } }));
    const r = await sh(
      ref,
      `ls /workspace; for p in ${other} ${root} /opt/melina ${process.cwd()}; do test -e "$p" && echo "看得到 $p"; done; ls /melina`,
    );
    expect(r.output).toContain('mine.txt');
    expect(r.output).not.toContain('other.txt');
    expect(r.output).not.toContain('看得到');
    expect(r.output.trim().split('\n').slice(-3).sort()).toEqual(['artifacts', 'logs', 'materials']);
  });

  it('后台进程跨调用存活；停了再起，装过的东西还在，后台进程没了', async () => {
    const ref = await start(spec('bg'));
    const bg = await (runtime as PodmanRuntime).exec(ref, { cmd: 'sleep 600', timeoutMs: 10_000, background: true });
    const pid = bg.background?.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    expect((await sh(ref, `kill -0 ${pid} && echo alive`)).output).toBe('alive\n');

    await sh(ref, 'echo installed > /opt/installed.txt');
    await runtime?.stop(ref);
    await start(spec('bg'));
    expect((await sh(ref, 'cat /opt/installed.txt')).output).toBe('installed\n');
    expect((await sh(ref, `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).output).toBe('gone\n');
  });

  it('取消和超时：整个进程组连 setsid 出去的都杀掉', async () => {
    const ref = await start(spec('cancel'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    const cancelled = await sh(ref, 'sleep 1001 & setsid sleep 1002 & sleep 1003', { signal: controller.signal });
    expect(cancelled).toMatchObject({ cancelled: true, exitCode: null });
    const timedOut = await sh(ref, 'sleep 1004 & sleep 1005', { timeoutMs: 1000 });
    expect(timedOut).toMatchObject({ timedOut: true, exitCode: null });
    await new Promise((r) => setTimeout(r, 500));
    const left = await sh(ref, `ps -eo args | grep -E '^sleep 100[0-9]$' || true`);
    expect(left.output).toBe('');
  });

  it('凭证以环境变量和文件给进去，输出里看不到值', async () => {
    const secret = `it-secret-${randomBytes(8).toString('hex')}`;
    const creds: ResolvedCredential[] = [
      { id: '01J00000000000000000000001', name: '测试 token', as: { env: 'GITHUB_TOKEN' }, value: secret },
      {
        id: '01J00000000000000000000002',
        name: '测试文件',
        as: { file: '/run/secrets/it' },
        value: `${secret}-file\n`,
      },
    ];
    const ref = await start(spec('cred', { credentials: creds }));
    const r = await sh(ref, 'echo "env=$GITHUB_TOKEN"; cat /run/secrets/it; stat -c %a /run/secrets/it');
    expect(r.output).not.toContain(secret);
    expect(r.output).toContain('env=[凭证「测试 token」已隐藏]');
    expect(r.output).toContain('[凭证「测试文件」已隐藏]');
    expect(r.output.trim().endsWith('600')).toBe(true);
  });

  it('超内存只杀这一个容器里的进程，别的容器照常', async (ctx) => {
    if (!info?.memoryLimit) ctx.skip();
    const small = await start(spec('oom', { memoryMax: 128 * 1024 * 1024 }));
    const neighbor = await start(spec('neighbor'));
    const oomKills = async () =>
      Number((await sh(small, "awk '/^oom_kill / {print $2}' /sys/fs/cgroup/memory.events")).output.trim());
    const before = await oomKills();
    // b'x' * n 会真的写满每一页，内存马上用掉
    const r = await sh(small, `python3 -c "b = b'x' * (512 * 1024 * 1024); print('allocated')"`);
    // bash 的 Killed 错误会回显整条命令（含 print('allocated')），只查程序实际输出的行，并确认 cgroup 发生了 OOM kill。
    expect(r.output.split('\n')).not.toContain('allocated');
    expect(r.exitCode).not.toBe(0);
    expect(await oomKills()).toBeGreaterThan(before);
    expect((await sh(neighbor, 'echo alive')).output).toBe('alive\n');
    expect(await runtime?.find(small.name)).toBeDefined();
  });

  it('容器连不到宿主机 127.0.0.1 上的服务（Melina 的 API 只听这里）', async () => {
    const server: Server = createServer((socket) => socket.end('melina-api\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ host: '127.0.0.1', port });
        let data = '';
        client.on('data', (chunk) => {
          data += chunk.toString();
        });
        client.on('end', () => resolve(data));
        client.on('error', reject);
      });
      expect(response).toBe('melina-api\n');
      const ref = await start(spec('net'));
      const hosts = [
        '127.0.0.1',
        'localhost',
        'host.containers.internal',
        'host.docker.internal',
        '10.0.2.2',
        '169.254.1.2',
      ];
      for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) hosts.push(a.address);
      }
      const probe = hosts
        .map((h) => `timeout 3 bash -c 'exec 3<>/dev/tcp/${h}/${port}' 2>/dev/null && echo "连上了 ${h}"`)
        .join('; ');
      const gw = `gw=$(ip route | awk '/default/ {print $3; exit}'); [ -n "$gw" ] && timeout 3 bash -c "exec 3<>/dev/tcp/$gw/${port}" 2>/dev/null && echo "连上了网关 $gw"`;
      const r = await sh(ref, `${probe}; ${gw}; echo done`);
      expect(r.output).not.toContain('连上了');
      expect(r.output).toContain('done');
    } finally {
      server.close();
    }
  });

  it.each(['dir-copy', 'git-clone'] as const)(
    '%s 的 snapshot 冻结所有写入者，符号链接不会带出宿主机文件，结束后恢复',
    async (kind) => {
      const hostSecret = `host-only-${randomBytes(16).toString('hex')}`;
      const secretPath = join(dir(`outside-${kind}`), 'secret');
      writeFileSync(secretPath, hostSecret);
      const source = dir(`source-${kind}`, { 'safe.txt': 'safe\n' });
      if (kind === 'git-clone') hostSh(source, 'git init -q -b main; git add -A; git commit -qm initial');
      const snapshots: { count: number } = { count: 0 };
      const writers: ContainerRef[] = [];
      const providers = createWorkspaceProviders({
        dataDir: dir(`data-${kind}`),
        artifacts: memoryArtifacts(),
        freeze: (path, work) =>
          (runtime as PodmanRuntime).withWorkspaceFrozen(path, async () => {
            const inspection = await runEngine(engine!, ['container', 'inspect', ...writers.map((ref) => ref.name)]);
            expect(inspection.code).toBe(0);
            const states = JSON.parse(inspection.stdout) as { State: { Paused: boolean } }[];
            expect(states).toHaveLength(2);
            expect(states.every((c) => c.State.Paused)).toBe(true);
            const counts = writers.map((_, i) => readFileSync(join(path, `counter-${i}`), 'utf8'));
            const result = await work();
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(writers.map((_, i) => readFileSync(join(path, `counter-${i}`), 'utf8'))).toEqual(counts);
            snapshots.count++;
            return result;
          }),
      });
      const run = makeRun({ root: source, kind });
      const provider = providers.forRun(run);
      await provider.init(run);
      const ws = await provider.create('root');
      for (let i = 0; i < 2; i++) {
        const ref = await start(
          spec(`snapshot-${kind}-${i}`, { workspace: { host: ws.path, container: '/workspace', readOnly: false } }),
        );
        writers.push(ref);
        // 只用测试生成的假秘密：不停在普通文件与指向宿主机的符号链接之间切换，复现 lstat/copyFile 的竞态。
        const script = `import os,time\ni=0\nwhile True:\n i+=1\n for n in range(32):\n  p=f'race-${i}-{n}'\n  try: os.unlink(p)\n  except FileNotFoundError: pass\n  with open(p,'w') as f: f.write('container-file')\n  os.unlink(p)\n  os.symlink(${JSON.stringify(secretPath)},p)\n with open('counter-${i}.tmp','w') as f: f.write(str(i))\n os.replace('counter-${i}.tmp','counter-${i}')\n time.sleep(0.001)\n`;
        const started = await (runtime as PodmanRuntime).exec(ref, {
          cmd: `python3 <<'PY'\n${script}\nPY`,
          timeoutMs: 10_000,
          background: true,
        });
        expect(started.exitCode).toBe(0);
        const ready = await sh(
          ref,
          `for n in $(seq 1 100); do test -f counter-${i} && exit 0; sleep 0.02; done; exit 1`,
        );
        expect(ready.exitCode).toBe(0);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await provider.snapshot(ws);
        const copy = await provider.create(snapshot);
        expect(JSON.stringify(treeOf(copy.path))).not.toContain(hostSecret);
        const inspection = await runEngine(engine!, ['container', 'inspect', ...writers.map((ref) => ref.name)]);
        const states = JSON.parse(inspection.stdout) as { State: { Paused: boolean } }[];
        expect(states.every((c) => !c.State.Paused)).toBe(true);
        expect((await sh(writers[0]!, 'echo resumed')).output).toBe('resumed\n');
      }
      expect(snapshots.count).toBe(3);
    },
  );

  it('临时容器访问不到分支的 localhost 服务，删除分支容器后仍能运行', async () => {
    const branch = await start(spec('branch'));
    await (runtime as PodmanRuntime).exec(branch, {
      cmd: 'cd /tmp && echo from-branch > hello.txt && python3 -m http.server 8765 --bind 127.0.0.1',
      timeoutMs: 10_000,
      background: true,
    });
    const ready = await sh(
      branch,
      'for i in 1 2 3 4 5; do curl --noproxy "*" --max-time 5 -fsS 127.0.0.1:8765/hello.txt && break; sleep 1; done',
    );
    expect(ready.output).toContain('from-branch');
    const temporary = await (runtime as PodmanRuntime).ephemeral(spec('scoper'));
    created.push(temporary);
    const isolated = await sh(temporary, 'curl --noproxy "*" --max-time 5 -fsS http://127.0.0.1:8765/hello.txt');
    expect(isolated.exitCode).toBe(7);
    expect(isolated.output).not.toContain('from-branch');
    await runtime?.remove(branch);
    expect(await runtime?.find(branch.name)).toBeUndefined();
    expect((await sh(temporary, 'echo alive')).output).toBe('alive\n');
  });

  it('临时容器（setup 用的那种）写进 workspace 的文件属于宿主机上跑 Melina 的用户，删掉后不留', async () => {
    const s = spec(`setup-${randomBytes(2).toString('hex')}`);
    const ref = await (runtime as PodmanRuntime).ephemeral(s);
    const r = await sh(ref, 'mkdir -p node_modules && echo ok > node_modules/marker');
    await runtime?.remove(ref);
    expect(r.exitCode).toBe(0);
    const marker = join(s.workspace.host, 'node_modules', 'marker');
    expect(readFileSync(marker, 'utf8')).toBe('ok\n');
    expect(statSync(marker).uid).toBe(process.getuid?.());
    expect((await runtime?.managed())?.filter((c) => c.ref.name === ref.name)).toEqual([]);
  });

  it('超过 128 KiB 的命令照样能跑', async () => {
    const ref = await start(spec('long'));
    const big = 'z'.repeat(200 * 1024);
    expect((await sh(ref, `printf %s '${big}' | wc -c`)).output).toBe(`${200 * 1024}\n`);
  });
});
