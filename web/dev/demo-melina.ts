// pnpm dev 时在旁边起一个演示模式的真 Melina（test/dev/demo.ts：模型按剧本走，别的都是真的），/api 转给它。
// 页面改了 Vite 热更新，后端是真的：建任务、看链长出来、回答、交付都能在开发服务器上走一遍，不用 key、不花钱。
// 用子进程起，不 import Melina 的代码（web/ 只通过 HTTP 访问 Melina， 模块规则）。

import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export interface DemoMelinaOptions {
  port: number;
  /** 模型每一步想多久（毫秒） */
  pace: number;
  /** 数据目录；不给就每次新建一个临时的，停下时删掉 */
  data?: string;
}

const DEMO = fileURLToPath(new URL('../../test/dev/demo.ts', import.meta.url));

export function demoMelina(options: DemoMelinaOptions): Plugin {
  let child: ChildProcess | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill('SIGTERM');
    child = undefined;
  };
  return {
    name: 'melina-demo-backend',
    configureServer(server) {
      const args = [DEMO, '--port', String(options.port), '--pace', String(options.pace)];
      if (options.data) args.push('--data', options.data);
      // 和 Vite 同一个进程组：终端里按 Ctrl+C 它自己也收到，停下并删掉临时数据目录（Vite 不处理 SIGINT，下面的 exit 不一定跑）；
      // 再收到这里补发的 SIGTERM 它不理（test/dev/demo.ts），不会跳过清理
      child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('exit', (code, signal) => {
        if (!stopping && (code !== 0 || signal !== null))
          server.config.logger.warn(`  演示模式的 Melina 退出了（${signal ?? code}），/api 连不上了：重启 pnpm dev`);
      });
      server.httpServer?.once('close', stop);
      process.once('exit', stop);
      server.config.logger.info(
        `  ➜  /api：演示模式的真 Melina（127.0.0.1:${options.port}，模型按剧本走）。用假后端：pnpm dev:fake`,
      );
    },
  };
}
