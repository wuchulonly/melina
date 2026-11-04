// test/dev/proot-runtime.ts（开发机上顶替容器的 proot 运行时）：没装 proot 就整组跳过（node test/dev/fetch-proot.ts 装）。
// 查的是联调要靠它的几样：路径对得上、看不到宿主机的其他目录和环境变量、超时和取消杀干净（逃出进程组的子进程也不卡住）、
// 后台进程跨调用活着、停容器连后台一起停、输出脱敏、只读挂载改不到原目录、Melina 崩溃重启后的接管；
// 内核有 Landlock 时：读不到宿主机上别的进程的环境变量，netAllow 只放行列出的端口，跨目录 mv、硬链接照常。
// 杀进程、找进程都按本测试目录的标记，几个 worktree 同时跑测试不会互相杀。

import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerRef, ContainerSpec } from '../../../src/core/interfaces/container.ts';
import { landlockAbi, ProotRuntime, prootPath } from '../../dev/proot-runtime.ts';

const haveProot = existsSync(prootPath());
const abi = haveProot ? landlockAbi() : 0;

let dir: string;
let rt: ProotRuntime;
let refs: ContainerRef[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'melina-proot-'));
});

afterEach(async () => {
  for (const ref of refs) await rt?.remove(ref);
  refs = [];
  rmSync(dir, { recursive: true, force: true });
});

function spec(name: string, over: Partial<ContainerSpec> = {}): ContainerSpec {
  const ws = join(dir, `${name}-ws`);
  mkdirSync(ws, { recursive: true });
  return {
    name,
    domain: 'general',
    workspace: { host: ws, container: '/workspace', readOnly: false },
    credentials: [],
    ...over,
  };
}

async function box(name: string, over: Partial<ContainerSpec> = {}) {
  const s = spec(name, over);
  const ref = await rt.start(s);
  refs.push(ref);
  return { ref, ws: s.workspace.host };
}

const run = (ref: ContainerRef, cmd: string, extra: Partial<Parameters<ProotRuntime['exec']>[1]> = {}) =>
  rt.exec(ref, { cmd, timeoutMs: 20_000, ...extra });

describe.skipIf(!haveProot)('proot 显式工具环境', () => {
  function setup(loginShell?: boolean) {
    const etc = join(dir, 'etc');
    const tools = join(dir, 'tools');
    mkdirSync(etc);
    mkdirSync(tools);
    writeFileSync(
      join(etc, 'profile'),
      'export PATH=/usr/bin:/bin\nexport VIRTUAL_ENV=/wrong\nexport PROFILE_LOADED=yes\n',
    );
    writeFileSync(join(tools, 'tool-probe'), '#!/bin/sh\nprintf "TOOL_ENV_OK\\n"\n');
    chmodSync(join(tools, 'tool-probe'), 0o755);
    rt = new ProotRuntime({
      root: join(dir, 'boxes'),
      landlock: false,
      loginShell,
      systemBinds: [
        { host: etc, container: '/etc' },
        { host: tools, container: '/opt/probe/bin' },
      ],
      toolEnvironment: { PATH: '/opt/probe/bin:/usr/bin:/bin', VIRTUAL_ENV: '/opt/probe' },
    });
  }

  it('默认仍读取登录 profile', async () => {
    setup();
    const { ref } = await box('login');
    const result = await run(ref, 'printf "%s %s %s" "$PROFILE_LOADED" "$PATH" "$VIRTUAL_ENV"');
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('yes /usr/bin:/bin /wrong');
  });

  it.each([true, false])('管道失败保留上游退出码（loginShell=%s）', async (loginShell) => {
    setup(loginShell);
    const { ref } = await box('pipeline');
    const result = await run(ref, "sh -c 'echo probe-failed; exit 7' 2>&1 | tail -n 1");
    expect(result.exitCode).toBe(7);
    expect(result.output).toBe('probe-failed\n');
  });

  it.each([false, true])('禁用登录 profile 后前台/后台均保留解释器环境（background=%s）', async (background) => {
    setup(false);
    const { ref, ws } = await box('explicit');
    const result = await run(
      ref,
      `set -eu
test "$PATH" = /opt/probe/bin:/usr/bin:/bin
test "$VIRTUAL_ENV" = /opt/probe
test -z "\${PROFILE_LOADED:-}"
tool-probe
printf done > /workspace/done`,
      { background },
    );
    expect(result.exitCode).toBe(0);
    await expect.poll(() => existsSync(join(ws, 'done')), { timeout: 2000 }).toBe(true);
    const output = background ? await run(ref, `cat ${result.background?.log}`) : result;
    expect(output.output).toContain('TOOL_ENV_OK');
  });
});

