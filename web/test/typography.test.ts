// 字：西文、数字用随页面带的 Inter 和 JetBrains Mono，中文照旧用系统字体。
// 1. 两个字体只管西文那一段：中文里也用的破折号、引号、省略号留给中文字体（西文字体里的是窄的，排在中文里像缺了半个字）。
// 2. 字体栈里它们排第一。
// 3. 字重只用 400、500、600 三档（× ✓ 这类符号 700）：以前混着 650，苹方没有这一档、落到 600，Inter 却真画成 650，同一行中文和数字粗细不一样。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? cssFiles(join(dir, d.name)) : d.name.endsWith('.css') ? [join(dir, d.name)] : [],
  );
}

/** @font-face 一块块拆开：字体名、文件、unicode-range 展开成 [起, 止] */
function faces(css: string): { family: string; src: string; ranges: [number, number][] }[] {
  return [...noComments(css).matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const body = m[1] ?? '';
    const family = /font-family:\s*"([^"]+)"/.exec(body)?.[1] ?? '';
    const src = /url\("([^"]+)"\)/.exec(body)?.[1] ?? '';
    const range = /unicode-range:([^;]+);/.exec(body)?.[1] ?? '';
    const ranges = range
      .split(',')
      .map((r) => r.trim().replace(/^U\+/i, ''))
      .filter(Boolean)
      .map((r): [number, number] => {
        const [a, b] = r.split('-');
        return [Number.parseInt(a ?? '', 16), Number.parseInt(b ?? a ?? '', 16)];
      });
    return { family, src, ranges };
  });
}

const covers = (ranges: [number, number][], ch: string) => {
  const c = ch.codePointAt(0) ?? -1;
  return ranges.some(([a, b]) => a <= c && c <= b);
};

describe('字', () => {
  const all = faces(read('styles/fonts.css'));

  it('随页面带两个西文字体：Melina Sans（Inter）和 Melina Mono（JetBrains Mono），文件是 woff2', () => {
    expect(all.map((f) => f.family)).toEqual(['Melina Sans', 'Melina Mono']);
    for (const f of all) {
      const file = readFileSync(join(SRC, 'styles', f.src));
      expect(file.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  it('只管西文、数字和常用符号；中文里也用的 — ‘ ’ “ ” … 和中文本身留给系统的中文字体', () => {
    for (const f of all) {
      for (const ch of 'Az09$%.,:;()[]·×–') expect(covers(f.ranges, ch), `${f.family} 管 ${ch}`).toBe(true);
      for (const ch of '—‘’“”…中，。「」（）') expect(covers(f.ranges, ch), `${f.family} 不管 ${ch}`).toBe(false);
    }
  });

  it('字体栈里它们排第一，中文接着落到系统字体', () => {
    const tokens = noComments(read('styles/tokens.css'));
    const stack = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.replace(/\s+/g, ' ').trim();
    expect(stack('--font-sans')).toMatch(/^"Melina Sans", system-ui, .*"PingFang SC".*"Microsoft YaHei"/);
    expect(stack('--font-mono')).toMatch(/^"Melina Mono", ui-monospace, /);
  });

  it('字重只用 400、500、600（符号用 700）', () => {
    const bad: string[] = [];
    for (const file of cssFiles(SRC)) {
      // @font-face 里的 font-weight 是字体文件带的范围（100 900），不是用的字重
      const rules = noComments(readFileSync(file, 'utf8')).replace(/@font-face\s*\{[^}]*\}/g, '');
      for (const m of rules.matchAll(/font-weight:\s*([^;]+);/g)) {
        const v = (m[1] ?? '').trim();
        if (!['400', '500', '600', '700', 'inherit'].includes(v) && !v.startsWith('var(')) bad.push(`${file}: ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
