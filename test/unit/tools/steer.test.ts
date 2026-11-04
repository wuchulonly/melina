import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ctfToolCheck } from '../../../extensions/ctf/entry.ts';
import { classifyCommand, commandSteer, LIGHT_PATHS } from '../../../extensions/ctf/steer.ts';
import type { RunConfigOverride } from '../../../src/core/config.ts';
import type { ToolCall } from '../../../src/core/interfaces/gateway.ts';
import { Obj } from '../../../src/core/schema.ts';
import { type SubmitWatchArgs, TOOL } from '../../../src/core/tools.ts';
import type { WatchBody } from '../../../src/core/types.ts';
import { projectWatchMap } from '../../../src/core/watch-map.ts';
import { mergeWatch } from '../../../src/projections/watch.ts';
import type { GatewayDeps, ToolExtension } from '../../../src/tools/session.ts';
import { MODEL } from '../storage/kit.ts';
import { type BranchKit, branch, call, type Kit, kit, openExplorer } from './gateway-kit.ts';

const kits: Kit[] = [];
beforeEach(() => vi.stubEnv('MELINA_ALLOW_FUZZ', ''));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of kits.splice(0)) k.cleanup();
});

function ctfKit(deps: Partial<GatewayDeps> = {}, config: RunConfigOverride = {}): Kit {
  const k = kit({ config, completion: false, deps: { toolChecks: [ctfToolCheck], ...deps } });
  kits.push(k);
  k.run = k.runStore.writer.draftCompletion(k.run.id, {
    domain: 'ctf',
    completion: { interpretation: '完成本地靶场任务', criteria: ['提供有执行证据的结果'] },
    constraints: [],
  });
  return k;
}

function untried(id = 'auth', direction = '检查鉴权逻辑'): SubmitWatchArgs['directions'][number] {
  return { id, direction, status: 'untried', result: '还没试', evidence: [], attempts: [] };
}

function publish(k: Kit, b: BranchKit, directions: SubmitWatchArgs['directions'] = [], forbid?: string[]) {
  return k.runStore.writer.recordWatch({
    runId: k.run.id,
    branchId: b.branch.id,
    model: MODEL,
    basedOnSeq: k.runStore.queries.lastSeq(),
    toolCalls: k.runStore.queries.getBranch(b.branch.id)!.toolCalls,
    draft: {
      standing: '继续完成任务',
      directions,
      tension: [],
      advice: '先核对当前证据',
      ...(forbid === undefined ? {} : { forbid }),
    },
  });
}

function fixture(b: BranchKit, name: string): string {
  writeFileSync(join(b.ws, name), '#!/bin/sh\nprintf "local fixture\\n"\n', { mode: 0o755 });
  return `./${name}`;
}

