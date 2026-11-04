// 页面代码（web/src）只 import src/core 的类型（项目规范「模块边界」）：import 值会把 typebox 和全部 schema 打进页面，
// 也违背「web/ 只通过 HTTP API 和 SSE 访问 Melina」。dependency-cruiser 管目录，这里管「只许类型」。

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [join(dir, d.name)] : [],
  );
}

describe('web/src 和 src/core', () => {
  it('只用 import type 引 src/core', () => {
    const bad: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)'/gm)) {
        const [, what = '', from = ''] = m;
        if (!from.includes('/src/core/')) continue;
        if (what.startsWith('type ')) continue;
        bad.push(`${relative(SRC, file)}: import ${what} from '${from}'`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('不碰 src/ 下别的模块，也不碰 test/fixtures（假后端在 web/fake，只在 Node 里用）', () => {
    const bad: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^(?:import|export)\s[\s\S]*?from\s+'([^']+)'/gm)) {
        const from = m[1] ?? '';
        if (/\/src\/(?!core\/)/.test(from) && from.startsWith('../../')) bad.push(`${relative(SRC, file)}: ${from}`);
        if (from.includes('/fake/') || from.includes('test/fixtures')) bad.push(`${relative(SRC, file)}: ${from}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
