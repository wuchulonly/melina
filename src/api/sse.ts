// SSE 事件流：GET /api/runs/:id/events 和 GET /api/events。
//
// - 每条事件一条消息：`id: <seq>`、`data: <MelinaEvent 的 JSON>`，不写 event 字段；
// - 先补发 seq 大于 since 的历史，再推新的（EventBus.stream，中间不漏不重）；
// - since 取查询参数和浏览器重连时自动带的 Last-Event-ID 里大的那个；两个都没有就只推连上以后的新事件（前端的全局流第一次连接就是这样）；
// - 每 15 秒一条心跳（具名事件 ping，data 是 {}），免得中间的代理以为连接断了，前端也靠它认出半开的连接（以前是注释行，浏览器看不到）；
// - 按需拉取：客户端读得慢就先不往下取，不在内存里攒事件；客户端断开就停。

import type { MelinaEvent } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { EventBus } from '../core/interfaces/store.ts';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/** 浏览器断线后多久重连（毫秒），写在流的开头 */
export const SSE_RETRY_MS = 2000;

/** 心跳：具名事件，data 不能空（data 为空的消息浏览器不派发） */
export const SSE_PING = 'event: ping\ndata: {}\n\n';

export interface SseOptions {
  bus: EventBus;
  /** 从哪个 seq 之后开始 */
  since: number;
  runId?: Id;
  /** 请求的 signal：客户端断开时触发 */
  signal: AbortSignal;
  heartbeatMs: number;
}

const encoder = new TextEncoder();

export function eventMessage(event: MelinaEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** 把事件流包成 SSE 的响应体 */
export function sseStream(options: SseOptions): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const onClientGone = () => abort.abort();
  options.signal.addEventListener('abort', onClientGone, { once: true });
  const iterator = options.bus
    .stream(options.since, { ...(options.runId ? { runId: options.runId } : {}), signal: abort.signal })
    [Symbol.asyncIterator]();
  // 正在取的下一条事件：心跳先到时留着，下次接着等它。每个 next() 只挂一个回调（反复拿它去 race 会一次心跳攒一个回调）
  let pending = false;
  let arrived: { value: IteratorResult<MelinaEvent> } | { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const fetchNext = () => {
    if (pending || arrived) return;
    pending = true;
    iterator.next().then(
      (value) => {
        pending = false;
        arrived = { value };
        wake?.();
      },
      (error: unknown) => {
        pending = false;
        arrived = { error };
        wake?.();
      },
    );
  };

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    wake?.();
    options.signal.removeEventListener('abort', onClientGone);
    abort.abort();
    void iterator.return?.();
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(encoder.encode(`retry: ${SSE_RETRY_MS}\n\n`));
      },
      async pull(controller) {
        fetchNext();
        if (!arrived) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, options.heartbeatMs);
          });
          wake = undefined;
          if (timer !== undefined) clearTimeout(timer);
        }
        if (stopped) return; // 等的时候客户端走了
        const got = arrived;
        if (!got) {
          controller.enqueue(encoder.encode(SSE_PING));
          return;
        }
        arrived = undefined;
        if ('error' in got) {
          stop();
          controller.error(got.error);
          return;
        }
        if (got.value.done) {
          stop();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(eventMessage(got.value.value)));
      },
      cancel() {
        stop();
      },
    },
    { highWaterMark: 0 },
  );
}

/** 解析 since：查询参数和 Last-Event-ID 取大的；都没有返回 undefined（只要新事件）。查询参数不是非负整数就返回 null */
export function parseSince(query: string | undefined, lastEventId: string | undefined): number | undefined | null {
  let since: number | undefined;
  if (query !== undefined && query !== '') {
    if (!/^\d+$/.test(query)) return null;
    since = Number(query);
  }
  if (lastEventId !== undefined && /^\d+$/.test(lastEventId.trim())) {
    since = Math.max(since ?? 0, Number(lastEventId.trim()));
  }
  return since;
}