describe('Heimdall 命令分类', () => {
  it.each([
    ['seq 1 80', null],
    ['seq 1 81', null],
    ['python3 -c "for i in range(10, 90): pass"', null],
    ['python3 -c "print(bytes(i ^ 42 for i in range(0, 256)).hex())"', null],
    ['python3 -c "print(bytes(i ^ 42 for i in range(256)).hex())"', null],
    ['python3 -c "print(sum(range(1, 10000)))"', null],
    ['printf "%s" "1-65535"', null],
    ['echo "nmap -p 1-65535 127.0.0.1"', null],
    ['nmap --version; python3 -c "print(sum(range(0, 256)))"', null],
    ['nmap -p 1-65535 127.0.0.1', 'forbid'],
    ['nmap -p- 127.0.0.1', 'forbid'],
    ['nmap -p "T:1-65535" 127.0.0.1', 'forbid'],
    ['timeout 5 nmap -p1-10000 127.0.0.1', 'forbid'],
    ['bash -lc "nmap -p 1-65535 127.0.0.1"', 'forbid'],
    ['masscan --ports=1-65535 127.0.0.1', 'forbid'],
    ['nmap -p 22,80,443 127.0.0.1', null],
    ['ffuf -u http://127.0.0.1:1/FUZZ -w small.txt', 'forbid'],
    ['/opt/ctf/bin/nuclei --version', 'forbid'],
    ['nuclei -duc -ni -u http://127.0.0.1:1 -t /opt/ctf/templates/product.yaml', null],
    ['nuclei --templates=./poc.yml -target http://127.0.0.1:1 -H "X-Test: test" -rl 4 -o results.txt', null],
    ['nuclei -duc -ni -t /opt/ctf/templates/product.yaml -u http://127.0.0.1:1 -fr -irr 2>&1 | head -n 40', null],
    ['nuclei -duc -ni -t poc.yaml -u http://127.0.0.1:1 > /tmp/nuclei.out 2>/dev/null </dev/null', null],
    ['bash -lc "nuclei -t poc.yaml -u http://127.0.0.1:1"', null],
    ['nuclei -t /poc.yaml -u http://127.0.0.1:1', null],
    ['nuclei -u http://127.0.0.1:1', 'forbid'],
    ['nuclei -tags cve -t poc.yaml', 'forbid'],
    ['nuclei -t /opt/ctf/templates/', 'forbid'],
    ['nuclei -t /opt/ctf/templates', 'forbid'],
    ['nuclei -t https://example.test/poc.yaml', 'forbid'],
    ['nuclei -t file:///opt/ctf/poc.yaml', 'forbid'],
    ['nuclei -t *.yaml', 'forbid'],
    ['nuclei -t "$TEMPLATE/poc.yaml"', 'forbid'],
    ['nuclei -t a.yaml,b.yaml', 'forbid'],
    ['nuclei -t a.yaml -t b.yaml', 'forbid'],
    ['nuclei -t a.yaml -templates b.yaml', 'forbid'],
    ['nuclei -t a.yaml b.yaml', 'forbid'],
    ['nuclei -t a.yaml -w flow.yaml', 'forbid'],
    ['nuclei -t a.yaml -config config.yaml', 'forbid'],
    ['nuclei -t a.yaml -as', 'forbid'],
    ['nuclei -t a.yaml -it other.yaml', 'forbid'],
    ['nuclei -t a.yaml -turl https://example.test/b.yaml', 'forbid'],
    ['nuclei -t a.yaml -future-selector broad', 'forbid'],
    ['nuclei -t poc.yaml -u http://127.0.0.1:1 < urls.txt', 'forbid'],
    ['nuclei -t > poc.yaml', 'forbid'],
    ['nuclei -t', 'forbid'],
    ['nuclei -t a.yaml; nuclei -tags cve', 'forbid'],
    ['nuclei -t a.yaml; ffuf --help', 'forbid'],
    ['2>/dev/null ffuf -u http://127.0.0.1:1/FUZZ -w small.txt', 'forbid'],
    ['env A=1 timeout 5 sudo -u nobody gobuster --help', 'forbid'],
    ['bash -lc "ffuf --help"', 'forbid'],
    ['echo ffuf', null],
    ['command -v nuclei', null],
    ['cat /opt/ctf/nuclei/README.md', null],
    ['dirsearch -u http://127.0.0.1:1', 'forbid'],
    ['dirsearch --help', null],
    ['dirsearch --version', null],
    ['dirsearch --help; dirsearch -u http://127.0.0.1:1', 'forbid'],
    ['dirsearch -w /opt/ctf/wordlists/paths.txt -u http://127.0.0.1:1', null],
    ['dirsearch --wordlist=/opt/ctf/wordlists/paths.txt -u http://127.0.0.1:1', null],
    ['dirsearch -w custom.txt -u http://127.0.0.1:1', 'forbid'],
    ['dirsearch -w /usr/share/seclists/big.txt', 'forbid'],
    ['python3 /usr/lib/python3/dist-packages/dirsearch/dirsearch.py -w wordlists/paths.txt', null],
    ['python3 /usr/lib/python3/dist-packages/dirsearch/dirsearch.py -w big.txt', 'forbid'],
    ['python3 -m dirsearch -w big.txt', 'forbid'],
    ['python3 /opt/ctf/jwt_tool/jwt_tool.py --help', 'later'],
    ['hydra --version', 'later'],
    ['john --help', 'later'],
    ['hashcat --help', 'later'],
    ['head wordlists/passwords.txt', null],
    ['for p in $(cat wordlists/passwords.txt); do test -n "$p"; done', 'later'],
    ['python3 login.py wordlists/sqli_login.txt', null],
    ['python3 login.py spray_passwords.txt', null],
    ['python3 login.py wordlists/passwords.txt', 'later'],
    ['flask-unsign --sign --secret "known-value"', null],
    ['grep SECRET_KEY app.py', null],
  ] as const)('%s → %s', (command, expected) => {
    expect(classifyCommand(command)).toBe(expected);
    expect(classifyCommand(command)).toBe(expected);
  });

  it('限制大批路径枚举，保留小批路径', () => {
    const paths = Array.from({ length: LIGHT_PATHS + 1 }, (_, i) => `/path${i}`);
    expect(classifyCommand(`for p in ${paths.join(' ')}; do curl "$p"; done`)).toBe('forbid');
    expect(classifyCommand(`for p in ${paths.slice(0, 3).join(' ')}; do curl "$p"; done`)).toBeNull();
    expect(classifyCommand(`for p in ${paths.join(' ')}; do test -f "$p"; done`)).toBeNull();
    expect(classifyCommand(`curl --version; for p in ${paths.join(' ')}; do test -f "$p"; done`)).toBeNull();
  });
});

