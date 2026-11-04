import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runtimeExtensions } from '../../../src/api/extensions.ts';
import type { InfraDeps } from '../../../src/api/sdk.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'melina-extension-entry-'));
  dirs.push(dir);
  const path = join(dir, 'entry.mjs');
  writeFileSync(path, source);
  return path;
}

it('普通部署不加载外部代码，SDK 的显式空列表覆盖环境入口', () => {
  vi.stubEnv('MELINA_RUNTIME_EXTENSION', '');
  expect(runtimeExtensions({} as InfraDeps)).toEqual([]);
  vi.stubEnv('MELINA_RUNTIME_EXTENSION', '/does/not/exist.mjs');
  expect(runtimeExtensions({} as InfraDeps, [])).toEqual([]);
});

it('显式本地入口只加载兼容版本，并把组装依赖传给扩展', () => {
  vi.stubEnv(
    'MELINA_RUNTIME_EXTENSION',
    entry('export const apiVersion = 1; export default deps => ({ tools: [], marker: deps.paths.dataDir });'),
  );
  expect(runtimeExtensions({ paths: { dataDir: '/fixture' } } as InfraDeps)).toEqual([
    { tools: [], marker: '/fixture' },
  ]);
  vi.stubEnv('MELINA_RUNTIME_EXTENSION', entry('export const apiVersion = 2; export default () => ({tools: []});'));
  expect(() => runtimeExtensions({} as InfraDeps)).toThrow('apiVersion');
  vi.stubEnv('MELINA_RUNTIME_EXTENSION', entry('export const apiVersion = 1; export default () => ({});'));
  expect(() => runtimeExtensions({} as InfraDeps)).toThrow('tools');
});
