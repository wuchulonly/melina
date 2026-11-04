// melinaStream：所有模型调用都经过这里，供 Harness 会话和单次生成共用。一次调用：
// 1. 选模型：这家熔断了就按 models.fallback 换同档位的备用模型；没有能用的备用就排队，每分钟试一次（breaker.ts）。
// 2. 向 Scheduler 要调用层的名额（按供应商排队，令牌桶按估的 token 数），调用完就还。拿到名额才占试探的机会。
// 3. 发请求：供应商适配器内部不重试（maxRetries: 0），让每次重试都重新过名额和令牌桶；
//    不限总时长，只看多久没收到新内容（model.idleTimeoutMs）。
// 4. 记账：每次请求一行（UsageLedger），实际用掉的 token 报给 Scheduler。记账出错不影响调用。
// 5. 出错先分清是谁的问题（classify.ts）：供应商那边的退避重试 retries.model 次再熔断这家，不交给 Agent，
//    分支不记失败；模型这边的（其他 4xx、上下文撑爆）原样交给 Agent，由角色降级；认不出来的重试几次再交给 Agent。
// 6. 一家配了几个 API key 的（keys.ts）：额度用完、key 失效时把这个 key 记成用不了，马上用下一个 key 重发，不算重试；
//    这家的 key 都用不了才熔断。用不了的 key 越试越疏；熔断到点时还有备用模型可换的，也只拿到了点的 key 去试。
//
// 交给 Agent 的事件：等最后一次请求结束才一次给全（start、done，或者 error）。中途重试过的请求不会在对话里留下半条回复；
// Melina 不需要边生成边显示。

import { Agent } from 'undici';
import type { Id } from '../core/ids.ts';
import type { ResolvedProviderKey } from '../core/interfaces/config-store.ts';
import type { UsageLedger } from '../core/interfaces/ledger.ts';
import type { MelinaStreamFactory, ModelCallMeta, ModelFailureKind } from '../core/interfaces/models.ts';
import type { Scheduler } from '../core/interfaces/scheduler.ts';
import { type ModelRef, modelKey } from '../core/model-ref.ts';
import { TOOL } from '../core/tools.ts';
import { classify, retryAfterMs } from './classify.ts';
import type { StreamFn } from './protocol.ts';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  estimateContextTokens,
  type JsonObject,
  type Model,
  type ProviderResponse,
  retryDelayMs,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from './protocol.ts';
import type { MelinaModelRegistry } from './registry.ts';

export interface MelinaStreamDeps {
  registry: MelinaModelRegistry;
  scheduler: Pick<Scheduler, 'modelSlot' | 'throttled' | 'consumed'>;
  ledger: Pick<UsageLedger, 'model'>;
  /** 退避：第 n 次重试等 baseMs·2^(n-1)，最多 maxMs；响应带 Retry-After 就至少等那么久 */
  backoff?: { baseMs: number; maxMs: number };
  now?: () => number;
  /** 值得记一笔的事（重试、熔断、换 key、换备用模型、记账出错），给日志 */
  onNotice?: (text: string) => void;
  onTiming?: (timing: ModelRequestTiming) => void;
  /** 后台的角色在熔断时最多等多久（毫秒），默认 BACKGROUND_WAIT_MS；测试里调短 */
  backgroundWaitMs?: number;
}

/** queueMs 在申请名额处计时；其余 *Ms 从请求开始计时（排队取消的 cancelMs 从入队计）。首内容仅指非空 delta。 */
export interface ModelRequestTiming {
  runId: Id;
  branchId?: Id;
  role: ModelCallMeta['role'];
  provider: string;
  model: string;
  queueMs: number;
  requestMs?: number;
  headersMs?: number;
  firstEventMs?: number;
  firstContentMs?: number;
  firstContentKind?: 'text_delta' | 'thinking_delta' | 'toolcall_delta';
  streamEndMs?: number;
  cancelMs?: number;
  cancelKind?: 'external' | 'idle';
  cancelStage?: 'queue' | 'request';
  status?: number;
  outcome: 'success' | 'error' | 'aborted' | 'idle_timeout' | 'queue_cancelled' | 'queue_error';
}

export const DEFAULT_BACKOFF = { baseMs: 2000, maxMs: 60_000 };

export const BACKGROUND_WAIT_MS = 180_000;

function isBackground(meta: ModelCallMeta): boolean {
  return meta.job === 'handoff_call' || meta.job === 'selection_call' || meta.role === 'watcher';
}

