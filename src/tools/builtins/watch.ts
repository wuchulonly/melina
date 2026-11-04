// 巡检器工具只查询冻结原文和发布；首屏及覆盖信息由上下文组装器一次生成。
import { directionLines } from '../../context/watch.ts';
import { fittingPrefix } from '../../core/bytes.ts';
import { invalid, isMelinaError } from '../../core/errors.ts';
import type { Handle, Id } from '../../core/ids.ts';
import type { ToolOutcome, ToolSessionOptions } from '../../core/interfaces/gateway.ts';
import type { StoreRecord } from '../../core/interfaces/store.ts';
import { observationSeq } from '../../core/observation-ref.ts';
import { textPage } from '../../core/text-page.ts';
import { type ObservationContextArgs, type SubmitWatchArgs, TOOL } from '../../core/tools.ts';
import {
  WATCH_CONTEXT_CALLS,
  WATCH_CORRECTION_BYTES,
  WATCH_CORRECTION_CALLS,
  WATCH_DETAIL_BYTES,
} from '../../core/watch-budget.ts';
import {
  isWatchExecution,
  latestWatch,
  normalizeWatchInput,
  validateWatchDraft,
  watchEvidence,
  watchInputText,
} from '../../projections/watch.ts';
import { watchReadStatus, watchRecordRef } from '../../projections/watch-snapshot.ts';
import { fail, messageOf, redactDeep, type ToolEnv } from '../session.ts';

type Inputs = NonNullable<ToolSessionOptions['observation']>;

export class ObservationSession {
  private readonly env: ToolEnv;
  private readonly inputs: Inputs;
  private readonly records: Map<Id, StoreRecord>;
  private readonly observations: Map<number, Id>;
  private readonly outputs = new Set<Handle>();
  private readonly seen: Set<number>;
  private readonly stateRefs: Set<Id>;
  private readonly delivered: Set<Id>;
  private readonly closing?: AbortSignal;
  private correctionBytes = 0;
  private contextCalls = 0;
  private correctionCalls = 0;
  private submissionStarted = false;
  private readonly inputWarnings = new Set<string>();
  private attempts = 0;
  private errors: string[] = [];

  constructor(env: ToolEnv, inputs: Inputs) {
    this.env = env;
    const { closing, ...frozen } = inputs;
    this.inputs = structuredClone(frozen);
    if (inputs.contextLimit !== undefined && (!Number.isSafeInteger(inputs.contextLimit) || inputs.contextLimit < 0))
      throw invalid('观察者补查预算必须是非负整数');
    this.closing = closing;
    const { request, input } = this.inputs;
    if (request.branchId !== env.caller.branchId) throw new Error('观察窗口与调用分支不一致');
    env.observationUntilSeq = request.untilSeq;
    this.records = new Map(input.records.map((r) => [r.record.id, r]));
    this.observations = new Map(
      input.records.flatMap((r) => (r.kind === 'observation' ? [[r.record.seq, r.record.id] as const] : [])),
    );
    this.stateRefs = new Set(input.stateRefs);
    this.seen = new Set(input.covered);
    this.delivered = new Set(
      [...input.delivered, ...(request.previous?.deliveredRefs ?? [])].filter((id) => this.records.has(id)),
    );
    for (const material of env.run.goal.materials) this.outputs.add(material.handle);
    for (const r of input.records) if (r.kind === 'observation') this.outputs.add(r.record.output);
  }

  private resolve(ref: string): Id {
    const seq = observationSeq(ref);
    return seq === undefined ? ref : (this.observations.get(seq) ?? ref);
  }

  private refOf = (id: Id): string => {
    const record = this.records.get(id);
    return record ? watchRecordRef(record) : id;
  };

