// 领域与镜像：列领域、按内容打标签（改 Dockerfile 标签就变、改描述不变）、先建基础镜像再建领域镜像、删旧标签。
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_GLOBAL_CONFIG } from '../../../src/core/config.ts';
import { isMelinaError } from '../../../src/core/errors.ts';
import {
  BASE_DIR,
  buildImages,
  contentHash,
  DOMAINS_DIR,
  DomainImages,
  listDomains,
  pruneImages,
} from '../../../src/tools/container-images.ts';
import { FakeEngine } from './fake-engine.ts';

const root = mkdtempSync(join(tmpdir(), 'melina-domains-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function copyOfRepoDomains(): string {
  const dir = mkdtempSync(join(root, 'copy-'));
  cpSync(DOMAINS_DIR, dir, { recursive: true });
  return dir;
}

describe('仓库里的 domains/', () => {
  it('包含默认领域和可选 CTF，都有一句描述；_base 不是领域', () => {
    const domains = listDomains();
    expect(DEFAULT_GLOBAL_CONFIG.domains).toEqual(['code', 'research', 'general']);
    expect(domains.map((d) => d.name)).toEqual([...DEFAULT_GLOBAL_CONFIG.domains, 'ctf'].sort());
    for (const d of domains) {
      expect(d.description.length, d.name).toBeGreaterThan(10);
      expect(d.description).not.toContain('\n');
    }
  });

  it('领域镜像使用 Melina 的初始化进程，CTF 从基础镜像复制到原生 Kali', async () => {
    const { readFileSync } = await import('node:fs');
    for (const d of listDomains()) {
      const lines = readFileSync(join(d.dir, 'Dockerfile'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'));
      if (d.name === 'ctf') {
        expect(lines.slice(0, 2)).toEqual(['ARG BASE', `FROM \${BASE} AS melina-base`]);
        expect(lines[2]).toMatch(
          /^FROM --platform=linux\/amd64 docker\.io\/kalilinux\/kali-rolling@sha256:[a-f0-9]{64}$/,
        );
        expect(lines).toContain('COPY --from=melina-base /usr/bin/tini /usr/bin/tini');
        expect(lines.filter((l) => /^(ENTRYPOINT|CMD)\b/.test(l))).toEqual([
          'ENTRYPOINT ["/usr/bin/tini", "--"]',
          'CMD ["sleep", "infinity"]',
        ]);
        continue;
      }
      expect(lines.slice(0, 2), d.name).toEqual(['ARG BASE', `FROM \${BASE}`]);
      expect(
        lines.some((l) => /^(ENTRYPOINT|CMD)\b/.test(l)),
        `${d.name} 不该改 ENTRYPOINT、CMD`,
      ).toBe(false);
    }
    const base = readFileSync(join(DOMAINS_DIR, BASE_DIR, 'Dockerfile'), 'utf8');
    expect(base).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(base).toContain('CMD ["sleep", "infinity"]');
  });

  it('镜像名：localhost/melina-<领域>:<12 位哈希>，各领域不同', () => {
    const images = new DomainImages();
    const names = listDomains().map((d) => images.imageFor(d.name));
    for (const n of names) expect(n).toMatch(/^localhost\/melina-[a-z]+:[0-9a-f]{12}$/);
    expect(new Set(names).size).toBe(names.length);
    expect(images.baseImage()).toMatch(/^localhost\/melina-base:[0-9a-f]{12}$/);
  });
});

describe('contentHash 和标签', () => {
  it('内容、文件名、可执行位变了哈希就变；description.txt 不算', () => {
    const dir = mkdtempSync(join(root, 'hash-'));
    writeFileSync(join(dir, 'Dockerfile'), 'FROM x\n');
    writeFileSync(join(dir, 'description.txt'), '一句描述\n');
    const h1 = contentHash(dir);
    writeFileSync(join(dir, 'description.txt'), '换了一句描述\n');
    expect(contentHash(dir)).toBe(h1);
    writeFileSync(join(dir, 'setup.sh'), 'echo hi\n');
    const h2 = contentHash(dir);
    expect(h2).not.toBe(h1);
    chmodSync(join(dir, 'setup.sh'), 0o755);
    expect(contentHash(dir)).not.toBe(h2);
  });

  it('ACL 的 group 执行位不改变 Git 里的文件模式和镜像标签', () => {
    const dir = mkdtempSync(join(root, 'acl-'));
    const file = join(dir, 'Dockerfile');
    writeFileSync(file, 'FROM x\n');
    chmodSync(file, 0o644);
    const hash = contentHash(dir);
    chmodSync(file, 0o674);
    expect(contentHash(dir)).toBe(hash);
    chmodSync(file, 0o774);
    expect(contentHash(dir)).not.toBe(hash);
  });

  it('改了基础镜像，所有领域镜像的标签都变；只改一个领域，别的不变', () => {
    const dir = copyOfRepoDomains();
    const before = new DomainImages(dir);
    const tags = { code: before.imageFor('code'), research: before.imageFor('research') };
    writeFileSync(join(dir, 'code', 'Dockerfile'), `ARG BASE\nFROM \${BASE}\nRUN true\n`);
    const afterCode = new DomainImages(dir);
    expect(afterCode.imageFor('code')).not.toBe(tags.code);
    expect(afterCode.imageFor('research')).toBe(tags.research);
    writeFileSync(join(dir, BASE_DIR, 'Dockerfile'), 'FROM docker.io/library/ubuntu:24.04\n');
    const afterBase = new DomainImages(dir);
    expect(afterBase.imageFor('research')).not.toBe(tags.research);
  });

  it('没有的领域、不合法的名字抛 invalid', () => {
    const images = new DomainImages();
    for (const bad of ['nope', '_base', '../etc', 'Code']) {
      try {
        images.imageFor(bad);
        throw new Error(`应该拒绝 ${bad}`);
      } catch (e) {
        expect(isMelinaError(e) && e.code === 'invalid', bad).toBe(true);
      }
    }
  });
});

describe('buildImages、pruneImages', () => {
  it('先建基础镜像，再建领域镜像（传 BASE）；已经有的跳过，--force 重建', async () => {
    const engine = new FakeEngine();
    const images = new DomainImages();
    const progress = new PassThrough();
    progress.resume();
    const reports = await buildImages({ engine, images, progress });
    expect(reports.map((r) => [r.name, r.built])).toEqual([
      ['_base', true],
      ['code', true],
      ['ctf', true],
      ['general', true],
      ['research', true],
    ]);
    const builds = engine.callsOf('build');
    expect(builds[0]).toContain(images.baseImage());
    expect(builds[0]?.at(-1)).toBe(join(DOMAINS_DIR, BASE_DIR));
    expect(builds[1]?.join(' ')).toContain(`--build-arg BASE=${images.baseImage()}`);
    expect(builds[1]?.join(' ')).toContain(`-t ${images.imageFor('code')}`);
    expect(reports.every((r) => r.sizeBytes === 1024 ** 3)).toBe(true);

    const again = await buildImages({ engine, images, progress, domains: ['code'] });
    expect(again.map((r) => r.built)).toEqual([false, false]);
    expect(engine.callsOf('build')).toHaveLength(5);
    await buildImages({ engine, images, progress, domains: ['code'], force: true });
    expect(engine.callsOf('build')).toHaveLength(7);
  });

  it('只删旧标签的 Melina 镜像', async () => {
    const engine = new FakeEngine();
    const images = new DomainImages();
    const current = [
      images.baseImage(),
      images.imageFor('code'),
      images.imageFor('ctf'),
      images.imageFor('general'),
      images.imageFor('research'),
    ];
    for (const i of current) engine.images.add(i);
    engine.images.add('localhost/melina-code:000000000000');
    engine.images.add('docker.io/library/ubuntu:24.04');
    expect(await pruneImages(engine, images)).toEqual(['localhost/melina-code:000000000000']);
    expect([...engine.images].sort()).toEqual([...current, 'docker.io/library/ubuntu:24.04'].sort());
  });
});

describe('临时的领域目录', () => {
  it('部署显式选择外部目录，领域列表和镜像标签使用同一份配方', () => {
    const dir = copyOfRepoDomains();
    mkdirSync(join(dir, 'alpha'));
    writeFileSync(join(dir, 'alpha', 'Dockerfile'), `ARG BASE\nFROM \${BASE}\n`);
    writeFileSync(join(dir, 'alpha', 'description.txt'), '独立目录中的可选领域\n');
    const module = new URL('../../../src/tools/container-images.ts', import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { DomainImages, listDomains } = await import(${JSON.stringify(module)});
        const images = new DomainImages();
        console.log(JSON.stringify({
          root: images.root,
          domains: listDomains().map(d => d.name),
          image: images.imageFor('alpha'),
          builtin: new DomainImages(${JSON.stringify(DOMAINS_DIR)}).imageFor('general'),
        }));`,
      ],
      { encoding: 'utf8', env: { ...process.env, MELINA_DOMAINS_DIR: dir } },
    );
    expect(JSON.parse(output)).toEqual({
      root: dir,
      domains: ['alpha', 'code', 'ctf', 'general', 'research'],
      image: new DomainImages(dir).imageFor('alpha'),
      builtin: new DomainImages().imageFor('general'),
    });
  });

  it('没有 Dockerfile 的目录、下划线和点开头的目录都不算领域', () => {
    const dir = mkdtempSync(join(root, 'list-'));
    for (const d of ['_base', 'alpha', '.hidden', '_private', 'empty']) mkdirSync(join(dir, d));
    for (const d of ['_base', 'alpha', '.hidden', '_private']) writeFileSync(join(dir, d, 'Dockerfile'), 'FROM x\n');
    expect(listDomains(dir).map((d) => d.name)).toEqual(['alpha']);
    expect(listDomains(join(dir, 'missing'))).toEqual([]);
  });
});
