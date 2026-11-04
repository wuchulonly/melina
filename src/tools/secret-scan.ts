// 工作目录和附件里原有的密钥：
// 被 .gitignore 忽略的小文件（.env、本地配置）会抄进每个 workspace（workspace/local-files.ts），普通目录整个复制，附件只读挂进容器，
// 程序要能照常读它们；可 agent `cat .env` 一下，里面的 key 就进了上下文、发给了模型供应商。
// 所以开跑前把这些文件里像密钥的值找出来，按 Run 登记进打码表（SecretRedactor.hold）：模型看到的是「[凭证「.env 里的 API_TOKEN」已隐藏]」，
// 文件本身不动。只按规则认，宁可少认也不乱遮（遮错了会把正常输出改得面目全非）：
// - KEY=VALUE、KEY: VALUE、"key": "value" 这类，键名像密钥（token、secret、password、api_key……），值不短于 8 个字符；
//   键名按整段认（API_TOKEN、apiKey、client-secret 拆成段看），tokenizer、sort_key 这类不算；值是路径、URL、数字、布尔的不算；
// - .env 这类专放配置的文件里，值本身像随机串（不短于 20 个字符、字母数字混着、没有空格）的，键名不像也算；*_KEY 也算（STRIPE_KEY）；
// - URL 里的口令（scheme://user:口令@host）；PEM、PGP 私钥块；几种有固定前缀的 token（sk-、gh?_、github_pat_、xox?-、AKIA、ASIA、AIza、glpat-、
//   sk_live_、rk_live_、npm_）；.npmrc 的 //registry/:_authToken=…、.netrc 的 password …。
// 文档里的示例 key（…EXAMPLE）、占位（sk-xxxx…）不算；随机串也排除主机名（redis-01.internal.example.com）、镜像（ghcr.io/acme/api:1.14.2）、命令行参数（--max-old-space-size=4096）
// 这类普通配置值。
// 猜得到的口令也不算：只由小写字母组成、不到 16 个字符的（postgres、password、changeme、minioadmin），
// 和 URL 里用户名一样的（app_user:app_user@）。它们是默认口令、文档里的占位或者普通单词，遮了保护不了什么；打码表却按子串满屏替换，
// 同名的角色、库名、镜像跟着被遮（`role "postgres" does not exist`、`image: postgres:16-alpine`），交付的文件里出现这个词
// 也当成泄露、只交 patch。不看主机：docker compose 里的库在 db、postgres 这类服务名上，和 localhost 一样是本地的默认口令。

import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { Secret } from './redact.ts';

/**
 * 键名里有这样一整段，一看就是密钥：值不短于 8 个字符就算（路径、URL、纯数字、true/false 这类除外）。
 * 按段认，不按子串：tokenizer、max_tokens、compass 不算
 */
const SECRET_WORDS = new Set([
  'secret',
  'secrets',
  'token',
  'password',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'apikey',
  'privatekey',
  'secretkey',
  'accesskey',
]);
/** 这些段后面紧跟 key 的也是（api_key、apiKey、ACCESS_KEY_ID、private-key、LICENSE_KEY）；别的 *_key（sort_key、cache_key）不算 */
const KEY_OWNERS = new Set([
  'api',
  'access',
  'private',
  'signing',
  'secret',
  'client',
  'master',
  'encryption',
  'auth',
  'license',
  'app',
  'service',
]);
/** 键名可能是密钥（auth、session、cookie……，还有别的 *_key）：值还得像随机串才算，免得把域名、列名这类遮掉 */
const MAYBE_SECRET_KEY = /(auth|session|cookie|credential|signature|dsn|webhook|salt|hmac|(^|[_.-])key$)/i;
/**
 * 不会是密钥的值：URL、数字、布尔、路径（PWD=/home/me、key_file: ./certs/a.pem），
 * 还有引用别处的占位（password: ${DB_PASSWORD}、{{ secret }}、<your-token>）
 */
