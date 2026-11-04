// 开发时把假后端挂进 Vite：pnpm dev 一条命令就有页面和 /api。连真的 Melina 时不用它（见 vite.config.ts）。

import type { Connect, Plugin } from 'vite';
import { createFakeHandler } from './http.ts';
import { FakeMelina, type FakeOptions } from './melina.ts';

export function fakeMelina(options: FakeOptions = {}): Plugin {
  let melina: FakeMelina | undefined;
  const mount = (middlewares: Connect.Server) => {
    melina ??= new FakeMelina(options);
    const handle = createFakeHandler(melina);
    middlewares.use((req, res, next) => {
      handle(req, res).then((done) => {
        if (!done) next();
      }, next);
    });
  };
  return {
    name: 'melina-fake-backend',
    configureServer(server) {
      mount(server.middlewares);
      server.httpServer?.once('close', () => melina?.close());
      server.config.logger.info(`  ➜  /api：假后端按 direct 剧本回放（倍速 ${options.speed ?? 5}）`);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}
