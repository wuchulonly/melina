// 开跑前把工作目录和附件里原有的密钥登记进打码表：
// git 仓库看抄进 local/ 的被忽略小文件，普通目录按文件名挑，附件都看；任务结束撤掉。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSecrets } from '../../../src/api/run-secrets.ts';
import { newId } from '../../../src/core/ids.ts';
import type { Run } from '../../../src/core/types.ts';
import { SecretRedactor } from '../../../src/tools/redact.ts';
import { runPaths } from '../../../src/workspace/layout.ts';
import { writeManifest } from '../../../src/workspace/local-files.ts';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function runOf(over: { kind: 'git-clone' | 'dir-copy'; root: string; materials?: Run['goal']['materials'] }): Run {
  return {
    id: newId(),
    goal: { statement: '把测试跑通', constraints: [], materials: over.materials ?? [] },
    workspace: { root: over.root, kind: over.kind },
  } as unknown as Run;
}

describe('任务的密钥进打码表', () => {
  it('git 仓库：抄进 local/ 的被忽略小文件（.env）；附件；结束时撤掉', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-run-secrets-'));
    const dataDir = join(dir, 'data');
    const material = join(dir, 'kubeconfig.yaml');
    writeFileSync(material, 'users:\n- name: admin\n  user:\n    token: k8s-token-0123456789abcdef\n');
    const run = runOf({
      kind: 'git-clone',
      root: join(dir, 'repo'),
      materials: [{ name: 'kubeconfig.yaml', handle: 'art://x' as never }],
    });
    const paths = runPaths(dataDir, run.id);
    mkdirSync(paths.local, { recursive: true });
    writeFileSync(join(paths.local, '.env'), 'PORT=3000\nOPENAI_API_KEY=sk-test-abcdefghijklmnopqrstuvwx\n');
    await writeManifest(paths.dir, { files: ['.env'], skipped: [] });
    const redactor = new SecretRedactor();
    const secrets = runSecrets({ dataDir, artifacts: { path: () => material }, redactor });

    expect(await secrets.add(run)).toBe(2);
    expect(redactor.redact('key=sk-test-abcdefghijklmnopqrstuvwx token=k8s-token-0123456789abcdef port=3000')).toBe(
      'key=[凭证「.env 里的 OPENAI_API_KEY」已隐藏] token=[凭证「附件 kubeconfig.yaml 里的 token」已隐藏] port=3000',
    );
    secrets.drop(run.id);
    expect(redactor.redact('sk-test-abcdefghijklmnopqrstuvwx')).toBe('sk-test-abcdefghijklmnopqrstuvwx');
  });

  it('git 仓库：原件的 .git/config 里远端地址带的口令也登记（它原样挂在 /melina/origin）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-run-secrets-'));
    const dataDir = join(dir, 'data');
    const root = join(dir, 'repo');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(
      join(root, '.git', 'config'),
      '[remote "origin"]\n\turl = https://x-access-token:ghs_0123456789abcdefghij0123456789@github.com/team/app.git\n',
    );
    const run = runOf({ kind: 'git-clone', root });
    mkdirSync(runPaths(dataDir, run.id).local, { recursive: true });
    await writeManifest(runPaths(dataDir, run.id).dir, { files: [], skipped: [] });
    const redactor = new SecretRedactor();
    expect(await runSecrets({ dataDir, artifacts: { path: () => '' }, redactor }).add(run)).toBe(1);
    expect(redactor.redact('url = https://x-access-token:ghs_0123456789abcdefghij0123456789@github.com')).toBe(
      'url = https://x-access-token:[凭证「.git/config 里的 URL 口令」已隐藏]@github.com',
    );
  });

  it('普通目录：按文件名挑像放密钥的文件', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-run-secrets-'));
    const root = join(dir, 'project');
    mkdirSync(join(root, 'conf'), { recursive: true });
    writeFileSync(join(root, '.env.local'), 'DB_PASSWORD=pg-pass-0123456789\n');
    writeFileSync(join(root, 'conf', 'notes.txt'), 'DB_PASSWORD=not-a-secret-file-123\n');
    const redactor = new SecretRedactor();
    const n = await runSecrets({ dataDir: join(dir, 'data'), artifacts: { path: () => '' }, redactor }).add(
      runOf({ kind: 'dir-copy', root }),
    );
    expect(n).toBe(1);
    expect(redactor.redact('pg-pass-0123456789 not-a-secret-file-123')).toBe(
      '[凭证「.env.local 里的 DB_PASSWORD」已隐藏] not-a-secret-file-123',
    );
  });
});

