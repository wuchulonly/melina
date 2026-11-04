// SDK 生命周期、配置、事件流与结果交付。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Melina, type MelinaInternals, notConnectedRuntime, type Runtime } from '../../../src/api/sdk.ts';
import type { MelinaOptions } from '../../../src/core/api.ts';
import { MelinaError } from '../../../src/core/errors.ts';
import type { MelinaEvent, SystemNotice } from '../../../src/core/events.ts';
import { PodmanRuntime } from '../../../src/tools/container.ts';
import { SecretRedactor } from '../../../src/tools/redact.ts';
import { FakeEngine } from '../tools/fake-engine.ts';
import { type FakeRuntimeHandle, fakeRuntime, MODEL, tempDir } from './kit.ts';

let dir: string;
const quiet = { warn: () => {}, error: () => {} };

beforeEach(() => {
  dir = tempDir('melina-sdk-');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function melina(internals: MelinaInternals = {}, options: Partial<MelinaOptions> = {}): Melina {
  return new Melina(
    { db: join(dir, 'melina.db'), artifacts: join(dir, 'artifacts'), ...options },
    { containers: null, env: {}, log: quiet, ...internals },
  );
}

/** 等到条件成立（后台查容器、定时重查这类异步的事） */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('等不到');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function noticesOf(k: Melina, kind: SystemNotice['kind']): SystemNotice[] {
  return (k.status().notices ?? []).filter((n) => n.kind === kind);
}

describe('Melina', () => {
  it('没接运行时：能看、能改配置，建任务和动任务回 unavailable', async () => {
    const k = melina({ runtime: notConnectedRuntime });
    try {
      expect(k.runtimeConnected).toBe(false);
      expect(k.runs()).toEqual([]);
      expect(k.models()).toEqual({ providers: [], strong: [], fast: [] });
      await expect(k.createRun({ goal: { statement: 'x' } })).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await k.close();
    }
  });

  it('默认接上运行时；没有容器引擎时建任务回 unavailable，说清楚缺什么', async () => {
    const k = melina({}, { models: { strong: [MODEL], fast: [{ ...MODEL, tier: 'fast' }] } });
    try {
      expect(k.runtimeConnected).toBe(true);
      await k.ready();
      await expect(k.createRun({ goal: { statement: 'x' } })).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringContaining('容器引擎'),
      });
      expect(k.runs()).toEqual([]);
    } finally {
      await k.close();
    }
  });

  it('Linux 上引擎不是 rootless 时拒绝建任务，不留下 Run 或启动容器', async () => {
    if (process.platform !== 'linux') return;
    const engine = new FakeEngine();
    engine.info.rootless = false;
    const containers = new PodmanRuntime({
      engine,
      images: { imageFor: (domain) => `melina-${domain}:test` },
      redactor: new SecretRedactor(),
    });
    const k = melina({ containers });
    try {
      await k.ready();
      await expect(k.createRun({ goal: { statement: 'x' } })).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringContaining('不是 rootless'),
      });
      expect(k.runs()).toEqual([]);
      expect(engine.callsOf('run')).toEqual([]);
    } finally {
      await k.close();
    }
  });

  it('冻不住容器（rootless 没让 systemd 管 cgroup）：系统状态是 sandbox 的 error，建任务被拒、不留 Run；修好了不用重启', async () => {
    const engine = new FakeEngine();
    engine.noCgroup = true;
    engine.info = { ...engine.info, memoryLimit: false, pidsLimit: false, cgroupManager: 'cgroupfs' };
    for (const domain of ['code', 'research', 'general']) engine.images.add(`melina-${domain}:test`);
    const containers = new PodmanRuntime({
      engine,
      images: { imageFor: (domain) => `melina-${domain}:test` },
      redactor: new SecretRedactor(),
      onWarn: () => {},
      freezeRetryMs: 10,
    });
    const k = melina({ containers, containerRecheckMs: 20 });
    try {
      await k.ready();
      await until(() => noticesOf(k, 'sandbox').length > 0);
      // 上限不生效是同一个原因：只有一条
      expect(noticesOf(k, 'sandbox')).toEqual([
        {
          kind: 'sandbox',
          level: 'error',
          text: expect.stringContaining('cannot pause the container without a cgroup'),
        },
      ]);
      await expect(k.createRun({ goal: { statement: 'x' } })).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringContaining('冻不住容器'),
      });
      expect(k.runs()).toEqual([]);
      engine.noCgroup = false;
      engine.info = { ...engine.info, memoryLimit: true, pidsLimit: true, cgroupManager: 'systemd' };
      // 上限那条也跟着没了：真试过冻结以后重新看了 info
      await until(() => noticesOf(k, 'sandbox').length === 0);
    } finally {
      await k.close();
    }
  });

  it('没装 slirp4netns：按分支容器的参数起不来容器，系统状态说装什么，建任务被拒；装上了不用重启', async () => {
    const engine = new FakeEngine();
    engine.noSlirp4netns = true;
    for (const domain of ['code', 'research', 'general']) engine.images.add(`melina-${domain}:test`);
    const containers = new PodmanRuntime({
      engine,
      images: { imageFor: (domain) => `melina-${domain}:test` },
      redactor: new SecretRedactor(),
      onWarn: () => {},
    });
    const k = melina({ containers, containerRecheckMs: 20 });
    try {
      await k.ready();
      await until(() => noticesOf(k, 'sandbox').length > 0);
      expect(noticesOf(k, 'sandbox')).toEqual([
        { kind: 'sandbox', level: 'error', text: expect.stringContaining('装上 slirp4netns 这个包') },
      ]);
      await expect(k.createRun({ goal: { statement: 'x' } })).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringContaining('could not find slirp4netns'),
      });
      expect(k.runs()).toEqual([]);
      engine.noSlirp4netns = false;
      await until(() => noticesOf(k, 'sandbox').length === 0);
    } finally {
      await k.close();
    }
  });

  it('先恢复再开始调度：ready() 等恢复和 start 都跑完，建任务也会等', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const base = notConnectedRuntime();
    const runtime = (): Runtime => ({
      ...base,
      start: async () => {
        order.push('start');
      },
      runs: {
        ...base.runs,
        create: async () => {
          order.push('create');
          throw new MelinaError('conflict', '测试');
        },
      },
      recovery: {
        run: async () => {
          order.push('recovery');
          await gate;
          order.push('recovered');
          return { runs: [], branches: [], unknownCommands: [], rescoped: [] };
        },
      },
    });
    const k = melina({ runtime });
    try {
      const creating = k.createRun({ goal: { statement: 'x' } }).catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
      expect(order).toEqual(['recovery']);
      release();
      await k.ready();
      await creating;
      expect(order).toEqual(['recovery', 'recovered', 'start', 'create']);
    } finally {
      await k.close();
    }
  });

  it('恢复失败：ready() 和之后的调用都报这个错，close 照样能关', async () => {
    const k = melina({
      runtime: () => ({
        ...notConnectedRuntime(),
        recovery: {
          run: async () => {
            throw new Error('恢复坏了');
          },
        },
      }),
    });
    await expect(k.ready()).rejects.toThrow('恢复坏了');
    await expect(k.createRun({ goal: { statement: 'x' } })).rejects.toThrow('恢复坏了');
    await k.close();
    await k.close(); // 可以重复调
  });

  it('createRun 的参数：相对路径按当前目录算，附件要是文件，接着做不传 workspace', async () => {
    const handle: FakeRuntimeHandle = {};
    const k = melina({ runtime: fakeRuntime(handle) });
    try {
      writeFileSync(join(dir, 'notes.md'), '笔记');
      mkdirSync(join(dir, 'ws'));
      await expect(k.createRun({ goal: { statement: 'x', materials: [join(dir, 'nope.md')] } })).rejects.toThrow(
        '附件不是文件',
      );
      const run = await k.createRun({
        goal: {
          statement: '看笔记',
          materials: [join(dir, 'notes.md'), { path: join(dir, 'notes.md'), name: '副本.md' }],
        },
        workspace: { root: join(dir, 'ws') },
      });
      expect(run.get().goal.materials.map((m) => m.name)).toEqual(['notes.md', '副本.md']);
      await expect(
        k.createRun({ goal: { statement: 'x' }, workspace: { root: join(dir, 'ws') }, continueFrom: run.id }),
      ).rejects.toThrow('不传 workspace');
      await expect(
        k.createRun({ goal: { statement: 'x' }, continueFrom: '01K6F1W3S2A8Q0Q6YH7J5M4N3P' }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(k.createRun({ goal: { statement: '' } })).rejects.toMatchObject({ code: 'invalid' });
      await expect(k.createRun({ goal: { statement: 'x' }, workspace: { root: k.paths.dataDir } })).rejects.toThrow(
        '数据目录',
      );
      expect(() => k.run('01K6F1W3S2A8Q0Q6YH7J5M4N3P')).toThrow('没有这个任务');
    } finally {
      await k.close();
    }
  });

  it('run.events() 在 Run 结束后自己停；run.result() 没结束就等', async () => {
    const handle: FakeRuntimeHandle = {};
    const k = melina({ runtime: fakeRuntime(handle) });
    try {
      const run = await k.createRun({ goal: { statement: '做点什么' } });
      const seen: MelinaEvent['type'][] = [];
      const consuming = (async () => {
        for await (const ev of run.events()) seen.push(ev.type);
      })();
      const result = run.result();
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false);
      await run.cancel();
      expect((await result).status).toBe('cancelled');
      await consuming;
      expect(seen[0]).toBe('run.created');
      expect(seen.at(-1)).toBe('run.updated');
      // 结束以后再要：马上给
      expect((await run.result()).status).toBe('cancelled');
      const again: string[] = [];
      for await (const ev of run.events()) again.push(ev.type);
      expect(again).toEqual(seen);
    } finally {
      await k.close();
    }
  });

  it('Melina 关掉时，还在等的 run.events()、run.result() 都停下', async () => {
    const k = melina({ runtime: fakeRuntime({}) });
    const run = await k.createRun({ goal: { statement: 'x' } });
    const seen: string[] = [];
    const consuming = (async () => {
      for await (const ev of run.events()) seen.push(ev.type);
    })();
    const waiting = run.result();
    await new Promise((r) => setTimeout(r, 20));
    await k.close();
    await consuming;
    expect(seen[0]).toBe('run.created');
    await expect(waiting).rejects.toThrow('Melina 已经关了');
  });

  it('已经结束的 Run：events({ since: lastSeq }) 不挂着，给完 since 之后的就停', async () => {
    const k = melina({ runtime: fakeRuntime({}) });
    try {
      const run = await k.createRun({ goal: { statement: 'x' } });
      await run.cancel();
      const after: string[] = [];
      for await (const ev of run.events({ since: run.summary().lastSeq })) after.push(ev.type);
      expect(after).toEqual([]);
      const all: string[] = [];
      for await (const ev of run.events()) all.push(ev.type);
      expect(all).toEqual(['run.created', 'run.updated']);
      const tail: string[] = [];
      const first = run.summary().lastSeq;
      for await (const ev of run.events({ since: first - 1 })) tail.push(ev.type);
      expect(tail).toEqual(['run.updated']);
    } finally {
      await k.close();
    }
  });

  it('run.result() 可以用 signal 不等了', async () => {
    const k = melina({ runtime: fakeRuntime({}) });
    try {
      const run = await k.createRun({ goal: { statement: 'x' } });
      const abort = new AbortController();
      const waiting = run.result({ signal: abort.signal });
      abort.abort(new Error('不等了'));
      await expect(waiting).rejects.toThrow('不等了');
    } finally {
      await k.close();
    }
  });

  it('melina.events() 默认只推新的，可以从某个 seq 补', async () => {
    const k = melina({ runtime: fakeRuntime({}) });
    try {
      const abort = new AbortController();
      const got: MelinaEvent[] = [];
      const consuming = (async () => {
        for await (const ev of k.events({ signal: abort.signal })) {
          got.push(ev);
          if (got.length === 1) abort.abort();
        }
      })();
      await new Promise((r) => setTimeout(r, 10));
      const run = await k.createRun({ goal: { statement: 'x' } });
      await consuming;
      expect(got[0]).toMatchObject({ type: 'run.created', runId: run.id });
    } finally {
      await k.close();
    }
  });

  it('配置以数据库为准：构造参数只在第一次当初值；setModels 查 DeepSeek 目录', async () => {
    const first = melina({}, { models: { strong: [MODEL], fast: [] } });
    expect(first.models().strong).toEqual([MODEL]);
    first.setModels({ providers: [], strong: [], fast: [] });
    expect(() => first.setModels({ providers: [{ provider: 'nope' }], strong: [], fast: [] })).toThrow(
      '不支持供应商 nope；当前仅启用 DeepSeek',
    );
    await first.close();
    const second = melina({}, { models: { strong: [MODEL], fast: [] } });
    expect(second.models().strong).toEqual([]);
    await second.close();
  });

  it('设置改了，脱敏跟着换（之后启动的容器、落盘的输出都不出现新凭证）', async () => {
    let deps: Parameters<NonNullable<MelinaInternals['runtime']>>[0] | undefined;
    const k = melina({
      runtime: (d) => {
        deps = d;
        return notConnectedRuntime();
      },
    });
    try {
      k.setSettings({
        credentials: [{ name: 'tok', as: { env: 'GH_TOKEN' }, value: 'super-secret-value' }],
        notify: true,
      });
      expect(deps?.redactor.redact('echo super-secret-value')).not.toContain('super-secret-value');
      expect(deps?.config.credentials()[0]?.value).toBe('super-secret-value');
    } finally {
      await k.close();
    }
  });

  it(':memory:：数据放在临时目录，关掉就删，不在当前目录留文件', async () => {
    const before = readdirSync(process.cwd());
    const k = new Melina(
      { db: ':memory:', artifacts: join(dir, 'artifacts') },
      { containers: null, env: {}, log: quiet },
    );
    const scratch = k.paths.scratch;
    try {
      expect(scratch && existsSync(join(scratch, 'melina.db'))).toBe(true);
      expect(k.paths.keyFile).toBeUndefined();
      k.setSettings({ credentials: [{ name: 't', as: { env: 'GH_TOKEN' }, value: 'v-123456' }], notify: false });
      expect(k.settings().credentials[0]?.hasValue).toBe(true);
    } finally {
      await k.close();
    }
    expect(scratch && existsSync(scratch)).toBe(false);
    expect(readdirSync(process.cwd())).toEqual(before);
  });

  it('构造参数不对：报 invalid，数据库连接都关上（同一个文件马上能再打开）', async () => {
    expect(() =>
      melina({}, { models: { strong: [{ provider: 'deepseek', model: 'x', tier: 'fast' }], fast: [] } }),
    ).toThrow(MelinaError);
    const k = melina();
    expect(k.models()).toEqual({ providers: [], strong: [], fast: [] });
    await k.close();
  });

  it('MELINA_SECRET_KEY 给了就不用密钥文件', async () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const k = melina({ env: { MELINA_SECRET_KEY: key } });
    try {
      k.setModels({ providers: [{ provider: 'deepseek', keys: [{ key: 'sk-abcdef' }] }], strong: [], fast: [] });
    } finally {
      await k.close();
    }
    expect(() => readFileSync(join(dir, 'melina.key'))).toThrow();
    const again = melina({ env: { MELINA_SECRET_KEY: key } });
    try {
      expect(again.models().providers[0]?.keys?.[0]?.hasKey).toBe(true);
    } finally {
      await again.close();
    }
  });

  it('启动后在后台查容器引擎和镜像：缺了记日志、进系统状态的提示；建好了不用重启，提示自己没了（C03）', async () => {
    const warnings: string[] = [];
    let built = false;
    const containers = {
      engine: 'podman',
      withWorkspaceFrozen: async <T>(_path: string, work: () => Promise<T>) => work(),
      probe: async () => ({ kind: 'podman', version: '5', rootless: false, memoryLimit: true, pidsLimit: true }),
      checkImages: async (domains: readonly string[]) =>
        domains.map((domain) => ({
          domain,
          image: `localhost/melina-${domain}:x`,
          present: built || domain === 'general',
        })),
    } as unknown as NonNullable<MelinaInternals['containers']>;
    const k = melina({ containers, containerRecheckMs: 20, log: { warn: (m) => warnings.push(m), error: () => {} } });
    try {
      await k.ready();
      await until(() => noticesOf(k, 'images').length > 0);
      expect(noticesOf(k, 'images')).toEqual([
        { kind: 'images', level: 'error', text: expect.stringContaining('pnpm images code research') },
      ]);
      expect(noticesOf(k, 'sandbox')).toEqual([
        {
          kind: 'sandbox',
          level: process.platform === 'linux' ? 'error' : 'warning',
          text: expect.stringContaining('不是 rootless'),
        },
      ]);
      expect(warnings.filter((w) => w.includes('pnpm images code research'))).toHaveLength(1);
      const logged = warnings.length;
      built = true;
      await until(() => noticesOf(k, 'images').length === 0);
      // 不是 rootless 那条不会自己变，照旧在；每分钟重查时同一条不再记日志
      expect(noticesOf(k, 'sandbox')).toHaveLength(1);
      expect(warnings).toHaveLength(logged);
    } finally {
      await k.close();
    }
  });

  it('容器引擎用不了：系统状态里是 sandbox 的 error；修好了不用重启（C03）', async () => {
    let fixed = false;
    const containers = {
      engine: 'podman',
      withWorkspaceFrozen: async <T>(_path: string, work: () => Promise<T>) => work(),
      probe: async () => {
        if (!fixed) throw new MelinaError('unavailable', 'podman 用不了：cannot connect to Podman socket');
        return { kind: 'podman', version: '5', rootless: true, memoryLimit: true, pidsLimit: true };
      },
      checkImages: async (domains: readonly string[]) =>
        domains.map((domain) => ({ domain, image: `localhost/melina-${domain}:x`, present: true })),
    } as unknown as NonNullable<MelinaInternals['containers']>;
    const k = melina({ containers, containerRecheckMs: 20 });
    try {
      await k.ready();
      await until(() => noticesOf(k, 'sandbox').length > 0);
      expect(noticesOf(k, 'sandbox')).toEqual([
        { kind: 'sandbox', level: 'error', text: expect.stringContaining('cannot connect to Podman socket') },
      ]);
      fixed = true;
      await until(() => noticesOf(k, 'sandbox').length === 0);
    } finally {
      await k.close();
    }
  });

  it('没有容器引擎、模型没配好：系统状态里一开始就写着；配好模型提示就没了（C03）', async () => {
    const k = melina();
    try {
      expect(noticesOf(k, 'sandbox')).toEqual([
        { kind: 'sandbox', level: 'error', text: expect.stringContaining('没找到容器引擎') },
      ]);
      expect(noticesOf(k, 'models').map((n) => n.level)).toEqual(['error', 'error']);
      k.setModels({
        providers: [{ provider: 'deepseek', keys: [{ key: 'sk-abcdef' }] }],
        strong: [MODEL],
        fast: [{ ...MODEL, tier: 'fast' }],
      });
      expect(noticesOf(k, 'models')).toEqual([]);
    } finally {
      await k.close();
    }
  });

  it('存储的凭证无效时拒绝启动，不跳过凭证继续运行', async () => {
    const first = melina();
    await first.ready();
    first.setSettings({
      credentials: [{ name: 'GitHub token', as: { env: 'GH_TOKEN' }, value: 'ghp_x' }],
      notify: true,
    });
    await first.close();
    // 绕过设置校验损坏存储，启动时仍应拒绝。
    const db = new Database(join(dir, 'melina.db'));
    db.prepare("UPDATE credentials SET as_env = 'PATH'").run();
    db.close();
    expect(() => melina()).toThrow('凭证「GitHub token」不能用环境变量名 PATH');
  });

  it('系统状态：合格式，熔断和配置变了会发 system.updated', async () => {
    const k = melina({ statusIntervalMs: 50 });
    try {
      const status = k.status();
      expect(status.runs).toEqual({ running: 0, paused: 0 });
      const events: MelinaEvent[] = [];
      const abort = new AbortController();
      const consuming = (async () => {
        for await (const ev of k.events({ since: 0, signal: abort.signal })) {
          events.push(ev);
          if (ev.type === 'system.updated' && ev.data.providers.some((p) => p.provider === 'deepseek')) abort.abort();
        }
      })();
      k.setModels({ providers: [{ provider: 'deepseek' }], strong: [MODEL], fast: [] });
      await consuming;
      expect(events.at(-1)?.type).toBe('system.updated');
    } finally {
      await k.close();
    }
  });
});

it('SDK 直接会话完成、读取结果后可接着创建新任务', async () => {
  mkdirSync(join(dir, 'repo'));
  const handle: FakeRuntimeHandle = {};
  const k = melina({ runtime: fakeRuntime(handle, { scripted: true }) });
  try {
    const first = await k.createRun({ goal: { statement: '完成任务' }, workspace: { root: join(dir, 'repo') } });
    expect((await first.result()).status).toBe('done');
    const next = await k.createRun({ goal: { statement: '继续核对边界' }, continueFrom: first.id });
    expect((await next.result()).status).toBe('done');
    expect(handle.runs?.calls.filter((c) => c.method === 'create')).toHaveLength(2);
  } finally {
    await k.close();
  }
});
