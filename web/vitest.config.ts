// web 的单元测试：假后端、SSE 客户端、缓存、格式化、Markdown 消毒。浏览器里跑的冒烟测试在 e2e/（Playwright）。

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