const PLAIN_VALUE =
  /^([a-z][a-z0-9+.-]*:\/\/.*|\d+(\.\d+)?|true|false|yes|no|null|none|~?\/.*|\.\.?\/.*|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{.*\}\}|<[^<>]*>)$/i;
/** 专放配置和密钥的文件：键名不像，值像随机串的也算 */
const CONFIG_FILE =
  /^(\.env(\..*)?|.*\.env|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.htpasswd|credentials(\..*)?|secrets?(\..*)?)$/i;
/** 普通目录里要看的文件名（不在 git 仓库里时没有「被忽略的小文件」，按名字挑） */
const SECRET_FILE =
  /^(\.env(\..*)?|.*\.env|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.htpasswd|credentials(\..*)?|secrets?(\..*)?|.*\.pem|.*\.key|id_(rsa|ed25519|ecdsa|dsa)|kubeconfig|.*\.kubeconfig|config\.json|settings\.json|application\.(ya?ml|properties)|appsettings\.json|\.dockercfg)$/i;
const VALUE_MIN = 8;
const RANDOM_MIN = 20;
/** 猜得到的口令：只由小写字母组成、不到 16 个字符（见文件头） */
const GUESSABLE = /^[a-z]{1,15}$/;

/** 值够长、又不是猜得到的单词，才算密钥（几种认法的 add 共用） */
function worthHiding(value: string): boolean {
  return value.length >= VALUE_MIN && !GUESSABLE.test(value);
}

/**
 * 有固定前缀的 token：在哪儿出现都算。GitHub 的 ghp_、gho_、ghu_、ghs_、ghr_，AWS 的长期 key（AKIA）和临时 key（ASIA），
 * Stripe 的 sk_live_、rk_live_，npm 的 npm_
 */
const PREFIXED =
  /\b(sk-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|[sr]k_live_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{36})/g;
/** 前缀之后的部分：判是不是占位（sk-xxxx…、AKIAXXXX…）用 */
const TOKEN_PREFIX = /^(?:sk-proj-|sk-|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|ASIA|AIza|glpat-|[sr]k_live_|npm_)/;
/** PEM 私钥块，连 PGP 的（-----BEGIN PGP PRIVATE KEY BLOCK-----） */
const PEM = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g;
/** .npmrc 里按仓库写的凭证：//registry.npmjs.org/:_authToken=…（行首不是标识符，KEY_VALUE 认不出） */
const NPMRC_AUTH = /^\s*\/\/[^\s=]*:(_authToken|_auth|_password)\s*=\s*(\S+)/;
/** .netrc（curl、git、ftp 都读）：machine … login … password …，空白分隔，可以写在一行或几行 */
const NETRC_FILE = /^[._]netrc$/i;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@]+):([^\s@/]{6,})@/gi;

/** URL 里的口令（scheme://user:口令@host）；和用户名一样的（postgres:postgres@、app_user:app_user@）猜得到，不算 */
function urlPasswords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_PASSWORD)) if (m[2] !== m[1]) out.push(m[2] as string);
  return out;
}

