// Playwright 冒烟测试：先打包，再用假后端（fake/server.ts，剧本停住不放）托管打包好的页面，在真浏览器里点一遍。
// 浏览器默认用系统装的 Chromium（MELINA_CHROMIUM 可以换），不另外下载；没有就用 Playwright 自己的。
// MELINA_SCREENSHOTS=1 时顺带把每个页面截图存进 screenshots/。

import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.MELINA_E2E_PORT ?? 5180);
const chromium = process.env.MELINA_CHROMIUM ?? '/usr/bin/chromium';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    launchOptions: existsSync(chromium) ? { executablePath: chromium } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js build && node fake/server.ts --port ${port} --speed 0 --static dist`,
    url: `http://127.0.0.1:${port}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
