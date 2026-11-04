// 工作目录和附件里原有的密钥：哪些值算密钥、按文件名挑普通目录里的文件。
// 交付前扫 patch：每个文件加进来的内容、名字像放 token 的文件、只看样子的那几条。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretRedactor } from '../../../src/tools/redact.ts';
import {
  addedInPatch,
  createdFileSecretsIn,
  gitConfigSecretsIn,
  obviousSecretsIn,
  secretFilesUnder,
  secretsIn,
  secretsInFile,
  tokenFileSecret,
} from '../../../src/tools/secret-scan.ts';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const values = (text: string, file = '.env') => secretsIn(text, file).map((s) => s.value);

describe('认得出的密钥', () => {
  it('.env：键名像密钥的值都算；键名不像、值像随机串的也算；端口、环境名、URL、布尔值不算', () => {
    const env = [
      'PORT=3000',
      'NODE_ENV=development',
      'API_TOKEN=tok-live-0123456789abcdef',
      'export DB_PASSWORD="hunter2-but-longer"',
      "STRIPE_KEY='rk_live_abcdefghijklmnop'",
      'SENTRY_DSN=https://abc123@o1.ingest.sentry.io/1',
      'FEATURE_FLAG=true',
      'BUILD_ID=a1b2c3d4e5f6a7b8c9d0e1f2',
      'APP_NAME=my-service',
      '# SECRET=commented-out-but-still-a-value',
    ].join('\n');
    const found = secretsIn(env, '.env');
    expect(found.map((s) => s.value)).toEqual(
      expect.arrayContaining(['tok-live-0123456789abcdef', 'hunter2-but-longer', 'rk_live_abcdefghijklmnop']),
    );
    expect(found.map((s) => s.value)).toContain('a1b2c3d4e5f6a7b8c9d0e1f2'); // .env 里的随机串
    for (const plain of ['3000', 'development', 'true', 'my-service', 'https://abc123@o1.ingest.sentry.io/1']) {
      expect(found.map((s) => s.value)).not.toContain(plain);
    }
    expect(found.find((s) => s.value === 'tok-live-0123456789abcdef')?.name).toBe('.env 里的 API_TOKEN');
  });

  it('不是 .env 的文件：只认键名像密钥的；auth、cookie 这类键名的值还得像随机串', () => {
    const yaml = [
      'database:',
      '  password: s3cretpassw0rd',
      '  host: db.internal.example.com',
      'cookie_domain: example.com',
    ];
    const json = '{ "apiKey": "abcdefgh12345678", "authUrl": "https://login.example.com", "sessionSecret": "x" }';
    expect(values(yaml.join('\n'), 'config.local.yaml')).toEqual(['s3cretpassw0rd']);
    expect(values(json, 'settings.json')).toEqual(['abcdefgh12345678']);
    expect(values('AUTH_HEADER=Bearer-a1b2c3d4e5f6g7h8i9', 'app.conf')).toEqual(['Bearer-a1b2c3d4e5f6g7h8i9']);
    expect(values('AUTH_MODE=oauth', 'app.conf')).toEqual([]);
  });

  it('键名按整段认：tokenizer、sort_key、PWD 的路径这类不遮；apiKey、client-secret、DB_PASS、ACCESS_KEY_ID 照样认', () => {
    const yaml = [
      'tokenizer: cl100k_base',
      'sort_key: created_at_timestamp',
      'cache_key: users-by-email',
      'PWD=/home/someone/project',
      'key_file: ./certs/server.pem',
      'max_tokens: 4096',
      'clientSecret: abcdefgh-ijkl-mnop',
      'client-secret: qrstuvwx-yz01-2345',
      'DB_PASS=hunter2-but-longer',
      'ACCESS_KEY_ID=AKIDEXAMPLE0001',
      'csrfToken: kjhgfdsa-poiu-ytre',
    ].join('\n');
    const found = values(yaml, 'config.local.yaml');
    expect(found.sort()).toEqual(
      [
        'abcdefgh-ijkl-mnop',
        'qrstuvwx-yz01-2345',
        'hunter2-but-longer',
        'AKIDEXAMPLE0001',
        'kjhgfdsa-poiu-ytre',
      ].sort(),
    );
    // 别的 *_key：值像随机串才算；.env 这类专放配置的文件里 *_KEY 都算
    expect(values('session_key: a1b2c3d4e5f6g7h8i9j0', 'app.yaml')).toEqual(['a1b2c3d4e5f6g7h8i9j0']);
    expect(values("STRIPE_KEY='rk_live_abcdefghijklmnop'", 'app.yaml')).toEqual([]);
    expect(values("STRIPE_KEY='rk_live_abcdefghijklmnop'", '.env')).toEqual(['rk_live_abcdefghijklmnop']);
  });

  it('URL 里的口令、PEM 私钥块、有固定前缀的 token：在哪儿出现都算', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0123456789\nabcdefghijk\n-----END RSA PRIVATE KEY-----';
    const text = [
      'DATABASE=postgres://app:Pa55w0rd-x@db:5432/app',
      pem,
      'echo ghp_abcdefghijklmnopqrstuvwxyz0123456789 > token.txt',
      'aws: AKIAABCDEFGHIJKLMNOP',
    ].join('\n');
    const found = values(text, 'notes.txt');
    expect(found).toEqual(
      expect.arrayContaining(['Pa55w0rd-x', pem, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP']),
    );
  });

  it('登记进打码表以后：输出里换成占位符，写明是哪个文件的哪个键', () => {
    const r = new SecretRedactor();
    r.hold('run:1', secretsIn('API_TOKEN=tok-live-0123456789abcdef\nPORT=3000', '.env'));
    expect(r.redact('API_TOKEN=tok-live-0123456789abcdef\nPORT=3000')).toBe(
      'API_TOKEN=[凭证「.env 里的 API_TOKEN」已隐藏]\nPORT=3000',
    );
    r.release('run:1');
    expect(r.redact('tok-live-0123456789abcdef')).toBe('tok-live-0123456789abcdef');
  });
});

/**
 *  拿结果已知的对照样例核出来的：已知是密钥的（照各家文档的格式）要认出，已知不是的（文档示例、占位、主机名、镜像、
 * 命令行参数）不认、不遮。测试里的 token 在运行时拼出来，源码里不写成一整串，免得被代码托管的密钥扫描当真
 */
describe('对照样例', () => {
  const fake = (prefix: string, n: number) => prefix + 'Ab3Kq9Zx7Pm2'.repeat(Math.ceil(n / 12)).slice(0, n);
  const obvious = (text: string, file: string) => obviousSecretsIn(text, file).map((s) => s.value);

  it('.npmrc 按仓库写的凭证、.netrc 的 password、PGP 私钥块：认得出', () => {
    const npm = fake('npm_', 36);
    expect(values(`//registry.npmjs.org/:_authToken=${npm}\nregistry=https://registry.npmjs.org/\n`, '.npmrc')).toEqual(
      [npm],
    );
    // 交付时新建的 .npmrc 也一样（专放配置的文件照全部规则认）；引用环境变量的不算
    expect(createdFileSecretsIn(`//npm.pkg.github.com/:_authToken=${npm}\n`, '.npmrc').map((s) => s.value)).toEqual([
      npm,
    ]);
    const fromEnv = `$${'{NPM_TOKEN}'}`; // 照抄 CI 脚本里的写法：${NPM_TOKEN}
    expect(values(`//registry.npmjs.org/:_authToken=${fromEnv}\n`, '.npmrc')).toEqual([]);
    const pass = 'Xy7pQ2rT9vLm4KsAa8';
    expect(values(`machine api.example.com\n  login deploy-bot\n  password ${pass}\n`, '.netrc')).toEqual([pass]);
    expect(values(`machine example.com login deploy-bot password ${pass}\n`, '.netrc')).toEqual([pass]);
    const pgp = [`-----BEGIN PGP ${'PRIVATE'} KEY BLOCK-----`, '', 'lQOYBF8abcdEFGH1234', '=AbCd'].join('\n');
    const block = `${pgp}\n-----END PGP ${'PRIVATE'} KEY BLOCK-----`;
    expect(obvious(block, 'keys/signing.asc')).toEqual([block]);
  });

  it('改老文件时只认一眼就是的：GitHub 的 ghu_、ghs_、ghr_，AWS 临时 key，Stripe 线上 key，npm token 也算', () => {
    const tokens = [
      fake('ghs_', 36),
      fake('ghu_', 36),
      fake('ghr_', 36),
      `${'AS'}IAY34FZKBOKMUTVV7A`,
      fake('sk_live_', 28),
      fake('rk_live_', 28),
      fake('npm_', 36),
    ];
    for (const token of tokens) expect(obvious(`token = "${token}"\n`, 'app/config.py'), token).toEqual([token]);
  });

  it('文档里的示例 key、README 里的占位不算泄露（以前交付因此只交 patch、不推分支）', () => {
    const example = `${'AK'}IAIOSFODNN7EXAMPLE`;
    const test = `client = boto3.client("s3", aws_access_key_id="${example}")\n`;
    expect(createdFileSecretsIn(test, 'tests/test_upload.py')).toEqual([]);
    expect(obvious(`export OPENAI_API_KEY=sk-${'x'.repeat(40)}\n`, 'README.md')).toEqual([]);
    expect(obvious(`export OPENAI_API_KEY=sk-proj-${'*'.repeat(30)}\n`, 'README.md')).toEqual([]);
    // 真的 key 照样认
    expect(obvious(`export OPENAI_API_KEY=${fake('sk-', 40)}\n`, 'README.md')).toEqual([fake('sk-', 40)]);
  });

  it('本地开发的 .env：主机名、镜像、命令行参数不是随机串，不登记，输出里也不遮；真随机串、JWT、连接串照样认', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'].join('.');
    const azure =
      'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==;EndpointSuffix=core.windows.net';
    const env = [
      'NODE_OPTIONS=--max-old-space-size=4096',
      'REDIS_HOST=redis-01.internal.example.com',
      'IMAGE=ghcr.io/acme/api:1.14.2',
      'BUILD_ID=a1b2c3d4e5f6a7b8c9d0e1f2',
      `SESSION_JWT=${jwt}`,
      `STORAGE=${azure}`,
    ].join('\n');
    const found = values(env);
    expect(found).toEqual(expect.arrayContaining(['a1b2c3d4e5f6a7b8c9d0e1f2', jwt, azure]));
    for (const plain of ['--max-old-space-size=4096', 'redis-01.internal.example.com', 'ghcr.io/acme/api:1.14.2']) {
      expect(found).not.toContain(plain);
    }
    const r = new SecretRedactor();
    r.hold('run:1', secretsIn(env, '.env'));
    for (const line of [
      'Error: getaddrinfo ENOTFOUND redis-01.internal.example.com',
      'node --max-old-space-size=4096 dist/server.js',
      'image: ghcr.io/acme/api:1.14.2',
    ]) {
      expect(r.redact(line)).toBe(line);
    }
  });
});