describe.skipIf(!haveProot)('proot 运行时', () => {
  beforeEach(() => {
    rt = new ProotRuntime({
      root: join(dir, 'boxes'),
      redactor: { redact: (t) => t.replaceAll('s3cr3t-value', '[凭证「tok」已隐藏]') },
      log: () => {},
    });
  });

  it('命令在 /workspace 里跑，写的文件落在宿主机的 workspace；看不到 /opt 和宿主机的环境变量', async () => {
    const { ref, ws } = await box('a1');
    const r = await run(ref, 'pwd; echo hi > out.txt; ls /opt 2>&1; echo "home=$HOME key=[$DEEPSEEK_API_KEY]"; exit 3');
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('/workspace');
    expect(r.output).toContain('No such file or directory');
    expect(r.output).toContain('home=/root key=[]');
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('hi\n');
  });

  it('附件和 /melina/artifacts 挂在固定位置；cwd 相对 /workspace', async () => {
    const materials = join(dir, 'materials');
    const views = join(dir, 'views');
    mkdirSync(materials);
    mkdirSync(join(views, 'ab'), { recursive: true });
    writeFileSync(join(materials, 'manual.md'), '# 手册\n');
    writeFileSync(join(views, 'ab', 'abc'), '原文\n');
    const { ref, ws } = await box('a2', { materialsDir: materials, artifactsDir: views });
    mkdirSync(join(ws, 'sub'));
    const r = await run(ref, 'pwd; cat /melina/materials/manual.md /melina/artifacts/ab/abc', { cwd: 'sub' });
    expect(r.output).toBe('/workspace/sub\n# 手册\n原文\n');
  });

  it('人选的工作目录不挂到 /melina/origin（proot 做不到只读，挂进来 agent 就写得进去），打一条日志', async () => {
    const logs: string[] = [];
    rt = new ProotRuntime({ root: join(dir, 'boxes'), log: (t) => logs.push(t) });
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    writeFileSync(join(origin, 'data.csv'), 'a,b\n');
    const { ref } = await box('a2o', { originDir: origin });
    const r = await run(ref, 'ls /melina/origin 2>&1; echo x > /melina/origin/data.csv 2>&1; echo done');
    expect(r.output).toContain('done');
    expect(readFileSync(join(origin, 'data.csv'), 'utf8')).toBe('a,b\n');
    expect(logs.some((t) => t.includes('/melina/origin'))).toBe(true);
  });

  it('超时和取消：返回 null 的退出码，命令和它起的子进程都没了', async () => {
    const { ref } = await box('a3');
    const marker = `melina-proot-${Date.now()}`;
    const t = await run(ref, `sleep 30 & sleep 31; echo ${marker}`, { timeoutMs: 500 });
    expect(t).toMatchObject({ exitCode: null, timedOut: true });
    const ac = new AbortController();
    const pending = run(ref, `sleep 32; echo ${marker}`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    expect(await pending).toMatchObject({ exitCode: null, cancelled: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(sleepers()).toEqual([]);
  });

  it('命令自己留下的后台子进程占着输出时，命令结束就返回', async () => {
    const { ref } = await box('a4');
    const started = Date.now();
    const r = await run(ref, 'sleep 5 & echo 起了');
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('起了');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('后台进程跨调用活着、日志在 /melina/logs；停容器时一起停', async () => {
    const { ref } = await box('a5');
    const bg = await run(ref, 'for i in 1 2 3; do echo tick $i; sleep 0.2; done; sleep 30', { background: true });
    expect(bg.background?.log).toMatch(/^\/melina\/logs\/bg-\d+\.log$/);
    await new Promise((r) => setTimeout(r, 900));
    const log = await run(ref, `cat ${bg.background?.log}`);
    expect(log.output).toContain('tick 3');
    // 容器里 kill 那个 pid 就能停掉
    const pid = bg.background?.pid as number;
    expect(existsSync(`/proc/${pid}`)).toBe(true);
    await rt.stop(ref);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it('凭证以环境变量给，输出里换成占位符', async () => {
    const { ref } = await box('a6', {
      credentials: [{ id: '01J0000000000000000000CRED', name: 'tok', as: { env: 'TOK' }, value: 's3cr3t-value' }],
    });
    const r = await run(ref, 'echo "token is $TOK"');
    expect(r.output).toBe('token is [凭证「tok」已隐藏]\n');
  });

  it('显式私有捕获可取原值，普通结果不回传原输出', async () => {
    const { ref } = await box('private-source', {
      credentials: [{ id: '01J0000000000000000000CRED', name: 'tok', as: { env: 'TOK' }, value: 's3cr3t-value' }],
    });
    let value: string | undefined;
    const result = await run(ref, 'printf "%s" "$TOK"', {
      capturePrivate: (raw) => {
        value = raw;
      },
    });
    expect(value).toBe('s3cr3t-value');
    expect(result.output).not.toContain('s3cr3t-value');
    expect(result.output).toContain('未回传');
    await expect(run(ref, 'true', { capturePrivate: () => {}, background: true })).rejects.toThrow('前台');
  });

  it('被动检查先看到完整成功原值，返回替换后的输出；失败调用不收集', async () => {
    const { ref } = await box('loot-source', {
      credentials: [{ id: '01J0000000000000000000CRED', name: 'tok', as: { env: 'TOK' }, value: 's3cr3t-value' }],
    });
    const values: string[] = [];
    const inspectPrivate = (raw: string) => {
      values.push(raw);
      return '已检查并隐藏';
    };
    expect((await run(ref, 'printf "%s" "$TOK"', { inspectPrivate })).output).toBe('已检查并隐藏');
    expect(values).toEqual(['s3cr3t-value']);
    await run(ref, 'printf "%s" "$TOK"; exit 1', { inspectPrivate });
    expect(values).toHaveLength(1);
    await expect(run(ref, 'true', { inspectPrivate, background: true })).rejects.toThrow('前台');
    await expect(run(ref, 'true', { inspectPrivate, capturePrivate: () => {} })).rejects.toThrow('同时');
  });

  it('只读挂载：挂的是去掉写权限的副本，写不进去，原目录也不动', async () => {
    const s = spec('a7');
    writeFileSync(join(s.workspace.host, 'keep.txt'), '原样\n');
    const ref = await rt.start({ ...s, workspace: { ...s.workspace, readOnly: true } });
    refs.push(ref);
    const r = await run(ref, 'cat keep.txt; echo 改了 > keep.txt; touch new.txt; cat keep.txt');
    expect(r.output).toContain('Permission denied');
    expect(r.output.match(/原样/g)).toHaveLength(2);
    expect(readFileSync(join(s.workspace.host, 'keep.txt'), 'utf8')).toBe('原样\n');
    expect(readdirSync(s.workspace.host)).toEqual(['keep.txt']);
  });

  it('Melina 崩溃后新进程接管同一个目录：恢复流程调 removeEphemeral 时才杀上一个实例的命令；同名容器（含只读副本）能重建', async () => {
    const s = spec('a8');
    const ro = { ...s, workspace: { ...s.workspace, readOnly: true } };
    await rt.start(ro);
    const bg = await run({ id: 'a8', name: 'a8' }, 'sleep 30', { background: true });
    const pid = bg.background?.pid as number;
    // 新的实例（不认识上一个的容器）：光构造不杀（误开的第二个 Melina 拿不到锁，不能先把正在跑的那个的命令杀了）
    rt = new ProotRuntime({ root: join(dir, 'boxes'), log: () => {} });
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(true);
    // 恢复流程拿到锁以后调 removeEphemeral：上一个实例起的都杀掉
    await rt.removeEphemeral();
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
    expect(await rt.find('a8')).toBeUndefined();
    const ref = await rt.start(ro);
    refs.push(ref);
    expect((await run(ref, 'echo 又起来了')).output).toBe('又起来了\n');
  });

  it('超时后有子进程逃出进程组、换掉环境变量又占着输出：不卡住，宽限几秒就返回', async () => {
    const { ref } = await box('a9');
    const started = Date.now();
    const r = await run(ref, 'setsid env -i sleep 14.5 & sleep 100', { timeoutMs: 300 });
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(7000);
    killCmdline('sleep 14.5');
  });

  it('容器里有没写权限的目录（go 的模块缓存这类 0555）：remove 删得掉，同名容器能重建', async () => {
    const s = spec('a10');
    let ref = await rt.start(s);
    await run(ref, 'mkdir -p /root/go/pkg/mod/x && touch /root/go/pkg/mod/x/f && chmod -R a-w /root/go');
    await rt.remove(ref);
    expect(existsSync(join(dir, 'boxes', 'a10'))).toBe(false);
    ref = await rt.start(s);
    refs.push(ref);
    expect((await run(ref, 'echo 好了')).output).toBe('好了\n');
  });

  it('proot 起不来（进程数满了、没有执行权限）：前台、后台命令都如实返回 127 和原因，Melina 不退出', async () => {
    const broken = join(dir, 'proot-not-executable');
    writeFileSync(broken, '#!/bin/sh\n', { mode: 0o644 });
    rt = new ProotRuntime({ root: join(dir, 'boxes'), proot: broken, log: () => {} });
    const { ref } = await box('a12');
    const fg = await run(ref, 'echo hi');
    expect(fg.exitCode).toBe(127);
    expect(fg.output).toContain('proot 起不来');
    const bg = await run(ref, 'sleep 30', { background: true });
    expect(bg.exitCode).toBe(127);
    expect(bg.output).toContain('proot 起不来');
    expect(bg.background).toBeUndefined();
  });

  it('后台命令的工作目录不在：如实返回退出码 2 和原因，不当成起了后台进程', async () => {
    const { ref } = await box('a11');
    const r = await run(ref, 'sleep 30', { background: true, cwd: 'nope' });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('工作目录不存在');
    expect(r.background).toBeUndefined();
  });
});

describe.skipIf(!haveProot || abi === 0)('proot 运行时：Landlock', () => {
  let host: ChildProcess | undefined;
  const servers: Server[] = [];

  afterEach(async () => {
    host?.kill('SIGKILL');
    host = undefined;
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(r));
  });

  it('读不到宿主机上别的进程的环境变量（门槛 1 时令牌就是这么漏的）；自己的照常读', async () => {
    rt = new ProotRuntime({ root: join(dir, 'boxes'), log: () => {} });
    expect(rt.isolation.landlock).toBe(true);
    // 宿主机上一个带「令牌」的进程，和 Melina、Claude Code 一样不在域里
    host = spawn('sleep', ['37'], {
      env: { ...process.env, MELINA_TEST_TOKEN: 'tok-should-not-leak' },
      stdio: 'ignore',
    });
    const pid = host.pid as number;
    const { ref } = await box('l1');
    const r = await run(
      ref,
      `cat /proc/${pid}/environ; echo "rc=$?"; readlink /proc/${pid}/cwd; echo "cwd=$?"; cat /proc/self/environ | tr '\\0' '\\n' | grep -c '^HOME='`,
    );
    expect(r.output).not.toContain('tok-should-not-leak');
    expect(r.output).toContain('Permission denied');
    expect(r.output).toMatch(/rc=1\n/);
    expect(r.output).toMatch(/cwd=1\n/);
    expect(r.output.trim().split('\n').at(-1)).toBe('1');
  });

  it('跨目录 mv、硬链接、git 写对象照常（文件系统只为建域，不限）', async () => {
    rt = new ProotRuntime({ root: join(dir, 'boxes'), log: () => {} });
    const { ref, ws } = await box('l2');
    const r = await run(
      ref,
      [
        'echo a > /tmp/a && mv /tmp/a ./a',
        'mkdir d && mv a d/a && ln d/a b',
        'git init -q . && git add -A && git -c user.email=k@k -c user.name=k commit -qm x',
        "python3 -c \"import os; open('t','w').write('x'); os.replace('t', 'd/t')\"",
        'echo ok',
      ].join(' && '),
    );
    expect(r.output.trim()).toBe('ok');
    expect(readFileSync(join(ws, 'b'), 'utf8')).toBe('a\n');
  });

  it.skipIf(abi < 4)('netAllow：只许连列出的 TCP 端口', async () => {
    const open = await listen();
    const closed = await listen();
    rt = new ProotRuntime({ root: join(dir, 'boxes'), log: () => {}, netAllow: [open] });
    expect(rt.isolation.netAllow).toEqual([open]);
    const { ref } = await box('l3');
    const probe = (port: number) =>
      `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo "${port} 通" || echo "${port} 不通"`;
    const r = await run(ref, `${probe(open)}; ${probe(closed)}`);
    expect(r.output).toBe(`${open} 通\n${closed} 不通\n`);
  });

  async function listen(): Promise<number> {
    const srv = createServer((sock) => sock.end());
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address();
    if (addr === null || typeof addr === 'string') throw new Error('没拿到端口');
    return addr.port;
  }
});

/** 这个测试的目录下起的、还活着的 sleep 3x（按环境变量里的目录标记认，别的 worktree 同时跑的测试不算） */
function sleepers(): string[] {
  const out: string[] = [];
  const mark = `MELINA_PROOT_ROOT=${join(dir, 'boxes')}`;
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      const env = readFileSync(`/proc/${p}/environ`, 'latin1').split('\0');
      if (/^sleep 3[012]$/.test(cmd) && env.includes(mark) && alive(Number(p))) out.push(`${p} ${cmd}`);
    } catch {}
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z');
  } catch {
    return false;
  }
}

/** 逃出去、环境变量也换掉了的进程只能按命令行认（用不常见的参数，免得碰到别的） */
function killCmdline(cmdline: string): void {
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      if (readFileSync(`/proc/${p}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() === cmdline) {
        process.kill(Number(p), 'SIGKILL');
      }
    } catch {}
  }
}