/** 一行开头的键值：KEY=VALUE、export KEY=VALUE、KEY: VALUE（.env、YAML、properties） */
const KEY_VALUE =
  /^\s*(?:export\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*(?:=|:)\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s#,}]+))/;
/** JSON 的键值，一行里在哪儿都算："key": "value" */
const JSON_PAIR = /"([A-Za-z_][A-Za-z0-9_.-]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * 一段文字里像密钥的值；file 是文件名（看它是不是专放配置的）。keyNeedsRandom：按键名认出来的值还得像随机串才算
 * （交付时新建的普通文件，见 createdFileSecretsIn）
 */
export function secretsIn(text: string, file: string, opts: { keyNeedsRandom?: boolean } = {}): Secret[] {
  const name = basename(file);
  const configFile = CONFIG_FILE.test(name);
  const out = new Map<string, string>(); // 值 → 名字
  const add = (value: string, what: string) => {
    const v = value.trim();
    if (worthHiding(v) && !out.has(v)) out.set(v, `${file} 里的${what}`);
  };
  // 先按键名认（名字说得清是哪个变量），再按样子认
  const consider = (key: string, raw: string) => {
    const value = raw.trim();
    if (PLAIN_VALUE.test(value)) return;
    const secret =
      (secretKey(key, configFile) && (!opts.keyNeedsRandom || looksRandom(value, 16))) ||
      (MAYBE_SECRET_KEY.test(key) && looksRandom(value, 16)) ||
      (configFile && looksRandom(value));
    if (secret) add(value, ` ${key}`);
  };
  for (const line of text.split(/\r?\n/)) {
    const m = KEY_VALUE.exec(line);
    if (m) consider(m[1] as string, m[2] ?? m[3] ?? m[4] ?? '');
    const npm = NPMRC_AUTH.exec(line);
    if (npm) consider(npm[1] as string, npm[2] as string);
  }
  if (NETRC_FILE.test(name)) {
    const words = text.split(/\s+/);
    for (let i = 0; i + 1 < words.length; i++) if (words[i] === 'password') add(words[i + 1] as string, ' password');
  }
  for (const m of text.matchAll(JSON_PAIR)) consider(m[1] as string, m[2] as string);
  for (const m of text.matchAll(PEM)) add(m[0], ` ${m[1]?.toLowerCase() ?? '私钥'}`);
  // URL 口令先认：口令本身是带前缀的 token 时（https://x-access-token:ghs_…@github.com），名字写它在哪
  for (const password of urlPasswords(text)) add(password, ' URL 口令');
  for (const m of text.matchAll(PREFIXED)) if (!exampleToken(m[1] as string)) add(m[1] as string, ' token');
  return [...out].map(([value, what]) => ({ name: what, value }));
}

/**
 * 有固定前缀、却是文档里的示例或者占位的：AWS 文档的 AKIAIOSFODNN7EXAMPLE、README 里的 sk-xxxxxxxx…。
 * 测试和文档里常见，当成泄露就会只交 patch、不推分支
 */
function exampleToken(token: string): boolean {
  return /EXAMPLE(?:KEY)?$/.test(token) || placeholder(token.replace(TOKEN_PREFIX, ''));
}

/** 占位：只由一两种字符组成（xxxx…、****…、0000…），不是真的值 */
function placeholder(value: string): boolean {
  return new Set(value).size <= 2;
}

/**
 * 键名一看就是密钥：拆成小写的段（API_TOKEN → api token，apiKey → api key，client-secret → client secret），
 * 有一段是 SECRET_WORDS，或者 KEY_OWNERS 后面紧跟 key；.env 这类专放配置的文件里 *_KEY 都算（STRIPE_KEY、KEY）
 */
function secretKey(key: string, configFile: boolean): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (parts.some((p) => SECRET_WORDS.has(p))) return true;
  if (parts.some((p, i) => p === 'key' && i > 0 && KEY_OWNERS.has(parts[i - 1] as string))) return true;
  return configFile && parts.at(-1) === 'key';
}

/** 主机名：小写的几段用点连起来、最后一段是字母（redis-01.internal.example.com），可以带端口 */
const HOST_NAME = /^(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d+)?$/;
/** 容器镜像：仓库主机/路径[:标签][@sha256:…]（ghcr.io/acme/api:1.14.2） */
const IMAGE_REF = /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/;

/**
 * 像随机串：够长、字母数字混着、没有空格（PORT=3000、NODE_ENV=development 这类不算）。
 * 主机名、镜像、命令行参数（-- 开头）、占位不算：它们也够长、字母数字混着，原来被当成凭证、在输出里按子串遮掉
 */