  normalizeArguments(raw: unknown): unknown {
    this.submissionStarted = true;
    const normalized = normalizeWatchInput(raw, { records: this.records, resolve: (ref) => this.resolve(ref) });
    for (const warning of normalized.warnings) this.inputWarnings.add(warning);
    if (normalized.errors.length) {
      this.attempts++;
      throw invalid(this.reject(normalized.errors).content);
    }
    return normalized.input;
  }

  contextAvailable(): boolean {
    return (
      this.contextCalls < (this.inputs.contextLimit ?? WATCH_CONTEXT_CALLS) ||
      (this.submissionStarted && this.correctionCalls < WATCH_CORRECTION_CALLS)
    );
  }

  async context(args: ObservationContextArgs): Promise<ToolOutcome> {
    const contextLimit = this.inputs.contextLimit ?? WATCH_CONTEXT_CALLS;
    if (this.contextCalls < contextLimit) this.contextCalls++;
    else if (this.submissionStarted && this.correctionCalls < WATCH_CORRECTION_CALLS) this.correctionCalls++;
    else
      return {
        ...this.result({
          ...this.status(),
          message: '本轮补查预算已用完，请单独调用 observation_submit；缺失细节写入 doubt。',
        }),
        isError: true,
      };
    const refs = [...new Set([...(args.evidenceRefs ?? []), ...(args.contextRefs ?? [])])];
    if (!refs.length && args.assessmentIds === undefined && !args.query) {
      if (this.closing?.aborted) return this.result(this.status());
      return this.result({
        ...this.status(),
        inspectContext: this.inputs.input.inspectContext,
      });
    }
    const budget = this.closing?.aborted
      ? Math.min(WATCH_DETAIL_BYTES, WATCH_CORRECTION_BYTES - this.correctionBytes)
      : WATCH_DETAIL_BYTES;
    if (budget < 1024) return fail('已进入收尾阶段，请根据已有摘要提交判断');
    const offset = args.offset ?? 1;
    const column = args.column ?? 0;
    const limit = args.limit ?? 200;
    const covered: number[] = [];
    const delivered: Id[] = [];
    const body: Record<string, unknown> = {};
    const count = Math.max(1, refs.length + (args.assessmentIds?.length ?? 0));
    const rowBudget = Math.floor((budget - Buffer.byteLength(JSON.stringify(this.status())) - 512) / count);
    const read = (text: string, data: Record<string, unknown>, totalLines?: number) => {
      const lines = text.split('\n');
      const selected = totalLines === undefined ? lines.slice(offset - 1, offset - 1 + limit).join('\n') : text;
      const base = { ...data, offset, column, totalLines: totalLines ?? lines.length };
      return {
        ...data,
        ...textPage(
          selected,
          { offset, column },
          base.totalLines,
          (page) => Buffer.byteLength(JSON.stringify({ ...base, ...page }), 'utf8') <= rowBudget,
        ),
      };
    };
    const evidence: Record<string, unknown>[] = [];
    for (const ref of refs) {
      const record = this.records.get(this.resolve(ref));
      const handle =
        record?.kind === 'observation'
          ? record.record.output
          : this.outputs.has(ref as Handle)
            ? (ref as Handle)
            : undefined;
      if (!record && !handle) {
        evidence.push({ ref, unavailable: 'unknown_evidence' });
        continue;
      }
      const part = args.part ?? (handle ? 'output' : 'record');
      const data = {
        ref: record ? watchRecordRef(record) : ref,
        ...(record ? { kind: record.kind, seq: record.record.seq } : {}),
        part,
      };
      let row: ReturnType<typeof read>;
      if (part === 'output') {
        if (!handle) {
          evidence.push({ ...data, unavailable: 'no_output' });
          continue;
        }
        let raw: { text: string; totalLines: number };
        try {
          raw = await this.env.deps.artifacts.readLines(this.env.run.id, handle, { offset, limit });
        } catch {
          evidence.push({ ...data, unavailable: 'artifact_unavailable' });
          continue;
        }
        row = read(this.redact(raw.text), { ...data, handle }, raw.totalLines);
      } else {
        if (!record) {
          evidence.push({ ...data, unavailable: 'unknown_record' });
          continue;
        }
        const fields = Object.fromEntries(
          Object.entries(record.record)
            .filter(([key]) => !['id', 'runId', 'branchId', 'snapshot'].includes(key))
            .map(([key, value]) => [key, key === 'ref' && typeof value === 'string' ? this.refOf(value) : value]),
        );
        row = read(
          this.redact(
            record.kind === 'observation' && record.record.role === 'watcher'
              ? watchInputText(record.record.tool, fields)
              : JSON.stringify(fields),
          ),
          data,
        );
      }
      evidence.push(row);
      if (record && row.text.length) {
        delivered.push(record.record.id);
        covered.push(...this.recordSeqs(record));
      }
    }
    if (refs.length) body.evidence = evidence;
    if (args.assessmentIds !== undefined) {
      const directions = this.inputs.request.previous?.directions ?? [];
      if (!args.assessmentIds.length) {
        const rows = directions
          .slice(offset - 1, offset - 1 + Math.min(limit, 40))
          .map((d) => ({ id: d.id, status: d.status, retired: d.retired, direction: short(d.direction, 120) }));
        while (rows.length && Buffer.byteLength(JSON.stringify(rows)) > budget - 2048) rows.pop();
        body.assessments = rows;
        if (offset - 1 + rows.length < directions.length) body.nextOffset = offset + rows.length;
      } else
        body.assessments = args.assessmentIds.map((id) => {
          const direction = directions.find((d) => d.id === id);
          return direction
            ? read(this.redact(directionLines(direction, undefined, this.refOf).join('\n')), { id, kind: 'direction' })
            : { id, unavailable: 'unknown_assessment' };
        });
    }
    if (args.query) {
      const query = args.query;
      const terms = query.text?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const found = [...this.records.values()]
        .filter(
          (r) =>
            r.record.seq < (query.beforeSeq ?? Infinity) &&
            terms.every((term) => JSON.stringify(r.record).toLowerCase().includes(term)),
        )
        .sort((a, b) => b.record.seq - a.record.seq)
        .slice(0, query.limit ?? 20);
      const rows: Record<string, unknown>[] = [];
      for (const r of found) {
        const item = r.record;
        const text = 'summary' in item ? item.summary : 'text' in item ? item.text : 'claim' in item ? item.claim : '';
        const row = {
          ...(isWatchExecution(r) ? { id: watchRecordRef(r) } : { contextRef: watchRecordRef(r) }),
          kind: r.kind,
          seq: item.seq,
          text: short(this.redact(text), 240),
        };
        if (Buffer.byteLength(JSON.stringify({ ...body, records: [...rows, row] })) > budget - 2048) break;
        rows.push(row);
        delivered.push(item.id);
        covered.push(...this.recordSeqs(r));
      }
      body.records = rows;
      if (rows.length) body.nextBeforeSeq = rows.at(-1)?.seq;
    }
    const result = this.result({ ...this.status(covered), ...body });
    const bytes = Buffer.byteLength(result.content, 'utf8');
    if (bytes > budget) throw invalid('读取结果超过预算，请减少本次查询的引用数量');
    for (const seq of covered) this.seen.add(seq);
    for (const id of delivered) this.delivered.add(id);
    if (this.closing?.aborted) this.correctionBytes += bytes;
    return result;
  }

