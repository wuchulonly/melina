// GET 结果的缓存：同一个 key 的请求合并成一次，页面先显示旧数据再悄悄刷新；
// 事件流说「这个变了」就 invalidate，有人在看的马上重拉，没人看的等下次有人看再拉。

import { useCallback, useSyncExternalStore } from 'react';

export interface ResourceDef<T> {
  key: string;
  fetch: (signal: AbortSignal) => Promise<T>;
  /** 新拉回来的和手上的一样（比如任务详情的 seq 没变）：留着旧对象，用它的组件不用重画 */
  same?: (prev: T, next: T) => boolean;
}

export interface ResourceSnapshot<T> {
  data: T | undefined;
  error: Error | undefined;
  /** 还没有数据，正在拉 */
  loading: boolean;
  /** 有数据，正在后台刷新 */
  refreshing: boolean;
}

interface Entry {
  def: ResourceDef<unknown>;
  data: unknown;
  error: Error | undefined;
  inflight: AbortController | null;
  /** 拉的过程中又被 invalidate 了：拉完再拉一次，免得旧结果盖掉新的 */
  again: boolean;
  stale: boolean;
  listeners: Set<() => void>;
  snapshot: ResourceSnapshot<unknown>;
  /** 最近一次有人用它（渲染时取、订阅、退订）的先后，扔没人看的时候先扔最久没用的 */
  usedAt: number;
}

const entries = new Map<string, Entry>();
const EMPTY: ResourceSnapshot<never> = { data: undefined, error: undefined, loading: false, refreshing: false };

/**
 * 无人订阅的运行进度、产物、diff 和分支详情缓存最多保留 IDLE_LIMIT 份，超出时淘汰最久未用的。
 * 最近访问的任务可以复用缓存；已淘汰的数据在下次访问时重新请求。
 */
export const IDLE_LIMIT = 30;
let clock = 0;

function ensure(def: ResourceDef<unknown>): Entry {
  let e = entries.get(def.key);
  if (!e) {
    e = {
      def,
      data: undefined,
      error: undefined,
      inflight: null,
      again: false,
      stale: true,
      listeners: new Set(),
      snapshot: { ...EMPTY },
      usedAt: ++clock,
    };
    entries.set(def.key, e);
  } else {
    e.def = def; // 用最新的 fetch（闭包里的参数可能变了）
    e.usedAt = ++clock;
  }
  return e;
}

/** 没人订阅、也没在拉的超过 IDLE_LIMIT 个：扔掉最久没人用的那些 */
function prune(): void {
  const idle = [...entries.values()].filter((e) => e.listeners.size === 0 && e.inflight === null);
  if (idle.length <= IDLE_LIMIT) return;
  idle.sort((a, b) => a.usedAt - b.usedAt);
  for (const e of idle.slice(0, idle.length - IDLE_LIMIT)) entries.delete(e.def.key);
}

function publish(e: Entry): void {
  const fetching = e.inflight !== null;
  const prev = e.snapshot;
  e.snapshot = {
    data: e.data,
    error: e.error,
    loading: fetching && e.data === undefined,
    refreshing: fetching && e.data !== undefined,
  };
  // 只有「后台刷新中」变化时不通知，避免页面重画相同的数据。
  if (prev.data === e.snapshot.data && prev.error === e.snapshot.error && prev.loading === e.snapshot.loading) return;
  for (const listener of [...e.listeners]) listener();
}

function load(e: Entry): Promise<void> {
  if (e.inflight) {
    e.again = true;
    return Promise.resolve();
  }
  const controller = new AbortController();
  e.inflight = controller;
  e.again = false;
  e.stale = false;
  publish(e);
  return e.def.fetch(controller.signal).then(
    (data) => {
      if (e.inflight !== controller) return;
      if (e.data === undefined || !e.def.same?.(e.data, data)) e.data = data;
      e.error = undefined;
      finish(e);
    },
    (error: unknown) => {
      if (e.inflight !== controller) return;
      if (controller.signal.aborted) return;
      e.error = error instanceof Error ? error : new Error(String(error));
      finish(e);
    },
  );
}

