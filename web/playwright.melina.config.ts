// 前端接真后端的端到端测试：对着演示模式的真 Melina（e2e-melina/melina.ts 起 test/dev/demo.ts）在 Chromium 里点。
// 模型按剧本走，别的（存储、运行时、会话、HTTP、SSE、交付）都是真的。先 pnpm build（pnpm e2e:melina 会先打包）。
// 和 playwright.config.ts（假后端）分开：那边测页面的每种画法，这边测接上真 Melina 以后人做的事走不走得通。

import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const chromium = process.env.MELINA_CHROMIUM ?? '/usr/bin/chromium';

export default defineConfig({
  testDir: 'e2e-melina',
  outputDir: 'test-results-melina',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    launchOptions: existsSync(chromium) ? { executablePath: chromium } : {},
    trace: 'retain-on-failure',
  },
});
