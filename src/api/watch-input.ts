import { fittingPrefix } from '../core/bytes.ts';
import type { Id } from '../core/ids.ts';
import type { WatchRequest } from '../core/interfaces/context.ts';
import type { CallerContext } from '../core/interfaces/gateway.ts';
import type { Branch, Observation, Run } from '../core/types.ts';
import { WATCH_HTTP_BYTES } from '../core/watch-budget.ts';
import { WATCH_INPUT } from '../core/watch-input.ts';
import { bet0WatchEnabled } from '../projections/bet0.ts';
import type { InfraDeps } from './assemble.ts';
import type { RuntimeExtension } from './extensions.ts';

interface Speech {
  caller: CallerContext;
  text: string;
}

type Deps = Pick<InfraDeps, 'queries' | 'writer' | 'artifacts'> & {
  redactor: Pick<InfraDeps['redactor'], 'redact'>;
  log: Pick<InfraDeps['log'], 'warn'>;
};

/** 把外部状态冻结成可引用的 RunStore 材料；上下文组装仍是确定的纯读取。 */
export class WatchInputs {
  private readonly speech = new Map<Id, Speech[]>();
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  publicText(caller: CallerContext, text: string): void {
    if (caller.role !== 'explorer' || !caller.branchId) return;
    const branch = this.deps.queries.getBranch(caller.branchId);
    if (!branch || this.deps.queries.getBet(branch.betId)?.kind !== 'direct') return;
    const run = this.deps.queries.getRun(branch.runId);
    if (!run || !bet0WatchEnabled(this.deps.queries, run, branch.betId) || !text.trim()) return;
    const entries = [
      ...(this.speech.get(branch.id) ?? []),
      { caller, text: this.deps.redactor.redact(text).slice(-64_000) },
    ];
    let size = entries.reduce((sum, entry) => sum + entry.text.length + 2, -2);
    // 发言是辅助材料，保留最近 64K 字符；原始工具观测始终完整落库。
    while (size > 64_000 && entries.length > 1) size -= (entries.shift()?.text.length ?? 0) + 2;
    this.speech.set(branch.id, entries);
  }

  drop(runId: Id): void {
    for (const [branchId, entries] of this.speech) {
      if (entries[0]?.caller.runId === runId) this.speech.delete(branchId);
    }
  }

  async collect(run: Run, branchId: Id, extensions: readonly RuntimeExtension[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const branch = this.deps.queries.getBranch(branchId);
    if (!branch) return;
    if (!bet0WatchEnabled(this.deps.queries, run, branch.betId)) return;
    const speech = this.speech.get(branch.id);
    if (speech?.length) {
      try {
        await this.save(
          branch,
          WATCH_INPUT.speech,
          speech.map((entry) => entry.text).join('\n\n'),
          {},
          false,
          speech.at(-1)?.caller,
        );
        // 只确认已持久化的那一批；存储期间新到的发言留给下一轮，失败则原批次仍在。
        const saved = new Set(speech);
        const pending = (this.speech.get(branch.id) ?? []).filter((entry) => !saved.has(entry));
        if (pending.length) this.speech.set(branch.id, pending);
        else this.speech.delete(branch.id);
      } catch (error) {
        this.deps.log.warn('主代理可见发言存档失败，保留待重试');
        throw error;
      }
    }
    for (const [index, extension] of extensions.entries()) {
      if (!extension.watcherInput) continue;
      let text: string | undefined;
      try {
        text = await extension.watcherInput(run.id, branch.id, {
          signal,
          observations: () => this.observations(branch),
          save: (tool, text, args, deduplicate) => {
            signal.throwIfAborted();
            return this.save(branch, tool, text, args, deduplicate);
          },
        });
      } catch {
        signal.throwIfAborted();
        text = '领域扩展状态暂不可用；不能把缺失状态当成空状态。';
      }
      if (text) await this.save(branch, WATCH_INPUT.extension, text, { extension: index });
    }
    signal.throwIfAborted();
  }

  /** 已冻结窗口的只读补充；不会改变截止点、工具计数或 RunStore。 */
  async read(run: Run, request: WatchRequest, signal: AbortSignal): Promise<WatchRequest> {
    signal.throwIfAborted();
    const branch = this.deps.queries.getBranch(request.branchId);
    if (!branch) return request;
    const { untilSeq } = request;
    const observations = this.observations(branch, untilSeq).filter((o) => o.seq > (request.previous?.basedOnSeq ?? 0));
    const candidates = observations
      .filter(
        (o) =>
          o.tool === WATCH_INPUT.http ||
          (o.role === 'explorer' &&
            o.tool !== WATCH_INPUT.speech &&
            /https?:\/\/|\b(?:curl|wget|HTTP\/\d)/i.test(`${JSON.stringify(o.args)}\n${o.summary}`)),
      )
      .slice(-12);
    const results = await Promise.allSettled(
      candidates.map(async (o) => {
        const raw = await this.deps.artifacts.readLines(run.id, o.output, { limit: 100 });
        return { observation: o.id, output: o.output, text: raw.text };
      }),
    );
    const http: NonNullable<WatchRequest['http']> = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { text, ...ref } = result.value;
      const fits = (prefix: string) =>
        Buffer.byteLength(JSON.stringify([...http, { ...ref, text: prefix }]), 'utf8') <= WATCH_HTTP_BYTES;
      if (!fits('')) break;
      const excerpt = fittingPrefix(text, fits);
      if (excerpt) http.push({ ...ref, text: excerpt });
      if (excerpt.length < text.length) break;
    }
    return {
      ...request,
      http,
    };
  }

  private observations(branch: Branch, until = Number.POSITIVE_INFINITY): Observation[] {
    return this.deps.queries
      .events({ runId: branch.runId, since: 0, types: ['observation.created'] })
      .flatMap((e) =>
        e.type === 'observation.created' && e.seq <= until && e.data.branchId === branch.id ? [e.data] : [],
      );
  }

  private async save(
    branch: Branch,
    tool: string,
    raw: string,
    args: unknown,
    deduplicate = true,
    caller?: CallerContext,
  ): Promise<Id> {
    const text = this.deps.redactor.redact(raw);
    const output = await this.deps.artifacts.put(branch.runId, text);
    const previous = deduplicate
      ? this.observations(branch)
          .filter((o) => o.tool === tool && sameValue(o.args, args))
          .at(-1)
      : undefined;
    if (previous?.output === output) return previous.id;
    return this.deps.writer.appendObservation(
      {
        runId: branch.runId,
        branchId: branch.id,
        episode: caller?.episode ?? branch.episode,
        role: caller?.role ?? 'watcher',
        tool,
        args: JSON.parse(this.deps.redactor.redact(JSON.stringify(args))),
        summary: text,
        output,
        snapshot: caller?.snapshot ?? branch.lastSnapshot,
      },
      { countsAsToolCall: false },
    ).id;
  }
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA).filter((key) => recordA[key] !== undefined);
  const keysB = Object.keys(recordB).filter((key) => recordB[key] !== undefined);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) => Object.hasOwn(recordB, key) && sameValue(recordA[key], recordB[key]))
  );
}
