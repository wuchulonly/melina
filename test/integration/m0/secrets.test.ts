// 工作目录里原有的密钥，完整组装的 Melina：
// 用户仓库的 .env 被 .gitignore 忽略、开跑时抄进 workspace；agent cat 它，程序照常读得到，模型看到的工具输出、
// RunStore 上的记录和原始产物里都只有占位符。
// 交付前查一遍：agent 把登录拿到的 token 写进工作目录，交付不推分支、只交 patch。

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  candidateCall,
  type DevMelina,
  devMelina,
  gitRepo,
  HELLO_COMPLETION,
  look,
  removeDir,
  STRONG,
  say,
  tempDir,
  toolResults,
  turn,
} from './kit.ts';

const TOKEN = 'svc-0123456789abcdef-token';

let dir: string | undefined;
let dk: DevMelina | undefined;

afterEach(async () => {
  await dk?.close();
  dk = undefined;
  if (dir) removeDir(dir);
  dir = undefined;
});

/** 一个目录下所有文件的内容拼在一起（原始产物都在 artifacts/ 下） */
function readAll(root: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out.join('\n');
}

describe('工作目录里原有的密钥（完整组装的 Melina）', () => {
  it('被忽略的 .env 抄进了 workspace、程序照常读得到；模型看到的、RunStore 上的、原始产物里都只有占位符', async () => {
    dir = tempDir('melina-m0-secrets-');
    const repo = gitRepo(join(dir, 'repo'), { 'README.md': '# 起点\n', '.gitignore': '.env\n' });
    writeFileSync(join(repo, '.env'), `PORT=3000\nSERVICE_TOKEN=${TOKEN}\n`);
    const seen: string[] = [];
    dk = await devMelina({
      dir,
      brain: ({ ctx, role }) => {
        if (role !== 'explorer') return say(`不该有 ${role} 的调用`);
        const results = toolResults(ctx.messages);
        if (results.length === 0) return turn(look('cat .env'));
        // 程序照常读得到原值：长度对得上
        if (results.length === 1) return turn(look('. ./.env && printf "%s" "$SERVICE_TOKEN" | wc -c'));
        if (results.length === 2) return turn(look("printf 'hello\\n' > hello.txt && cat hello.txt"));
        for (const r of results) seen.push(r.text);
        return turn(
          candidateCall({
            claim: '工作目录根下有 hello.txt，内容是 hello',
          }),
        );
      },
    });
    const run = await dk.melina.createRun({
      goal: { statement: '写一个 hello.txt，内容是 hello', completion: HELLO_COMPLETION, domain: 'general' },
      workspace: { root: repo },
      config: { bet0: { models: [STRONG] }, continuation: { enabled: false } },
    });
    const result = await run.result({ signal: AbortSignal.timeout(60_000) });
    expect(result.status, dk.logs.join('\n')).toBe('done');

    const all = seen.join('\n');
    expect(all).toContain('[凭证「.env 里的 SERVICE_TOKEN」已隐藏]');
    expect(all).toContain('PORT=3000');
    expect(all).not.toContain(TOKEN);
    expect(all).toContain(String(TOKEN.length)); // wc -c：程序读到的是原值
    expect(JSON.stringify(run.summary())).not.toContain(TOKEN);
    expect(readAll(join(dir, 'artifacts'))).not.toContain(TOKEN);
    expect(dk.logs.some((t) => t.includes('像密钥的值'))).toBe(true);
  });

  it('agent 把登录拿到的 token 写进了工作目录：交付不推分支、只交 patch，结束原因里说在哪', async () => {
    dir = tempDir('melina-m0-leak-');
    const repo = gitRepo(join(dir, 'repo'), { 'README.md': '# 起点\n' });
    const login = '0f3c9a7b5e1d2f4a6c8b0e2d4f6a8c1b';
    dk = await devMelina({
      dir,
      brain: ({ ctx, role }) => {
        if (role !== 'explorer') return say(`不该有 ${role} 的调用`);
        const results = toolResults(ctx.messages);
        if (results.length === 0)
          return turn(look(`printf '%s\\n' ${login} > .token && printf 'hello\\n' > hello.txt`));
        if (results.length === 1) return turn(look('cat hello.txt'));
        return turn(
          candidateCall({
            claim: '工作目录根下有 hello.txt，内容是 hello',
          }),
        );
      },
    });
    const run = await dk.melina.createRun({
      goal: { statement: '写一个 hello.txt，内容是 hello', completion: HELLO_COMPLETION, domain: 'general' },
      workspace: { root: repo },
      config: { bet0: { models: [STRONG] }, continuation: { enabled: false } },
    });
    const result = await run.result({ signal: AbortSignal.timeout(60_000) });
    expect(result.status, dk.logs.join('\n')).toBe('done');
    expect(result.branch).toBeUndefined();
    expect(result.patch).toBeDefined();
    expect(result.endReason).toContain('.token 的整段内容');
    expect(result.endReason).not.toContain(login);
    const branches = spawnSync('git', ['-C', repo, 'branch', '--list', 'melina/*'], { encoding: 'utf8' });
    expect(branches.stdout.trim()).toBe('');
  });
});
