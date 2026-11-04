// pnpm dev：页面 + 演示模式的真 Melina（dev/demo-melina.ts 起 test/dev/demo.ts，/api 转给它）。
// pnpm dev:fake：页面 + 假后端（fake/，按 的剧本回放；e2e 测试也用它）。
// MELINA_API=http://127.0.0.1:<端口> pnpm dev：/api 转给已经在跑的 Melina（比如 melina serve、test/dev/serve.ts）。
// 转发时把 Origin 换成 Melina 自己的，不然 Melina 的 Host、Origin 校验会拒掉从开发服务器来的请求。

import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';
import { demoMelina } from './dev/demo-melina.ts';
import { fakeMelina } from './fake/vite-plugin.ts';

const DEMO_PORT = Number(process.env.MELINA_DEMO_PORT ?? 8485);

export default defineConfig(({ mode, command }) => {
  const fake = mode === 'fake';
  const external = process.env.MELINA_API;
  const target = external ?? `http://127.0.0.1:${DEMO_PORT}`;
  const proxy: Record<string, ProxyOptions> | undefined = fake
    ? undefined
    : { '/api': { target, changeOrigin: true, headers: { origin: new URL(target).origin } } };
  return {
    plugins: [
      react(),
      ...(fake
        ? [
            fakeMelina({
              speed: Number(process.env.MELINA_FAKE_SPEED ?? 5),
            }),
          ]
        : []),
      ...(!fake && !external && command === 'serve'
        ? [
            demoMelina({
              port: DEMO_PORT,
              pace: Number(process.env.MELINA_DEMO_PACE ?? 1500),
              ...(process.env.MELINA_DEMO_DATA ? { data: process.env.MELINA_DEMO_DATA } : {}),
            }),
          ]
        : []),
    ],
    server: {
      host: '127.0.0.1',
      port: 5173,
      ...(proxy ? { proxy } : {}),
    },
    preview: { host: '127.0.0.1', port: 4173 },
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: true,
    },
  };
});