function looksRandom(value: string, min = RANDOM_MIN): boolean {
  if (value.length < min || /\s/.test(value) || !/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
  return !value.startsWith('-') && !HOST_NAME.test(value) && !IMAGE_REF.test(value) && !placeholder(value);
}

// ── 交付前查一遍──────────────────────────────
// agent 干活时会把登录拿到的 token（.token、token.txt）、抓下来的数据、探测脚本写进工作目录，交付时跟着推进用户仓库。
// 收尾时扫候选相对起点的改动：新建的文件按 createdFileSecretsIn 认，再加「名字像放 token 的文件、整段是一个随机串」；
// 改了的老文件只认一眼就是密钥的（私钥块、固定前缀的 token、URL 里的口令）——老文件里原有的配置写法（password: xxx）
// 不归 agent，按键名认会把正常的配置改动当成泄露。

/** git 配置里 http.extraheader 带的认证头：Authorization: basic|bearer|token <凭证> */
const EXTRA_HEADER = /^\s*extraheader\s*=\s*"?\s*authorization\s*:\s*(basic|bearer|token)\s+([^\s"]+)/i;

/** 仓库的 git 配置（.git/config）：路径以 .git/config 结尾的按 gitConfigSecretsIn 认 */
export const GIT_CONFIG_FILE = /(^|[\\/])\.git[\\/]config$/;

/**
 * 用户仓库的 git 配置（.git/config）里的凭证。人选的工作目录原样只读挂在 /melina/origin，原仓库的 .git 也在里面：
 * workspace 里的克隆去掉了远端地址里的口令，原件没去，以前也不进打码表。认三样：远端地址里的口令（url = https://user:口令@host）、
 * 有固定前缀的 token（secretsIn 本来就认），和 http.extraheader 带的认证头（CI 检出常这样配；basic 的再解开、取冒号后面那段）
 */
export function gitConfigSecretsIn(text: string, file: string): Secret[] {
  const out = new Map<string, string>(secretsIn(text, file).map((s) => [s.value, s.name]));
  const add = (value: string, what: string) => {
    const v = value.trim();
    if (worthHiding(v) && !out.has(v)) out.set(v, `${file} 里的${what}`);
  };
  for (const line of text.split(/\r?\n/)) {
    const m = EXTRA_HEADER.exec(line);
    if (!m) continue;
    const [, scheme, credential] = m as unknown as [string, string, string];
    add(credential, ' http.extraheader');
    if (scheme.toLowerCase() === 'basic') {
      const decoded = Buffer.from(credential, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0) add(decoded.slice(colon + 1), ' http.extraheader 里的口令');
    }
  }
  return [...out].map(([value, name]) => ({ name, value }));
}

/** 只看样子、不看键名的几条：私钥块、有固定前缀的 token、URL 里的口令 */
export function obviousSecretsIn(text: string, file: string): Secret[] {
  const out = new Map<string, string>();
  const add = (value: string, what: string) => {
    const v = value.trim();
    if (worthHiding(v) && !out.has(v)) out.set(v, `${file} 里的${what}`);
  };
  for (const m of text.matchAll(PEM)) add(m[0], ` ${m[1]?.toLowerCase() ?? '私钥'}`);
  // URL 口令先认：口令本身是带前缀的 token 时（https://x-access-token:ghs_…@github.com），名字写它在哪
  for (const password of urlPasswords(text)) add(password, ' URL 口令');
  for (const m of text.matchAll(PREFIXED)) if (!exampleToken(m[1] as string)) add(m[1] as string, ' token');
  return [...out].map(([value, what]) => ({ name: what, value }));
}

/** 测试、样例数据所在的路径：里面的口令、token 多半是编的（password = "correct-horse-battery"） */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?|fixtures?|testdata|test_data|mocks?|__mocks__|examples?|samples?)\/|(^|\/)(test_[^/]*|[^/]*_test\.[^/.]+|[^/]*\.(test|spec)\.[^/.]+|conftest\.py)$/i;

/**
 * 交付的改动里新建的文件：.env 这类专放配置的照全部规则认；测试、样例数据只认一眼就是的；
 * 别的文件按键名认出来的值还得像随机串。登录拿到的 token、抄下来的 key 是随机串，测试里编的口令（correct-horse-battery）、
 * 开发用的默认值（dev-only-not-secret）多半不是；原来按全部规则认，代码任务加个带口令的测试就不推分支、只交 patch。
 * 登记过的值（设置里的凭证、附件和工作目录里原有的）不管在哪都算，由调用方查（api/run-secrets.ts）
 */