describe('交付前查 patch', () => {
  /** 一个文件的 git diff：新建的整个是加进来的，改了的只有一行加进来的 */
  const file = (path: string, created: boolean, lines: string[]) =>
    [
      `diff --git a/${path} b/${path}`,
      ...(created ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
    ].join('\n');

  it('新建的文件按 createdFileSecretsIn 认，改了的老文件只认一眼就是的；登记过的值不管新老都算；占位符原样写进文件的不算；只回在哪，不回值', () => {
    const redactor = new SecretRedactor();
    redactor.update([
      { id: newId(), name: 'GitHub token', as: { env: 'GH_TOKEN' }, value: 'gh-secret-value-0123456789' },
    ]);
    const secrets = runSecrets({ dataDir: '/nonexistent', artifacts: { path: () => '' }, redactor });
    const patch = [
      file('.token', true, ['4eb4a5b0f5f0b23777540b34e698c1fb']),
      file('probe.sh', true, ['TOKEN=4eb4a5b0f5f0b23777540b34e698c1fb', 'curl -H "Authorization: Bearer $TOKEN" …']),
      file('config.yaml', false, ['password: realpass-123456']),
      file('README.md', false, ['export GH_TOKEN=gh-secret-value-0123456789']),
      file('notes.md', true, ['登录时用的是 [凭证「GitHub token」已隐藏]']),
      file('answer.json', true, ['{"orders": 51, "total_cents": 11811371}']),
    ].join('\n');
    const leaks = secrets.leaksIn(patch);
    expect([...leaks].sort()).toEqual(
      ['.token 的整段内容', 'README.md 里的「GitHub token」', 'probe.sh 里的 TOKEN'].sort(),
    );
    for (const l of leaks) expect(l).not.toContain('4eb4a5b0');
    expect(secrets.leaksIn(file('answer.json', true, ['{"orders": 51}']))).toEqual([]);
  });

  it('新建的测试夹具、开发用的默认值不算泄露；脚本里写死的登录 token、新建的 .env、测试里出现登记过的值照样算', () => {
    const redactor = new SecretRedactor();
    redactor.update([
      { id: newId(), name: 'GitHub token', as: { env: 'GH_TOKEN' }, value: 'gh-secret-value-0123456789' },
    ]);
    const secrets = runSecrets({ dataDir: '/nonexistent', artifacts: { path: () => '' }, redactor });
    const harmless = [
      file('tests/test_login.py', true, ['def test_login():', '    password = "correct-horse-battery"']),
      file('tests/fixtures/users.json', true, ['[{"name": "alice", "password": "hunter2hunter2"}]']),
      file('src/auth.test.ts', true, ['const token = "test-token-0123456789abcdef";']),
      file('config/dev.yaml', true, ['debug: true', 'secret_key: dev-only-not-secret']),
    ].join('\n');
    expect(secrets.leaksIn(harmless)).toEqual([]);
    const leaks = secrets.leaksIn(
      [
        file('fetch_orders.py', true, ['_token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def456"']),
        file('.env', true, ['API_KEY=plain-value']),
        file('tests/test_gh.py', true, ['TOKEN = "gh-secret-value-0123456789"']),
      ].join('\n'),
    );
    expect([...leaks].sort()).toEqual(
      ['.env 里的 API_KEY', 'fetch_orders.py 里的 _token', 'tests/test_gh.py 里的「GitHub token」'].sort(),
    );
  });

  it('工作目录里本地库的默认口令（postgres:postgres）不登记：改动里出现 postgres 不算泄露，照常推分支', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-run-secrets-'));
    const root = join(dir, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, '.env'),
      'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\nPOSTGRES_PASSWORD=postgres\n',
    );
    const redactor = new SecretRedactor();
    const secrets = runSecrets({ dataDir: join(dir, 'data'), artifacts: { path: () => '' }, redactor });
    expect(await secrets.add(runOf({ kind: 'dir-copy', root }))).toBe(0);
    const patch = [
      file('docker-compose.yml', true, ['services:', '  db:', '    image: postgres:16-alpine']),
      file('README.md', false, ['psql postgres://postgres:postgres@localhost:5432/app']),
    ].join('\n');
    expect(secrets.leaksIn(patch)).toEqual([]);
  });
});
