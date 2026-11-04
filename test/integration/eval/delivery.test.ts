// 跑分脚本取 Melina 的交付（要真 git）：起点仓库每次一样；从推回来的 melina/<runId> 分支只读对象取文件，符号链接不要，
// 起点仓库的 HEAD 和工作区不动；没有分支时在起点文件上打 patch，打完不留 .git；取出来的交付直接给检查用。

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResultResponse } from '../../../src/core/api.ts';
import type { MelinaRun } from '../../eval/melina.ts';
import { extractDelivery, git, MelinaDeliveryError, prepareWorkspace, snapshotDelivery } from '../../eval/workspace.ts';
import { MACHINE_PRESETS, machineTask } from '../../sim/machine/tasks.ts';
import { generateMachine } from '../../sim/machine/world.ts';

const RUN_ID = '01JBBBBBBBBBBBBBBBBBBBBBBB';
const REPORT = `art://${'0'.repeat(64)}` as const;
const PATCH = `art://${'1'.repeat(64)}` as const;
const SEED = 'delivery';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'melina-eval-delivery-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeRun(patch?: Uint8Array): MelinaRun {
  return {
    id: RUN_ID,
    events: async function* () {},
    cancel: async () => {},
    result: async () => ({}) as RunResultResponse,
    artifact: async () => patch ?? new Uint8Array(),
  };
}

/** 像 Melina 一样：在另一个 clone 里提交，推回起点仓库的 melina/<runId>，不碰起点仓库的工作区；返回这次提交的 patch */
function deliverLikeMelina(repo: string, files: Record<string, string>, symlink?: [string, string]): string {
  const work = join(dir, 'melina-clone');
  git(dir, ['clone', '-q', repo, work]);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(work, name), content);
  if (symlink) symlinkSync(symlink[1], join(work, symlink[0]));
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'Melina：交付']);
  git(work, ['push', '-q', 'origin', `HEAD:refs/heads/melina/${RUN_ID}`]);
  return git(work, ['diff', 'HEAD~1', 'HEAD']).toString('utf8');
}

