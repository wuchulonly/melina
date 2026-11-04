import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { MelinaContainers } from '../../src/api/assemble.ts';
import { melinaRuntime } from '../../src/api/runtime.ts';
import { startServer } from '../../src/cli.ts';
import { brainProvider, HostContainers, MODELS } from '../integration/m0/kit.ts';
import { demoBrain } from './demo/story.ts';

export interface DemoOptions {
  port: number;
  /** 数据目录；不给就新建一个临时的，stop 时删掉 */
  data?: string;
  /** 前端打包出来的 dist；没有就只有接口 */
  web?: string;
  /** 模型每一步想多久（毫秒） */
  pace: number;
  log?: (text: string) => void;
}

export interface Demo {
  url: string;
  home: string;
  stop(): Promise<void>;
}

export async function startDemo(options: DemoOptions): Promise<Demo> {
  const temp = options.data === undefined;
  const home = temp ? mkdtempSync(join(tmpdir(), 'melina-demo-')) : resolve(options.data as string);
  const log = options.log ?? ((text: string) => console.warn(`[演示] ${text}`));
  const brain = demoBrain({ pace: options.pace });
  const { provider } = brainProvider(() => brain);
  const containers = new HostContainers({ root: join(home, 'host') });
  const assemble = melinaRuntime({ extensions: [] });

  const { stop } = await startServer(
    { port: options.port, home, ...(options.web && existsSync(options.web) ? { web: options.web } : {}) },
    {
      models: MODELS,
      internals: {
        containers: containers as unknown as MelinaContainers,
        modelProviders: [provider],
        log: { warn: log, error: (m, e) => log(`${m} ${e instanceof Error ? e.message : (e ?? '')}`) },
        runtime: assemble,
      },
    },
  );

  let stopping: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${options.port}`,
    home,
    stop: () => {
      stopping ??= (async () => {
        await stop();
        for (const c of containers.containers.values()) await containers.stop(c.ref);
        if (temp) rmSync(home, { recursive: true, force: true });
      })();
      return stopping;
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '8485' },
      data: { type: 'string' },
      web: { type: 'string' },
      pace: { type: 'string', default: '1500' },
    },
  });
  const web = resolve(values.web ?? fileURLToPath(new URL('../../web/dist', import.meta.url)));
  const demo = await startDemo({
    port: Number(values.port),
    pace: Number(values.pace),
    web,
    ...(values.data !== undefined ? { data: values.data } : {}),
  });
  console.log(`Melina 演示模式在运行：${demo.url}`);
  console.log('模型按剧本走（不用 key、不花钱），命令用这台机器上的 bash 跑，只碰 workspace 里的 demo/。');
  console.log('随便写一个目标建任务，看三路持续会话和执行记录。');
  console.log(`数据目录：${demo.home}${values.data === undefined ? '（退出时删掉）' : ''}`);
  if (!existsSync(web)) console.log('前端还没打包（pnpm --dir web build），现在只有 HTTP 接口能用');

  // 第一次收到信号就停下（删掉临时数据目录）；正在停的时候再按一次 Ctrl+C 直接退出。
  // 再来的 SIGTERM 不理：pnpm dev 退出时 Vite 和终端可能各发一次，不能因此跳过清理
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      if (signal === 'SIGINT') process.exit(1);
      return;
    }
    stopping = true;
    console.log('正在停下……（再按一次 Ctrl+C 直接退出）');
    demo.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
