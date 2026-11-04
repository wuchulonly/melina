// 标准解和直接的做法只能用 agent 也有的东西：HTTP 接口（client.ts）、附件和目标、排布搜索（kit/pack.ts，规则是它自己摸出来的）。
// 不许 import 各环境的 world.ts、api.ts、tasks.ts，否则「标准解能过」证明不了题目只靠接口就做得出来。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SIM = fileURLToPath(new URL('../../sim/', import.meta.url));
const ALLOWED = [
  /^\.\.\/client\.ts$/,
  /^\.\.\/task\.ts$/,
  /^\.\.\/kit\/pack\.ts$/,
  /^\.\/(solve|naive)\.ts$/,
  /^node:/,
];

/** 源码里引用的所有模块：import … from、import '…'、export … from、import('…')、require('…') */
function moduleSpecifiers(source: string): string[] {
  const patterns = [
    /(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gms,
    /(?:^|[\s;])import\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1] as string));
}

describe('moduleSpecifiers', () => {
  it('认得各种写法', () => {
    const source = [
      "import { a } from './a.ts';",
      "import type {\n  B,\n} from '../b.ts';",
      "import './side-effect.ts';",
      "export { c } from './c.ts';",
      "export * from './d.ts';",
      "const e = await import('./e.ts');",
      "const f = require('./f.ts');",
    ].join('\n');
    expect(moduleSpecifiers(source).sort()).toEqual(
      ['../b.ts', './a.ts', './c.ts', './d.ts', './e.ts', './f.ts', './side-effect.ts'].sort(),
    );
  });
});

describe('标准解只靠接口', () => {
  const files = readdirSync(SIM, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'kit')
    .flatMap((d) => ['solve.ts', 'naive.ts'].map((f) => join(d.name, f)));

  it('四类环境都有标准解和直接的做法', () => {
    expect(files.sort()).toEqual([
      'constraints/naive.ts',
      'constraints/solve.ts',
      'machine/naive.ts',
      'machine/solve.ts',
      'service/naive.ts',
      'service/solve.ts',
      'tuning/naive.ts',
      'tuning/solve.ts',
    ]);
  });

  for (const file of files) {
    it(`${file} 只 import 接口客户端、类型和排布搜索`, () => {
      const source = readFileSync(join(SIM, file), 'utf8');
      const imports = moduleSpecifiers(source);
      expect(imports.length).toBeGreaterThan(0);
      expect(source, `${file} 用了参数不是字面量的 import() 或 require()`).not.toMatch(
        /\b(import|require)\s*\(\s*[^'"\s)]/,
      );
      for (const spec of imports)
        expect(
          ALLOWED.some((re) => re.test(spec)),
          `${file} import 了 ${spec}`,
        ).toBe(true);
    });
  }
});
