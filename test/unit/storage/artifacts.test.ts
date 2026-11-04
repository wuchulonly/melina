// Artifact store：按内容寻址、同一个 Run 里去重、写完只读、按行读、复制到别的 Run、删除。
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleOf, handlePath, newId } from '../../../src/core/ids.ts';
import { FileArtifactStore } from '../../../src/storage/artifacts.ts';

let dir: string;
let store: FileArtifactStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'melina-artifacts-'));
  store = new FileArtifactStore(join(dir, 'artifacts'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
describe('按内容寻址', () => {
  it('句柄是内容的 sha256，路径是 <runId>/<前两位>/<sha256>；相同内容只存一份', async () => {
    const run = newId();
    const h = await store.put(run, 'Tests 386 passed\n');
    expect(h).toBe(handleOf('Tests 386 passed\n'));
    expect(store.path(run, h)).toBe(join(dir, 'artifacts', run, handlePath(h)));
    expect(await store.put(run, 'Tests 386 passed\n')).toBe(h);
    expect(await store.has(run, h)).toBe(true);
    expect(store.hasSync(run, h)).toBe(true);
    expect(new TextDecoder().decode(await store.read(run, h))).toBe('Tests 386 passed\n');
    expect(await store.stat(run, h)).toEqual({ size: 17 });
    // 写完只读：内容和句柄永远对得上
    expect(statSync(store.path(run, h)).mode & 0o222).toBe(0);
  });
  it('putFile：把宿主机上的文件放进来，句柄按内容算', async () => {
    const run = newId();
    const src = join(dir, 'upload.md');
    writeFileSync(src, '# 讲义要求\n');
    const h = await store.putFile(run, src);
    expect(h).toBe(handleOf('# 讲义要求\n'));
    expect(await store.putFile(run, src)).toBe(h);
    await expect(store.putFile(run, join(dir, '没有这个文件'))).rejects.toThrow();
  });
  it('不同 Run 分开存；没有的句柄读不到', async () => {
    const a = newId();
    const b = newId();
    const h = await store.put(a, 'x');
    expect(await store.has(b, h)).toBe(false);
    await expect(store.read(b, h)).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.stat(b, h)).toBeUndefined();
  });
  it('runId 和句柄要合格式，拼不出目录外的路径', () => {
    expect(() => store.path('../etc', handleOf('x'))).toThrow();
    expect(() => store.path(newId(), 'art://../../x' as `art://${string}`)).toThrow();
  });
});
describe('按行读（artifact_read，§8）', () => {
  it('offset 从 1 数，limit 条；最后一个换行后面没有内容时不算一行', async () => {
    const run = newId();
    const h = await store.put(run, 'a\nb\nc\nd\n');
    expect(await store.readLines(run, h)).toEqual({ text: 'a\nb\nc\nd', totalLines: 4 });
    expect(await store.readLines(run, h, { offset: 2, limit: 2 })).toEqual({ text: 'b\nc', totalLines: 4 });
    expect(await store.readLines(run, h, { offset: 9 })).toEqual({ text: '', totalLines: 4 });
    const empty = await store.put(run, '');
    expect(await store.readLines(run, empty)).toEqual({ text: '', totalLines: 0 });
  });
});
describe('复制和删除', () => {
  it('接着做时复制到新 Run（§4）；删掉上个 Run 不影响新的', async () => {
    const old = newId();
    const next = newId();
    const h = await store.put(old, '# 知识报告');
    expect(await store.copy(old, h, next)).toBe(h);
    expect(await store.copy(old, h, next)).toBe(h);
    await store.deleteRun(old);
    expect(await store.has(old, h)).toBe(false);
    expect(new TextDecoder().decode(await store.read(next, h))).toBe('# 知识报告');
    await expect(store.copy(old, h, newId())).rejects.toMatchObject({ code: 'not_found' });
  });
  it('删除不存在的 Run 不报错', async () => {
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    await expect(store.deleteRun(newId())).resolves.toBeUndefined();
  });
});
