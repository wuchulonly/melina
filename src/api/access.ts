// 访问规则：只监听 127.0.0.1，不做登录；每个请求校验 Host 和 Origin，
// 防止任意网页往 localhost 发请求（DNS 重绑定、跨站提交），替人建任务或取消任务。
//
// - Host 只认 127.0.0.1:<端口> 和 localhost:<端口>：换个域名解析到 127.0.0.1 的网页（DNS 重绑定）带的是它自己的 Host，拒掉。
// - 带了 Origin 就必须是上面两个源之一；没带 Origin 的是同源的 GET（浏览器的 EventSource、fetch GET 常不带）或者本机的命令行工具，放行。
//   浏览器的跨源请求和非 GET 请求一定带 Origin，跨站伪造的提交到不了这里。
// - 没带 Origin、Sec-Fetch-Site 却说是别的站点发来的（<img>、<script> 引用 /api）：除了用户自己点链接打开页面，一律拒。
//
// 防不住本机的其他程序：它们能伪造任何请求头。Melina 只给本机的一个人用；容器与宿主机回环地址的隔离
// 由 rootless 引擎和网络配置保证，必须在部署机器上跑容器集成测试核实，Host、Origin 校验本身不能挡住容器。

import { forbidden } from '../core/errors.ts';

export interface AccessPolicy {
  /** 认的 Host 头，例如 127.0.0.1:7474、localhost:7474 */
  hosts: ReadonlySet<string>;
  /** 认的 Origin，例如 http://127.0.0.1:7474、http://localhost:7474 */
  origins: ReadonlySet<string>;
}

export function accessPolicy(port: number, hostnames: readonly string[] = ['127.0.0.1', 'localhost']): AccessPolicy {
  const hosts = new Set<string>();
  const origins = new Set<string>();
  for (const name of hostnames) {
    hosts.add(`${name}:${port}`);
    origins.add(`http://${name}:${port}`);
    if (port === 80) {
      hosts.add(name);
      origins.add(`http://${name}`);
    }
  }
  return { hosts, origins };
}

export interface AccessRequest {
  method: string;
  path: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  secFetchMode: string | undefined;
}

/** 不合规则就抛 forbidden，message 给人看 */
export function checkAccess(policy: AccessPolicy, req: AccessRequest): void {
  const host = req.host?.trim().toLowerCase();
  if (!host || !policy.hosts.has(host)) {
    throw forbidden(
      `Melina 只接受发给 ${[...policy.hosts].join(' 或 ')} 的请求，这个请求的 Host 是 ${req.host ?? '空的'}`,
    );
  }
  const origin = req.origin?.trim().toLowerCase();
  if (origin !== undefined && origin !== '') {
    if (!policy.origins.has(origin)) throw forbidden(`不接受来自 ${req.origin} 的请求：只有 Melina 自己的页面能调用它`);
    return;
  }
  const site = req.secFetchSite?.toLowerCase();
  if (site === 'cross-site' || site === 'same-site') {
    const navigate = req.secFetchMode?.toLowerCase() === 'navigate';
    const safe = req.method === 'GET' || req.method === 'HEAD';
    // 从别处点链接打开 Melina 的页面可以；别的网页拿 <img>、<script> 引用接口不行
    if (!(navigate && safe && !req.path.startsWith('/api/'))) {
      throw forbidden('不接受别的网站发来的请求：只有 Melina 自己的页面能调用它');
    }
  }
}
