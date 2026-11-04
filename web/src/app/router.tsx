// 很小的路由：History API 加一张路由表。页面路径不带 /api 前缀，Melina 托管前端时把不认识的页面路径都回 index.html。
//
//   /              总览
//   /runs          任务列表
//   /runs/:id/...  一个任务：工作台页、结果页
//   /models        模型
//   /settings      设置
//
// 哪一页后面加 ?new 或 ?continue=<runId>，就在那一页上开着「新建任务」「接着做」的弹窗（app/new-task.tsx）。

import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from 'react';

const CHANGE = 'melina:navigate';

export interface Location {
  pathname: string;
  search: string;
  hash: string;
}

let cached: Location | null = null;
let cachedHref = '';

function read(): Location {
  const href = window.location.href;
  if (!cached || href !== cachedHref) {
    cachedHref = href;
    cached = { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash };
  }
  return cached;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener(CHANGE, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(CHANGE, cb);
  };
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, read, read);
}

export interface NavigateOptions {
  replace?: boolean;
  /** 不回到顶上：同一页开关抽屉这类，只是把状态记进地址（好让后退能关、能把链接发给别人） */
  keepScroll?: boolean;
  /** 存进 history.state 的标记，比如抽屉是不是这一页自己推进去的（关的时候用后退） */
  state?: unknown;
}

export function navigate(to: string, opts: NavigateOptions = {}): void {
  const before = window.location.pathname + window.location.search;
  if (opts.replace) window.history.replaceState(opts.state ?? null, '', to);
  else window.history.pushState(opts.state ?? null, '', to);
  window.dispatchEvent(new Event(CHANGE));
  // 换了页面（或者同一页换了参数）回到顶上；只改 #hash 不动，开关抽屉、弹窗这类传 keepScroll
  if (!opts.replace && !opts.keepScroll && window.location.pathname + window.location.search !== before)
    window.scrollTo({ top: 0 });
}

/**
 * 地址里的一段解码；坏的百分号编码（/runs/%zz）原样留着：以前 decodeURIComponent 抛错，外壳渲染时整页白屏。
 * 原样拿去查任务，Melina 回「没有这个任务」
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** '/runs/:id' 对 '/runs/abc' → { id: 'abc' }；末尾的 '/*' 匹配剩下的部分 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const rest = pattern.endsWith('/*');
  const parts = (rest ? pattern.slice(0, -2) : pattern).split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (rest ? actual.length < parts.length : actual.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    const a = actual[i] as string;
    if (p.startsWith(':')) params[p.slice(1)] = decodeSegment(a);
    else if (p !== a) return null;
  }
  if (rest) params['*'] = actual.slice(parts.length).join('/');
  return params;
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  replace?: boolean;
}

/** 站内链接：普通点击走前端路由；按着 Ctrl、Cmd、Shift 或中键还是浏览器自己开新标签 */
export function Link({ to, replace, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target && rest.target !== '_self') return;
    e.preventDefault();
    navigate(to, { replace });
  };
  return <a href={to} onClick={handle} {...rest} />;
}
