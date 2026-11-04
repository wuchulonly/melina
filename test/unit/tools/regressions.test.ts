// 工具回归：长输出、凭证占位符、分页、存档失败、命令记账和原子文件编辑。

import { chmodSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../../src/core/ids.ts';
import type { ArtifactStore } from '../../../src/core/interfaces/artifacts.ts';
import { branch, call, type Kit, kit, openExplorer, SECRET, sh } from './gateway-kit.ts';

let k: Kit;
afterEach(() => k?.cleanup());

const placeholder = `[凭证「${SECRET.name}」已隐藏]`;

describe('一长串换行不会卡住进程', () => {
  it('20 万个空行后面跟着文字：几秒内就回来', async () => {
    k = kit();
    const b = await branch(k);
    const started = Date.now();
    const r = await call(openExplorer(k, b), 'sh', { cmd: "yes '' | head -n 200000; echo done" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.json?.summary).toMatch(/done$/);
  });
});

describe('凭证占位符', () => {
  it('write 的内容里有占位符：不写，说清楚怎么办；文件里的真值不动', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, '.env'), `TOKEN=${SECRET.value}\n`);
    const s = openExplorer(k, b);
    const r = await call(s, 'write', { path: '.env', content: `TOKEN=${placeholder}\nDEBUG=1\n` });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^content 里有凭证占位符 \[凭证「GitHub token」已隐藏\]：它代表一个你看不到原文的凭证值/);
    // 附件、工作目录文件里的凭证不在环境变量里：要说从原文件取
    expect(r.content).toContain('附件、工作目录文件里的从那个文件取');
    expect(readFileSync(join(b.ws, '.env'), 'utf8')).toBe(`TOKEN=${SECRET.value}\n`);
    expect(s.toolCalls).toBe(0);
  });

  it('edit 的 old 里有占位符：告诉它那里其实是真值，只改旁边的；new 里有占位符同 write', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, '.env'), `TOKEN=${SECRET.value}\nDEBUG=0\n`);
    const s = openExplorer(k, b);
    const old = await call(s, 'edit', { path: '.env', old: `TOKEN=${placeholder}`, new: 'TOKEN=x' });
    expect(old.content).toMatch(/^old 里有凭证占位符 .*：文件里那个位置其实是凭证的真值/);
    const neu = await call(s, 'edit', { path: '.env', old: 'DEBUG=0', new: `DEBUG=1\nCOPY=${placeholder}` });
    expect(neu.content).toMatch(/^new 里有凭证占位符/);
    const fine = await call(s, 'edit', { path: '.env', old: 'DEBUG=0', new: 'DEBUG=1' });
    expect(fine.isError).toBe(false);
    expect(readFileSync(join(b.ws, '.env'), 'utf8')).toBe(`TOKEN=${SECRET.value}\nDEBUG=1\n`);
  });
});

