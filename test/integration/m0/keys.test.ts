// 一家配几个 API key：完整组装的 Melina（模型换成 faux），额度用完换下一个 key，
// key 都用不了才熔断，人在模型页保存后马上用回排在前面的那个。
// faux 不查 key：brain 看这次请求用的是哪个 key（Ask.apiKey），「没钱」的那个回 402。

import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelsConfig } from '../../../src/core/config.ts';
import { fauxAssistantMessage } from '../../unit/models/protocol.ts';
import {
  act,
  type Brain,
  candidateCall,
  type DevMelina,
  devMelina,
  git,
  gitRepo,
  HELLO_COMPLETION,
  look,
  MODELS,
  PROVIDER,
  removeDir,
  STRONG,
  say,
  tempDir,
  toolResults,
  turn,
  waitFor,
} from './kit.ts';

let dir: string | undefined;
let dk: DevMelina | undefined;

afterEach(async () => {
  await dk?.close();
  dk = undefined;
  if (dir) removeDir(dir);
  dir = undefined;
});

const TWO_KEYS: ModelsConfig = {
  ...MODELS,
  providers: [
    {
      provider: PROVIDER,
      keys: [
        { name: '公司账号', key: 'sk-company' },
        { name: '个人账号', key: 'sk-personal' },
      ],
    },
  ],
};

/** 求解分支写 hello.txt、看一眼、提交；broke 里的 key 回 402（余额不足）。 */
function brain(broke: Set<string>): Brain {
  return (ask) => {
    if (ask.apiKey && broke.has(ask.apiKey))
      return fauxAssistantMessage([], { stopReason: 'error', errorMessage: '402 Insufficient Balance' });
    if (ask.role !== 'explorer') return say(`没想到会有 ${ask.role} 的调用`);
    const results = toolResults(ask.ctx.messages);
    if (results.length === 0) return turn(act("printf 'hello\\n' > hello.txt", '写出 hello.txt'));
    if (results.length === 1) return turn(look('cat hello.txt'));
    return turn(
      candidateCall({
        claim: '工作目录根下有 hello.txt，内容是 hello',
      }),
    );
  };
}

async function hello(melina: DevMelina['melina'], repo: string) {
  return melina.createRun({
    goal: { statement: '写一个 hello.txt，内容是 hello', completion: HELLO_COMPLETION, domain: 'general' },
    workspace: { root: repo },
    config: { bet0: { models: [STRONG] }, continuation: { enabled: false } },
  });
}

/** 存一遍模型页（不带 key 的值，原来的照留）：Melina 当成人改了配置，清熔断和 key 的状况 */
function saveModelsPage(melina: DevMelina['melina']): void {
  melina.setModels(melina.models());
}

describe('一家配几个 API key', () => {
  it('额度用完：同一次调用马上换下一个 key，任务照常做完；人在模型页保存后用回排在前面的', async () => {
    dir = tempDir();
    const repo = gitRepo(join(dir, 'repo'), { 'README.md': '# 小仓库\n' });
    const broke = new Set(['sk-company']);
    dk = await devMelina({ dir, brain: brain(broke), models: TWO_KEYS });
    const first = await hello(dk.melina, repo);
    await first.result({ signal: AbortSignal.timeout(60_000) });
    expect(first.get().status, dk.logs.join('\n')).toBe('done');
    expect(git(repo, 'show', `melina/${first.id}:hello.txt`)).toBe('hello');

    // 同时在途的多个角色调用可能都先撞上公司账号，各自马上换到个人账号；之后都用个人账号。
    const keys = dk.asks.map((a) => a.apiKey);
    expect(keys[0]).toBe('sk-company');
    expect(new Set(keys)).toEqual(new Set(['sk-company', 'sk-personal']));
    expect(keys.filter((k) => k === 'sk-company').length).toBeLessThanOrEqual(3);
    expect(keys.slice(-3)).toEqual(['sk-personal', 'sk-personal', 'sk-personal']);
    // 分支没记失败：换 key 不算重试
    expect(first.summary().branches.every((b) => b.branch.state === 'succeeded')).toBe(true);
    const status = dk.melina.status().providers.find((p) => p.provider === PROVIDER);
    expect(status).toMatchObject({
      breaker: 'ok',
      keys: [
        { name: '公司账号', state: 'down', reason: expect.stringContaining('402') },
        { name: '个人账号', state: 'active' },
      ],
    });

    // 公司账号充了值，人在模型页存了一下：马上用回它
    broke.clear();
    saveModelsPage(dk.melina);
    expect(
      dk.melina
        .status()
        .providers.find((p) => p.provider === PROVIDER)
        ?.keys?.map((k) => k.state),
    ).toEqual(['active', 'standby']);
    const before = dk.asks.length;
    const second = await hello(dk.melina, repo);
    await second.result({ signal: AbortSignal.timeout(60_000) });
    expect(second.get().status).toBe('done');
    expect(dk.asks.slice(before).every((a) => a.apiKey === 'sk-company')).toBe(true);
  });

  it('key 都用不了才熔断这家，原因写明；人在模型页保存后马上重试，任务接着做完', async () => {
    dir = tempDir();
    const repo = gitRepo(join(dir, 'repo'), { 'README.md': '# 小仓库\n' });
    const broke = new Set(['sk-company', 'sk-personal']);
    dk = await devMelina({ dir, brain: brain(broke), models: TWO_KEYS });
    const run = await hello(dk.melina, repo);
    const provider = () => dk?.melina.status().providers.find((p) => p.provider === PROVIDER);
    await waitFor('这家熔断', () => provider()?.breaker === 'open');
    expect(provider()).toMatchObject({
      breaker: 'open',
      reason: '2 个 API key 都用不了（最后一个：402 Insufficient Balance）',
      keys: [{ state: 'down' }, { state: 'down' }],
    });
    // 在途的调用各自两个 key 都试过；熔断以后排队等，不再一直发
    expect(new Set(dk.asks.map((a) => a.apiKey))).toEqual(new Set(['sk-company', 'sk-personal']));
    const asked = dk.asks.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(dk.asks.length).toBe(asked);
    expect(run.get().status).toBe('running');

    // 个人账号充了值：存一下模型页，排队的调用马上重试
    broke.delete('sk-personal');
    saveModelsPage(dk.melina);
    await run.result({ signal: AbortSignal.timeout(60_000) });
    expect(run.get().status, dk.logs.join('\n')).toBe('done');
    expect(provider()?.breaker).toBe('ok');
    expect(provider()?.keys?.map((k) => k.state)).toEqual(['down', 'active']);
  });
});
