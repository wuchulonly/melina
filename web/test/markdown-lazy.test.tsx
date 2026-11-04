// @vitest-environment jsdom
// Markdown 的渲染部分是按需加载的（components/Markdown.tsx）：加载失败（Melina 重新打包过、正在重启）时退回原文，
// 页面别的部分照常显示，不能整页变白。

import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Markdown } from '../src/components/Markdown.tsx';

vi.mock('../src/components/MarkdownBody.tsx', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/MarkdownBody-old.js');
});

it('渲染部分加载失败：显示原文，旁边的内容还在', async () => {
  const div = document.createElement('div');
  const errors: unknown[] = [];
  const root = createRoot(div, { onUncaughtError: (e) => errors.push(e), onCaughtError: () => {} });
  root.render(
    <main>
      <h1>任务页的其余部分</h1>
      <Markdown source="# 交付文档" />
    </main>,
  );
  await vi.waitFor(() => expect(div.querySelector('pre.plain-text')).not.toBeNull(), { timeout: 3000 });
  expect(div.querySelector('h1')?.textContent).toBe('任务页的其余部分');
  expect(div.querySelector('pre.plain-text')?.textContent).toBe('# 交付文档');
  expect(errors).toEqual([]);
  root.unmount();
});
