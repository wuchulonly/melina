// @vitest-environment jsdom
// Markdown 的渲染部分按需加载（components/Markdown.tsx）：还在加载时放几行骨架，别是一块空白，
// 看着像文档没了。

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Markdown } from '../src/components/Markdown.tsx';

// 渲染部分一直加载不完
vi.mock('../src/components/MarkdownBody.tsx', () => new Promise(() => {}));

it('渲染部分还在加载：几行骨架，标着正在读', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const div = document.createElement('div');
  const root = createRoot(div);
  await act(async () => {
    root.render(<Markdown source="# 交付文档" className="result-doc-body" />);
  });
  const loading = div.querySelector('.md-loading');
  expect(loading).not.toBeNull();
  expect(loading?.getAttribute('aria-busy')).toBe('true');
  expect(loading?.classList.contains('result-doc-body')).toBe(true);
  expect(loading?.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(3);
  act(() => root.unmount());
});