/** 原生 fetch 使用应用入口配置的 dispatcher，不让 HTTP 默认超时短于模型空闲上限。 */
export const MODEL_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** 后台调用等熔断恢复的预算（pickTarget）：deadline 在第一次真要等时定下 */
interface WaitBudget {
  ms: number;
  deadline?: number;
}

interface Attempt {
  message: AssistantMessage;
  status?: number;
  retryAfterMs?: number;
  idle: boolean;
  ms: number;
  timing: ModelRequestTiming;
}

export function createMelinaStream(deps: MelinaStreamDeps): MelinaStreamFactory<StreamFn> {
  const { registry, scheduler, ledger } = deps;
  const breaker = registry.breaker;
  const keyPool = registry.keys;
  const now = deps.now ?? Date.now;
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const backgroundWait = deps.backgroundWaitMs ?? BACKGROUND_WAIT_MS;
  const notice = (text: string) => {
    try {
      deps.onNotice?.(text);
    } catch {
      // 日志的错不影响调用
    }
  };
  const timing = (value: ModelRequestTiming) => {
    try {
      deps.onTiming?.(value);
    } catch {
      /* 观测失败不影响调用 */
    }
  };
  const failed = (meta: ModelCallMeta, kind: ModelFailureKind | undefined) => {
    try {
      meta.onFailure?.(kind);
    } catch {
      /* 观测失败不影响调用 */
    }
  };

  /**
   * 选这次发给谁，还不占试探的机会：
   * 1. 首选现在就能发（usableNow）就用首选；否则按 models.fallback 的顺序找现在就能发的备用（只当备用的那家也要有机会恢复）。
   * 2. 都没有，这次调用就没有别的可换了（urgent）：首选、备用里谁到了熔断的试探时间就试谁，
   *    用不了的 key 不看时间一个个试（force），还是每分钟一次。
   * 3. 还不行就等，任何一家能试了再看。
   * 有别的顶着时，key 都用不了的那家熔断到点了也只拿到了点的 key 去试：用不了的 key 越试越疏（keys.ts），
   * 不在每次熔断的试探里都撞一遍。
   * budget 是后台调用能等多久：从这次调用第一次要等时算起，试探失败、抢试探落空回到这里接着等的也算在里面
   * （以前每次进来重新计时，试探每分钟一次、比上限短，这个上限就永远到不了）。
   */
  async function pickTarget(
    preferred: ModelRef,
    signal: AbortSignal,
    budget?: WaitBudget,
  ): Promise<{ ref: ModelRef; urgent: boolean }> {
    for (;;) {
      signal.throwIfAborted();
      if (usableNow(preferred.provider)) return { ref: preferred, urgent: false };
      const candidates = registry.fallbacks(preferred);
      const chosen = (ref: ModelRef, urgent: boolean) => {
        if (ref !== preferred) breaker.noteFallback(preferred.provider, ref);
        return { ref, urgent };
      };
      const backup = candidates.find((candidate) => usableNow(candidate.provider));
      if (backup) return chosen(backup, false);
      const due = [preferred, ...candidates].find((ref) => breaker.ready(ref.provider) === 'due');
      if (due) return chosen(due, true);
      const providers = [preferred.provider, ...candidates.map((c) => c.provider)];
      if (budget === undefined) {
        await breaker.wait(providers, signal);
        continue;
      }
      budget.deadline ??= now() + budget.ms;
      const left = budget.deadline - now();
      if (left <= 0) throw new Error(brokenText(preferred, candidates.length));
      await breaker.wait(providers, AbortSignal.any([signal, AbortSignal.timeout(left)])).catch((error: unknown) => {
        if (signal.aborted) throw error;
      });
    }
  }

  /** 这家现在就能发：没熔断的，或者熔断了、到了试探时间、还有到了点的 key 的 */
  function usableNow(provider: string): boolean {
    const state = breaker.ready(provider);
    return state === 'ok' || (state === 'due' && keysDue(provider));
  }

  /** 这家有没有现在就能拿的 key（能用的，或者用不了、到了自己试探时间的）；没配 key 的不归 key 管，读 key 出错交给发请求那里报 */
  function keysDue(provider: string): boolean {
    try {
      const keys = registry.apiKeys(provider);
      return keys.length === 0 || keyPool.available(keys);
    } catch {
      return true;
    }
  }

  /** 后台调用等不到时交回的原因：哪家、为什么熔断、有没有备用 */
  function brokenText(preferred: ModelRef, fallbacks: number): string {
    const reason = breaker.status([preferred.provider])[0]?.reason;
    const why = reason ? `（${reason}）` : '';
    const backup = fallbacks > 0 ? '备用模型也都在熔断中' : '没有配同档位的备用模型';
    return `${preferred.provider} 熔断中${why}，${backup}；后台的调用不排队等，这次没做成`;
  }

  async function attempt(
    meta: ModelCallMeta,
    model: Model<Api>,
    target: ModelRef,
    apiKey: string | undefined,
    context: TranscriptContext,
    options: SimpleStreamOptions,
    signal: AbortSignal,
    queueMs: number,
  ): Promise<Attempt> {
    const started = now();
    const measured: ModelRequestTiming = {
      runId: meta.runId,
      branchId: meta.branchId,
      role: meta.role,
      provider: target.provider,
      model: target.model,
      queueMs,
      outcome: 'error',
    };
    const controller = new AbortController();
    const onAbort = () => {
      measured.cancelMs ??= now() - started;
      measured.cancelKind ??= 'external';
      measured.cancelStage ??= 'request';
      controller.abort(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: number | undefined;
    let retryAfter: number | undefined;
    let message: AssistantMessage | undefined;

    try {
      const provider = registry.provider(target.provider);
      if (!provider) throw new Error(`模型目录里没有供应商 ${target.provider}`);
      const idleMs = registry.global().model.idleTimeoutMs;
      const onIdle = () => {
        idle = true;
        measured.cancelMs ??= now() - started;
        measured.cancelKind ??= 'idle';
        measured.cancelStage ??= 'request';
        controller.abort(new Error('model.idleTimeoutMs'));
      };
      timer = setTimeout(onIdle, idleMs);
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(onIdle, idleMs);
      };
      const see = (code: number, headers: { get(name: string): string | null }) => {
        measured.headersMs ??= now() - started;
        status = code;
        retryAfter = code >= 400 ? retryAfterMs(headers, now()) : undefined;
      };
      const opts: SimpleStreamOptions = {
        ...options,
        apiKey,
        signal: controller.signal,
        maxRetries: 0,
        timeoutMs: idleMs,
        sessionId: meta.sessionId,
        onResponse: async (response: ProviderResponse, model: Model<Api>) => {
          see(response.status, recordHeaders(response.headers));
          await options.onResponse?.(response, model);
        },
      };
      const stream = await provider.streamSimple(model, context, opts);
      try {
        for await (const event of stream) {
          measured.firstEventMs ??= now() - started;
          if (
            measured.firstContentMs === undefined &&
            (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') &&
            event.delta.length > 0
          ) {
            measured.firstContentMs = now() - started;
            measured.firstContentKind = event.type;
          }
          touch();
          if (event.type === 'done') message = event.message;
          else if (event.type === 'error') message = event.error;
        }
      } finally {
        measured.streamEndMs = now() - started;
      }
      message ??= await stream.result();
    } catch (error) {
      // 没配 key 时适配器会报错（No API key for provider）；读配置出错也在这里。都变成一条出错的回复
      const aborted = controller.signal.aborted && !idle;
      message = failedMessage(model, aborted ? 'aborted' : 'error', errorText(error));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    measured.requestMs = now() - started;
    measured.status = status;
    measured.outcome = signal.aborted
      ? 'aborted'
      : idle
        ? 'idle_timeout'
        : message.stopReason === 'error'
          ? 'error'
          : message.stopReason === 'aborted'
            ? 'aborted'
            : 'success';
    return {
      message,
      status,
      retryAfterMs: retryAfter,
      idle: idle && !signal.aborted,
      ms: measured.requestMs,
      timing: measured,
    };
  }

  /** 记账、报用掉的 token：账本只是观测，出错只记一笔日志，不影响这次调用 */
  function account(meta: ModelCallMeta, target: ModelRef, result: Attempt): void {
    const u: Usage = result.message.usage;
    const tokens = {
      input: whole(u?.input),
      cacheRead: whole(u?.cacheRead),
      cacheWrite: whole(u?.cacheWrite),
      output: whole(u?.output),
    };
    const total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
    // 没到供应商那里的（没配 key、还没连上就断了）不记账，只有真正发出去的请求算一次调用
    const failed = result.message.stopReason === 'error' || result.message.stopReason === 'aborted';
    if (failed && total === 0 && result.status === undefined) return;
    try {
      ledger.model({
        runId: meta.runId,
        ...(meta.branchId !== undefined ? { branchId: meta.branchId } : {}),
        role: meta.role,
        provider: target.provider,
        model: target.model,
        tokens,
        usd: Number.isFinite(u?.cost?.total) && u.cost.total > 0 ? u.cost.total : 0,
        ms: Math.max(0, Math.round(result.ms)),
      });
      if (total > 0) scheduler.consumed(target.provider, total);
    } catch (error) {
      notice(`记账出错（不影响调用）：${errorText(error)}`);
    }
  }

  function throttle(provider: string, signal: { status: number; retryAfterMs?: number }): void {
    try {
      scheduler.throttled(provider, signal);
    } catch (error) {
      notice(`Scheduler 收限流信号出错：${errorText(error)}`);
    }
  }

  async function run(
    meta: ModelCallMeta,
    agentModel: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions,
  ): Promise<AssistantMessage> {
    const signal = anySignal([options.signal, meta.signal]);
    const estTokens = estimateContextTokens(context);
    let target = meta.model;
    let retries = 0; // 当前这个模型已经重试了几次
    const skip = new Set<Id>(); // 这次调用里刚记成用不了的 key，不再拿
    let keyFailure: string | undefined; // 最近一个 key 用不了的原因，这家的 key 都用不了时写进熔断原因
    // 后台的角色在熔断时最多等多久：整次调用算一份，不随每次回到 pickTarget 重新计时
    const budget: WaitBudget | undefined = isBackground(meta) ? { ms: backgroundWait } : undefined;

    for (;;) {
      let picked: ModelRef;
      let urgent: boolean;
      try {
        ({ ref: picked, urgent } = await pickTarget(meta.model, signal, budget));
      } catch (error) {
        if (signal.aborted) return failedMessage(agentModel, 'aborted', abortReason(signal));
        failed(meta, 'provider');
        return failedMessage(agentModel, 'error', `选模型时出错：${errorText(error)}`);
      }
      if (modelKey(picked) !== modelKey(target)) {
        if (modelKey(picked) !== modelKey(meta.model)) {
          notice(`${meta.model.provider} 熔断中，这次调用换到 ${modelKey(picked)}`);
        }
        target = picked;
        retries = 0;
      }

      let model: Model<Api>;
      try {
        model = registry.model(target);
      } catch (error) {
        failed(meta, 'model');
        return failedMessage(agentModel, 'error', errorText(error));
      }

      let slot: { release(): void };
      const queueStarted = now();
      try {
        slot = await scheduler.modelSlot(
          {
            runId: meta.runId,
            provider: target.provider,
            job: meta.job,
            ...(meta.branchId !== undefined ? { branchId: meta.branchId } : {}),
            estTokens,
          },
          signal,
        );
      } catch (error) {
        timing({
          runId: meta.runId,
          branchId: meta.branchId,
          role: meta.role,
          provider: target.provider,
          model: target.model,
          queueMs: now() - queueStarted,
          outcome: signal.aborted ? 'queue_cancelled' : 'queue_error',
          ...(signal.aborted
            ? { cancelKind: 'external' as const, cancelStage: 'queue' as const, cancelMs: now() - queueStarted }
            : {}),
        });
        if (signal.aborted) return failedMessage(model, 'aborted', abortReason(signal));
        failed(meta, 'queue');
        // Scheduler 自己出错（不该发生）：交给角色当模型这边的问题，免得被当成取消
        return failedMessage(model, 'error', `Scheduler 没给出调用名额：${errorText(error)}`);
      }
      const queueMs = now() - queueStarted;

      // 拿到名额才占试探的机会：等名额的时候不挡别人试
      const gate = breaker.gate(target.provider);
      if (gate === 'open') {
        slot.release();
        continue;
      }
      const probe = gate === 'probe';
      let reported = !probe; // 试探的结果一定要回报，否则这家会一直卡在 probing
      const report = (outcome: 'success' | 'release' | { failure: string }) => {
        reported = true;
        if (outcome === 'success') breaker.success(target.provider);
        else if (outcome === 'release') breaker.release(target.provider);
        else breaker.failure(target.provider, outcome.failure);
      };
      // 用哪个 key：这家熔断的试探、这次调用又没有别的可换时（force），用不了的 key 不看时间都能拿去试；
      // 有别的顶着就只拿到了点的（pickTarget 只在有这样的 key 时才选它）
      const force = probe && urgent;
      let key: { key: ResolvedProviderKey; probe: boolean } | undefined;
      let keyReported = true;
      // 只有拿来试探的 key 要回报：照常用的 key 这次通了，也不去清别的调用刚记下的「用不了」（那次可能更晚）
      const reportKey = (outcome: 'success' | 'release') => {
        keyReported = true;
        if (!key?.probe) return;
        if (outcome === 'success') keyPool.success(key.key.id);
        else keyPool.release(key.key.id);
      };

      try {
        let keys: ResolvedProviderKey[];
        try {
          keys = registry.apiKeys(target.provider);
        } catch (error) {
          slot.release();
          if (probe) report('release');
          return failedMessage(model, 'error', `读 API key 时出错：${errorText(error)}`);
        }
        if (keys.length > 0) {
          key = keyPool.pick(target.provider, keys, { skip, force });
          if (!key) {
            // 这家配的 key 都用不了（别的调用记下的）：熔断，按 models.fallback 换备用或排队；熔断的试探到点时，
            // 有别的可换就等 key 自己到点，没有就一个个试（pickTarget）
            slot.release();
            const last = keyFailure ?? keys.map((k) => keyPool.reason(k.id)).find((r) => r !== undefined);
            const reason = allKeysDown(keys.length, last);
            report({ failure: reason });
            notice(`${target.provider} 熔断：${reason}`);
            skip.clear();
            keyFailure = undefined;
            retries = 0;
            continue;
          }
          keyReported = !key.probe;
        }

        let result: Attempt;
        try {
          result = await attempt(meta, model, target, key?.key.key, context, options, signal, queueMs);
        } finally {
          slot.release();
        }
        account(meta, target, result);
        timing(result.timing);

        const stop = result.message.stopReason;
        if (signal.aborted && (stop === 'error' || stop === 'aborted')) {
          // 请求失败和取消同时发生：按取消算，不计重试、不熔断
          if (probe) report('release');
          reportKey('release');
          return { ...result.message, stopReason: 'aborted', errorMessage: abortReason(signal) };
        }

        const failure = classify(result.message, {
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          idle: result.idle,
          contextWindow: model.contextWindow,
        });
        if (!failure) {
          failed(meta, undefined);
          report('success');
          reportKey('success');
          return result.message;
        }
        if (failure.kind !== 'aborted')
          failed(
            meta,
            failure.kind === 'overflow'
              ? 'context'
              : failure.kind === 'model'
                ? 'model'
                : failure.kind === 'unknown'
                  ? 'unknown'
                  : 'provider',
          );
        switch (failure.kind) {
          case 'aborted':
            if (probe) report('release');
            reportKey('release');
            return result.message;
          case 'overflow':
          case 'model':
            // 供应商回了话，说明这家是通的，key 也能用
            report('success');
            reportKey('success');
            return result.message;
          case 'auth':
          case 'billing':
            if (key) {
              // 这个 key 用不了：记下来，有下一个 key 就马上换它重发，不算重试；都用不了才熔断这家
              keyReported = true;
              keyPool.failure(target.provider, key.key, failure.reason);
              skip.add(key.key.id);
              if (keyPool.available(keys, { skip, force })) {
                keyFailure = failure.reason;
                if (probe) report('release');
                notice(
                  `${target.provider} 的 API key（${keyLabel(key.key, keys)}）用不了：${failure.reason}。换下一个 key`,
                );
                continue;
              }
              skip.clear();
              keyFailure = undefined;
            }
            {
              const reason = key ? allKeysDown(keys.length, failure.reason) : failure.reason;
              report({ failure: reason });
              notice(`${target.provider} 熔断：${reason}`);
            }
            retries = 0;
            continue;
          case 'provider':
          case 'unknown': {
            // 不是 key 的问题，key 的状况不变；拿来试探的 key 交还机会
            reportKey('release');
            if (failure.kind === 'provider' && failure.throttle) throttle(target.provider, failure.throttle);
            const limit = registry.global().retries.model;
            if (failure.kind === 'provider' && (probe || retries >= limit)) {
              const reason = probe ? failure.reason : `${failure.reason}（重试 ${limit} 次仍不行）`;
              report({ failure: reason });
              notice(`${target.provider} 熔断：${reason}`);
              retries = 0;
              continue;
            }
            if (failure.kind === 'unknown') {
              // 认不出的错不当作供应商不通，也不熔断；重试几次还不行就交给角色
              if (probe) report('success');
              if (retries >= limit) return result.message;
            }
            retries++;
            const delay = Math.max(
              retryDelayMs(retries, backoff),
              failure.kind === 'provider' ? (failure.throttle?.retryAfterMs ?? 0) : 0,
            );
            // 每次重试记一笔：账本里没有出错的标记，各家多久出一次错、为什么出错只在日志里看得到
            notice(
              `${modelKey(target)} 出错，${seconds(delay)} 秒后重试（第 ${retries} 次，最多 ${limit} 次）：` +
                (failure.kind === 'provider' ? failure.reason : failure.message),
            );
            try {
              await sleep(delay, signal);
            } catch {
              return failedMessage(model, 'aborted', abortReason(signal));
            }
            continue;
          }
        }
      } finally {
        if (!reported) breaker.release(target.provider);
        if (!keyReported && key) keyPool.release(key.key.id);
      }
    }
  }

  function finish(out: AssistantMessageEventStream, message: AssistantMessage): void {
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      out.push({ type: 'error', reason: message.stopReason, error: message });
    } else {
      for (const block of message.content) {
        if (block.type !== 'toolCall' || !block.argumentsError) continue;
        const repaired = repairToolArguments(block.name, block.argumentsError);
        if (!repaired) continue;
        block.arguments = repaired.args;
        delete block.argumentsError;
        notice(`${message.provider}/${message.model} 的 ${block.name} 参数已修复：${repaired.reason}`);
      }
      out.push({ type: 'start', partial: { ...message } });
      out.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
    }
    out.end(message);
  }

  return (meta) => (agentModel, context, options) => {
    const out = createAssistantMessageEventStream();
    void run(meta, agentModel, context, options ?? {})
      .then((message) => finish(out, message))
      .catch((error: unknown) => {
        // StreamFn 的约定是不抛错：melinaStream 自己的问题也编码成一条出错的回复
        finish(out, failedMessage(agentModel, 'error', `melinaStream 出错：${errorText(error)}`));
      });
    return out;
  };
}

/** 一家的 key 都用不了时的熔断原因：只配了一个 key 的，和以前一样就写那个错 */
function allKeysDown(count: number, reason: string | undefined): string {
  if (count === 1) return reason ?? 'API key 用不了';
  return `${count} 个 API key 都用不了${reason ? `（最后一个：${reason}）` : ''}`;
}

/** 日志里怎么称呼一个 key：有名字用名字，没有就说排第几，不露 key 本身 */
function keyLabel(key: ResolvedProviderKey, keys: readonly ResolvedProviderKey[]): string {
  return key.name ?? `第 ${keys.indexOf(key) + 1} 个`;
}

/** 只返回可完整恢复的参数及原因；消息更新和日志由调用层处理。 */
function repairToolArguments(name: string, error: string): { args: JsonObject; reason: string } | undefined {
  // 原生适配器保留解析失败的原文，允许恢复完整 JSON 对象。
  const marker = '\n\nReceived arguments:\n';
  const start = error.indexOf(marker);
  if (start < 0) return;
  const raw = error.slice(start + marker.length).trimEnd();
  for (let trimmed = raw; trimmed.endsWith('}'); ) {
    trimmed = trimmed.slice(0, -1).trimEnd();
    const args = parseArgumentObject(trimmed);
    if (args) return { args, reason: '去掉尾部多余的 }' };
  }
  // 无值尾字段仅对 end_episode 容错；补一个根 } 就须能解析为非空对象。
  // 不截断字符串、嵌套对象或已写出的值，也不改变环境工具的执行参数。
  if (name !== TOOL.endEpisode) return;
  const tail = /,\s*"(?:[^"\\]|\\.)*"\s*:{0,2}\s*(?:}\s*)*$/.exec(raw);
  if (!tail) return;
  const args = parseArgumentObject(`${raw.slice(0, tail.index)}}`);
  if (args && Object.keys(args).length > 0) return { args, reason: '去掉尾部未写入值的字段并补齐根对象' };
}

function parseArgumentObject(raw: string): JsonObject | undefined {
  try {
    const args: unknown = JSON.parse(raw);
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) return args as JsonObject;
  } catch {
    // 不能恢复完整对象就保留原参数和错误，交回模型修正。
  }
  return undefined;
}

export function failedMessage(
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  stopReason: 'error' | 'aborted',
  errorMessage: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return new AbortController().signal;
  return present.length === 1 ? (present[0] as AbortSignal) : AbortSignal.any(present);
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return reason === undefined ? '已取消' : String(reason);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function recordHeaders(headers: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

/** 日志里的秒数：一位小数 */
function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

function whole(n: number | undefined): number {
  return Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0;
}
