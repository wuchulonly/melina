// pnpm images：构建领域镜像。
// 先建基础镜像（domains/_base），再建各领域镜像，都按内容打标签，已经有的跳过；改了 Dockerfile 再跑一遍就行。
//
// 用法：pnpm images [--force] [--prune] [领域…]
//   --force  已经有了也重建
//   --prune  建完删掉旧标签的 Melina 镜像（Dockerfile 改过以后留下的）
// 容器引擎默认找 PATH 里的 podman，再找 docker；也可以用环境变量 MELINA_CONTAINER_ENGINE 指定。

import { detectEngine } from '../src/tools/container.ts';
import { buildImages, DomainImages, pruneImages } from '../src/tools/container-images.ts';

const args = process.argv.slice(2);
const force = args.includes('--force');
const prune = args.includes('--prune');
const domains = args.filter((a) => !a.startsWith('--'));

const engine = detectEngine();
if (!engine) {
  console.error('没找到容器引擎：先装 rootless podman（或 docker），也可以用环境变量 MELINA_CONTAINER_ENGINE 指定。');
  process.exit(1);
}

const images = new DomainImages();
try {
  const reports = await buildImages({ engine, images, domains, force });
  const base = reports.find((r) => r.name === '_base')?.sizeBytes ?? 0;
  console.log(`\n${engine.kind} 里的 Melina 镜像：`);
  for (const r of reports) {
    const extra = r.name !== '_base' && r.sizeBytes && base ? `，比基础镜像多 ${gb(r.sizeBytes - base)}` : '';
    console.log(`  ${r.name.padEnd(9)} ${r.image}  ${r.built ? '新建' : '已有'}  共 ${gb(r.sizeBytes)}${extra}`);
  }
  if (prune) {
    const removed = await pruneImages(engine, images);
    console.log(removed.length > 0 ? `删掉了旧镜像：${removed.join('、')}` : '没有要删的旧镜像');
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function gb(bytes: number | undefined): string {
  return bytes === undefined ? '大小未知' : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
