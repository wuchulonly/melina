// ToolGateway 的环境工具：sh、read、edit、write 在调用方的容器里执行（这里在宿主机上真跑），
// act 可省略 expect、执行前先写意图、原文进 Artifact store 和本分支的 /melina/artifacts、大输出只回摘要和路径、
// 写 Observation 和工具账、输出里的凭证换掉、别的分支的原文看不到。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePath } from '../../../src/core/ids.ts';
import type { Branch, ExecContention, Observation } from '../../../src/core/types.ts';
import { FOREGROUND_MAX_MS } from '../../../src/tools/sh.ts';
import { type BranchKit, branch, call, type Kit, kit, openExplorer, SECRET, sh } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());

const obsOf = (id: string) => k.runStore.queries.getObservation(id) as Observation;
const branchNow = (b: BranchKit) => k.runStore.queries.getBranch(b.branch.id) as Branch;

describe('sh', () => {
  it('melina-batch 通过 sh 使用实际总预算，恢复不重跑已完成项，Observation 保留原命令', async () => {
    k = kit({ config: { sh: { timeoutMs: 5000 } } });
    const b = await branch(k);
    writeFileSync(
      join(b.ws, 'items.json'),
      JSON.stringify([{ id: 'one', argv: ['bash', '-c', 'echo once >> count; echo result'] }]),
    );
    const session = openExplorer(k, b);
    const cmd = 'melina-batch run items.json --state .batch --item-timeout 1';
    const first = await call(session, 'sh', { cmd, expect: '逐项执行并保存结果' });
    expect(first.isError).toBe(false);
    expect(first.json?.summary).toContain('completed');
    expect(obsOf(first.observationId as string).args).toMatchObject({ cmd });
    const state = JSON.parse(readFileSync(join(b.ws, '.batch/state.json'), 'utf8'));
    expect(state.budgetSeconds).toBeGreaterThan(0);
    expect(state.budgetSeconds).toBeLessThanOrEqual(5);
    await call(session, 'sh', { cmd, expect: '已完成项不重复执行' });
    expect(readFileSync(join(b.ws, 'count'), 'utf8')).toBe('once\n');
  });

  it('melina-batch 前面的等待计入同一个期限，不会在批次开始时重置预算', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, 'items.json'), JSON.stringify([{ id: 'one', argv: ['echo', 'done'] }]));
    const result = await call(openExplorer(k, b), 'sh', {
      cmd: 'sleep 0.4; melina-batch run items.json --state .batch --reserve 0.2 --item-timeout 1.8',
      expect: '剩余时间不足就保存 pending',
      timeoutMs: 2000,
    });
    expect(result.isError).toBe(false);
    const state = JSON.parse(readFileSync(join(b.ws, '.batch/state.json'), 'utf8'));
    expect(state.status).toBe('paused');
    expect(state.budgetSeconds).toBeLessThan(1.7);
    expect(state.items[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('melina-batch 后台显式预算独立于前台时限，wait 在完成时返回状态', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, 'items.json'), JSON.stringify([{ id: 'one', argv: ['echo', 'done'] }]));
    const session = openExplorer(k, b);
    const first = await call(session, 'sh', {
      cmd: 'melina-batch run items.json --state .batch --budget 10 --item-timeout 1',
      expect: '后台批次完成后保存 completed',
      background: true,
      timeoutMs: 1000,
    });
    expect(first.isError).toBe(false);
    const result = await call(session, 'sh', {
      cmd: 'melina-batch wait --state .batch --seconds 10',
      timeoutMs: 5000,
    });
    expect(result.isError).toBe(false);
    expect(result.json?.summary).toContain('"active": false');
    expect(result.json?.summary).toContain('"status": "completed"');
    expect(JSON.parse(readFileSync(join(b.ws, '.batch/state.json'), 'utf8')).budgetSeconds).toBe(10);
    await k.runtime.stop(b.container);
  });

  it('只读命令也先记录意图：在 workspace 里执行，摘要带退出码；写 Observation、记工具账、算一次工具调用', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, 'a.txt'), 'hello\n');
    const s = openExplorer(k, b);
    const r = await call(s, 'sh', { cmd: 'cat a.txt; ls' });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ summary: '退出码 0\nhello\na.txt' });
    expect(r.json?.path).toBeUndefined();
    const obs = obsOf(r.observationId as string);
    expect(obs).toMatchObject({
      branchId: b.branch.id,
      episode: 1,
      role: 'explorer',
      tool: 'sh',
      args: { cmd: 'cat a.txt; ls' },
      exitCode: 0,
      snapshot: 'root',
      summary: '退出码 0\nhello\na.txt',
    });
    expect(Buffer.from(await k.runStore.artifacts!.read(k.run.id, obs.output)).toString()).toBe('hello\na.txt\n');
    expect(s.toolCalls).toBe(1);
    expect(branchNow(b).toolCalls).toBe(1);
    expect(k.ledger).toEqual([
      expect.objectContaining({ runId: k.run.id, branchId: b.branch.id, role: 'explorer', tool: 'cat' }),
    ]);
    expect(k.ledger[0]).toMatchObject({ exitCode: 0, bytes: 12, handle: obs.output });
    expect(k.runStore.queries.pendingShIntents(k.run.id)).toEqual([]);
    expect(k.runStore.published.find((e) => e.type === 'sh.intent')?.data).toMatchObject({
      id: obs.id,
      cmd: 'cat a.txt; ls',
    });
  });

  it('退出码不是 0 也是一次正常的观测，不算出错', async () => {
    k = kit();
    const b = await branch(k);
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'echo boom >&2; exit 3' });
    expect(r.isError).toBe(false);
    expect(r.json?.summary).toBe('退出码 3\nboom');
    expect(obsOf(r.observationId as string).exitCode).toBe(3);
  });

  it('所有分支的 sh 都可省略 expect，仍记录意图、执行结果和工具次数', async () => {
    k = kit();
    for (const kind of ['direct'] as const) {
      const b = await branch(k, { kind });
      const s = openExplorer(k, b);
      const result = await call(s, 'sh', { cmd: 'printf observed' });
      expect(result.isError, kind).toBe(false);
      const o = obsOf(result.observationId as string);
      expect(o.summary).toContain('observed');
      expect(o.expect).toBeUndefined();
      expect(k.runStore.published.some((e) => e.type === 'sh.intent' && e.data.id === o.id)).toBe(true);
      expect(s.toolCalls).toBe(1);
    }
  });

  it('命令执行：执行前先写 sh.intent，之后那条 Observation 用同一个 id，带上 expect', async () => {
    k = kit();
    const b = await branch(k);
    const r = await call(openExplorer(k, b), 'sh', {
      cmd: 'touch made && echo done',
      expect: '建出 made 文件，打印 done',
    });
    expect(r.isError).toBe(false);
    const types = k.runStore.published.map((e) => e.type);
    const intent = k.runStore.published.find((e) => e.type === 'sh.intent');
    const created = k.runStore.published.find((e) => e.type === 'observation.created');
    expect(types.indexOf('sh.intent')).toBeLessThan(types.indexOf('observation.created'));
    expect(intent?.data).toEqual({
      id: r.observationId,
      branchId: b.branch.id,
      episode: 1,
      cmd: 'touch made && echo done',
      expect: '建出 made 文件，打印 done',
    });
    expect(created?.data).toMatchObject({ id: r.observationId, expect: '建出 made 文件，打印 done' });
    expect(k.runStore.queries.pendingShIntents(k.run.id)).toEqual([]);
    expect(existsSync(join(b.ws, 'made'))).toBe(true);
  });

  it('工具层的名额（§12）：sh、read 执行前各要一个、执行完就还；排队时被取消的不执行，也不留 shell 意图', async () => {
    const asked: { runId: string; branchId?: string }[] = [];
    let held = 0;
    let gate: (() => void) | undefined;
    k = kit({
      deps: {
        toolSlots: {
          toolSlot: async (req, signal) => {
            asked.push(req);
            if (gate === undefined) {
              held++;
              return { release: () => held-- };
            }
            // 名额满了：等放开或者被取消
            await new Promise<void>((resolve, reject) => {
              const open = gate as () => void;
              gate = () => {
                open();
                resolve();
              };
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            held++;
            return { release: () => held-- };
          },
        },
      },
    });
    const b = await branch(k);
    const s = openExplorer(k, b);
    await sh(s, 'echo hi');
    expect((await call(s, 'read', { path: 'README.md' })).isError).toBeDefined();
    expect(asked).toEqual([
      { runId: k.run.id, branchId: b.branch.id },
      { runId: k.run.id, branchId: b.branch.id },
    ]);
    expect(held).toBe(0);

    gate = () => {};
    const ac = new AbortController();
    const pending = call(s, 'sh', { cmd: 'touch made', expect: '建出文件' }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    expect(k.runtime.execs.some((e) => e.cmd.includes('touch made'))).toBe(false);
    ac.abort(new Error('不等了'));
    const r = await pending;
    expect(r).toMatchObject({ isError: true });
    expect(r.content).toMatch(/已取消，命令没有执行/);
    expect(k.runStore.published.filter((e) => e.type === 'sh.intent').map((e) => e.data.cmd)).toEqual(['echo hi']);
    expect(existsSync(join(b.ws, 'made'))).toBe(false);
    expect(held).toBe(0);
  });

  it('分支已经不在跑：执行意图写不进去，命令不执行', async () => {
    k = kit();
    const b = await branch(k);
    const s = openExplorer(k, b);
    k.runStore.writer.updateBranch(b.branch.id, { state: 'paused' });
    const r = await call(s, 'sh', { cmd: 'touch made', expect: '建出文件' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/这次命令没有执行/);
    expect(existsSync(join(b.ws, 'made'))).toBe(false);
  });

  it('大输出：原文进 Artifact store 和本分支的视图，只回头尾片段、大小和只读路径', async () => {
    k = kit({ config: { toolOutput: { inlineMaxTokens: 200 } } });
    const b = await branch(k);
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'seq 1 5000' });
    const obs = obsOf(r.observationId as string);
    const path = `/melina/artifacts/${handlePath(obs.output)}`;
    expect(r.json?.path).toBe(path);
    const summary = r.json?.summary as string;
    expect(summary).toMatch(
      /^退出码 0\n输出共 5000 行、[\d.]+ KB，太长了，下面只有开头和结尾；原文在 \/melina\/artifacts\//,
    );
    expect(summary).toContain('--- 开头 ---\n1\n2\n3\n');
    expect(summary).toMatch(/--- 结尾 ---\n[\s\S]*4999\n5000$/);
    expect(summary).toMatch(/……（中间 \d+ 行没有显示）……/);
    const full = Buffer.from(await k.runStore.artifacts!.read(k.run.id, obs.output)).toString();
    expect(full.split('\n')).toHaveLength(5001);
    // 本分支的 /melina/artifacts 里有它，容器里按路径能读到
    expect(existsSync(join(k.views.branchDir(k.run.id, b.branch.id), handlePath(obs.output)))).toBe(true);
    const back = await call(openExplorer(k, b), 'sh', { cmd: `sed -n '4000p' ${path}` });
    expect(back.json?.summary).toBe('退出码 0\n4000');
  });

  it('大的 JSON 输出附结构概要：键名、数组长度', async () => {
    k = kit({ config: { toolOutput: { inlineMaxTokens: 100 } } });
    const b = await branch(k);
    const data = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, title: `第 ${i} 条` })), page: 1 };
    writeFileSync(join(b.ws, 'data.json'), JSON.stringify(data));
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'cat data.json' });
    const summary = r.json?.summary as string;
    expect(summary).toContain('JSON 结构：');
    expect(summary).toContain('整体：对象，2 个键');
    expect(summary).toContain('.items：数组，长度 300，元素是对象');
    expect(summary).toContain('.items[].id：数字');
    expect(summary).toContain('.page：数字');
  });

  it('凭证的值在摘要、原文、Observation 的命令和意图里都换掉', async () => {
    k = kit();
    const b = await branch(k);
    const r = await call(openExplorer(k, b), 'sh', {
      cmd: `echo "token=$GH_TOKEN"; echo ${SECRET.value} | wc -c`,
      expect: `打印 ${SECRET.value}`,
    });
    const placeholder = '[凭证「GitHub token」已隐藏]';
    const obs = obsOf(r.observationId as string);
    expect(obs.summary).toContain(`token=${placeholder}`);
    expect(JSON.stringify(obs)).not.toContain(SECRET.value);
    expect((obs.args as { cmd: string }).cmd).toContain(placeholder);
    expect(obs.expect).toBe(`打印 ${placeholder}`);
    const intent = k.runStore.published.find((e) => e.type === 'sh.intent');
    expect(JSON.stringify(intent)).not.toContain(SECRET.value);
    const raw = Buffer.from(await k.runStore.artifacts!.read(k.run.id, obs.output)).toString();
    expect(raw).not.toContain(SECRET.value);
    expect(r.content).not.toContain(SECRET.value);
  });

  it('超时：杀掉，记一条带 error 的 Observation，模型看到的是错误', async () => {
    k = kit();
    const b = await branch(k);
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'echo started; sleep 30', timeoutMs: 1000 });
    expect(r.isError).toBe(true);
    expect(r.json?.summary).toMatch(/^超时：1 秒还没跑完，已经连同它起的进程一起杀掉；下面是已有的输出.*\nstarted$/);
    expect(obsOf(r.observationId as string)).toMatchObject({ error: '超时（1 秒）' });
    expect(obsOf(r.observationId as string).exitCode).toBeUndefined();
    expect(r.json?.summary).toContain('等待和所有子命令都计时，有输出也不会续期');
    expect(r.json?.summary).toContain('已产生的文件和外部影响不会回滚，已有输出不表示整批完成');
    // 没到前台上限也先按任务选择执行方式，单项预算明确时才调整 timeoutMs。
    expect(r.json?.summary).toContain('批量任务优先用 melina-batch 按剩余预算分批保存');
    expect(r.json?.summary).toContain('单项任务确认所需总时长后可调整 timeoutMs，前台命令最多跑 5 分钟');
  });

  it('前台命令最多跑 5 分钟：timeoutMs 给多了按 5 分钟执行，Observation 照记模型给的值', async () => {
    k = kit();
    const b = await branch(k);
    const exec = vi.spyOn(k.runtime, 'exec');
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'echo hi', timeoutMs: 600_000 });
    expect(r.isError).toBe(false);
    expect(FOREGROUND_MAX_MS).toBe(300_000);
    expect(exec.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 300_000 });
    expect(obsOf(r.observationId as string).args).toMatchObject({ timeoutMs: 600_000 });
  });

  it('配置的默认超时超过 5 分钟也按 5 分钟；没超过的照用', async () => {
    k = kit({ config: { sh: { timeoutMs: 900_000 } } });
    const b = await branch(k);
    const exec = vi.spyOn(k.runtime, 'exec');
    const s = openExplorer(k, b);
    await call(s, 'sh', { cmd: 'echo hi' });
    await call(s, 'sh', { cmd: 'echo hi', timeoutMs: 90_000 });
    expect(exec.mock.calls.map((c) => c[1].timeoutMs)).toEqual([300_000, 90_000]);
  });

  it('到了上限还没跑完：提示用 background，说清给的 timeoutMs 被压到了 5 分钟', async () => {
    k = kit();
    const b = await branch(k);
    vi.spyOn(k.runtime, 'exec').mockResolvedValueOnce({
      exitCode: null,
      output: 'started\n',
      timedOut: true,
      cancelled: false,
      durationMs: 300_000,
    });
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'make bench', timeoutMs: 900_000 });
    expect(r.isError).toBe(true);
    expect(r.json?.summary).toMatch(
      /^超时：300 秒还没跑完，已经连同它起的进程一起杀掉；下面是已有的输出（你给的 timeoutMs 是 900 秒，前台命令最多跑 5 分钟；批量任务优先用 melina-batch 按剩余预算分批保存；需连续长跑用 background，并由程序设置总期限，之后看日志）/,
    );
    expect(obsOf(r.observationId as string).error).toBe('超时（300 秒）');
  });

  it('后台命令不受前台的上限管', async () => {
    k = kit();
    const b = await branch(k);
    const exec = vi.spyOn(k.runtime, 'exec');
    const r = await call(openExplorer(k, b), 'sh', {
      cmd: 'sleep 30',
      expect: '起在后台',
      background: true,
      timeoutMs: 600_000,
    });
    expect(r.isError).toBe(false);
    expect(exec.mock.calls[0]?.[1]).toMatchObject({ background: true, timeoutMs: 600_000 });
    expect(r.json?.summary).toContain('这次只确认启动，命令仍可能运行或失败');
    expect(r.json?.summary).toContain('timeoutMs 不限制后台运行时长');
    await k.runtime.stop(b.container);
  });

  it('取消：AbortSignal 一到就杀掉', async () => {
    k = kit();
    const b = await branch(k);
    const controller = new AbortController();
    setTimeout(() => controller.abort('kill'), 200);
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'sleep 30' }, { signal: controller.signal });
    expect(r.isError).toBe(true);
    expect(obsOf(r.observationId as string).error).toBe('被取消');
  });

  it('background：立即返回 pid 和日志路径，进程跨调用存活，日志能用 read 读', async () => {
    k = kit();
    const b = await branch(k);
    const s = openExplorer(k, b);
    const r = await call(s, 'sh', { cmd: 'echo serving; sleep 30', expect: '服务起来', background: true });
    expect(r.isError).toBe(false);
    const summary = r.json?.summary as string;
    const log = /日志在 (\S+)（/.exec(summary)?.[1] as string;
    expect(summary).toMatch(/^已在后台启动：pid \d+，日志在 \/melina\/logs\/bg-\d+\.log/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const read = await call(s, 'read', { path: log });
    expect(read.json?.summary).toContain('serving');
    await k.runtime.stop(b.container);
  });

  it('容器没在跑：记一条没跑起来的 Observation，回错误', async () => {
    k = kit();
    const b = await branch(k);
    await k.runtime.stop(b.container);
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'ls' });
    expect(r.isError).toBe(true);
    expect(obsOf(r.observationId as string).error).toMatch(/没跑起来：容器 .* 没在运行/);
  });
});

