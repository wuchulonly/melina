// 凭证能不能给容器：和 Melina 保存设置时查的同一套（src/core/config.ts credentialProblem）。
// 页面不 import core 的值（test/imports.test.ts），这里抄一份；test/unit/web/credentials.test.ts 拿 core 的核对两边一样。

import type { Credential } from '../../../../src/core/config.ts';

/** 能以环境变量给容器的名字：凭证值也会进引擎进程的环境，只放明确的凭证名；别的系统的凭证用文件形式 */
export const CREDENTIAL_ENV_NAMES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'PYPI_TOKEN',
  'UV_PUBLISH_TOKEN',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
];

/** 凭证文件不能放的目录：/workspace 会进 snapshot 和交付；/melina 下是只读挂载；/run/melina 是容器里包装脚本的状态目录 */
export const RESERVED_CREDENTIAL_DIRS: readonly string[] = ['/workspace', '/melina', '/run/melina'];

/** 和 node 的 posix.normalize 一样折掉「//」「.」「..」（只用在绝对路径上） */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** 这样给容器行不行，不行就返回一句人话（短的，页面上就地说）；值里的 NUL 字符只在保存时由 Melina 查 */
export function credentialIssue(as: Credential['as']): string | undefined {
  if ('env' in as) {
    return CREDENTIAL_ENV_NAMES.includes(as.env)
      ? undefined
      : `环境变量名 ${as.env} 不在 Melina 认的凭证名单里：换成名单里的名字，或者改用文件形式`;
  }
  if (!as.file.startsWith('/')) return '文件要写容器里的绝对路径，比如 /run/secrets/token';
  const path = normalize(as.file);
  if (path === '/' || RESERVED_CREDENTIAL_DIRS.some((d) => path === d || path.startsWith(`${d}/`)))
    return '文件不能放在 /、/workspace、/melina、/run/melina 下面（会进 snapshot 和交付，或者被挂载盖住），换个目录，比如 /run/secrets';
  return undefined;
}