describe('CTF 工具网关', () => {
  it.each([{ enabled: false }, { enabled: true, disabledBet0Copies: [3] }])(
    '关闭观察的路线无需等待地图，仍禁止重型扫描：%j',
    async (watch) => {
      const run = vi.fn(async () => ({ content: 'local fixture', isError: false }));
      const extension: ToolExtension = {
        spec: { name: 'hydra', description: '本地假凭据工具', parameters: Obj({}), environment: true },
        roles: ['explorer'],
        run,
      };
      const k = ctfKit({ extensions: [extension] }, { watch });
      for (let i = 0; i < 2; i++) {
        const b = await branch(k);
        const s = openExplorer(k, b);
        const check: ToolCall = { id: `check-${i}`, name: 'hydra', args: {} };
        expect(s.check(check, [check]) !== undefined).toBe(watch.enabled);
      }
      const b = await branch(k);
      const s = openExplorer(k, b);
      for (const name of ['hashcat', 'hydra', 'jwt_tool']) {
        const out = await call(s, TOOL.sh, { cmd: fixture(b, name) });
        expect(out.isError, out.content).toBe(false);
        expect(out.observationId).toBeDefined();
      }
      expect((await call(s, TOOL.sh, { cmd: 'printf "%s" wordlists/passwords.txt' })).isError).toBe(false);
      expect((await call(s, 'hydra', {})).isError).toBe(false);
      expect(run).toHaveBeenCalledOnce();
      expect((await call(s, TOOL.sh, { cmd: fixture(b, 'ffuf') })).blocked).toBe(true);
      expect((await call(s, TOOL.sh, { cmd: 'nmap -p- 127.0.0.1' })).blocked).toBe(true);
    },
  );

  it('显式单模板可执行，附带扩大扫描范围的参数在执行前拦截', async () => {
    const k = ctfKit();
    const b = await branch(k, { kind: 'direct' });
    const s = openExplorer(k, b);
    const cmd = `${fixture(b, 'nuclei')} -duc -ni -t ./product.yaml -u http://127.0.0.1:1`;
    const allowed = await call(s, TOOL.sh, { cmd });
    expect(allowed.isError, allowed.content).toBe(false);
    expect(allowed.observationId).toBeDefined();
    const seq = k.runStore.queries.lastSeq();
    expect((await call(s, TOOL.sh, { cmd: `${cmd} -tags cve` })).blocked).toBe(true);
    expect(k.runStore.queries.lastSeq()).toBe(seq);
    expect(s.toolCalls).toBe(1);
  });

  it('执行前拒绝：不写 shell 意图、观测、工具账，也不产生文件', async () => {
    const k = ctfKit();
    const b = await branch(k, { kind: 'direct' });
    const s = openExplorer(k, b);
    const args = { cmd: 'touch forbidden; nuclei --version', expect: '检查本地扫描器版本' };
    const seq = k.runStore.queries.lastSeq();
    const out = await call(s, TOOL.sh, args);
    expect(out.blocked).toBe(true);
    expect(out.content).toContain('命令没有执行');
    expect(existsSync(join(b.ws, 'forbidden'))).toBe(false);
    expect(k.runStore.queries.lastSeq()).toBe(seq);
    expect(k.runStore.queries.observations(b.branch.id).items).toEqual([]);
    expect(s.toolCalls).toBe(0);
    expect(k.ledger).toEqual([]);

    // SDK 调用者直接调 run，仍不能绕过策略。
    const direct = await s.tools
      .find((tool) => tool.spec.name === TOOL.sh)!
      .run({ id: 'direct-run', name: TOOL.sh, args }, new AbortController().signal);
    expect(direct.isError).toBe(true);
    expect(existsSync(join(b.ws, 'forbidden'))).toBe(false);
    expect(k.runStore.queries.lastSeq()).toBe(seq);
  });

  it('本地循环在普通和 CTF 领域都能执行；选定 CTF 后开始拦截扫描器', async () => {
    const k = kit({ completion: false, deps: { toolChecks: [ctfToolCheck] } });
    kits.push(k);
    const b = await branch(k, { kind: 'direct' });
    const s = openExplorer(k, b);
    const args = { cmd: 'for i in $(seq 1 100); do :; done; printf done' };
    const out = await call(s, TOOL.sh, args);
    expect(out.isError, out.content).toBe(false);
    expect(out.observationId).toBeDefined();
    k.runStore.writer.draftCompletion(k.run.id, {
      domain: 'ctf',
      completion: { interpretation: '本地验证', criteria: ['有证据'] },
      constraints: [],
    });
    expect((await call(s, TOOL.sh, args)).isError).toBe(false);
    const decoded = await call(s, TOOL.sh, {
      cmd: 'python3 -c "print(bytes(i ^ 42 for i in range(0, 256)).hex())"',
      expect: '输出 256 个字节的十六进制表示',
    });
    expect(decoded.isError, decoded.content).toBe(false);
    expect(decoded.content).toContain('2a2b28292e2f2c2d');
    expect(decoded.observationId).toBeDefined();
    expect((await call(s, TOOL.sh, { cmd: fixture(b, 'nuclei') })).blocked).toBe(true);
    expect(s.toolCalls).toBe(3);
  });

  it('同一会话现读地图；其他方向试过后解锁爆破，新方向出现后重新关闭', async () => {
    const k = ctfKit();
    const b = await branch(k, { kind: 'direct' });
    const s = openExplorer(k, b);
    const args = { cmd: fixture(b, 'hydra') };
    expect((await call(s, TOOL.sh, args)).content).toContain('还没有交地图');
    publish(k, b, [untried()]);
    expect((await call(s, TOOL.sh, args)).content).toContain('检查鉴权逻辑');
    const checked = await call(s, TOOL.sh, { cmd: 'echo checked' });
    publish(k, b, [
      {
        ...untried(),
        status: 'failed',
        result: '本次检查没有推进',
        attempts: [{ id: 't1', action: '检查', result: '没有推进', evidence: [checked.observationId!] }],
      },
    ]);
    const allowed = await call(s, TOOL.sh, args);
    expect(allowed.isError, allowed.content).toBe(false);
    expect(allowed.observationId).toBeDefined();
    publish(k, b, [untried('headers', '检查请求头处理')]);
    expect((await call(s, TOOL.sh, args)).content).toContain('检查请求头处理');
  });

  it('只用本路线的地图，不用另一份 Bet 0 的地图解锁', async () => {
    const k = ctfKit();
    const a = await branch(k, { kind: 'direct' });
    const b = await branch(k, { kind: 'direct', model: { ...MODEL, model: 'other-fixture' } });
    publish(k, b);
    const out = await call(openExplorer(k, a), TOOL.sh, { cmd: fixture(a, 'hydra') });
    expect(out.blocked).toBe(true);
    expect(out.content).toContain('还没有交地图');
  });

  it('无 dirbust 标记时可重复目录探查，已有执行记录和重开会话都不会永久禁扫', async () => {
    const k = ctfKit();
    const b = await branch(k, { kind: 'direct' });
    const cmd = `${fixture(b, 'dirsearch')} -w wordlists/paths.txt`;
    const s = openExplorer(k, b);
    expect(
      (
        await call(s, TOOL.sh, {
          cmd: 'mkdir -p wordlists; printf "login\\nadmin\\n" > wordlists/paths.txt',
        })
      ).isError,
    ).toBe(false);
    expect((await call(s, TOOL.sh, { cmd: './dirsearch --help' })).isError).toBe(false);
    expect((await call(s, TOOL.sh, { cmd })).isError).toBe(false);
    expect((await call(openExplorer(k, b), TOOL.sh, { cmd })).isError).toBe(false);
    expect(k.runStore.queries.observations(b.branch.id).items).toHaveLength(4);
    publish(k, b, [], ['portscan']);
    const inspect: ToolCall = { id: 'inspect', name: TOOL.sh, args: { cmd: 'head wordlists/paths.txt' } };
    expect(s.check(inspect, [inspect])).toBeUndefined();
    expect((await call(s, TOOL.sh, { cmd: `head wordlists/paths.txt; ${cmd}` })).isError).toBe(false);
  });

  it.each([false, true])('观察者标记可发布、撤销和重新发布，不依赖是否已扫过（%s）', async (scanned) => {
    const k = ctfKit();
    const b = await branch(k, { kind: 'direct' });
    const s = openExplorer(k, b);
    const args = { cmd: `${fixture(b, 'dirsearch')} -w wordlists/paths.txt` };
    if (scanned) expect((await call(s, TOOL.sh, args)).isError).toBe(false);
    publish(k, b, [], ['pause DIRBUST: no new information']);
    const seq = k.runStore.queries.lastSeq();
    const calls = s.toolCalls;
    const ledger = k.ledger.length;
    const blocked = await call(s, TOOL.sh, args);
    expect(blocked.blocked).toBe(true);
    expect(blocked.content).toContain('forbid 含 dirbust');
    expect(k.runStore.queries.lastSeq()).toBe(seq);
    expect(s.toolCalls).toBe(calls);
    expect(k.ledger).toHaveLength(ledger);
    expect((await call(openExplorer(k, b), TOOL.sh, args)).blocked).toBe(true);
    // 只认当前地图；换目标时由观察者判断是否撤销，不擅自绕过仍在生效的标记。
    const newTarget = { ...args, cmd: `${args.cmd} -u http://127.0.0.1:2` };
    expect((await call(s, TOOL.sh, newTarget)).blocked).toBe(true);
    publish(k, b, [untried('new-target', '检查新目标')], []);
    expect((await call(s, TOOL.sh, newTarget)).isError).toBe(false);
    publish(k, b, [], ['dirbust']);
    expect((await call(s, TOOL.sh, args)).blocked).toBe(true);
    // 新版省略该字段也清除旧标记，不会从历史地图恢复禁令。
    publish(k, b);
    expect((await call(openExplorer(k, b), TOOL.sh, args)).isError).toBe(false);
  });

  it('禁扫时仍能准备、读取小词表和查看帮助；手写路径循环同样受标记控制', async () => {
    const k = ctfKit();
    const b = await branch(k, { kind: 'direct' });
    const s = openExplorer(k, b);
    fixture(b, 'dirsearch');
    fixture(b, 'curl');
    publish(k, b, [], ['dirbust']);
    expect(
      (await call(s, TOOL.sh, { cmd: 'mkdir -p wordlists; printf "login\\n" > wordlists/paths.txt' })).isError,
    ).toBe(false);
    expect((await call(s, TOOL.sh, { cmd: 'head wordlists/paths.txt' })).isError).toBe(false);
    expect((await call(s, TOOL.sh, { cmd: './dirsearch --help' })).isError).toBe(false);
    const args = { cmd: 'for p in $(cat wordlists/paths.txt); do printf "%s" "$p"; done' };
    expect((await call(s, TOOL.sh, args)).isError).toBe(false);
    const probe = { ...args, cmd: 'for p in $(cat wordlists/paths.txt); do ./curl "$p"; done' };
    expect((await call(s, TOOL.sh, probe)).blocked).toBe(true);
    expect(
      (await call(s, TOOL.sh, { cmd: 'head wordlists/paths.txt; ./dirsearch -w wordlists/paths.txt' })).blocked,
    ).toBe(true);
    publish(k, b, [], []);
    expect((await call(s, TOOL.sh, probe)).isError).toBe(false);
  });

  it('目录禁扫标记只控制观察者自己的路线，不借用另一份地图', async () => {
    const k = ctfKit();
    const a = await branch(k, { kind: 'direct' });
    const b = await branch(k, { kind: 'direct', model: { ...MODEL, model: 'other-fixture' } });
    publish(k, b, [], ['dirbust']);
    const args = { cmd: `${fixture(a, 'dirsearch')} -w wordlists/paths.txt` };
    expect((await call(openExplorer(k, a), TOOL.sh, args)).isError).toBe(false);
  });

  it('每条 direct 路线独立等待自己的地图，不能借用其他副本放行后置工具', async () => {
    const k = ctfKit();
    const a = await branch(k, { kind: 'direct' });
    const b = await branch(k, { kind: 'direct' });
    publish(k, a);
    const s = openExplorer(k, b);
    expect((await call(s, TOOL.sh, { cmd: fixture(b, 'hydra') })).blocked).toBe(true);
    publish(k, b);
    expect((await call(s, TOOL.sh, { cmd: fixture(b, 'hydra') })).isError).toBe(false);
    expect((await call(s, TOOL.sh, { cmd: fixture(b, 'ffuf') })).blocked).toBe(true);
  });

  it.each(['later', 'dirbust'])('排队期间地图变化会在启动命令之前拒绝，并归还工具名额（%s）', async (policy) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = { release: vi.fn() };
    const k = ctfKit({
      toolSlots: {
        toolSlot: async () => {
          enter();
          await waiting;
          return slot;
        },
      },
    });
    const b = await branch(k, { kind: 'direct' });
    publish(k, b);
    const out = call(openExplorer(k, b), TOOL.sh, {
      cmd: policy === 'dirbust' ? `${fixture(b, 'dirsearch')} -w wordlists/paths.txt` : fixture(b, 'hydra'),
      expect: '执行本地假工具',
    });
    await entered;
    publish(k, b, [untried()], policy === 'dirbust' ? ['dirbust'] : []);
    const seq = k.runStore.queries.lastSeq();
    release();
    expect((await out).isError).toBe(true);
    expect(k.runStore.queries.lastSeq()).toBe(seq);
    expect(k.runStore.queries.observations(b.branch.id).items).toEqual([]);
    expect(slot.release).toHaveBeenCalledOnce();
  });

  it('命名 dirsearch 扩展也按最新标记拦截，撤销或显式关闭策略后恢复执行', async () => {
    const run = vi.fn(async () => ({ content: 'local fixture', isError: false }));
    const extension: ToolExtension = {
      spec: { name: 'dirsearch', description: '本地假目录扫描器', parameters: Obj({}), environment: true },
      roles: ['explorer'],
      run,
    };
    const k = ctfKit({ extensions: [extension] });
    const b = await branch(k, { kind: 'direct' });
    const s = openExplorer(k, b);
    expect((await call(s, 'dirsearch', {})).isError).toBe(false);
    publish(k, b, [], ['dirbust']);
    expect((await call(s, 'dirsearch', {})).blocked).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    publish(k, b, [], []);
    expect((await call(s, 'dirsearch', {})).isError).toBe(false);
    publish(k, b, [], ['dirbust']);
    vi.stubEnv('MELINA_ALLOW_FUZZ', '1');
    expect((await call(s, 'dirsearch', {})).isError).toBe(false);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each(['ffuf', 'nuclei'])('命名扫描器 %s 扩展也被拒绝；显式开关可放行', async (name) => {
    const run = vi.fn(async () => ({ content: 'local fixture', isError: false }));
    const extension: ToolExtension = {
      spec: { name, description: '本地假扫描器', parameters: Obj({}), environment: true },
      roles: ['explorer'],
      run,
    };
    const k = ctfKit({ extensions: [extension] });
    const b = await branch(k, { kind: 'direct' });
    const s = openExplorer(k, b);
    expect((await call(s, name, {})).blocked).toBe(true);
    expect(run).not.toHaveBeenCalled();
    vi.stubEnv('MELINA_ALLOW_FUZZ', '1');
    expect((await call(s, name, {})).isError).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('观察地图的后置开关', () => {
  it('只更新一个方向时，其余未试备选保持在图中，不能提前放开爆破', () => {
    const first = mergeWatch(undefined, {
      standing: '发现两个入口',
      advice: '检查权限边界',
      tension: [],
      directions: [untried('auth'), untried('sqli', 'SQLi 登录绕过')],
    });
    const second = mergeWatch(first, {
      standing: '第一个入口需要核对结果',
      advice: '继续检查登录入口',
      tension: [],
      directions: [{ ...untried('auth'), status: 'unclear' }],
    });
    expect(projectWatchMap(second).angles.map((d) => d.id)).toEqual(['sqli']);
    expect(commandSteer(second)).toEqual({ now: ['SQLi 登录绕过'], laterOpen: false });
    const retired = mergeWatch(second, {
      standing: '登录入口也已排除',
      advice: '',
      tension: [],
      directions: [{ ...untried('sqli', 'SQLi 登录绕过'), retired: true }],
    });
    expect(commandSteer(retired).laterOpen).toBe(true);
  });

  it('拦截返回的 now 与地图共享优先级和定向词表分类', () => {
    const body: WatchBody = {
      standing: '',
      advice: '',
      tension: [],
      directions: [
        { ...untried('brute', 'hydra 密码爆破'), priority: 1 },
        { ...untried('logic', '鉴权逻辑'), priority: 3 },
        { ...untried('sqli', 'SQLi 小字典定向验证'), priority: 1 },
      ],
    };
    expect(
      projectWatchMap(body)
        .angles.map((d) => d.direction)
        .slice(0, 2),
    ).toEqual(commandSteer(body).now);
    expect(commandSteer(body)).toEqual({ now: ['SQLi 小字典定向验证', '鉴权逻辑'], laterOpen: false });
  });

  it('只剩爆破或已退休方向时，不会把爆破自己永远锁住', () => {
    const note: WatchBody = { standing: '', directions: [], tension: [], advice: '' };
    expect(commandSteer(note)).toEqual({ now: [], laterOpen: true });
    expect(commandSteer(undefined).laterOpen).toBe(false);
    expect(
      commandSteer({
        ...note,
        directions: [{ ...untried('old', '检查旧入口'), retired: true }, untried('passwords', '普通密码字典爆破')],
      }),
    ).toEqual({ now: [], laterOpen: true });
    const targeted = { ...note, directions: [untried()] };
    expect(commandSteer(targeted).laterOpen).toBe(false);
    expect(
      commandSteer({
        ...note,
        directions: [{ ...untried('spray', '口令字典验证'), result: '使用已收集的口令规则生成有限候选' }],
      }).laterOpen,
    ).toBe(false);
  });
});