describe('read 取回的内容超过上限', () => {
  it('在整行处停下，行号和「接着读」的位置都对', async () => {
    k = kit();
    const b = await branch(k);
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${i + 1}-${'x'.repeat(1000)}`);
    writeFileSync(join(b.ws, 'big.txt'), `${lines.join('\n')}\n`);
    const s = openExplorer(k, b);
    const r = await call(s, 'read', { path: 'big.txt' });
    const summary = r.json?.summary as string;
    const m = /这次是第 1–(\d+) 行；后面还有 (\d+) 行，用 offset=(\d+) 接着读/.exec(summary);
    expect(m).not.toBeNull();
    const last = Number(m?.[1]);
    expect(last).toBeGreaterThan(900);
    expect(last).toBeLessThan(2000);
    expect(Number(m?.[2])).toBe(2000 - last);
    expect(Number(m?.[3])).toBe(last + 1);
    // 摘要结尾那一行的行号就是 last，内容也对得上
    expect(summary).toMatch(new RegExp(`\\n\\s+${last}\\tline-${last}-x+$`));
    const next = await call(s, 'read', { path: 'big.txt', offset: last + 1, limit: 2 });
    expect(next.json?.summary).toContain(`${last + 1}\tline-${last + 1}-`);
    expect(next.json?.summary).toContain(`${last + 2}\tline-${last + 2}-`);
  });

  it('一行就超过上限：只取开头，写明这一行太长', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, 'min.js'), `${'y'.repeat(1_500_000)}\nsecond\n`);
    const r = await call(openExplorer(k, b), 'read', { path: 'min.js' });
    expect(r.json?.summary).toMatch(
      /^min\.js：共 2 行、[\d.]+ MB，这次是第 1–1 行；第 1 行太长，只取了开头 1\.0 MB，整行用 sh 看；后面还有 1 行，用 offset=2 接着读/,
    );
  });
});

describe('输出存档失败', () => {
  function failingStore(base: ArtifactStore, opts: { emptyToo?: boolean } = {}): ArtifactStore {
    return {
      ...base,
      put: async (runId, content) => {
        const empty = typeof content === 'string' ? content === '' : content.length === 0;
        if (!empty || opts.emptyToo)
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return base.put(runId, content);
      },
      path: (runId, handle) => base.path(runId, handle),
      readLines: (runId, handle, o) => base.readLines(runId, handle, o),
    };
  }

  it('命令已经执行：照样把输出给模型，记一条原文为空的 Observation，act 的意图有结果', async () => {
    k = kit();
    const store = k.runStore.artifacts as unknown as ArtifactStore;
    k = { ...k, gateway: kitGateway(k, failingStore(store)) };
    const b = await branch(k);
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'echo deployed', expect: '部署成功' });
    expect(r.isError).toBe(false);
    expect(r.json?.summary).toMatch(
      /^退出码 0\n（原文没能存档：ENOSPC: no space left on device；能给的都在下面）\ndeployed$/,
    );
    expect(r.json?.path).toBeUndefined();
    const obs = k.runStore.queries.getObservation(r.observationId as string);
    expect(obs?.error).toBe('原文没能存档：ENOSPC: no space left on device');
    expect(k.runStore.queries.pendingShIntents(k.run.id)).toEqual([]);
  });

  it('连空的原文都存不进去：告诉模型已经执行过了、不要重跑', async () => {
    k = kit();
    const store = k.runStore.artifacts as unknown as ArtifactStore;
    k = { ...k, gateway: kitGateway(k, failingStore(store, { emptyToo: true })) };
    const b = await branch(k);
    const r = await call(openExplorer(k, b), 'sh', { cmd: 'echo deployed', expect: '部署成功' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(
      /deployed\n（这次调用已经执行过了，不要重跑；但没能记录下来，没有 observationId，不能当证据/,
    );
  });
});

describe('工具账里的命令首词', () => {
  it('跳过开头的环境变量赋值；凭证值换成占位符', async () => {
    k = kit();
    const b = await branch(k);
    const s = openExplorer(k, b);
    await sh(s, `GH_TOKEN=${SECRET.value} FOO=1 true`);
    await sh(s, `${SECRET.value} --version || true`);
    expect(k.ledger.map((e) => e.tool)).toEqual(['true', placeholder]);
    expect(JSON.stringify(k.ledger)).not.toContain(SECRET.value);
  });
});

describe('edit 写临时文件再换过去', () => {
  it('保留原来的权限；改符号链接时改的是它指向的文件，链接不动', async () => {
    k = kit();
    const b = await branch(k);
    writeFileSync(join(b.ws, 'run.sh'), '#!/bin/sh\necho old\n');
    chmodSync(join(b.ws, 'run.sh'), 0o755);
    writeFileSync(join(b.ws, 'target.txt'), 'a=1\n');
    symlinkSync('target.txt', join(b.ws, 'link.txt'));
    const s = openExplorer(k, b);
    expect((await call(s, 'edit', { path: 'run.sh', old: 'echo old', new: 'echo new' })).isError).toBe(false);
    expect(statSync(join(b.ws, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(b.ws, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho new\n');
    expect((await call(s, 'edit', { path: 'link.txt', old: 'a=1', new: 'a=2' })).isError).toBe(false);
    expect(lstatSync(join(b.ws, 'link.txt')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(b.ws, 'target.txt'), 'utf8')).toBe('a=2\n');
  });
});

/** 换掉 Artifact store 的网关（别的依赖和 kit 一样） */
function kitGateway(kt: Kit, artifacts: ArtifactStore) {
  return new (kt.gateway.constructor as new (deps: unknown) => Kit['gateway'])({
    writer: kt.runStore.writer,
    queries: kt.runStore.queries,
    artifacts,
    runtime: kt.runtime,
    redactor: kt.redactor,
    views: kt.views,
    ledger: { tool: (e: unknown) => kt.ledger.push(e as never) },
    domains: () => ['code', 'research', 'general'],
    onError: (error: unknown, what: string) => kt.errors.push(`${what}：${String(error)}`),
    fileTimeoutMs: 10_000,
    newId,
  });
}