function finish(e: Entry): void {
  e.inflight = null;
  if (e.again) {
    e.again = false;
    if (e.listeners.size > 0) {
      void load(e);
      return;
    }
    e.stale = true;
  }
  publish(e);
}

function subscribe(e: Entry, listener: () => void): () => void {
  // 渲染时取到它、订阅之前被扔了（同一次提交里别的组件退订触发了 prune）：放回去，事件流才找得到它
  if (!entries.has(e.def.key)) entries.set(e.def.key, e);
  e.listeners.add(listener);
  e.usedAt = ++clock;
  if (e.stale || (e.data === undefined && e.error === undefined && !e.inflight)) void load(e);
  return () => {
    e.listeners.delete(listener);
    e.usedAt = ++clock;
    if (e.listeners.size === 0) prune();
  };
}

/** 不用 React 时订阅：有人订阅就拉，过期了就重拉；返回退订函数 */
export function subscribeResource<T>(def: ResourceDef<T>, listener: () => void): () => void {
  return subscribe(ensure(def as ResourceDef<unknown>), listener);
}

/** 现在缓存里的样子 */
export function readResource<T>(key: string): ResourceSnapshot<T> {
  return (entries.get(key)?.snapshot ?? EMPTY) as ResourceSnapshot<T>;
}

/** 读一个 GET 的结果；def 为 null 时什么都不做 */
export function useResource<T>(def: ResourceDef<T> | null): ResourceSnapshot<T> & { reload: () => Promise<void> } {
  const entry = def ? ensure(def as ResourceDef<unknown>) : null;
  const key = def?.key ?? null;
  const snapshot = useSyncExternalStore(
    // biome-ignore lint/correctness/useExhaustiveDependencies: 按 key 订阅；entry 由 key 决定
    useCallback((cb: () => void) => (entry ? subscribe(entry, cb) : () => {}), [key]),
    () => (entry ? entry.snapshot : EMPTY),
    () => (entry ? entry.snapshot : EMPTY),
  ) as ResourceSnapshot<T>;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上
  const reload = useCallback(() => (entry ? load(entry) : Promise.resolve()), [key]);
  return { ...snapshot, reload };
}

/**
 * 事件流第一次连上：这之前拉完的可能漏了中间的事件，重拉；还在拉的不管（它会带上连上之前的事，之后的事件流会推），
 * 避免刚打开页面时重复请求；断线重连时用 invalidate() 重新获取全部数据。
 */
export function invalidateSettled(): void {
  invalidate((key) => entries.get(key)?.inflight === null);
}

type KeyMatch = string | ((key: string) => boolean);

/** match 是 key 本身、key 的前缀（到冒号为止）或判断函数；不给就是全部 */
function hits(key: string, match: KeyMatch | undefined): boolean {
  if (match === undefined) return true;
  return typeof match === 'string' ? key === match || key.startsWith(`${match}:`) : match(key);
}

/** 标记过期：有人在看的马上重拉 */
export function invalidate(match?: KeyMatch): void {
  for (const [key, e] of entries) {
    if (!hits(key, match)) continue;
    if (e.listeners.size > 0) void load(e);
    else e.stale = true;
  }
}

/** 直接放进新数据（比如 system.updated 带着完整的系统状态），不用再拉 */
export function setResource<T>(key: string, data: T): void {
  const e = entries.get(key);
  if (!e) return;
  e.data = data;
  e.error = undefined;
  e.stale = false;
  if (e.inflight) {
    e.inflight.abort();
    e.inflight = null;
  }
  publish(e);
}

/** 按旧数据算出新数据（乐观更新）；没有旧数据就不动 */
export function mutateResource<T>(key: string, update: (prev: T) => T): void {
  const e = entries.get(key);
  if (!e || e.data === undefined) return;
  e.data = update(e.data as T);
  publish(e);
}

/** 测试用：清空缓存 */
export function resetResources(): void {
  for (const e of entries.values()) e.inflight?.abort();
  entries.clear();
}
