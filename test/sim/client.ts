// 标准解和直接的做法用的 HTTP 小客户端。它们和 agent 在容器里用 curl 一样，只看得到响应：
// 不许 import 各环境的 world.ts、api.ts（test/unit/sim/honest.test.ts 查），证明题目只靠接口就做得出来。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface HttpResult {
  status: number;
  headers: Headers;
  body: unknown; // 按 JSON 解析的；不是 JSON 时是 undefined
  text: string;
}

export interface RequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function http(url: string, init: RequestInit = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(url, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

/** 2xx 才返回 body，否则抛错带上响应 */
export async function httpOk<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await http(url, init);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${init.method ?? 'GET'} ${url} 返回 ${res.status}：${res.text.slice(0, 300)}`);
  }
  return res.body as T;
}

export function writeJson(dir: string, name: string, value: unknown): void {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Link 头：rel → URL */
export function parseLink(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (m) out[m[2] as string] = m[1] as string;
  }
  return out;
}
