// 跑分前的自检：分支容器连不连得上仿真环境。
// 在 0.0.0.0 上起一个只回 pong 的实例，用 Melina 的 general 镜像起临时容器 curl 它，挨个试几个宿主机地址，打出能用的那个：
//   node test/sim/preflight.ts                      # 试 host.containers.internal、host.docker.internal 和本机的局域网地址
//   node test/sim/preflight.ts --public-host 10.0.0.5 --image docker.io/library/alpine
// Melina 的容器用默认网络；进程入口给 PodmanRuntime 配了 network 的话，这里也传 --network 一样的值。
// 能用的地址交给跑分脚本的 --sim-host。这台开发机起不了容器，这个脚本没在真引擎上跑过。

import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { detectEngine, runEngine } from '../../src/tools/container.ts';
import { DomainImages, imageExists } from '../../src/tools/container-images.ts';
import { json } from './kit/http.ts';
import { SimServer } from './server.ts';

const { values } = parseArgs({
  options: {
    'public-host': { type: 'string', multiple: true },
    host: { type: 'string', default: '0.0.0.0' },
    image: { type: 'string' },
    network: { type: 'string' }, // Melina 的容器运行时配了 network（PodmanRuntime 的 network 选项）就传一样的
  },
});

const engine = detectEngine();
if (!engine) {
  console.error('找不到容器引擎（podman 或 docker）；MELINA_CONTAINER_ENGINE 可以指定');
  process.exit(1);
}
const image = values.image ?? new DomainImages().imageFor('general');
if (!(await imageExists(engine, image))) {
  console.error(`镜像 ${image} 不在，先 pnpm images general，或者用 --image 指定一个带 curl 的镜像`);
  process.exit(1);
}

const server = new SimServer({ host: values.host });
await server.start();
const env = server.mount({ handle: () => json(200, { pong: true }) });
const candidates = values['public-host'] ?? ['host.containers.internal', 'host.docker.internal', ...lanAddresses()];
let found: string | undefined;
for (const host of candidates) {
  const url = `${server.urlFor(env.token, host)}/`;
  const network = values.network ? ['--network', values.network] : [];
  const res = await runEngine(engine, ['run', '--rm', ...network, image, 'curl', '-fsS', '--max-time', '5', url], {
    timeoutMs: 60_000,
  }).catch((e: unknown) => ({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) }));
  const ok = res.code === 0 && res.stdout.includes('"pong"');
  console.log(
    `${ok ? '通' : '不通'}  ${host}${ok ? '' : `：${(res.stderr || res.stdout).trim().split('\n').pop() ?? ''}`}`,
  );
  if (ok) {
    found = host;
    break;
  }
}
await server.close();
if (!found) {
  console.error(
    '容器里一个地址都连不上：看看防火墙、引擎的网络模式（pasta、slirp4netns），或者用 --public-host 再试别的地址',
  );
  process.exit(1);
}
console.log(`跑分时用：--sim-bind ${values.host} --sim-host ${found}`);

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
