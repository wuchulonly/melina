// 崩溃恢复集成测试的子进程（node 直接跑这个 .ts）：真的 RunStore（SQLite 文件）和真的 DirCopy workspace，
// 假的 Explorer 第一个 episode 写 a.txt 正常收尾，第二个 episode 写 b.txt、记一条 shell 意图，然后打印 READY 等着被 kill -9。
// 用法：node crash-child.ts <数据目录>，数据目录下要有 project/（工作目录）。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock } from '../../../src/api/data-lock.ts';
import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig } from '../../../src/core/config.ts';
import type { Branch } from '../../../src/core/types.ts';
import { createKernel } from '../../../src/runtime/runtime.ts';
import { createScheduler } from '../../../src/runtime/scheduler.ts';
import { openRunStore } from '../../../src/storage/state.ts';
import { createWorkspaceProviders } from '../../../src/workspace/provider.ts';
import {
  COMPLETION,
  closes,
  FakeEnv,
  FakeExplorer,
  FakeGateway,
  FakeScoper,
  fakeAssembler,
  registry,
} from '../../unit/runtime/kit.ts';

const ACT_ID = '01J0000000000000000000ACT9';

const dir = process.argv[2];
if (!dir) throw new Error('要给数据目录');
// 和 Melina 一样，先拿数据目录的锁再打开库（api/data-lock.ts）；被 kill -9 时锁文件留在那里
acquireLock(join(dir, 'data', 'melina.lock'));
const store = openRunStore({ db: join(dir, 'melina.db'), artifacts: join(dir, 'artifacts') });
const artifacts = store.artifacts as NonNullable<typeof store.artifacts>;
const global: GlobalConfig = { ...DEFAULT_GLOBAL_CONFIG, limits: { modelCalls: {}, toolExec: 2, diskFreeMin: 0 } };
const explorer = new FakeExplorer(store);
explorer.on(
  '主干直解路线',
  (ctx) => {
    writeFileSync(join(ctx.input.branch.workspace?.path as string, 'a.txt'), '第一步\n');
    ctx.observe('写了 a.txt');
    return ctx.done(closes.end({ handoff: '写 b.txt，再部署' }));
  },
  (ctx) => {
    writeFileSync(join(ctx.input.branch.workspace?.path as string, 'b.txt'), '第二步，没做完\n');
    ctx.observe('写了 b.txt');
    const b = store.queries.getBranch(ctx.input.branch.id) as Branch;
    store.writer.appendShIntent(b.runId, {
      id: ACT_ID,
      branchId: b.id,
      episode: b.episode,
      cmd: 'curl -X POST https://deploy.example.com/release',
      expect: '返回 200，新版本上线',
    });
    process.stdout.write(`READY ${b.runId} ${b.id}\n`);
    return ctx.untilAborted();
  },
);

const runtime = createKernel({
  writer: store.writer,
  queries: store.queries,
  bus: store.bus,
  artifacts,
  workspaces: createWorkspaceProviders({ dataDir: join(dir, 'data'), artifacts }),
  gateway: new FakeGateway(),
  assembler: fakeAssembler(store),
  explorer,
  scoper: new FakeScoper(),
  registry,
  config: { global: () => global, credentials: () => [] },
  scheduler: createScheduler({ limits: () => global.limits, cpus: () => 2 }),
  dataDir: join(dir, 'data'),
  env: new FakeEnv(),
  log: (t) => process.stderr.write(`[子进程] ${t}\n`),
});
await runtime.recovery.run();
await runtime.start();
await runtime.runs.create({
  statement: '在工作目录里加两个文件，再部署',
  materials: [],
  workspace: join(dir, 'project'),
  completion: COMPLETION,
  domain: 'code',
  config: { bet0: { copies: 1 }, continuation: { enabled: false } },
});
// 一直跑，等父进程 kill -9
setInterval(() => {}, 1000);
