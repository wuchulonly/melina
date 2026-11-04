// 一家供应商配几个 API key。每家按模型页的顺序排，第一个是首选，后面是备用：
// - 一直用排在最前面、能用的那个，不轮流用：缓存按账号算，轮流用会丢掉缓存命中。
// - 只在额度用完（billing）和 key 失效（auth）时把这个 key 记成用不了（down）；stream.ts 在同一次调用里马上换下一个 key 重发，不算重试。
//   限流、过载、5xx、断线不换 key，照熔断那条处理（breaker.ts）。
// - 用不了的 key 过一阵拿一次真实调用去试：到点后下一次调用先拿它试（只放一个调用去试，别的照常用后面的 key），
//   试通了就用回它。第一次一分钟后试，试探又失败就隔得翻倍，最长一小时：按这个时间试的时候总有别的在顶着
//   （后面的 key，或者 stream.ts 换的备用模型），不急着用回它；周、月额度用完的 key 要好几天才恢复，每分钟撞一次，
//   一周白发上万个 403。
//   只有试探的那次又失败才翻倍：记成用不了以前就在途、一起撞上额度的几个调用只算一次。
// - 一家的 key 都用不了：stream.ts 熔断这家。熔断的试探到点、这次调用又没有别的可换（不试就得排队）时（force），
//   用不了的 key 不看时间都能拿去试，还是每分钟一次。
// - 人在模型页改了 key（reset），或者某个 key 的值换了，就当新的，马上能用，间隔也从头算。
// 这里只管状态，不发请求。状态按 key 的 id 记，给 GET /status 和 system.updated（registry.breakers()）。
// 状态只在内存里：重启后从首选 key 重新开始试，间隔也从一分钟算起。

import { createHash } from 'node:crypto';
import type { ProviderKeyStatus } from '../core/events.ts';
import type { Id } from '../core/ids.ts';
import type { ResolvedProviderKey } from '../core/interfaces/config-store.ts';
import { PROBE_INTERVAL_MS, PROBE_TIMEOUT_MS } from './breaker.ts';

/** 用不了的 key 试探又失败时，间隔翻倍到这么久为止 */
export const MAX_KEY_PROBE_INTERVAL_MS = 3_600_000;

export interface KeyPoolOptions {
  /** 用不了的 key 第一次多久后试，默认一分钟；试探又失败就翻倍 */
  probeIntervalMs?: number;
  /** 翻倍到多久为止，默认一小时 */
  maxProbeIntervalMs?: number;
  /** 试探的调用多久没回报就再放一个去试，默认和熔断器一样 */
  probeTimeoutMs?: number;
  now?: () => number;
}

/** 状态里要的：模型页上的 key（解不开的也列，hasKey 是 false） */
export interface ListedKey {
  id: Id;
  name?: string;
  hasKey?: boolean;
}

export interface KeyPool {
  /**
   * 这次用哪个 key：按顺序找第一个能用的。没记过用不了的直接用；用不了的到了试探时间、没有别的调用在试，就拿它试（probe）。
   * skip：这次调用里刚记成用不了的，不再拿；force：这家熔断的试探，用不了的 key 不看时间也能试。
   * probe 为 true 的，发完必须用 success、failure 或 release 回报。都不能用就是 undefined。
   */
  pick(
    provider: string,
    keys: readonly ResolvedProviderKey[],
    opts?: { skip?: ReadonlySet<Id>; force?: boolean },
  ): { key: ResolvedProviderKey; probe: boolean } | undefined;
  /** pick 能不能挑到（不占试探机会）：这次调用里一个 key 刚用不了，看还有没有下一个可换 */
  available(keys: readonly ResolvedProviderKey[], opts?: { skip?: ReadonlySet<Id>; force?: boolean }): boolean;
  /** 记成用不了的原因；能用的是 undefined */
  reason(id: Id): string | undefined;
  /** 用这个 key 调用通了（或者供应商回了话、不是 key 的问题）：用不了的就恢复 */
  success(id: Id): void;
  /** 额度用完或 key 失效：记成用不了，过一阵再试（第一次一分钟后，试探又失败就翻倍，最长一小时） */
  failure(provider: string, key: ResolvedProviderKey, reason: string): void;
  /** 试探的调用没有结果就结束了（被取消、供应商那边出错）：交还机会，下一个调用马上可以试 */
  release(id: Id): void;
  /** 这家每个 key 的状况，按模型页的顺序；resolved 是解得开的那些（拿来比对 key 的值换过没有） */
  status(listed: readonly ListedKey[], resolved: readonly ResolvedProviderKey[]): ProviderKeyStatus[];
  /** 这家（不给就是所有家）的 key 都当新的 */
  reset(provider?: string): void;
  /** 状态变化时通知（给 system.updated 用） */
  onChange(listener: (provider: string) => void): () => void;
}