export function createdFileSecretsIn(text: string, file: string): Secret[] {
  if (CONFIG_FILE.test(basename(file))) return secretsIn(text, file);
  if (TEST_PATH.test(file)) return obviousSecretsIn(text, file);
  return secretsIn(text, file, { keyNeedsRandom: true });
}

/** 名字像专放 token、口令的文件（.token、token.txt、access_token、api.key、secret.txt、password） */
const TOKEN_FILE =
  /^\.?([\w.-]*[._-])?(token|tokens|secret|secrets|password|passwd|apikey|api[_-]key|access[_-]token|bearer|cookie|session)(\.(txt|json|key|dat))?$/i;

/** 名字像专放 token 的文件，内容整个就是一个随机串（可能带结尾的换行）：算密钥 */
export function tokenFileSecret(path: string, content: string): Secret | undefined {
  const name = basename(path);
  if (!TOKEN_FILE.test(name) && !SECRET_FILE.test(name)) return undefined;
  const value = content.trim();
  if (!looksRandom(value, 16)) return undefined;
  return { name: `${path} 的整段内容`, value };
}

/** git 格式的 patch 里每个文件加进来的行（去掉开头的 +），新建的文件标出来；二进制、删掉的文件不算 */
export function addedInPatch(patch: string): { path: string; created: boolean; added: string }[] {
  const out: { path: string; created: boolean; lines: string[] }[] = [];
  let cur: { path: string; created: boolean; lines: string[] } | undefined;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = undefined;
      inHunk = false;
      const m = / b\/(.+)$/.exec(line);
      if (m) {
        cur = { path: m[1] as string, created: false, lines: [] };
        out.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.created = true;
      else if (line.startsWith('+++ ')) {
        const path = line.slice(4).replace(/^b\//, '');
        if (path === '/dev/null') cur = undefined;
        else cur.path = path;
      } else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) cur.lines.push(line.slice(1));
  }
  return out
    .filter((f) => f.lines.length > 0)
    .map((f) => ({ path: f.path, created: f.created, added: f.lines.join('\n') }));
}

const FILE_MAX = 1024 * 1024;

/** 一个文件里的：读不了、太大、像二进制的跳过；仓库的 .git/config 按 gitConfigSecretsIn 认 */
export async function secretsInFile(path: string, label: string): Promise<Secret[]> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > FILE_MAX) return [];
    const fh = await open(path, 'r');
    try {
      const buf = await fh.readFile();
      if (buf.subarray(0, 8192).includes(0)) return [];
      const text = buf.toString('utf8');
      return GIT_CONFIG_FILE.test(path) ? gitConfigSecretsIn(text, label) : secretsIn(text, label);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '.cache',
  '__pycache__',
]);

/**
 * 普通目录（不是 git 仓库，整个复制进 workspace）里按文件名挑像放密钥的文件：一层一层往下看（放密钥的文件多在浅处，
 * 一个大的子目录不会把根上的 .env 挤出去），最多 depth 层、看 maxEntries 个文件和目录，跳过依赖和构建目录。
 * 嵌在里面的仓库不往 .git 里走，只带上它的 .git/config。返回相对路径
 */
export async function secretFilesUnder(root: string, depth = 4, maxEntries = 5000): Promise<string[]> {
  const out: string[] = [];
  let seen = 0;
  let level: string[] = [root];
  for (let d = 0; d <= depth && level.length > 0 && seen < maxEntries; d++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (seen >= maxEntries) return out;
        seen++;
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) next.push(path);
          // 嵌在里面的仓库：不往 .git 里走，只看它的配置（远端地址里的口令，gitConfigSecretsIn）
          else if (e.name === '.git' && (await stat(join(path, 'config')).catch(() => null))?.isFile())
            out.push(relative(root, join(path, 'config')));
        } else if (e.isFile() && SECRET_FILE.test(e.name)) {
          out.push(relative(root, path));
        }
      }
    }
    level = next;
  }
  return out;
}