  private stateProgress() {
    return watchReadStatus(this.inputs.request, this.inputs.input, this.seen).state ?? { seenSeq: 0, complete: true };
  }

  private progress() {
    const progress = watchReadStatus(this.inputs.request, this.inputs.input, this.seen).progress;
    return { untilSeq: progress.coveredUntilSeq, toolCalls: progress.toolCalls };
  }

  /** 同一条提示的 input 与 inbox 共用展示进度，无需分别翻页。 */
  private recordSeqs(record: StoreRecord): number[] {
    if (record.kind !== 'input' && record.kind !== 'inbox') return [record.record.seq];
    const ref = record.kind === 'inbox' ? record.record.ref : record.record.id;
    if (!ref) return [record.record.seq];
    return [
      record.record.seq,
      ...[...this.records.values()]
        .filter((r) => r.record.id === ref || (r.kind === 'inbox' && r.record.ref === ref))
        .map((r) => r.record.seq),
    ];
  }

  private status(extra: number[] = []): Record<string, unknown> {
    const limit = this.inputs.contextLimit ?? WATCH_CONTEXT_CALLS;
    const remaining = Math.max(0, limit - this.contextCalls);
    const correctionRemaining = this.submissionStarted ? Math.max(0, WATCH_CORRECTION_CALLS - this.correctionCalls) : 0;
    const submit = this.closing?.aborted || remaining + correctionRemaining === 0;
    return {
      ...watchReadStatus(this.inputs.request, this.inputs.input, new Set([...this.seen, ...extra])),
      phase: submit ? 'submit' : 'read',
      contextBudget: { limit, used: this.contextCalls, remaining, correctionRemaining },
      submissionAttempts: this.attempts,
      lastErrors: this.errors.slice(0, 3).map((error) => short(error, 120)),
      errorCount: this.errors.length,
      ...(submit
        ? { submissionRequired: true, message: '请根据已有材料单独调用 observation_submit；未展示材料留给下一轮。' }
        : {}),
    };
  }

