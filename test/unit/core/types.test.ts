// 类型是从 schema 推出来的：这里确认推出来的类型是字面量联合、可选字段对，不是退化成 string 或 unknown。
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  credentialProblem,
  DEFAULT_GLOBAL_CONFIG,
  DEFAULT_RUN_CONFIG,
  GlobalConfig,
  GlobalConfigOverride,
  RunConfig,
  RunConfigOverride,
  resolveGlobalConfig,
  resolveRunConfig,
  watchEnabled,
} from '../../../src/core/config.ts';
import { ExecContention, Observation } from '../../../src/core/types.ts';
import { issues, isValid } from '../../../src/core/validate.ts';

describe('凭证能不能给容器（§11）', () => {
  it('白名单拒绝加载代码、改引擎和任意自定义变量，不能只靠危险变量黑名单', () => {
    for (const env of [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'NODE_OPTIONS',
      'GIT_SSH_COMMAND',
      'GIT_CONFIG_COUNT',
      'PYTHONPATH',
      'SSLKEYLOGFILE',
      'CUSTOM_TOKEN',
      'github_token',
    ]) {
      expect(credentialProblem({ name: 'token', as: { env }, value: 'a-secret-123' })).toContain('白名单');
    }
    for (const env of ['GH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY']) {
      expect(credentialProblem({ name: 'token', as: { env }, value: 'a-secret-123' })).toBeUndefined();
    }
  });

  it('保留的环境变量名、NUL、/workspace 和 /melina 下的文件：说清楚哪里不行', () => {
    expect(credentialProblem({ name: 'GitHub', as: { env: 'GITHUB_TOKEN' }, value: 'ghp_x' })).toBeUndefined();
    expect(credentialProblem({ name: 'GitHub', as: { env: 'GITHUB_TOKEN' } })).toBeUndefined();
    expect(credentialProblem({ name: '路径', as: { env: 'PATH' } })).toMatch(/PATH/);
    expect(credentialProblem({ name: 'K', as: { env: 'MELINA_X' } })).toMatch(/MELINA_X/);
    expect(credentialProblem({ name: 'N', as: { env: 'GH_TOKEN' }, value: 'a\0b' })).toMatch(/NUL/);
    expect(credentialProblem({ name: 'ssh', as: { file: '/root/.ssh/id_ed25519' } })).toBeUndefined();
    expect(credentialProblem({ name: 'env', as: { file: '/workspace/.env' } })).toMatch(/\/workspace/);
    expect(credentialProblem({ name: 'env', as: { file: '/workspace/../workspace/x' } })).toMatch(/\/workspace/);
    expect(credentialProblem({ name: 'k', as: { file: '/melina/materials/x' } })).toBeDefined();
    expect(credentialProblem({ name: 'k', as: { file: '/run/melina/x' } })).toBeDefined();
    expect(credentialProblem({ name: 'k', as: { file: '/' } })).toBeDefined();
  });
});

describe('命令跑的时候撞到的资源上限', () => {
  const obs = {
    id: '01M46E1B51FV55QK6VKSWFFNFG',
    runId: '01M46E1B4YTHEC73QH7PBCB7NJ',
    seq: 7,
    branchId: '01M46E1B4VEAXWP2Y4RDPDDC7F',
    episode: 1,
    role: 'explorer',
    tool: 'sh',
    args: { cmd: 'make -j32' },
    expect: '编译通过',
    summary: '退出码 2',
    output: `art://${'a'.repeat(64)}`,
    snapshot: 'root',
    exitCode: 2,
  };

  it('老的观测没有 contention 照样合 schema；有的话 scope 只能是 container 或 host', () => {
    expect(issues(Observation, obs)).toEqual([]);
    const hit = { scope: 'host', pidsMax: 37, cpuWait: 0.64, alongside: ['01M46E1B4YTHEC73QH7PBCB7NJ'] };
    expect(issues(Observation, { ...obs, contention: hit })).toEqual([]);
    expect(isValid(Observation, { ...obs, contention: { ...hit, scope: 'vm' } })).toBe(false);
    expect(isValid(Observation, { ...obs, contention: { ...hit, cpuWait: 1.5 } })).toBe(false);
    expectTypeOf<NonNullable<Observation['contention']>['scope']>().toEqualTypeOf<'container' | 'host'>();
  });

  it('容器运行时给的那份不带 alongside（同时在跑的路线由工具层记）', () => {
    expect(isValid(ExecContention, { scope: 'container', oomKills: 1 })).toBe(true);
    expect(isValid(ExecContention, { scope: 'container', alongside: [] })).toBe(false);
  });
});

describe('直接运行配置', () => {
  it('默认配置合法，三副本加两路接力有固定并发上限', () => {
    expect(issues(RunConfig, DEFAULT_RUN_CONFIG)).toEqual([]);
    expect(issues(GlobalConfig, DEFAULT_GLOBAL_CONFIG)).toEqual([]);
    expect(DEFAULT_RUN_CONFIG.bet0.copies).toBe(3);
    expect(DEFAULT_RUN_CONFIG.continuation).toMatchObject({
      enabled: true,
      forkCopies: 2,
      maxActive: 5,
      momentumToolCalls: 12,
    });
    expect(DEFAULT_RUN_CONFIG.episode).toEqual({ maxFailures: 3 });
  });
  it('组内覆盖独立复制，不改变默认配置', () => {
    const resolved = resolveRunConfig({ continuation: { maxActive: 4 }, episode: { maxFailures: 5 } });
    expect(resolved.continuation).toEqual({ ...DEFAULT_RUN_CONFIG.continuation, maxActive: 4 });
    resolved.episode.maxFailures = 9;
    expect(DEFAULT_RUN_CONFIG.episode.maxFailures).toBe(3);
    expect(isValid(RunConfig, resolved)).toBe(true);
  });
  it('拒绝删除功能的配置，不接受历史兼容字段', () => {
    for (const option of [
      { director: {} },
      { recon: { enabled: true } },
      { ablation: { sharing: 'facts' } },
      { episode: { toolCalls: 50 } },
      { continuation: { stallMs: 420000 } },
      { continuation: { maxGenerations: 3 } },
      { notebook: { maxTokens: 1500 } },
    ])
      expect(isValid(RunConfigOverride, option)).toBe(false);
  });
  it('全局容量只能全局覆盖，观察者开关和副本排除正常校验', () => {
    expect(isValid(RunConfigOverride, { limits: { toolExec: 2 } })).toBe(false);
    expect(isValid(GlobalConfigOverride, { limits: { toolExec: 2 } })).toBe(true);
    expect(resolveGlobalConfig({ limits: { modelCalls: { local: 2 } } }).limits.modelCalls).toEqual({ local: 2 });
    expect(watchEnabled(resolveRunConfig({ watch: { enabled: false } }))).toBe(false);
    expect(isValid(RunConfigOverride, { watch: { disabledBet0Copies: [3] } })).toBe(true);
    expect(isValid(RunConfigOverride, { watch: { continuationEnabled: false } })).toBe(true);
    expect(isValid(RunConfigOverride, { watch: { continuationEnabled: 'false' } })).toBe(false);
  });
});
