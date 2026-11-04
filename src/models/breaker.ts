// 供应商熔断。每个供应商一个熔断器：
// - 供应商那边的错重试 retries.model 次还不行，或者 401、403、余额不足、没配 key，就熔断这家（open）。
// - 熔断期间：有同档位的备用模型（models.fallback）就换过去；没有就排队，每分钟试一次，通了就恢复。
//   key 都用不了的那种熔断，有备用模型顶着时 stream.ts 到点了也只拿到了自己试探时间的 key 去试（keys.ts，越试越疏）。
// - 试探就是一次真实的模型调用：ready() 说这家能不能试，拿到调用名额以后 gate() 才占下试探的机会，
//   发完必须用 success、failure 或 release 回报（stream.ts 用 finally 保证）。只当备用的那家也一样到点就试，否则它熔断后永远回不来。
// - 万一占了试探机会的调用一直没回报，超过 probeTimeoutMs 就再放一个去试，多试一次没有坏处。
// 这里只管状态和等待，不发请求（发请求在 stream.ts）。状态给 GET /status 和 system.updated（registry.breakers()）。

import type { ModelRef } from '../core/model-ref.ts';

export type BreakerState = 'ok' | 'open' | 'probing';

export interface BreakerStatus {
  provider: string;
  breaker: BreakerState;
  reason?: string; // 熔断原因，例如「401：API key 无效」「502 Bad Gateway（重试 3 次仍不行）」
  fallbackTo?: ModelRef; // 熔断期间换到的备用模型
}

export interface BreakerOptions {
  /** 熔断后多久试一次，默认一分钟 */
  probeIntervalMs?: number;
  /** 试探的调用多久没回报就再放一个去试，默认 15 分钟（和 model.idleTimeoutMs 的默认值一样） */
  probeTimeoutMs?: number;
  now?: () => number;
}

export interface Breaker {
  /** 不占机会地看一眼：ok 没熔断；due 熔断中、可以去试了；wait 熔断中、还不能试（或者别的调用正在试） */
  ready(provider: string): 'ok' | 'due' | 'wait';
  /** 真要发了：ok 照常发；probe 这次就是试探（已经占下），发完必须回报；open 不能发 */
  gate(provider: string): 'ok' | 'probe' | 'open';
  /** 调用成功（或者供应商回了话）：熔断中的就恢复 */
  success(provider: string): void;
  /** 熔断这家（或试探失败、重新熔断），一个周期后再试 */
  failure(provider: string, reason: string): void;
  /** 试探的调用没有结果就结束了（被取消、出了意外）：交还机会，别的调用马上可以试 */
  release(provider: string): void;
  /** 熔断期间换到了哪个备用模型，显示用 */
  noteFallback(provider: string, to: ModelRef): void;
  /** open 和 probing 都算熔断中 */
  isOpen(provider: string): boolean;
  /** 等到其中任何一家可以试了，或者状态变了；signal 取消时抛 AbortError */
  wait(providers: string | readonly string[], signal?: AbortSignal): Promise<void>;
  status(providers: readonly string[]): BreakerStatus[];
  /** 模型页改了（比如换了 API key）：清掉熔断，马上重试 */
  reset(provider?: string): void;
  /** 状态变化时通知（给 system.updated 用） */
  onChange(listener: (provider: string) => void): () => void;
}

interface Entry {
  state: 'open' | 'probing';
  reason: string;
  nextProbeAt: number;
  probingSince?: number;
  fallbackTo?: ModelRef;
}

export const PROBE_INTERVAL_MS = 60_000;
export const PROBE_TIMEOUT_MS = 900_000;

export function createBreaker(options: BreakerOptions = {}): Breaker {
  const probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const waiters = new Map<string, Set<() => void>>();
  const listeners = new Set<(provider: string) => void>();

  const changed = (provider: string) => {
    const set = waiters.get(provider);
    if (set) {
      waiters.delete(provider);
      for (const wake of set) wake();
    }
    for (const listener of listeners) {
      try {
        listener(provider);
      } catch {
        // 监听方的错不影响熔断
      }
    }
  };

  /** 熔断中的这家现在能不能去试 */
  const due = (e: Entry, t: number) =>
    e.state === 'open' ? t >= e.nextProbeAt : t - (e.probingSince ?? t) >= probeTimeoutMs;

  /** 熔断中的这家还要等多久才能试 */
  const msUntilDue = (e: Entry, t: number) =>
    e.state === 'open'
      ? Math.max(0, e.nextProbeAt - t)
      : Math.min(probeIntervalMs, Math.max(0, probeTimeoutMs - (t - (e.probingSince ?? t))));

  return {
    ready(provider) {
      const e = entries.get(provider);
      if (!e) return 'ok';
      return due(e, now()) ? 'due' : 'wait';
    },

    gate(provider) {
      const e = entries.get(provider);
      if (!e) return 'ok';
      const t = now();
      if (!due(e, t)) return 'open';
      e.state = 'probing';
      e.probingSince = t;
      changed(provider);
      return 'probe';
    },

    success(provider) {
      if (!entries.delete(provider)) return;
      changed(provider);
    },

    failure(provider, reason) {
      const e = entries.get(provider);
      entries.set(provider, {
        state: 'open',
        reason,
        nextProbeAt: now() + probeIntervalMs,
        ...(e?.fallbackTo ? { fallbackTo: e.fallbackTo } : {}),
      });
      changed(provider);
    },

    release(provider) {
      const e = entries.get(provider);
      if (e?.state !== 'probing') return;
      e.state = 'open';
      e.nextProbeAt = now();
      delete e.probingSince;
      changed(provider);
    },

    noteFallback(provider, to) {
      const e = entries.get(provider);
      if (!e || (e.fallbackTo?.provider === to.provider && e.fallbackTo.model === to.model)) return;
      e.fallbackTo = to;
      changed(provider);
    },

    isOpen(provider) {
      return entries.has(provider);
    },

    wait(providers, signal) {
      const list = typeof providers === 'string' ? [providers] : [...new Set(providers)];
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError(signal));
          return;
        }
        const t = now();
        let ms = probeIntervalMs;
        for (const p of list) {
          const e = entries.get(p);
          ms = Math.min(ms, e ? msUntilDue(e, t) : 0);
        }
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          for (const p of list) waiters.get(p)?.delete(done);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(abortError(signal));
        };
        const timer = setTimeout(done, ms);
        for (const p of list) {
          let set = waiters.get(p);
          if (!set) {
            set = new Set();
            waiters.set(p, set);
          }
          set.add(done);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },

    status(providers) {
      return providers.map((provider) => {
        const e = entries.get(provider);
        if (!e) return { provider, breaker: 'ok' };
        return {
          provider,
          breaker: e.state,
          reason: e.reason,
          ...(e.fallbackTo ? { fallbackTo: e.fallbackTo } : {}),
        };
      });
    },

    reset(provider) {
      const providers = provider === undefined ? [...entries.keys()] : [provider];
      for (const p of providers) if (entries.delete(p)) changed(p);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  const error = new Error(reason instanceof Error ? reason.message : reason ? String(reason) : '已取消');
  error.name = 'AbortError';
  return error;
}
