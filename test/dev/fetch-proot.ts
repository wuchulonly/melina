// 下载 proot 的静态版到 ~/.cache/melina/proot（test/dev/proot-runtime.ts 用），按 sha256 核对。
//   node test/dev/fetch-proot.ts [--to <路径>] [--sha256 <新的哈希>]
// 从带版本号的正式发布下载，内容不会变；原来下的 proot.gitlab.io/proot/bin/proot 跟着上游 master 重编，
// 10-02 一重编钉的哈希就对不上了。升级时版本和哈希一起换，哈希取那个发布自带的 SHA256SUMS。
// 下到的和钉的对不上时不装，打出新哈希；确认没问题再用 --sha256 指定。

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { prootPath } from './proot-runtime.ts';

const URL = 'https://github.com/proot-me/proot/releases/download/v5.5.0/proot';
/** proot v5.5.0（2026-10-02 发布，提交 25dc6a3，x86_64 静态链接），和发布里的 SHA256SUMS 一致 */
const SHA256 = 'db185300a9daabbce86aca7632d8c7fdc4249f6f153171954013b70c5f491ec0';

const { values } = parseArgs({ options: { to: { type: 'string' }, sha256: { type: 'string' } } });
const target = values.to ?? prootPath();
const want = values.sha256 ?? SHA256;

const res = await fetch(URL);
if (!res.ok) throw new Error(`下载失败：${res.status} ${URL}`);
const bytes = Buffer.from(await res.arrayBuffer());
const got = createHash('sha256').update(bytes).digest('hex');
if (got !== want) {
  console.error(`哈希对不上：要 ${want}，下到的是 ${got}。确认无误后用 --sha256 ${got} 再跑。`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(`${target}.tmp`, bytes);
chmodSync(`${target}.tmp`, 0o755);
renameSync(`${target}.tmp`, target);
console.log(`proot 放在 ${target}`);
