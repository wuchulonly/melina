// SSE 客户端：每条消息 id 是 seq，data 是一条 MelinaEvent。
// - 浏览器自己重连时会带 Last-Event-ID，Melina 从那之后补发；
// - 连接彻底断了（Melina 重启、返回了错误）浏览器就不再重连，这里按 since=最后收到的 seq 重新连，间隔逐步拉长；
// - seq 不大于已收到的直接丢掉，补发和推送重叠也不会重复处理；
// - 每次连上（包括第一次）都告诉调用方：断开期间的事可能没收到，GET 要重新拉一遍；
// - Melina 每 15 秒发一条具名事件 ping（api.ts 的 SSE 约定）：收到过 ping 以后，45 秒什么都没收到就当连接半死了，
//   关掉按 since 重连（半开的连接浏览器自己发现不了，侧栏会一直写「已连上」）。没发过 ping 的老 Melina 不看门；
// - pauseWhenHidden：页面切到后台一段时间就先断开、回到前台按 since 续上（HTTP/1.1 下一个地址最多 6 条连接，
//   每个标签页常驻几条 SSE，开多了别的请求就排不上队）。

import type { MelinaEvent } from '../../../src/core/events.ts';

export type StreamState = 'connecting' | 'open' | 'reconnecting';

/** EventSource 用到的那几个成员，测试里用假的顶替 */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent<string>) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  close(): void;
  /** 具名事件（ping）；测试里的假 EventSource 可以不实现 */
  addEventListener?(type: string, listener: (ev: MessageEvent<string>) => void): void;
}

/** 页面前后台，测试里用假的顶替 */
export interface VisibilityLike {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface MelinaStreamOptions {
  /** 连接地址；since 是最后收到的 seq，第一次连接时没有（只要之后的新事件） */
  url: (since?: number) => string;
  onEvent: (event: MelinaEvent) => void;
  onState?: (state: StreamState) => void;
  onOpen?: (info: { reconnect: boolean }) => void;
  /** 从哪个 seq 之后开始（比如 RunSummary.lastSeq）；不给就只要连上以后的新事件 */
  since?: number;
  create?: (url: string) => EventSourceLike;
  /** 连接彻底断了以后，第 n 次重连前等多久 */
  retryDelays?: readonly number[];
  /** 收到过 ping 以后，多久什么都没收到算半死（Melina 15 秒一条 ping，api.ts 约定 45 秒） */
  staleMs?: number;
  /** 切到后台多久以后先断开（不给就一直连着）；回到前台按 since 续上 */
  pauseWhenHidden?: number;
  visibility?: VisibilityLike;
}

const CLOSED = 2;
const DEFAULT_DELAYS = [1000, 2000, 5000, 10_000] as const;
const STALE_MS = 45_000;

export class MelinaStream {
  private readonly opts: MelinaStreamOptions;
  private es: EventSourceLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private opened = false;
  private stopped = true;
  private seq: number;
  private current: StreamState = 'connecting';
  /** 最后一次收到东西（连上、事件、ping）的时间；收到第一条 ping 才开始看门 */
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** 看门狗看的是哪条连接 */
  private watched: EventSourceLike | null = null;
  /** 切到后台以后断开了，等回到前台再连 */
  private paused = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onVisibility = () => this.visibilityChanged();

  constructor(opts: MelinaStreamOptions) {
    this.opts = opts;
    this.seq = opts.since ?? 0;
  }

  private get visibility(): VisibilityLike | undefined {
    if (this.opts.pauseWhenHidden === undefined) return undefined;
    return this.opts.visibility ?? (typeof document === 'undefined' ? undefined : document);
  }

  /** 收到的最后一条事件的 seq */
  get lastSeq(): number {
    return this.seq;
  }

  get state(): StreamState {
    return this.current;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.visibility?.addEventListener('visibilitychange', this.onVisibility);
    if (this.visibility?.hidden) this.visibilityChanged();
    this.connect();
  }

