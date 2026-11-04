// 领域与镜像。领域只决定分支容器用哪个镜像，每个领域在仓库 domains/ 下占一个目录，
// 放 Dockerfile 和一句描述（description.txt）；加领域就加目录，不进设置页。几个领域镜像都从同一个基础镜像
// （domains/_base/，下划线开头的目录不是领域）构建，共用底层。部署可用 MELINA_DOMAINS_DIR 指定独立维护的领域目录。
//
// 镜像按内容打标签：基础镜像 localhost/melina-base:<基础目录的哈希>，领域镜像 localhost/melina-<领域>:<基础和领域目录合起来的哈希>。
// 改了 Dockerfile 标签就变，启动时 checkImages 发现新标签的镜像不在，提示先跑 pnpm images（domains/build.ts）。

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { invalid, MelinaError } from '../core/errors.ts';
import { type Engine, runEngine } from './container.ts';

/** 默认使用仓库里的 domains/；部署时可显式指定外部配方目录。 */
export const DOMAINS_DIR = process.env.MELINA_DOMAINS_DIR
  ? resolve(process.env.MELINA_DOMAINS_DIR)
  : fileURLToPath(new URL('../../domains/', import.meta.url));
export const BASE_DIR = '_base';
export const DESCRIPTION_FILE = 'description.txt';
/** 本地镜像的名字前缀；localhost/ 让 podman 和 docker 都不去远端拉 */
export const IMAGE_PREFIX = 'localhost/melina-';

export interface DomainInfo {
  name: string;
  /** 一句描述：给 Scoper 选领域用 */
  description: string;
  dir: string;
}