// （方法论清单第 7 条「共享资源缺协调」）：容器运行时量到的撞线，真撞了才记，连同同时在跑命令的别的路线
describe('sh：跑的时候撞到的资源上限', () => {
  /** 让宿主机上的「容器」交回量到的计数（真的 cgroup 撞不出来）：命令里带 HIT 的才撞 */
  function measured(contention: ExecContention): void {
    const exec = k.runtime.exec.bind(k.runtime);
    vi.spyOn(k.runtime, 'exec').mockImplementation(async (ref, req) => {
      const r = await exec(ref, req);
      return req.cmd.includes('HIT') ? { ...r, contention } : r;
    });
  }

  it('整台机器的进程数撞到上限：摘要第一行写明，记进 Observation，带上同时在跑命令的路线', async () => {
    k = kit();
    measured({ scope: 'host', pidsMax: 37, oomKills: 0, cpuWait: 0.2 });
    const a = await branch(k, { label: '穷举对拍' });
    const b = await branch(k, { label: '报错对齐' });
    const slow = call(openExplorer(k, b), 'sh', { cmd: 'sleep 0.6; echo slow' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const r = await call(openExplorer(k, a), 'sh', { cmd: ': HIT; echo threads' });
    await slow;
    expect(r.json?.summary).toBe(
      '退出码 0；跑的时候这台机器（几条路线和本机别的进程共用）：进程数撞到上限 37 次（起进程、起线程失败）；同时在跑命令的还有「报错对齐」\nthreads',
    );
    expect(obsOf(r.observationId as string).contention).toEqual({
      scope: 'host',
      pidsMax: 37,
      alongside: [b.branch.id],
    });
  });

  it('容器自己的上限：不列别的路线（那是它自己的进程数，和别的路线无关），alongside 照记', async () => {
    k = kit();
    measured({ scope: 'container', oomKills: 2 });
    const a = await branch(k);
    const b = await branch(k);
    const slow = call(openExplorer(k, b), 'sh', { cmd: 'sleep 0.6' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const r = await call(openExplorer(k, a), 'sh', { cmd: ': HIT' });
    await slow;
    expect(r.json?.summary).toBe('退出码 0，没有输出；跑的时候这个容器：2 个进程因为内存超限被杀');
    expect(obsOf(r.observationId as string).contention).toEqual({
      scope: 'container',
      oomKills: 2,
      alongside: [b.branch.id],
    });
  });

  it('一半以上的时间在等 CPU：记进 Observation（读数上才说），摘要不写；不到一半、什么都没撞就不记', async () => {
    k = kit();
    const a = await branch(k);
    const s = openExplorer(k, a);
    measured({ scope: 'container', pidsMax: 0, oomKills: 0, cpuWait: 0.834 });
    const busy = await call(s, 'sh', { cmd: ': HIT' });
    expect(busy.json?.summary).toBe('退出码 0，没有输出');
    expect(obsOf(busy.observationId as string).contention).toEqual({ scope: 'container', cpuWait: 0.83 });
    vi.restoreAllMocks();
    measured({ scope: 'container', pidsMax: 0, oomKills: 0, cpuWait: 0.3 });
    const calm = await call(s, 'sh', { cmd: ': HIT' });
    expect(obsOf(calm.observationId as string).contention).toBeUndefined();
  });
});

describe('read', () => {
  it('按行读，带行号；offset、limit；摘要说清楚读了哪几行', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, 'a.ts'), 'one\ntwo\nthree\nfour\n');
    const s = openExplorer(k, b);
    const whole = await call(s, 'read', { path: 'a.ts' });
    expect(whole.json?.summary).toBe('a.ts：共 4 行、19 字节\n     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour');
    const part = await call(s, 'read', { path: '/workspace/a.ts', offset: 2, limit: 2 });
    expect(part.json?.summary).toBe(
      'a.ts：共 4 行、19 字节，这次是第 2–3 行；后面还有 1 行，用 offset=4 接着读\n     2\ttwo\n     3\tthree',
    );
    // 原文（没有行号）进 Artifact store
    const obs = obsOf(part.observationId as string);
    expect(Buffer.from(await k.runStore.artifacts!.read(k.run.id, obs.output)).toString()).toBe('two\nthree\n');
    expect(obs.args).toEqual({ path: '/workspace/a.ts', offset: 2, limit: 2 });
    expect(s.toolCalls).toBe(2);
  });

  it('不存在、目录、二进制、空文件：都记一条 Observation，说清楚是怎么回事', async () => {
    k = kit();
    const b = await branch(k);
    mkdirSync(join(b.ws, 'src'));
    writeFileSync(join(b.ws, 'src', 'x.ts'), 'x');
    writeFileSync(join(b.ws, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(b.ws, 'empty.txt'), '');
    const s = openExplorer(k, b);
    const missing = await call(s, 'read', { path: 'nope.txt' });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.json?.summary).toBe('nope.txt 不存在');
    const dir = await call(s, 'read', { path: 'src' });
    expect(dir.isError).toBe(false);
    expect(dir.json?.summary).toMatch(/^src 是目录，下面是里面有什么.*\n[\s\S]*x\.ts/);
    const bin = await call(s, 'read', { path: 'bin.dat' });
    expect(bin.isError).toBe(true);
    expect(bin.json?.summary).toBe('bin.dat 是二进制文件（6 字节），read 读不了；用 sh 看（file、xxd、strings）');
    const empty = await call(s, 'read', { path: 'empty.txt' });
    expect(empty.json?.summary).toBe('empty.txt：空文件');
    expect(s.toolCalls).toBe(4);
  });

  it('只能读 workspace 和 /melina 下的文件：别处的直接拒绝，不算工具调用', async () => {
    k = kit();
    const b = await branch(k);
    const s = openExplorer(k, b);
    for (const path of ['/etc/passwd', '../../etc/passwd', '/workspace/../etc/passwd']) {
      const r = await call(s, 'read', { path });
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/只能操作workspace（\/workspace）和 \/melina 下的文件/);
    }
    expect(s.toolCalls).toBe(0);
  });

  it('读附件（/melina/materials，按原文件名）', async () => {
    k = kit();
    const handle = await k.runStore.artifacts!.put(k.run.id, '需求：搜索要支持拼音\n');
    k.run = { ...k.run, goal: { ...k.run.goal, materials: [{ name: '需求.md', handle }] } };
    const b = await branch(k);
    const r = await call(openExplorer(k, b), 'read', { path: '/melina/materials/需求.md' });
    expect(r.json?.summary).toBe('/melina/materials/需求.md：共 1 行、31 字节\n     1\t需求：搜索要支持拼音');
  });

  it('文件里的凭证值读出来是占位符', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, '.env'), `TOKEN=${SECRET.value}\n`);
    const r = await call(openExplorer(k, b), 'read', { path: '.env' });
    expect(r.content).not.toContain(SECRET.value);
    expect(r.json?.summary).toContain('TOKEN=[凭证「GitHub token」已隐藏]');
  });
});