describe('起点仓库和取交付', () => {
  const world = machineTask('easy').create(SEED);
  const machine = generateMachine(MACHINE_PRESETS.easy, SEED);
  const answer = JSON.stringify(machine.shortest.map((b) => machine.buttons[b]));

  it('同样的起点文件，提交的哈希每次一样', () => {
    prepareWorkspace(join(dir, 'a'), world.starter(), { git: true });
    prepareWorkspace(join(dir, 'b'), world.starter(), { git: true });
    const head = (d: string) => git(join(dir, d), ['rev-parse', 'HEAD']).toString().trim();
    expect(head('a')).toBe(head('b'));
  });

  it('从 melina/<runId> 分支取：普通文件都在，符号链接不要，起点仓库的 HEAD 和工作区不动；交付过检查', async () => {
    const repo = join(dir, 'repo');
    prepareWorkspace(repo, world.starter(), { git: true });
    const before = git(repo, ['rev-parse', 'HEAD']).toString();
    deliverLikeMelina(repo, { 'procedure.json': answer, 'notes.md': '记录' }, ['link', '/etc/passwd']);
    const into = join(dir, 'delivered');
    const result: RunResultResponse = {
      runId: RUN_ID,
      status: 'done',
      branch: `melina/${RUN_ID}`,
      unfinished: false,
      knowledgeReport: REPORT,
    };
    expect(await extractDelivery({ repo, result, run: fakeRun(), starter: world.starter(), into })).toBe('branch');
    expect(readFileSync(join(into, 'procedure.json'), 'utf8')).toBe(answer);
    expect(readFileSync(join(into, 'notes.md'), 'utf8')).toBe('记录');
    expect(readFileSync(join(into, 'README.md'), 'utf8')).toContain('procedure.json');
    expect(existsSync(join(into, 'link'))).toBe(false);
    expect(git(repo, ['rev-parse', 'HEAD']).toString()).toBe(before);
    expect(existsSync(join(repo, 'procedure.json'))).toBe(false);
    expect(world.check(into).pass).toBe(true);
  });

  it('没有分支时用 patch：在起点文件上打，打完不留 .git；交付过检查', async () => {
    const repo = join(dir, 'repo');
    prepareWorkspace(repo, world.starter(), { git: true });
    const patch = deliverLikeMelina(repo, { 'procedure.json': answer });
    const into = join(dir, 'delivered');
    const result: RunResultResponse = {
      runId: RUN_ID,
      status: 'done',
      patch: PATCH,
      unfinished: false,
      knowledgeReport: REPORT,
    };
    const run = fakeRun(Buffer.from(patch));
    expect(await extractDelivery({ repo, result, run, starter: world.starter(), into })).toBe('patch');
    expect(readFileSync(join(into, 'procedure.json'), 'utf8')).toBe(answer);
    expect(existsSync(join(into, '.git'))).toBe(false);
    expect(world.check(into).pass).toBe(true);
  });

  it('workspace 里装了一大堆东西：只取检查要的文件，不受影响；不带 files 时超过上限的跳过、不报错', async () => {
    const repo = join(dir, 'repo');
    prepareWorkspace(repo, world.starter(), { git: true });
    const files: Record<string, string> = { 'procedure.json': answer };
    for (let i = 0; i < 5100; i++) files[`dep-${i}.js`] = `module.exports = ${i};\n`;
    deliverLikeMelina(repo, files);
    const result: RunResultResponse = {
      runId: RUN_ID,
      status: 'done',
      branch: `melina/${RUN_ID}`,
      unfinished: false,
      knowledgeReport: REPORT,
    };
    const only = join(dir, 'only');
    await extractDelivery({
      repo,
      result,
      run: fakeRun(),
      starter: world.starter(),
      into: only,
      files: ['procedure.json'],
    });
    expect(world.check(only).pass).toBe(true);
    expect(existsSync(join(only, 'dep-0.js'))).toBe(false);
    const all = join(dir, 'all');
    await extractDelivery({ repo, result, run: fakeRun(), starter: world.starter(), into: all });
    expect(existsSync(join(all, 'README.md'))).toBe(true);
  });

  it('交付物是符号链接的不认：分支里的不取，patch 打出来的删掉，检查不会顺着它读宿主机上的文件', async () => {
    const repo = join(dir, 'repo');
    prepareWorkspace(repo, world.starter(), { git: true });
    const patch = deliverLikeMelina(repo, {}, ['procedure.json', '/etc/hostname']);
    const viaBranch = join(dir, 'branch');
    const branchResult: RunResultResponse = {
      runId: RUN_ID,
      status: 'done',
      branch: `melina/${RUN_ID}`,
      unfinished: false,
      knowledgeReport: REPORT,
    };
    await extractDelivery({ repo, result: branchResult, run: fakeRun(), starter: world.starter(), into: viaBranch });
    expect(world.check(viaBranch).summary).toBe('工作目录里没有 procedure.json');
    const viaPatch = join(dir, 'patch');
    const patchResult = { ...branchResult, branch: undefined, patch: PATCH } as RunResultResponse;
    const run = fakeRun(Buffer.from(patch));
    await extractDelivery({ repo, result: patchResult, run, starter: world.starter(), into: viaPatch });
    expect(existsSync(join(viaPatch, 'procedure.json'))).toBe(false);
    expect(world.check(viaPatch).pass).toBe(false);
  });

  it('既没有分支也没有 patch：报错', async () => {
    const result = { runId: RUN_ID, status: 'done', unfinished: false, knowledgeReport: REPORT } as RunResultResponse;
    await expect(
      extractDelivery({ repo: dir, result, run: fakeRun(), starter: {}, into: join(dir, 'x') }),
    ).rejects.toThrow('既没有分支也没有 patch');
  });
});

