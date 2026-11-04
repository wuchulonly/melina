// 「实」：长列表屏幕外先不排版（content-visibility: auto）。
// 真任务上量的（开发机只读起的 Melina，最大的那个任务，热打开）：决策日志排版 230–315 → 46–69 ms，时间线 170–200 → 22–25 ms，
// 35 个任务的任务列表 62–68 → 9–11 ms。工作台不这么做：右边的块和连线要量主线上每一步的位置，没排的步骤量不准。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function css(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 某个选择器那一条规则的正文：只认顶格写的（@media 块里的规则缩进了，不算） */
function rule(text: string, selector: string): string {
  const at = text.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`));
  if (at < 0) throw new Error(`没有 ${selector}`);
  const open = text.indexOf('{', at);
  return text.slice(open + 1, text.indexOf('}', open));
}

describe('长任务列表', () => {
  const tasks = css('pages/tasks/tasks.css');
  it('屏幕外任务行延迟排版并预留高度', () => {
    const body = rule(tasks, '.task');
    expect(body).toContain('content-visibility: auto;');
    expect(body).toMatch(/contain-intrinsic-block-size: auto \d+px;/);
  });
  it('打印时排出完整任务列表', () => {
    expect(tasks).toMatch(/@media print \{\s*\.task \{\s*content-visibility: visible;/);
  });
});