  /**
   * 正在等着重连（断了、或者一直没连上）时现在就连，不等退避的那几秒，也从头算退避；连着的、停了的、在后台断开的不动。
   * 给「连不上 Melina」旁边的「现在重试」用
   */
  retryNow(): void {
    if (this.stopped || this.paused || this.current === 'open') return;
    // 旧连接的看门狗一起清掉：以前留着它，它只认旧连接、一直空转，新连接也挂不上新的看门狗，
    // 按过「现在重试」以后半开的连接就再也认不出来了
    this.disconnect();
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.visibility?.removeEventListener('visibilitychange', this.onVisibility);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.paused = false;
    this.disconnect();
  }

  /** 关掉现在的连接和计时器（stop、切后台、看门狗都用） */
  private disconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.watched = null;
    this.lastHeard = 0;
    this.es?.close();
    this.es = null;
  }

  private visibilityChanged(): void {
    const vis = this.visibility;
    if (!vis || this.stopped) return;
    if (vis.hidden) {
      if (this.hideTimer || this.paused) return;
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        if (this.stopped || !vis.hidden) return;
        this.paused = true;
        this.disconnect();
      }, this.opts.pauseWhenHidden ?? 0);
      return;
    }
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.paused) {
      this.paused = false;
      this.connect();
    }
  }

  private connect(): void {
    if (this.stopped || this.paused) return;
    const since = this.seq > 0 || this.opts.since !== undefined ? this.seq : undefined;
    const create = this.opts.create ?? ((url: string): EventSourceLike => new EventSource(url));
    const es: EventSourceLike = create(this.opts.url(since));
    this.es = es;
    this.setState(this.opened ? 'reconnecting' : 'connecting');
    es.onopen = () => {
      if (this.es !== es) return;
      this.heard();
      this.attempts = 0;
      const reconnect = this.opened;
      this.opened = true;
      this.setState('open');
      this.opts.onOpen?.({ reconnect });
    };
    es.addEventListener?.('ping', () => {
      if (this.es !== es) return;
      this.heard();
      this.armWatchdog(es);
    });
    es.onmessage = (message) => {
      if (this.es !== es) return;
      this.heard();
      let event: MelinaEvent;
      try {
        event = JSON.parse(message.data) as MelinaEvent;
      } catch {
        return;
      }
      if (typeof event?.seq !== 'number' || event.seq <= this.seq) return;
      this.seq = event.seq;
      this.opts.onEvent(event);
    };
    es.onerror = () => {
      if (this.es !== es || this.stopped) return;
      if (es.readyState === CLOSED) {
        es.close();
        this.es = null;
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
        this.retry();
      } else {
        this.setState('reconnecting'); // 浏览器在自己重连，会带 Last-Event-ID
      }
    };
  }

  private heard(): void {
    this.lastHeard = Date.now();
  }

  /** Melina 会发心跳：太久什么都没收到就当连接半死了，关掉重连。看门狗只看一条连接，换了连接就换一只 */
  private armWatchdog(es: EventSourceLike): void {
    if (this.watchdog && this.watched === es) return;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watched = es;
    const staleMs = this.opts.staleMs ?? STALE_MS;
    this.watchdog = setInterval(
      () => {
        if (this.es !== es || this.stopped) return;
        if (Date.now() - this.lastHeard <= staleMs) return;
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
        es.close();
        this.es = null;
        this.retry();
      },
      Math.max(1000, Math.floor(staleMs / 3)),
    );
  }

  private retry(): void {
    const delays = this.opts.retryDelays ?? DEFAULT_DELAYS;
    const delay = delays[Math.min(this.attempts, delays.length - 1)] ?? 10_000;
    this.attempts++;
    this.setState('reconnecting');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private setState(state: StreamState): void {
    if (state === this.current) return;
    this.current = state;
    this.opts.onState?.(state);
  }
}