describe('取不到交付算谁的（§16：说做完了却取不到交付算 Melina 失败，本机读不出才算跑分出错）', () => {
  const world = machineTask('easy').create(SEED);
  const result = (over: Partial<RunResultResponse>) =>
    ({ runId: RUN_ID, status: 'done', unfinished: false, knowledgeReport: REPORT, ...over }) as RunResultResponse;
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    );

  it('交付指的分支不在起点仓库里：MelinaDeliveryError', async () => {
    const repo = join(dir, 'repo');
    prepareWorkspace(repo, world.starter(), { git: true });
    const e = await failure(
      extractDelivery({
        repo,
        result: result({ branch: `melina/${RUN_ID}` }),
        run: fakeRun(),
        starter: world.starter(),
        into: join(dir, 'x'),
      }),
    );
    expect(e).toBeInstanceOf(MelinaDeliveryError);
    expect((e as Error).message).toContain(`Melina 交的分支 melina/${RUN_ID} 在起点仓库里读不出`);
  });

  it('patch 打不上起点：MelinaDeliveryError', async () => {
    const repo = join(dir, 'repo');
    prepareWorkspace(repo, world.starter(), { git: true });
    const bad = 'diff --git a/nope.txt b/nope.txt\n--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-old\n+new\n';
    const e = await failure(
      extractDelivery({
        repo,
        result: result({ patch: PATCH }),
        run: fakeRun(Buffer.from(bad)),
        starter: world.starter(),
        into: join(dir, 'x'),
      }),
    );
    expect(e).toBeInstanceOf(MelinaDeliveryError);
    expect((e as Error).message).toContain('Melina 交的 patch 打不上起点');
  });

  it('起点仓库本身读不出（本机的问题）：照原样抛，不算 Melina 的', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const e = await failure(
      extractDelivery({
        repo: plain,
        result: result({ branch: `melina/${RUN_ID}` }),
        run: fakeRun(),
        starter: {},
        into: join(dir, 'x'),
      }),
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(MelinaDeliveryError);
  });
});

describe('基线的交付照 Melina 交付成分支的样子取（snapshotDelivery，§16 两边用同一套检查）', () => {
  it('.gitignore 盖住的新文件、符号链接不算交付，FIFO 跳过；起点里有的文件被后写的 .gitignore 盖住也照收', () => {
    const ws = join(dir, 'ws');
    prepareWorkspace(ws, { 'README.md': '起点\n', 'data.json': '{}\n' }, { git: true });
    writeFileSync(join(ws, '.gitignore'), '*.json\n');
    writeFileSync(join(ws, 'answer.json'), '{"a":1}\n');
    writeFileSync(join(ws, 'report.md'), '报告\n');
    symlinkSync('/etc/hostname', join(ws, 'link'));
    execFileSync('mkfifo', [join(ws, 'pipe')]);
    const into = join(dir, 'delivered');
    snapshotDelivery(ws, ['README.md', 'data.json'], into);
    expect(existsSync(join(into, 'answer.json'))).toBe(false);
    expect(readFileSync(join(into, 'report.md'), 'utf8')).toBe('报告\n');
    expect(readFileSync(join(into, 'data.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(into, 'link'))).toBe(false);
    expect(existsSync(join(into, 'pipe'))).toBe(false);
    // 只取检查要的文件时也一样
    const only = join(dir, 'only');
    snapshotDelivery(ws, ['README.md', 'data.json'], only, ['answer.json', 'report.md']);
    expect(readdirSync(only)).toEqual(['report.md']);
  });

  it('workspace 的 .git 是 agent 写得动的：里面配的 filter 不跑，指到别处的 gitdir 不认', () => {
    const ws = join(dir, 'ws');
    prepareWorkspace(ws, { 'a.txt': 'a\n' }, { git: true });
    const marker = join(dir, 'filter-ran');
    git(ws, ['config', 'filter.evil.clean', `touch ${marker}; cat`]);
    writeFileSync(join(ws, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(ws, 'b.txt'), 'b\n');
    snapshotDelivery(ws, ['a.txt'], join(dir, 'delivered'));
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(dir, 'delivered', 'b.txt'), 'utf8')).toBe('b\n');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(join(ws, '.git'), { recursive: true, force: true });
    writeFileSync(join(ws, '.git'), `gitdir: ${elsewhere}\n`);
    snapshotDelivery(ws, ['a.txt'], join(dir, 'again'));
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readFileSync(join(dir, 'again', 'a.txt'), 'utf8')).toBe('a\n');
  });
});