  private redact(text: string): string {
    return this.env.deps.redactor.redact(text);
  }

  async submit(input: SubmitWatchArgs, signal: AbortSignal): Promise<ToolOutcome> {
    this.attempts++;
    const { env } = this;
    const { request, model } = this.inputs;
    if (signal.aborted) return this.reject(['本轮已中断，没有发布']);
    const revision = request.previous?.rev ?? 0;
    if ((latestWatch(env.deps.queries, env.run.id, request.branchId)?.rev ?? 0) !== revision)
      return this.reject(['本轮上一版已被新发布取代，窗口已过期']);
    // 引用只受冻结边界约束，原文展开进度不参与草稿或扩展校验。
    env.observationUntilSeq = request.untilSeq;
    env.observationStateRefs = this.stateRefs;
    const checked = validateWatchDraft(this.inputs.request.previous, input, {
      records: this.records,
      resolve: (ref) => this.resolve(ref),
    });
    let { draft } = checked;
    const { errors, warnings } = checked;
    warnings.unshift(...this.inputWarnings);
    try {
      // 地图失败也聚合扩展错误；此时不剥离线索，修正后的整批输入仍由同一窗口校验。
      const coreValid = errors.length === 0;
      for (const extension of env.deps.extensions ?? []) {
        if (!extension.roles.includes('watcher') || !extension.observation?.validate) continue;
        const field = extension.observation.field;
        const fields = draft as unknown as Record<string, unknown>;
        const value = fields[field];
        if (value === undefined || (Array.isArray(value) && !value.length)) continue;
        signal.throwIfAborted();
        const issues = await extension.observation.validate(env, value, signal);
        if (!issues.length) continue;
        if (!coreValid || !Array.isArray(value)) {
          errors.push(...issues);
          continue;
        }
        const kept: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          signal.throwIfAborted();
          const issues = await extension.observation.validate(env, [value[i]], signal);
          if (issues.length)
            warnings.push(`${field}[${i}] 已省略：${issues.map((error) => short(error, 240)).join('；')}`);
          else kept.push(value[i]);
        }
        fields[field] = kept;
        if (kept.length) errors.push(...(await extension.observation.validate(env, kept, signal)));
      }
      // 扩展可选项的剥离也必须通过最终的宿主约束；预检阶段没有副作用。
      for (const guard of env.deps.submissionGuards ?? []) {
        const reason = await guard(env, { tool: TOOL.submitWatch, args: draft }, signal);
        if (reason !== undefined) errors.push(typeof reason === 'string' ? reason : reason.again);
      }
      if (errors.length) return this.reject(errors);
      const extra: Record<string, unknown> = {};
      for (const extension of env.deps.extensions ?? []) {
        if (!extension.roles.includes('watcher') || !extension.observation) continue;
        const field = extension.observation.field;
        const value = (draft as unknown as Record<string, unknown>)[field];
        if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
        signal.throwIfAborted();
        const outcome = await extension.run(env, extension.observation.arguments(value), signal);
        if (outcome.isError) return this.reject([`${field}: ${outcome.content}`]);
        extra[field] = outcome.content;
      }
      signal.throwIfAborted();
      if ((latestWatch(env.deps.queries, env.run.id, request.branchId)?.rev ?? 0) !== revision)
        return this.reject(['本轮窗口已过期，没有发布']);
      draft = redactDeep(draft, (text) => env.deps.redactor.redact(text));
      // 模型主动引用的冻结记录也记入宿主进度；中间未展示的摘要仍留给下一轮。
      for (const id of watchEvidence(draft)) {
        const record = this.records.get(id);
        if (!record) continue;
        this.delivered.add(id);
        for (const seq of this.recordSeqs(record)) this.seen.add(seq);
      }
      const progress = this.progress();
      const note = env.deps.writer.recordWatch({
        runId: env.run.id,
        branchId: request.branchId,
        basedOnSeq: progress.untilSeq,
        ...(request.state
          ? {
              state: {
                untilSeq: request.state.untilSeq,
                seenSeq: this.stateProgress().seenSeq,
                refs: [...this.stateRefs].filter((id) => this.seen.has(this.records.get(id)?.record.seq ?? -1)),
              },
            }
          : {}),
        delivered: { untilSeq: request.untilSeq, refs: [...this.delivered].filter((id) => !this.stateRefs.has(id)) },
        toolCalls: progress.toolCalls,
        model,
        draft,
      });
      env.state.publishedWatch = note;
      env.state.closed = { tool: TOOL.submitWatch, args: draft };
      this.errors = [];
      if (warnings.length) {
        try {
          env.deps.onNotice?.(
            this.redact(`观察者调整后发布 ${env.run.id}/${request.branchId}：${warnings.join('；')}`),
          );
        } catch {
          /* 日志不能回滚已发布的版本 */
        }
      }
      return {
        ...this.result({ ok: true, revision: note.rev, ...extra, ...(warnings.length ? { warnings } : {}) }),
        terminate: true,
      };
    } catch (error) {
      const validation = isMelinaError(error) && ['invalid', 'forbidden', 'not_found'].includes(error.code);
      return this.reject([...errors, messageOf(error)], validation ? 'validation' : 'storage');
    }
  }

  private result(value: unknown): ToolOutcome {
    return { content: this.redact(JSON.stringify(value)), isError: false };
  }

  private reject(errors: string[], failure: 'validation' | 'storage' = 'validation'): ToolOutcome {
    this.errors = [...new Set(errors.map((error) => this.redact(error)))];
    return {
      ...this.result({
        ok: false,
        failure,
        errors: this.errors.slice(0, 12).map((error) => short(error, 600)),
        errorCount: this.errors.length,
        message:
          failure === 'validation'
            ? '这一版没收下；按错误修正后单独调用 observation_submit。'
            : '发布未完成：运行或存储失败，恢复后原样重试会去重。',
      }),
      isError: true,
    };
  }
}

export const missingObservationSession = (): ToolOutcome => fail('观察工具需要宿主提供本轮固定的输入窗口');

function short(text: string, bytes: number): string {
  return fittingPrefix(text, (prefix) => Buffer.byteLength(prefix, 'utf8') <= bytes);
}
