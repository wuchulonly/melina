// 仿真环境和 HTTP 服务之间的约定：环境只看到解析好的请求，返回状态码、头和 JSON（或纯文本）。
// 环境自己不碰网络，单元测试可以直接调 handle。

export interface SimRequest {
  method: string;
  /** 去掉实例前缀以后的路径，以 / 开头，不含查询串 */
  path: string;
  query: URLSearchParams;
  /** 头名都是小写 */
  headers: Record<string, string>;
  /** 请求体按 JSON 解析的结果；没有请求体或不是 JSON 时是 undefined（curl -d 不带 Content-Type 也照样解析） */
  body: unknown;
  /** 原始请求体 */
  text: string;
  /** 这个实例对外的地址（按请求里的 Host 拼），Link 头和游标里用 */
  base: string;
}

export interface SimResponse {
  status: number;
  headers?: Record<string, string>;
  /** 对象按 JSON 返回，字符串按纯文本返回，没有就是空响应 */
  body?: unknown;
}

export interface SimHandler {
  handle(req: SimRequest): SimResponse | Promise<SimResponse>;
}

export function json(status: number, body: unknown, headers?: Record<string, string>): SimResponse {
  return headers ? { status, body, headers } : { status, body };
}

/** 路径不对。和「实例不存在」返回一样的内容，不让人试探出别的实例 */
export function noRoute(): SimResponse {
  return json(404, { error: '没有这个接口' });
}

/** 按 / 切路径，去掉空段：'/sessions/ab/press' → ['sessions', 'ab', 'press'] */
export function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/** 测试和标准解里造请求用 */
export function makeRequest(
  method: string,
  pathAndQuery: string,
  options: { body?: unknown; headers?: Record<string, string>; base?: string } = {},
): SimRequest {
  const url = new URL(pathAndQuery, 'http://sim.local');
  const text = options.body === undefined ? '' : JSON.stringify(options.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = v;
  return {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers,
    body: options.body,
    text,
    base: options.base ?? 'http://sim.local/t',
  };
}