describe('猜得到的口令', () => {
  it('小写单词、和用户名一样的口令不登记，同名的角色、镜像、库名照常看得到；带数字、大写、符号的照样认', () => {
    const env = [
      'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app',
      'POSTGRES_PASSWORD=postgres',
      'MINIO_ROOT_PASSWORD=minioadmin',
      'APP_DB_URL=postgres://app_user:app_user@db:5432/app',
      'REDIS_URL=redis://default:Rd9-x2Lq@cache:6379',
      'ADMIN_PASSWORD=admin12345',
    ].join('\n');
    expect(secretsIn(env, '.env')).toEqual([
      { name: '.env 里的 ADMIN_PASSWORD', value: 'admin12345' },
      { name: '.env 里的 URL 口令', value: 'Rd9-x2Lq' },
    ]);
    const r = new SecretRedactor();
    r.hold('run:1', secretsIn(env, '.env'));
    for (const line of [
      'image: postgres:16-alpine',
      'FATAL:  role "postgres" does not exist',
      'GRANT ALL ON DATABASE app TO app_user;',
      'mc alias set local http://minio:9000 minioadmin minioadmin',
    ]) {
      expect(r.redact(line)).toBe(line);
    }
    expect(r.redact('redis-cli -a Rd9-x2Lq ping')).toBe('redis-cli -a [凭证「.env 里的 URL 口令」已隐藏] ping');
  });

  it('交付时也不当泄露：README 里的占位连接串、新建的 .env.example 里的默认口令', () => {
    expect(obviousSecretsIn('DATABASE_URL=postgresql://user:password@localhost:5432/mydb\n', 'README.md')).toEqual([]);
    expect(createdFileSecretsIn('DB_PASSWORD=changeme\nDB_USER=app\n', '.env.example')).toEqual([]);
    // 长的、混了别的字符的照样算
    expect(createdFileSecretsIn('DB_PASSWORD=correcthorsebatterystaple\n', '.env').map((s) => s.value)).toEqual([
      'correcthorsebatterystaple',
    ]);
  });
});

