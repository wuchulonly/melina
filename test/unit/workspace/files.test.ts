// files.ts：复制、同步、放文件都不跟随符号链接（只用临时目录，不用 git）。

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTree, entryOf, placeFile, removeTree, syncTree } from '../../../src/workspace/files.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'melina-files-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string, mode?: number) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, mode === undefined ? {} : { mode });
}

describe('copyTree', () => {
  it('复制权限、修改时间和符号链接（不跟随），没变的文件可以硬链接到上一份', async () => {
    write('src/a.txt', 'a');
    write('src/run.sh', '#!/bin/sh', 0o755);
    symlinkSync('/etc/passwd', join(dir, 'src/out'));
    await copyTree(join(dir, 'src'), join(dir, 's1'));
    expect(readFileSync(join(dir, 's1/a.txt'), 'utf8')).toBe('a');
    expect(statSync(join(dir, 's1/run.sh')).mode & 0o777).toBe(0o755);
    expect((await lstat(join(dir, 's1/out'))).isSymbolicLink()).toBe(true);
    expect(statSync(join(dir, 's1/a.txt')).mtimeMs).toBeCloseTo(statSync(join(dir, 'src/a.txt')).mtimeMs, 0);

    write('src/b.txt', 'b');
    await copyTree(join(dir, 'src'), join(dir, 's2'), { linkFrom: join(dir, 's1') });
    expect(statSync(join(dir, 's2/a.txt')).ino).toBe(statSync(join(dir, 's1/a.txt')).ino);
    expect(statSync(join(dir, 's2/b.txt')).nlink).toBe(1);
  });
});

describe('syncTree', () => {
  it('多的删、少的补、变的改；目标里换成符号链接的目录不会被穿过去', async () => {
    write('snap/data/x.txt', 'x');
    write('snap/keep.txt', 'keep');
    mkdirSync(join(dir, 'outside'));
    await copyTree(join(dir, 'snap'), join(dir, 'ws'));
    rmSync(join(dir, 'ws/data'), { recursive: true });
    symlinkSync(join(dir, 'outside'), join(dir, 'ws/data'));
    write('ws/junk.txt', 'junk');
    write('ws/keep.txt', 'changed');
    await syncTree(join(dir, 'snap'), join(dir, 'ws'));
    expect(readdirSync(join(dir, 'outside'))).toEqual([]);
    expect(readFileSync(join(dir, 'ws/data/x.txt'), 'utf8')).toBe('x');
    expect(readFileSync(join(dir, 'ws/keep.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(join(dir, 'ws')).sort()).toEqual(['data', 'keep.txt']);
  });
});

describe('placeFile', () => {
  it('已有东西不放；父目录里有符号链接就放弃', async () => {
    write('src.env', 'SECRET=1');
    const e = entryOf(await lstat(join(dir, 'src.env'), { bigint: true }));
    mkdirSync(join(dir, 'ws'));
    expect(await placeFile(join(dir, 'ws'), 'conf/.env', join(dir, 'src.env'), e)).toBe(true);
    expect(await placeFile(join(dir, 'ws'), 'conf/.env', join(dir, 'src.env'), e)).toBe(false);
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'ws/linked'));
    expect(await placeFile(join(dir, 'ws'), 'linked/.env', join(dir, 'src.env'), e)).toBe(false);
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
  });
});

describe('removeTree', () => {
  it('删得掉只读目录；删符号链接只删链接', async () => {
    write('t/ro/f.txt', 'f');
    write('target/keep.txt', 'keep');
    symlinkSync(join(dir, 'target'), join(dir, 't/link'));
    chmodSync(join(dir, 't/ro'), 0o555);
    await removeTree(join(dir, 't'));
    expect(readdirSync(dir).sort()).toEqual(['target']);
    expect(readFileSync(join(dir, 'target/keep.txt'), 'utf8')).toBe('keep');
  });
});
