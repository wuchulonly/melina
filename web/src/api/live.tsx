// 全局事件流（GET /events）：页面开着就一直连着；几个标签页共用一条（shared-stream.ts，领头的标签页连 SSE）。
// - 事件来了，相关的 GET 标记过期（攒 250 ms 一起刷），system.updated 直接换上新的系统状态；
// - 断线重连后把所有 GET 重拉一遍，断开期间漏掉的事就补上了；第一次连上只重拉已经拉完的（还在拉的会带上连上之前的事）；
// - usage.updated 带着任务的累计用量，直接改进缓存，不重拉；总览的 GET /usage 最多 USAGE_REFRESH_MS 拉一次；
// - 设置里开了通知：任务结束就发浏览器通知（lib/notify.ts），只由连着 SSE 的那个标签页发；
// - 回到这个标签页（或窗口）时，任务列表和正在看的任务摘要重拉一次（refreshOnReturn）：删除没有事件，
//   别处删掉的任务，开着的页面只能在这时知道；
// - 别的组件可以 useMelinaEvents 拿到原始事件，useStreamState 拿到连接状态。

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { RunListResponse, RunSummary } from '../../../src/core/api.ts';
import type { MelinaEvent, UsageTotals } from '../../../src/core/events.ts';
import type { Id } from '../../../src/core/ids.ts';
import type { RunStatus } from '../../../src/core/types.ts';
import { navigate } from '../app/router.tsx';
import { showNotification } from '../lib/notify.ts';

import { streamUrl } from './client.ts';
import { invalidate, invalidateSettled, mutateResource, setResource, useResource } from './resource.ts';
import { RUNS, SETTINGS } from './resources.ts';
import { SharedMelinaStream } from './shared-stream.ts';
import type { StreamState } from './stream.ts';

type Listener = (event: MelinaEvent) => void;

interface LiveValue {
  state: StreamState;
  subscribe: (listener: Listener) => () => void;
}

const LiveContext = createContext<LiveValue>({ state: 'connecting', subscribe: () => () => {} });

const ENDED: ReadonlySet<RunStatus> = new Set(['done', 'cancelled', 'failed']);
const ENDED_TITLE: Partial<Record<RunStatus, string>> = {
  done: '任务完成了',
  cancelled: '任务取消了',
  failed: '任务出错停下了',
};

/**
 * GET /usage 最多这么久重拉一次：运行中大约每秒一条用量事件，以前每条都让总览重拉一次，
 * 这个接口在 Melina 那边同步查整本账（本机实测一次 0.2 秒多）。总览上的花费晚几秒没关系，任务自己的用量照旧就地改
 */
export const USAGE_REFRESH_MS = 10_000;