describe('文件', () => {
  it('普通目录按文件名挑（跳过依赖和构建目录）；读文件时太大、像二进制的跳过', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-secret-scan-'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, '.env'), 'API_TOKEN=tok-live-0123456789abcdef\n');
    writeFileSync(join(dir, 'config', 'credentials.json'), '{"password": "correct-horse-battery"}');
    writeFileSync(join(dir, 'node_modules', 'pkg', '.env'), 'API_TOKEN=should-not-be-read-1234567\n');
    writeFileSync(join(dir, 'README.md'), 'password: not-scanned-here-123\n');
    writeFileSync(join(dir, 'blob.key'), Buffer.from([0, 1, 2, 3]));
    expect((await secretFilesUnder(dir)).sort()).toEqual(['.env', 'blob.key', 'config/credentials.json']);
    expect((await secretsInFile(join(dir, 'blob.key'), 'blob.key')).length).toBe(0);
    expect((await secretsInFile(join(dir, 'config', 'credentials.json'), 'config/credentials.json'))[0]).toEqual({
      name: 'config/credentials.json 里的 password',
      value: 'correct-horse-battery',
    });
    expect(await secretsInFile(join(dir, 'missing'), 'missing')).toEqual([]);
  });

  it('普通目录一层一层看：前面一个大子目录看满了上限，根上和浅处的 .env 照样找得到', async () => {
    dir = mkdtempSync(join(tmpdir(), 'melina-secret-scan-'));
    mkdirSync(join(dir, 'aaa-data', 'deep'), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, 'aaa-data', 'deep', `f${i}.txt`), 'x');
    mkdirSync(join(dir, 'zzz-config'), { recursive: true });
    writeFileSync(join(dir, 'zzz-config', '.env'), 'API_TOKEN=tok-live-0123456789abcdef\n');
    writeFileSync(join(dir, 'zz.env'), 'API_TOKEN=tok-live-0123456789abcdef\n');
    // 上限 10：按层看，先看完根和第一层，深处的 40 个文件看不到也不要紧
    expect((await secretFilesUnder(dir, 4, 10)).sort()).toEqual(['zz.env', 'zzz-config/.env']);
  });

  it('仓库的 .git/config：远端地址里的口令、http.extraheader 的认证头（basic 的解开取口令）；嵌在普通目录里的仓库也带上', async () => {
    const basic = Buffer.from('x-access-token:ghs_0123456789abcdefghij0123456789').toString('base64');
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = https://deploy-bot:s3cr3t-deploy-pass@git.example.com/team/app.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[http "https://github.com/"]',
      `\textraheader = AUTHORIZATION: basic ${basic}`,
      '[http "https://gitlab.example.com/"]',
      '\textraheader = "Authorization: Bearer glbearer-0123456789abcdef"',
    ].join('\n');
    expect(gitConfigSecretsIn(config, '.git/config').map((s) => [s.name, s.value])).toEqual([
      ['.git/config 里的 URL 口令', 's3cr3t-deploy-pass'],
      ['.git/config 里的 http.extraheader', basic],
      ['.git/config 里的 http.extraheader 里的口令', 'ghs_0123456789abcdefghij0123456789'],
      ['.git/config 里的 http.extraheader', 'glbearer-0123456789abcdef'],
    ]);
    // 没有凭证的配置什么都不认
    expect(gitConfigSecretsIn('[remote "origin"]\n\turl = git@github.com:team/app.git\n', '.git/config')).toEqual([]);

    dir = mkdtempSync(join(tmpdir(), 'melina-secret-scan-'));
    mkdirSync(join(dir, 'vendor', 'lib', '.git', 'objects'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'lib', '.git', 'config'), config);
    writeFileSync(join(dir, 'vendor', 'lib', '.git', 'objects', 'credentials'), 'password=not-read-1234567');
    expect(await secretFilesUnder(dir)).toEqual(['vendor/lib/.git/config']);
    const found = await secretsInFile(join(dir, 'vendor', 'lib', '.git', 'config'), 'vendor/lib/.git/config');
    expect(found.map((s) => s.value)).toContain('ghs_0123456789abcdefghij0123456789');
  });
});

