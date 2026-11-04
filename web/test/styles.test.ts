// 样式文件的约束：
// 1. markdown.css 跟着 Markdown 的渲染部分按需加载，里面只放 .md 下面的样式；别的地方要用的放进常驻的样式。
// 2. 色边不用 inset 阴影画，避免在圆角处变细。
// 3. 减少动效时过渡时长为 0 s，避免给没有过渡的元素添加动效，影响布局测量。

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? cssFiles(join(dir, d.name)) : d.name.endsWith('.css') ? [join(dir, d.name)] : [],
  );
}

const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 每条规则的选择器（@ 规则的头、关键帧的 from/to/百分比不算） */
function selectors(css: string): string[] {
  const out: string[] = [];
  for (const m of noComments(css).matchAll(/([^{};]+)\{/g)) {
    const head = (m[1] ?? '').trim();
    if (!head || head.startsWith('@') || /^(from|to|\d+%)/.test(head)) continue;
    out.push(...head.split(',').map((s) => s.trim()));
  }
  return out;
}

describe('样式文件', () => {
  it('按需加载的 markdown.css 里只有 .md 下面的样式', () => {
    const md = readFileSync(join(SRC, 'styles/markdown.css'), 'utf8');
    expect(selectors(md).filter((s) => !s.startsWith('.md'))).toEqual([]);
  });

  it('.plain-text 在常驻的 ui.css 里', () => {
    expect(selectors(readFileSync(join(SRC, 'styles/ui.css'), 'utf8'))).toContain('.plain-text');
  });

  it('色边不用 inset 阴影画', () => {
    const bad: string[] = [];
    for (const file of cssFiles(SRC)) {
      const text = noComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/inset\s+(?:[2-9]px\s+0|0\s+[2-9]px)\s+0\s/g))
        bad.push(`${relative(SRC, file)}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it('减少动效时过渡时长是 0 s，不给没有过渡的元素凭空加一段过渡', () => {
    const bad: string[] = [];
    for (const file of cssFiles(SRC)) {
      const text = noComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g))
        for (const d of (m[1] ?? '').matchAll(/transition-duration:\s*([^;!]+)/g))
          if (!/^0s?\s*$/.test((d[1] ?? '').trim())) bad.push(`${relative(SRC, file)}: transition-duration ${d[1]}`);
    }
    expect(bad).toEqual([]);
    const base = noComments(readFileSync(join(SRC, 'styles/base.css'), 'utf8'));
    expect(base).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition-duration:\s*0s\s*!important/);
  });
});
