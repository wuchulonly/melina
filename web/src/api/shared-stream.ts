// 几个标签页共用一条全局事件流（GET /events）。
//
// HTTP/1.1 下浏览器对同一地址的连接数有限，共享 SSE 给普通请求留出连接。
//
// 做法：用 Web Locks 选一个标签页当「领头的」，只有它连 SSE，收到的事件、连接状态经 BroadcastChannel 发给别的标签页；
// 领头的关了，锁自动放开，排着的下一个接手，按自己收到过的最后一个 seq 续上（Melina 补发，重复的按 seq 丢掉）。
// 浏览器没有 Web Locks 或 BroadcastChannel 时退回每个标签页自己连。
// 浏览器通知只由领头的发（fromPeer 为 false），免得开着几个标签页弹几遍。

import type { MelinaEvent } from '../../../src/core/events.ts';
import { type EventSourceLike, MelinaStream, type StreamState } from './stream.ts';

/** navigator.locks 用到的那一个方法 */
export interface LocksLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>;
}

/** BroadcastChannel 用到的那几个成员 */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  close(): void;
}

type Message =
  | { t: 'event'; e: MelinaEvent }
  | { t: 'state'; s: StreamState }
  | { t: 'open'; reconnect: boolean }
  | { t: 'hello' };

export interface SharedStreamOptions {
  url: (since?: number) => string;
  /** fromPeer：事件是别的标签页转过来的（这个标签页不是领头的） */
  onEvent: (event: MelinaEvent, fromPeer: boolean) => void;
  onState?: (state: StreamState) => void;
  onOpen?: (info: { reconnect: boolean }) => void;
  /** 锁和频道的名字 */
  name?: string;
  /** 不给就用浏览器的；传 null 表示不共用 */
  locks?: LocksLike | null;
  channel?: ((name: string) => ChannelLike) | null;
  create?: (url: string) => EventSourceLike;
  retryDelays?: readonly number[];
  staleMs?: number;
}

export class SharedMelinaStream {
  private readonly opts: SharedStreamOptions;
  private readonly name: string;
  private channel: ChannelLike | null = null;
  private stream: MelinaStream | null = null;
  private abort: AbortController | null = null;
  private release: (() => void) | null = null;
  private seq = 0;
  private current: StreamState = 'connecting';
  private opened = false;
  private stopped = true;

  constructor(opts: SharedStreamOptions) {
    this.opts = opts;
    this.name = opts.name ?? 'melina-events';
  }

  /** 这个标签页是不是连着 SSE 的那个 */
  get leading(): boolean {
    return this.stream !== null;
  }

  get state(): StreamState {
    return this.current;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const locks = this.opts.locks === undefined ? browserLocks() : this.opts.locks;
    const makeChannel = this.opts.channel === undefined ? browserChannel() : this.opts.channel;
    if (!locks || !makeChannel) {
      this.lead(null);
      return;
    }
    const channel = makeChannel(this.name);
    this.channel = channel;
    channel.onmessage = (ev) => this.receive(ev.data as Message);
    channel.postMessage({ t: 'hello' } satisfies Message);
    const abort = new AbortController();
    this.abort = abort;
    locks
      .request(this.name, { signal: abort.signal }, () => {
        if (this.stopped) return Promise.resolve();
        return new Promise<void>((resolve) => {
          this.release = resolve;
          this.lead(channel);
        });
      })
      .catch(() => {}); // 还在排队时 stop()：AbortError
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    this.stream?.stop();
    this.stream = null;
    this.release?.();
    this.release = null;
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.channel = null;
  }

  /** 当领头的：自己连 SSE，收到的转给别的标签页 */
  private lead(channel: ChannelLike | null): void {
    const post = (m: Message) => channel?.postMessage(m);
    const wasOpened = this.opened;
    const stream = new MelinaStream({
      url: this.opts.url,
      ...(this.seq > 0 ? { since: this.seq } : {}),
      ...(this.opts.create ? { create: this.opts.create } : {}),
      ...(this.opts.retryDelays ? { retryDelays: this.opts.retryDelays } : {}),
      ...(this.opts.staleMs !== undefined ? { staleMs: this.opts.staleMs } : {}),
      onEvent: (e) => {
        if (e.seq <= this.seq) return;
        this.seq = e.seq;
        post({ t: 'event', e });
        this.opts.onEvent(e, false);
      },
      onState: (s) => {
        post({ t: 'state', s });
        this.setState(s);
      },
      onOpen: ({ reconnect }) => {
        post({ t: 'open', reconnect });
        // 接手前是跟着别人收的：接手这一下按重连算（交接的空当里 GET 可能过期了）
        const again = reconnect || wasOpened;
        this.opened = true;
        this.opts.onOpen?.({ reconnect: again });
      },
    });
    this.stream = stream;
    stream.start();
  }

  /** 跟着领头的收 */
  private receive(m: Message): void {
    if (this.stopped) return;
    if (m.t === 'hello') {
      if (this.stream) this.channel?.postMessage({ t: 'state', s: this.current } satisfies Message);
      return;
    }
    if (this.stream) return; // 自己就是领头的（别的标签页不该这时还在发，防一手）
    if (m.t === 'event') {
      if (m.e.seq <= this.seq) return;
      this.seq = m.e.seq;
      this.opts.onEvent(m.e, true);
      return;
    }
    if (m.t === 'state') {
      this.setState(m.s);
      if (m.s === 'open' && !this.opened) {
        this.opened = true;
        this.opts.onOpen?.({ reconnect: false });
      }
      return;
    }
    if (m.t === 'open') {
      const reconnect = this.opened && m.reconnect;
      if (!this.opened || reconnect) {
        this.opened = true;
        this.opts.onOpen?.({ reconnect });
      }
    }
  }

  private setState(state: StreamState): void {
    if (state === this.current) return;
    this.current = state;
    this.opts.onState?.(state);
  }
}

function browserLocks(): LocksLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: LocksLike }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

function browserChannel(): ((name: string) => ChannelLike) | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return (name) => new BroadcastChannel(name);
}