/** 配置里引用环境变量的写法（字面量 ${DB_PASSWORD}，不是模板） */
const DB_REF = `\${DB_PASSWORD}`;

/** git diff 的样子：新建的 .token、改了的 config.yaml、删掉的 old.txt、二进制的 logo.png */
const PATCH = [
  'diff --git a/.token b/.token',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/.token',
  '@@ -0,0 +1 @@',
  '+4eb4a5b0f5f0b23777540b34e698c1fb',
  'diff --git a/config.yaml b/config.yaml',
  'index 2222222..3333333 100644',
  '--- a/config.yaml',
  '+++ b/config.yaml',
  '@@ -1,2 +1,3 @@',
  ' host: db',
  '-password: old',
  `+password: ${DB_REF}`,
  '+++ odd: line starting with plus signs',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/logo.png differ',
  '',
].join('\n');

describe('交付前扫 patch', () => {
  it('每个文件加进来的行：新建的标出来，删掉的、二进制的不算；hunk 里以 +++ 开头的内容照样算', () => {
    expect(addedInPatch(PATCH)).toEqual([
      { path: '.token', created: true, added: '4eb4a5b0f5f0b23777540b34e698c1fb' },
      { path: 'config.yaml', created: false, added: `password: ${DB_REF}\n++ odd: line starting with plus signs` },
    ]);
  });

  it('名字像放 token 的文件、整段是一个随机串才算；普通文件、写了句话的不算', () => {
    expect(tokenFileSecret('.token', '4eb4a5b0f5f0b23777540b34e698c1fb\n')?.name).toBe('.token 的整段内容');
    expect(tokenFileSecret('work/access_token.txt', 'eyJhbGciOiJIUzI1NiJ9abc123def456')).toBeDefined();
    expect(tokenFileSecret('notes.txt', '4eb4a5b0f5f0b23777540b34e698c1fb')).toBeUndefined();
    expect(tokenFileSecret('token.txt', '把 token 放在环境变量里')).toBeUndefined();
  });

  it('占位不是密钥（引用环境变量、{{ }}、<…>）；只看样子的那几条不看键名', () => {
    expect(secretsIn(`password: ${DB_REF}\ntoken: {{ api_token }}\napi_key: <your-key>`, 'app.yaml')).toEqual([]);
    expect(obviousSecretsIn('password: hunter2-but-longer', 'app.yaml')).toEqual([]);
    expect(obviousSecretsIn('curl https://bot:Pa55w0rd-x@example.com', 'probe.sh').map((s) => s.value)).toEqual([
      'Pa55w0rd-x',
    ]);
  });

  it('新建的文件：.env 照全部规则；测试、样例只认一眼就是的；别的按键名认的值还得像随机串', () => {
    const names = (text: string, file: string) => createdFileSecretsIn(text, file).map((s) => s.name);
    expect(names('DB_PASSWORD=plain-value', '.env')).toEqual(['.env 里的 DB_PASSWORD']);
    for (const file of [
      'tests/a.py',
      'test/x.ts',
      'pkg/auth_test.go',
      'src/a.spec.ts',
      'conftest.py',
      'testdata/u.json',
    ]) {
      expect(names('password = "Zx9vQ2mL7pR4tK8w"', file)).toEqual([]);
    }
    expect(names('ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'tests/a.py')).toEqual(['tests/a.py 里的 token']);
    expect(names('password = "correct-horse-battery"', 'scripts/login.py')).toEqual([]);
    expect(names('password = "Zx9vQ2mL7pR4tK8w"', 'scripts/login.py')).toEqual(['scripts/login.py 里的 password']);
  });
});