describe('edit、write', () => {
  it('edit：old 唯一就替换，回改动附近几行；Observation 记下改了什么', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const r = await call(openExplorer(k, b), 'edit', { path: 'a.ts', old: 'const b = 2;', new: 'const b = 20;' });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(b.ws, 'a.ts'), 'utf8')).toBe('const a = 1;\nconst b = 20;\nconst c = 3;\n');
    expect(r.json?.summary).toBe(
      '已修改 a.ts：替换了 1 处，第一处在第 2 行；改完共 3 行。改动附近：\n     1\tconst a = 1;\n     2\tconst b = 20;\n     3\tconst c = 3;',
    );
    expect(obsOf(r.observationId as string).args).toEqual({ path: 'a.ts', old: 'const b = 2;', new: 'const b = 20;' });
  });

  it('edit：找不到、不唯一时不改，说清楚怎么办；all=true 全部替换', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, 'a.ts'), 'x\nx\ny\n');
    const s = openExplorer(k, b);
    const missing = await call(s, 'edit', { path: 'a.ts', old: 'zzz', new: 'w' });
    expect(missing.isError).toBe(true);
    expect(missing.json?.summary).toMatch(/^没改：a\.ts 里没有 old 这段文字/);
    const multiple = await call(s, 'edit', { path: 'a.ts', old: 'x', new: 'w' });
    expect(multiple.isError).toBe(true);
    expect(multiple.json?.summary).toMatch(/^没改：old 在 a\.ts 里出现了 2 次/);
    expect(readFileSync(join(b.ws, 'a.ts'), 'utf8')).toBe('x\nx\ny\n');
    const all = await call(s, 'edit', { path: 'a.ts', old: 'x', new: 'w', all: true });
    expect(all.isError).toBe(false);
    expect(all.json?.summary).toMatch(/^已修改 a\.ts：替换了 2 处/);
    expect(readFileSync(join(b.ws, 'a.ts'), 'utf8')).toBe('w\nw\ny\n');
    const nofile = await call(s, 'edit', { path: 'b.ts', old: 'x', new: 'w' });
    expect(nofile.json?.summary).toBe('b.ts 不存在；新建文件用 write');
  });

  it('edit 不会把文件里的凭证值改成占位符（不经过脱敏的输出回写）', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, '.env'), `A=1\nTOKEN=${SECRET.value}\n`);
    const r = await call(openExplorer(k, b), 'edit', { path: '.env', old: 'A=1', new: 'A=2' });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(b.ws, '.env'), 'utf8')).toBe(`A=2\nTOKEN=${SECRET.value}\n`);
    expect(r.content).not.toContain(SECRET.value);
  });

  it('write：新建（连同目录）或覆盖，内容原样写进去；摘要不把内容再回一遍，原文进 Artifact store', async () => {
    k = kit();
    const b = await branch(k);
    const s = openExplorer(k, b);
    const content = `第一行\n'引号' "双引号" $HOME \`反引号\`\nMELINA_WRITE_B64\n${SECRET.value}\n`;
    const r = await call(s, 'write', { path: 'docs/新/说明.md', content });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(b.ws, 'docs/新/说明.md'), 'utf8')).toBe(content);
    expect(r.json?.summary).toMatch(/^新建了 docs\/新\/说明\.md：4 行，\d+ 字节$/);
    const again = await call(s, 'write', { path: 'docs/新/说明.md', content: '' });
    expect(again.json?.summary).toBe('覆盖了 docs/新/说明.md：0 行，0 字节');
    expect(readFileSync(join(b.ws, 'docs/新/说明.md'), 'utf8')).toBe('');
    const obs = obsOf(r.observationId as string);
    expect(JSON.stringify(obs)).not.toContain(SECRET.value);
    const raw = Buffer.from(await k.runStore.artifacts!.read(k.run.id, obs.output)).toString();
    expect(raw).toContain('第一行');
  });

  it('edit、write 只能写 workspace 里的文件', async () => {
    k = kit();
    const b = await branch(k);
    const s = openExplorer(k, b);
    for (const [tool, args] of [
      ['write', { path: '/melina/materials/x', content: 'x' }],
      ['write', { path: '/tmp/x', content: 'x' }],
      ['write', { path: '/workspace', content: 'x' }],
      ['edit', { path: '../x', old: 'a', new: 'b' }],
    ] as const) {
      const r = await call(s, tool, args);
      expect(r.isError).toBe(true);
    }
    expect(s.toolCalls).toBe(0);
  });
});
