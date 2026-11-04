// 单 agent 基线要自己调模型，key 和开发机的 Melina 读同一个文件（~/.melina-keys.env，一行一个 NAME=value，见 test/dev/serve.ts）。
// 变量名 <供应商>_API_KEY，后面可以接 _后缀（同一家配几个 key，按文件里的顺序：第一个是首选，额度用完换下一个）。
// 供应商 id 由变量名推：去掉 _API_KEY，小写，下划线换成连字符（ZAI_CODING_CN_API_KEY → zai-coding-cn）；GEMINI 是 google。

import { existsSync, readFileSync } from 'node:fs';
import type { ResolvedProviderKey } from '../../src/core/interfaces/config-store.ts';

const SPECIAL: Record<string, string> = { GEMINI: 'google' };

/** 文件不存在就是空的；值为空的、同一家重复的 key 跳过 */
export function readKeyFile(path: string): Record<string, ResolvedProviderKey[]> {
  if (!existsSync(path)) return {};
  const out: Record<string, ResolvedProviderKey[]> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+?)_API_KEY(?:_([A-Z0-9_]+))?\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const base = m[1] as string;
    const provider = SPECIAL[base] ?? base.toLowerCase().replace(/_/g, '-');
    const value = (m[3] as string).replace(/^(['"])(.*)\1$/, '$2');
    if (!value) continue;
    const list = out[provider] ?? [];
    if (list.some((k) => k.key === value)) continue;
    const name = `${base}_API_KEY${m[2] ? `_${m[2]}` : ''}`;
    list.push({ id: `${provider}-${list.length + 1}`, name, key: value });
    out[provider] = list;
  }
  return out;
}

/** 脱敏用：文件里所有的 key 值（够长的），跑分的输出、交付、存档里出现就换掉 */
export function keyValues(keys: Record<string, ResolvedProviderKey[]>): string[] {
  return Object.values(keys)
    .flat()
    .map((k) => k.key)
    .filter((v) => v.length >= 12);
}