/** 列出领域：domains/ 下有 Dockerfile、名字不以下划线或点开头的目录 */
export function listDomains(root = DOMAINS_DIR): DomainInfo[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .filter((e) => existsSync(join(root, e.name, 'Dockerfile')))
    .map((e) => {
      const dir = join(root, e.name);
      const descPath = join(dir, DESCRIPTION_FILE);
      const description = existsSync(descPath) ? readFileSync(descPath, 'utf8').trim() : '';
      return { name: e.name, description, dir };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 一个目录的内容哈希（sha256，十六进制）：按相对路径排序，算进路径、可执行位和内容。
 * description.txt 不算：改描述不用重建镜像。
 */
export function contentHash(dir: string): string {
  const hash = createHash('sha256');
  for (const file of listFiles(dir)) {
    const rel = relative(dir, file).split(sep).join('/');
    if (rel === DESCRIPTION_FILE) continue;
    // Git 只记录属主的执行位；ACL 的 mask 可能让 group 看起来可执行，不能因此把同一份源码算成另一个镜像。
    const executable = (statSync(file).mode & 0o100) !== 0;
    hash.update(`${rel}\0${executable ? 'x' : '-'}\0`);
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 领域到镜像名的对应，哈希在第一次用到时算，之后缓存（进程运行中改了 Dockerfile 要重启才认） */
export class DomainImages {
  readonly root: string;
  #baseHash: string | undefined;
  readonly #tags = new Map<string, string>();

  constructor(root = DOMAINS_DIR) {
    this.root = root;
  }

  domains(): DomainInfo[] {
    return listDomains(this.root);
  }

  baseImage(): string {
    return `${IMAGE_PREFIX}base:${this.#base().slice(0, 12)}`;
  }

  /** 领域的镜像名；没有这个领域抛 invalid */
  imageFor(domain: string): string {
    let image = this.#tags.get(domain);
    if (image) return image;
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(domain) || domain.startsWith('_')) throw invalid(`领域名不合法：${domain}`);
    const dir = join(this.root, domain);
    if (!existsSync(join(dir, 'Dockerfile')))
      throw invalid(`没有这个领域：${domain}（domains/ 下没有 ${domain}/Dockerfile）`);
    const tag = createHash('sha256').update(this.#base()).update('\0').update(contentHash(dir)).digest('hex');
    image = `${IMAGE_PREFIX}${domain}:${tag.slice(0, 12)}`;
    this.#tags.set(domain, image);
    return image;
  }

  #base(): string {
    if (!this.#baseHash) {
      const dir = join(this.root, BASE_DIR);
      if (!existsSync(join(dir, 'Dockerfile'))) throw invalid(`缺少基础镜像的 Dockerfile：${join(dir, 'Dockerfile')}`);
      this.#baseHash = contentHash(dir);
    }
    return this.#baseHash;
  }
}

// ── 构建（pnpm images，domains/build.ts） ─────────────────────────────────

export interface BuildReport {
  /** 领域名；基础镜像是 _base */
  name: string;
  image: string;
  /** 这次新建的；false 是已经有了、跳过 */
  built: boolean;
  /** 镜像总大小（含底层），字节 */
  sizeBytes?: number;
}

export interface BuildOptions {
  engine: Engine;
  images: DomainImages;
  /** 只建这几个领域；不给就全部 */
  domains?: readonly string[];
  /** 已经有了也重建 */
  force?: boolean;
  /** 构建过程的输出，默认 process.stderr */
  progress?: Writable;
}

/** 先建基础镜像，再建各领域镜像；按内容打的标签已经有了就跳过 */
export async function buildImages(options: BuildOptions): Promise<BuildReport[]> {
  const { engine, images } = options;
  const progress = options.progress ?? process.stderr;
  const names = options.domains?.length ? [...options.domains] : images.domains().map((d) => d.name);
  const base = images.baseImage();
  const reports = [await buildOne(engine, '_base', base, join(images.root, BASE_DIR), [], options.force, progress)];
  for (const name of names) {
    const image = images.imageFor(name);
    reports.push(
      await buildOne(
        engine,
        name,
        image,
        join(images.root, name),
        ['--build-arg', `BASE=${base}`],
        options.force,
        progress,
      ),
    );
  }
  return reports;
}

/** 删掉不是当前标签的 Melina 镜像（Dockerfile 改过以后留下的旧版本）；还有容器在用的删不掉，跳过 */
export async function pruneImages(engine: Engine, images: DomainImages): Promise<string[]> {
  const keep = new Set([images.baseImage(), ...images.domains().map((d) => images.imageFor(d.name))]);
  const r = await runEngine(engine, ['images', '--format', '{{.Repository}}:{{.Tag}}']);
  if (r.code !== 0) throw new MelinaError('internal', `列镜像失败：${r.stderr.trim()}`);
  const stale = [...new Set(r.stdout.split('\n').map((s) => s.trim()))].filter(
    (s) => s.startsWith(IMAGE_PREFIX) && !keep.has(s),
  );
  const removed: string[] = [];
  for (const image of stale) if ((await runEngine(engine, ['rmi', image])).code === 0) removed.push(image);
  return removed;
}

export async function imageExists(engine: Engine, image: string): Promise<boolean> {
  return (await runEngine(engine, ['image', 'inspect', '--format', '{{.Id}}', image])).code === 0;
}

export async function imageSize(engine: Engine, image: string): Promise<number | undefined> {
  const r = await runEngine(engine, ['image', 'inspect', '--format', '{{.Size}}', image]);
  const size = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(size) && size > 0 ? size : undefined;
}

async function buildOne(
  engine: Engine,
  name: string,
  image: string,
  dir: string,
  extra: string[],
  force: boolean | undefined,
  progress: Writable,
): Promise<BuildReport> {
  if (!force && (await imageExists(engine, image))) {
    return { name, image, built: false, sizeBytes: await imageSize(engine, image) };
  }
  progress.write(`\n== 构建 ${image}（${name}）\n`);
  const args = ['build', '-t', image, '--label', 'melina.managed=1', '--label', `melina.domain=${name}`, ...extra];
  const proc = engine.spawn([...args, '-f', join(dir, 'Dockerfile'), dir]);
  proc.stdout.pipe(progress, { end: false });
  proc.stderr.pipe(progress, { end: false });
  const code = await proc.closed;
  if (code !== 0) throw new MelinaError('internal', `构建 ${image} 失败（退出码 ${code}），输出见上面`);
  return { name, image, built: true, sizeBytes: await imageSize(engine, image) };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