/** touch 叫多少次都行，fn 最多每 ms 跑一次；最后一次 touch 以后一定再跑一次（拖到点），不会漏掉最后那点变化 */
export function atMostEvery(ms: number, fn: () => void): { touch: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = Number.NEGATIVE_INFINITY;
  return {
    touch() {
      if (timer) return;
      timer = setTimeout(
        () => {
          timer = null;
          last = Date.now();
          fn();
        },
        Math.max(0, last + ms - Date.now()),
      );
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** 一条事件会让哪些 GET 过期 */
export function staleKeys(e: MelinaEvent): string[] {
  switch (e.type) {
    case 'system.updated':
      return [];
    case 'run.created':
    case 'run.updated':
    case 'completion.drafted':
      return ['runs', `run:${e.runId}`, 'status'];
    case 'usage.updated':
      return ['usage']; // 这个任务的用量就地改（patchUsage），不重拉摘要和任务列表
    // 每次工具调用都来一条，不改摘要里的任何东西（分支卡、候选、用量都另有事件）
    case 'observation.created':
    case 'sh.intent':
    case 'snapshot.created':
    // 巡检器的看法只在路线详情里显示，摘要里没有
    case 'watch.noted':
      return [];
    default:
      return e.runId ? [`run:${e.runId}`] : [];
  }
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StreamState>('connecting');
  const listeners = useRef(new Set<Listener>());
  const settings = useResource(SETTINGS);
  const runs = useResource(RUNS);
  const notify = useRef(false);
  notify.current = settings.data?.notify ?? false;
  const known = useRef(new Map<Id, { status: RunStatus; statement: string }>());

  useEffect(() => {
    for (const r of runs.data?.runs ?? [])
      if (!known.current.has(r.id)) known.current.set(r.id, { status: r.status, statement: r.statement });
  }, [runs.data]);

  useEffect(() => {
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const keys = [...pending];
      pending.clear();
      for (const key of keys) invalidate(key);
    };
    // 用量单独节流：上一次重拉以后不到 USAGE_REFRESH_MS 的，等到点再拉一次（最后一条用量事件也一定拉得到）
    const usage = atMostEvery(USAGE_REFRESH_MS, () => invalidate('usage'));

    // 只给页面打开以后发生的事发通知：Melina 补发的历史（比如断线后续传的）里更早的不弹
    const openedAt = Date.now() - 5_000;
    const stream = new SharedMelinaStream({
      url: (since) => streamUrl.all(since),
      onState: setState,
      onOpen: ({ reconnect }) => (reconnect ? invalidate() : invalidateSettled()),
      onEvent: (e, fromPeer) => {
        if (e.type === 'system.updated') setResource('status', e.data);
        if (e.type === 'usage.updated' && e.runId) patchUsage(e.runId, e.data.total);
        for (const key of staleKeys(e)) {
          if (key === 'usage') usage.touch();
          else pending.add(key);
        }
        if (pending.size > 0 && timer === null) timer = setTimeout(flush, 250);
        if (notify.current && !fromPeer && Date.parse(e.at) >= openedAt) notifyFor(e, known.current);
        if (e.type === 'run.created' || e.type === 'run.updated' || e.type === 'completion.drafted')
          known.current.set(e.data.id, { status: e.data.status, statement: e.data.goal.statement });
        for (const listener of listeners.current) listener(e);
      },
    });
    stream.start();
    return () => {
      stream.stop();
      if (timer) clearTimeout(timer);
      usage.stop();
    };
  }, []);

  useEffect(
    () => refreshOnReturn(document, window, () => invalidate((key) => key === 'runs' || key.startsWith('run:'))),
    [],
  );

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const value = useMemo<LiveValue>(() => ({ state, subscribe }), [state, subscribe]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/**
 * 人离开过这一页（切到别的标签页、别的窗口，visibilitychange 到后台或者窗口 blur）、又回来了（回到前台、窗口拿回焦点）时
 * 调一次 refresh；返回取消监听的函数。没离开过的 focus 不算（页面刚打开时浏览器也会发一次）；回来时两个事件常常一起来，
 * 只算一次。
 * 用处：删除任务没有事件（C36 不做），在别的标签页、窗口或用 SDK 删掉的任务，开着它的页面一直不知道，
 * 回来时重拉一次摘要，404 了任务页就换成「没有这个任务」；任务列表也一起重拉，删掉的行不再留着。
 * 只拉这两样：别的变化都有事件推，事件流在后台也一直连着
 */
export function refreshOnReturn(
  doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  refresh: () => void,
): () => void {
  let away = false;
  const leave = () => {
    away = true;
  };
  const back = () => {
    if (!away || doc.visibilityState !== 'visible') return;
    away = false;
    refresh();
  };
  const onVisibility = () => (doc.visibilityState === 'visible' ? back() : leave());
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('blur', leave);
  win.addEventListener('focus', back);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('blur', leave);
    win.removeEventListener('focus', back);
  };
}

/**
 * usage.updated 带着这个任务的累计用量：直接改进摘要和任务列表（运行中大约每秒一条，每条都重拉摘要太勤）。
 * 不动摘要的 lastSeq：摘要重拉回来按 lastSeq 认「和手上一样」（resources.ts），以前这里把它推到最新，
 * 状态变了（run.updated）紧跟一条用量事件时，重拉回来的新状态被当成没变丢掉，页头一直写「进行中」
 */
export function patchUsage(runId: Id, total: UsageTotals): void {
  mutateResource<RunSummary>(`run:${runId}`, (prev) => ({ ...prev, usage: total }));
  mutateResource<RunListResponse>('runs', (prev) => ({
    ...prev,
    runs: prev.runs.map((r) => (r.id === runId ? { ...r, usage: total } : r)),
  }));
}

function notifyFor(e: MelinaEvent, known: Map<Id, { status: RunStatus; statement: string }>): void {
  if (e.type === 'run.updated' && ENDED.has(e.data.status)) {
    const before = known.get(e.data.id)?.status;
    if (before === undefined || ENDED.has(before)) return;
    showNotification(ENDED_TITLE[e.data.status] ?? '任务结束了', clip(e.data.goal.statement), {
      tag: `run-${e.data.id}`,
      onClick: () => navigate(`/runs/${e.data.id}`),
    });
  }
}

function clip(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 全局事件流的连接状态 */
export function useStreamState(): StreamState {
  return useContext(LiveContext).state;
}

/** 收到每一条全局事件时调用 listener（组件卸载时自动退订） */
export function useMelinaEvents(listener: Listener): void {
  const { subscribe } = useContext(LiveContext);
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}