interface Entry {
  provider: string;
  state: 'down' | 'probing';
  reason: string;
  nextProbeAt: number;
  probingSince?: number;
  /** 接连失败了几次：记成用不了是 1，之后试探每失败一次加 1；隔多久再试按它翻倍 */
  failures: number;
  /** 记成用不了时 key 的指纹：值换了这条就作废 */
  fingerprint: string;
}

/** 解不开的 key（密钥换过）在状态里的原因 */
export const UNREADABLE_KEY = '存着的 key 解不开（密钥换过），要在模型页重新填';

export function createKeyPool(options: KeyPoolOptions = {}): KeyPool {
  const probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
  const maxProbeIntervalMs = Math.max(probeIntervalMs, options.maxProbeIntervalMs ?? MAX_KEY_PROBE_INTERVAL_MS);
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<Id, Entry>();
  const listeners = new Set<(provider: string) => void>();

  const changed = (provider: string) => {
    for (const listener of listeners) {
      try {
        listener(provider);
      } catch {
        // 监听方的错不影响换 key
      }
    }
  };

  /** 还记着的状态；key 的值换过就作废 */
  const current = (key: ResolvedProviderKey): Entry | undefined => {
    const e = entries.get(key.id);
    if (e && e.fingerprint !== fingerprint(key.key)) {
      entries.delete(key.id);
      changed(e.provider);
      return undefined;
    }
    return e;
  };

  /** 这个 key 现在能不能拿：能用的直接用（ok），用不了的到点了拿去试（probe） */
  const usable = (key: ResolvedProviderKey, t: number, force?: boolean): 'ok' | 'probe' | undefined => {
    const e = current(key);
    if (!e) return 'ok';
    const due = e.state === 'down' ? force || t >= e.nextProbeAt : t - (e.probingSince ?? t) >= probeTimeoutMs;
    return due ? 'probe' : undefined;
  };

  return {
    pick(provider, keys, opts = {}) {
      const t = now();
      for (const key of keys) {
        if (opts.skip?.has(key.id)) continue;
        const use = usable(key, t, opts.force);
        if (use === undefined) continue;
        if (use === 'ok') return { key, probe: false };
        const e = entries.get(key.id) as Entry;
        e.state = 'probing';
        e.probingSince = t;
        changed(provider);
        return { key, probe: true };
      }
      return undefined;
    },

    available(keys, opts = {}) {
      const t = now();
      return keys.some((key) => !opts.skip?.has(key.id) && usable(key, t, opts.force) !== undefined);
    },

    reason(id) {
      return entries.get(id)?.reason;
    },

    success(id) {
      const e = entries.get(id);
      if (!e) return;
      entries.delete(id);
      changed(e.provider);
    },

    failure(provider, key, reason) {
      // 试探的那次又失败才加一；已经记成用不了、不在试探的，是记下以前就在途的调用回来了，不另算
      const prev = current(key);
      const failures = prev ? prev.failures + (prev.state === 'probing' ? 1 : 0) : 1;
      entries.set(key.id, {
        provider,
        state: 'down',
        reason,
        nextProbeAt: now() + Math.min(probeIntervalMs * 2 ** (failures - 1), maxProbeIntervalMs),
        failures,
        fingerprint: fingerprint(key.key),
      });
      changed(provider);
    },

    release(id) {
      const e = entries.get(id);
      if (e?.state !== 'probing') return;
      e.state = 'down';
      e.nextProbeAt = now();
      delete e.probingSince;
      changed(e.provider);
    },

    status(listed, resolved) {
      const byId = new Map(resolved.map((k) => [k.id, k]));
      let active = false;
      return listed.map((k) => {
        const base = { id: k.id, ...(k.name !== undefined ? { name: k.name } : {}) };
        const key = byId.get(k.id);
        if (!key || k.hasKey === false) return { ...base, state: 'down', reason: UNREADABLE_KEY };
        const e = entries.get(k.id);
        if (e && e.fingerprint === fingerprint(key.key)) return { ...base, state: 'down', reason: e.reason };
        if (active) return { ...base, state: 'standby' };
        active = true;
        return { ...base, state: 'active' };
      });
    },

    reset(provider) {
      const touched = new Set<string>();
      for (const [id, e] of entries) {
        if (provider !== undefined && e.provider !== provider) continue;
        entries.delete(id);
        touched.add(e.provider);
      }
      for (const p of touched) changed(p);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 只留指纹，不在内存里多存一份明文 */
function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 16);
}
