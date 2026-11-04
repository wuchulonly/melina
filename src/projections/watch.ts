// 方向是唯一事实来源。模型提交一层证据，宿主生成尝试、滚动归档并投影短地图。
// 持久化之前保留执行证据和分支可见性的强约束。

import { invalid } from '../core/errors.ts';
import type { Id } from '../core/ids.ts';
import type { RunStoreQueries, StoreRecord } from '../core/interfaces/store.ts';
import { SemanticDigest } from '../core/telemetry.ts';
import { type SubmitWatchArgs, SubmitWatchInput } from '../core/tools.ts';
import type { WatchAttempt, WatchBody, WatchDirection, WatchNote } from '../core/types.ts';
import { issues } from '../core/validate.ts';
import { type FeedbackSource, WATCH_INPUT, WatchPlatform } from '../core/watch-input.ts';
import { platformObservations, watchEvents } from './read-model.ts';

/** 活跃尝试的展示窗口；超出部分自动归档，完整历史仍可查询。 */
export const WATCH_MAX_ATTEMPTS = 20;

/** 给巡检器看的上一版里，每个在做的方向列最近几次尝试；更早的用 observation_context 按编号看 */
export const WATCH_RECENT_ATTEMPTS = 3;

/** 来源用于宿主追溯；模型只引用本分支回执，不把来源 ID 或输出句柄当作可见证据。 */
export function watchSourceText(source: FeedbackSource | undefined): string {
  if (!source) return '宿主尚未取得原始观测来源';
  return `${[source.tool, source.command].filter(Boolean).join('：') || '宿主已记录来源'}（仅供追溯；证据请引用本分支平台回执）`;
}

/** 首屏、原文与按记录查询使用同一展示规则；原始 args 保留完整来源。 */
export function watchInputText(tool: string, value: unknown): string {
  return JSON.stringify(value, (key, item) =>
    key === 'source' && (tool === WATCH_INPUT.platform || tool === WATCH_INPUT.receipt) ? watchSourceText(item) : item,
  );
}

/** flag 及产出来源只来自宿主回执；本分支关联与产出分支的方向分别保存。 */
export function platformFlags(
  queries: RunStoreQueries,
  runId: Id,
  branchId: Id,
  until: number,
  body: WatchBody,
  previous?: WatchBody,
  stateRefs: ReadonlySet<Id> = new Set(),
): NonNullable<WatchBody['flags']> {
  let found: { observation: Id; platform: WatchPlatform } | undefined;
  for (const o of platformObservations(queries, runId, branchId, until, stateRefs)) {
    if (issues(WatchPlatform, o.args).length > 0) continue;
    found = { observation: o.id, platform: o.args as WatchPlatform };
    break;
  }
  const latest = found;
  if (!latest) return [];
  const sourceUntil = Math.max(until, ...[...stateRefs].map((id) => queries.getRecord(id)?.record.seq ?? 0));
  return latest.platform.accepted.map((flag) => {
    const old = previous?.flags?.find((f) => f.id === flag.id);
    const origin =
      flag.source?.runId === runId && flag.source.branchId === branchId ? flag.source.observationId : undefined;
    const linked = body.directions
      .filter(
        (d) =>
          d.status === 'works' &&
          [...d.evidence, ...allWatchAttempts(d).flatMap((a) => a.evidence)].some(
            (id) => id === flag.receipt || id === old?.receipt || id === origin,
          ),
      )
      .map((d) => d.id);
    const source = flag.source;
    const originRecord = source ? queries.getObservation(source.observationId) : undefined;
    const sourceBody = source
      ? source.runId === runId && source.branchId === branchId
        ? body
        : latestWatch(queries, source.runId, source.branchId, sourceUntil)
      : undefined;
    const sourceReceipt =
      source?.runId === runId && source.branchId === branchId
        ? (flag.receipt ?? old?.receipt)
        : sourceBody?.flags?.find((f) => f.id === flag.id)?.receipt;
    const sourceDirections =
      source &&
      originRecord?.runId === source.runId &&
      originRecord.branchId === source.branchId &&
      isWatchExecution({ kind: 'observation', record: originRecord }) &&
      originRecord.seq <= sourceUntil
        ? (sourceBody?.directions ?? [])
            .filter((d) =>
              [...d.evidence, ...allWatchAttempts(d).flatMap((a) => a.evidence)].some(
                (id) => id === source.observationId || id === sourceReceipt,
              ),
            )
            .map((d) => d.id)
        : [];
    const sameSource =
      source &&
      old?.source?.runId === source.runId &&
      old.source.branchId === source.branchId &&
      old.source.observationId === source.observationId;
    return {
      ...flag,
      ...(source
        ? {
            source: {
              ...source,
              directionIds: unique([...(sameSource ? (old.source?.directionIds ?? []) : []), ...sourceDirections]),
            },
          }
        : {}),
      receipt: flag.receipt ?? old?.receipt ?? latest.observation,
      dependsOn: unique([...(old?.dependsOn ?? []), ...linked]),
    };
  });
}

/** 读出来的一版：加上写它的那条 watch.noted 事件的 seq（这一版是什么时候写上 RunStore 的） */
export type WatchVersion = WatchNote & { seq: number };

/** 这条分支的各版看法，按先后（rev 从 1 起）；给了 untilSeq 就只要那一刻以前（含）写上的 */
export function watchVersions(
  queries: Pick<RunStoreQueries, 'readModel'>,
  runId: Id,
  branchId: Id,
  untilSeq?: number,
): WatchVersion[] {
  return watchEvents(queries, runId, branchId, untilSeq).map((e) => ({ ...e.data, seq: e.seq }));
}

/** 最新的一版（给了 untilSeq 就是那一刻以前的最新一版）；还没有就是 undefined */
export function latestWatch(
  queries: Pick<RunStoreQueries, 'readModel'>,
  runId: Id,
  branchId: Id,
  untilSeq?: number,
): WatchVersion | undefined {
  const event = watchEvents(queries, runId, branchId, untilSeq, true)[0];
  return event ? { ...event.data, seq: event.seq } : undefined;
}

/** 一版引用的全部证据 id，去重并保留出现顺序。 */
export function watchEvidence(
  body: Pick<WatchBody, 'telemetry'> & {
    directions: Pick<WatchDirection, 'evidence' | 'attempts' | 'archivedAttempts'>[];
  },
): Id[] {
  const ids = [
    ...body.directions.flatMap((d) => [...d.evidence, ...allWatchAttempts(d).flatMap((a) => a.evidence)]),
    ...(body.telemetry?.evidence ?? []),
  ];
  return unique(ids);
}

/** 执行依据分类由输入展示与提交校验共用，避免两套规则漂移。 */
export function isWatchExecution(record: StoreRecord | undefined): boolean {
  if (record?.kind !== 'observation') return false;
  const o = record.record;
  return (
    (o.role === 'explorer' && !(Object.values(WATCH_INPUT) as string[]).includes(o.tool)) ||
    (o.role === 'watcher' && (o.tool === WATCH_INPUT.receipt || o.tool === WATCH_INPUT.http))
  );
}

export function allWatchAttempts(d: Pick<WatchDirection, 'attempts' | 'archivedAttempts'>): WatchAttempt[] {
  return [...(d.archivedAttempts ?? []), ...d.attempts];
}

/** 只为新增执行依据保存一条结果快照；重述结论或重排证据不会增加尝试次数。 */
function recordAttempts(
  previous: WatchBody | undefined,
  draft: SubmitWatchArgs,
  recordOf: (id: Id) => StoreRecord | undefined,
): SubmitWatchArgs {
  return {
    ...draft,
    directions: draft.directions.map((d) => {
      if (d.status === 'untried' || d.attempts.length || !d.result.trim()) return d;
      const old = previous?.directions.find((item) => item.id === d.id);
      const history = old ? allWatchAttempts(old) : [];
      const known = new Set(history.flatMap((a) => a.evidence));
      const evidence = unique(d.evidence.filter((id) => !known.has(id) && isWatchExecution(recordOf(id))));
      if (!evidence.length) return d;
      const next = history.length + 1;
      return { ...d, attempts: [{ id: `t${next}`, action: d.direction, result: d.result, evidence }] };
    }),
  };
}

/**
 * 每次实际尝试至少有一条执行记录或宿主回执；发言、任务、提示和状态摘要只能补充判断，不能证明执行过。
 * 只查本轮新增的记录；已发布历史不重复校验。
 * 调用方负责把查询限制在本分支的冻结窗口内。
 */
export function watchExecutionIssues(
  body: Pick<SubmitWatchArgs, 'directions' | 'telemetry'>,
  recordOf: (id: Id) => StoreRecord | undefined,
): string[] {
  const errors: string[] = [];
  for (const id of body.telemetry?.evidence ?? []) {
    if (!recordOf(id)) errors.push(`telemetry 的证据 ${id} 不在本轮冻结的可见窗口内`);
  }
  for (const d of body.directions) {
    for (const a of d.attempts) {
      if (!a.evidence.some((id) => isWatchExecution(recordOf(id))))
        errors.push(
          `方向 ${d.id} 的尝试 ${a.id} 缺少执行依据：请在方向的 evidence 中引用已提供的工具执行记录、平台回执或 HTTP 记录`,
        );
    }
  }
  return errors;
}

/** 保存新增执行结果；判断不依赖原文展开进度，也不因重试或收尾而改写。 */
export function normalizeWatchDraft(
  previous: WatchBody | undefined,
  draft: SubmitWatchArgs,
  recordOf?: (id: Id) => StoreRecord | undefined,
): { draft: SubmitWatchArgs; warnings: string[] } {
  const warnings: string[] = [];
  if (recordOf) draft = recordAttempts(previous, draft, recordOf);
  if (recordOf) {
    draft = {
      ...draft,
      directions: draft.directions.map((d) => {
        const old = previous?.directions.find((item) => item.id === d.id);
        const tried = d.attempts.length > 0 || !!(old && allWatchAttempts(old).length);
        if (d.status === 'untried' && tried) {
          warnings.push(`方向 ${d.id} 已有真实尝试，untried 已修正为 unclear`);
          return { ...d, status: 'unclear' };
        }
        if (d.status === 'trying' && !tried) {
          warnings.push(`方向 ${d.id} 尚无已落库的执行依据，trying 已修正为 unclear，保留原描述`);
          return { ...d, status: 'unclear' };
        }
        return d;
      }),
    };
  }
  return { draft, warnings };
}

/**
 * 草稿合不合格：每一处不合格写一句给巡检器看的话，合格是空数组。
 * 先查草稿编号，再按合并后的方向检查尝试和矛盾原话
 */
export function watchIssues(previous: WatchBody | undefined, draft: SubmitWatchArgs): string[] {
  const issues: string[] = [];
  if (draft.telemetry) issues.push(...telemetryIssues(draft.telemetry));
  const seen = new Set<string>();
  for (const d of draft.directions) {
    if (seen.has(d.id)) issues.push(`方向 ${d.id} 在 directions 里写了两次`);
    seen.add(d.id);
    const attempts = new Set<string>();
    for (const a of d.attempts) {
      if (attempts.has(a.id)) issues.push(`方向 ${d.id} 的尝试 ${a.id} 写了两次`);
      attempts.add(a.id);
    }
  }
  const next = combine(previous, draft);
  for (const d of next.directions) {
    if (d.retired && !seen.has(d.id)) continue;
    if (d.status !== 'untried' && d.status !== 'unclear' && allWatchAttempts(d).length === 0)
      issues.push(
        `方向 ${d.id} 的状态是 ${d.status}，要至少一次尝试：请在 evidence 中引用执行依据，并在 result 写明实测条件和结果；尚未尝试写 untried，无法确认执行写 unclear`,
      );
  }
  if (draft.tension.length === 1) issues.push('tension 要么给空数组，要么正好两句互相矛盾的原话');
  return issues;
}

/** 草稿和上一版合并成这一版的内容（见文件开头）；草稿不合格就抛 invalid（巡检器交的时候已经核对过，这里兜底） */
export function mergeWatch(previous: WatchBody | undefined, draft: SubmitWatchArgs): WatchBody {
  const issues = watchIssues(previous, draft);
  if (issues.length > 0) throw invalid(`巡检器的看法不合格：${issues.join('；')}`);
  return combine(previous, draft);
}

/** 工具预检同时报告结构关系与执行依据问题；不写入，也不因第一类错误而跳过另一类。 */
export function watchSubmissionIssues(
  previous: WatchBody | undefined,
  draft: SubmitWatchArgs,
  recordOf: (id: Id) => StoreRecord | undefined,
): string[] {
  return [...watchIssues(previous, draft), ...watchExecutionIssues(draft, recordOf)];
}

interface WatchEvidenceWindow {
  records: ReadonlyMap<Id, StoreRecord>;
  resolve: (ref: string) => Id;
}

/** 只剥离与有效执行依据同列表的未知引用，不按相邻序号或相似文本猜测。 */
function resolveWatchEvidence(ids: string[], owner: string, window: WatchEvidenceWindow, warnings: string[]): Id[] {
  const resolved = unique(ids.map(window.resolve));
  if (!resolved.some((id) => isWatchExecution(window.records.get(id)))) return resolved;
  return resolved.filter((id) => {
    if (window.records.has(id)) return true;
    warnings.push(`${owner} 的证据 ${id} 不在本轮可见证据中，已忽略，保留其余有效依据`);
    return false;
  });
}

/** schema 前的有限整理：正文中的明确执行引用可补入漏填的 evidence；显式空数组保持原义。 */
export function normalizeWatchInput(
  raw: unknown,
  window: WatchEvidenceWindow,
): { input: unknown; warnings: string[]; errors: string[] } {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { input: raw, warnings: [], errors: [] };
    }
  }
  const input = structuredClone(raw);
  const warnings: string[] = [];
  const errors: string[] = [];
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const refs = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === 'string');
  if (!object(input)) return { input, warnings, errors };
  if (Array.isArray(input.directions)) {
    for (const d of input.directions) {
      if (!object(d) || !('status' in d)) continue;
      if (d.evidence === undefined) {
        const cited =
          typeof d.result === 'string'
            ? [...d.result.matchAll(/(?<![A-Za-z0-9_])o[1-9][0-9]{0,15}(?![A-Za-z0-9_])/g)].map((match) => match[0])
            : [];
        const recoverable = cited.some((ref) => isWatchExecution(window.records.get(window.resolve(ref))));
        d.evidence = recoverable ? cited : [];
        if (recoverable) warnings.push(`方向 ${d.id} 的 evidence 已从 result 中明确引用的执行短码补齐`);
        else
          for (const ref of cited) {
            if (!window.records.has(window.resolve(ref)))
              errors.push(`方向 ${d.id} 的 result 引用 ${ref} 不在本轮可见证据中，无法补齐 evidence`);
          }
      }
      if (refs(d.evidence)) {
        d.evidence = resolveWatchEvidence(d.evidence, `方向 ${d.id}`, window, warnings);
        for (const id of d.evidence as string[]) {
          if (!window.records.has(id))
            errors.push(`引用的 ${id} 不在本轮可见证据中，请从本轮证据目录逐字复制，不推算邻号`);
        }
      }
    }
  }
  if (
    object(input.telemetry) &&
    refs(input.telemetry.evidence) &&
    issues(SubmitWatchInput.properties.telemetry, { ...input.telemetry, evidence: unique(input.telemetry.evidence) })
      .length === 0
  ) {
    const telemetry = input.telemetry;
    telemetry.evidence = unique((telemetry.evidence as string[]).map(window.resolve)).filter((id) => {
      if (window.records.has(id)) return true;
      warnings.push(`telemetry 的证据 ${id} 不在本轮可见证据中，已忽略`);
      return false;
    });
    if (!(telemetry.evidence as string[]).length) {
      warnings.push('telemetry 本轮未更新：没有本轮可见证据');
      delete input.telemetry;
    }
  }
  return { input, warnings, errors: unique(errors) };
}

/** 解析引用、核对冻结窗口可见性、保存尝试；摘要引用与完整原文引用同等有效。 */
export function validateWatchDraft(
  previous: WatchBody | undefined,
  input: SubmitWatchArgs,
  window: WatchEvidenceWindow,
): { draft: SubmitWatchArgs; errors: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const recordOf = (id: Id) => window.records.get(id);
  const resolve = (ids: string[]) => ids.map((id) => window.resolve(id));
  const evidence = (ids: string[], owner: string) => resolveWatchEvidence(ids, owner, window, warnings);
  const { telemetry, ...rest } = input;
  const telemetryEvidence = resolve(telemetry?.evidence ?? []).filter((id) => {
    if (window.records.has(id)) return true;
    warnings.push(`telemetry 的证据 ${id} 不在本轮可见证据中，已忽略`);
    return false;
  });
  if (telemetry && !telemetryEvidence.length) warnings.push('telemetry 已省略：没有本轮可见证据');
  // 在尝试编号和去重前清理，避免同一次执行因夹带笔误被重复计入历史。
  input = {
    ...rest,
    directions: input.directions.map((d) => ({
      ...d,
      evidence: evidence(d.evidence, `方向 ${d.id}`),
      attempts: d.attempts.map((a) => ({ ...a, evidence: evidence(a.evidence, `方向 ${d.id} 的尝试 ${a.id}`) })),
    })),
    ...(telemetry === null
      ? { telemetry: null }
      : telemetry && telemetryEvidence.length
        ? { telemetry: { ...telemetry, evidence: telemetryEvidence } }
        : {}),
  };
  // 剩余未知引用仍须退回；宿主不替模型编造证据。
  const errors = watchEvidence(input)
    .filter((id) => !window.records.has(id))
    .map((id) => `引用的 ${id} 不在本轮可见证据中，用 observation_context 核对`);
  const normalized = normalizeWatchDraft(previous, input, recordOf);
  const { draft } = normalized;
  warnings.push(...normalized.warnings);
  errors.push(...watchSubmissionIssues(previous, draft, recordOf));
  return { draft, errors: [...new Set(errors)], warnings };
}

/** 所有方向与尝试增量保留；只有显式 retired:true 才退休，retired:false 恢复。 */
function combine(previous: WatchBody | undefined, draft: SubmitWatchArgs): WatchBody {
  const directions: WatchDirection[] = (previous?.directions ?? []).map((d) => ({
    ...d,
    evidence: [...d.evidence],
    attempts: d.attempts.map(({ id, action, result, evidence }) => ({ id, action, result, evidence: [...evidence] })),
  }));
  const at = new Map(directions.map((d, i) => [d.id, i]));
  for (const item of draft.directions) {
    const i = at.get(item.id);
    const old = i === undefined ? undefined : directions[i];
    const attempts = new Map<string, WatchAttempt>((old ? allWatchAttempts(old) : []).map((a) => [a.id, a]));
    for (const a of item.attempts) {
      attempts.set(a.id, {
        id: a.id,
        action: a.action,
        result: a.result,
        evidence: unique(a.evidence),
      });
    }
    // 判断字段整项替换；生命周期与投影属性省略时沿用。
    const body: WatchDirection = {
      id: item.id,
      direction: item.direction,
      status: item.status,
      result: item.result,
      evidence: unique(item.evidence),
      ...(item.doubt?.trim() ? { doubt: item.doubt } : {}),
      ...(item.experiment ? { experiment: structuredClone(item.experiment) } : {}),
      attempts: [...attempts.values()].slice(-WATCH_MAX_ATTEMPTS),
      ...(attempts.size > WATCH_MAX_ATTEMPTS
        ? { archivedAttempts: [...attempts.values()].slice(0, -WATCH_MAX_ATTEMPTS) }
        : {}),
      ...((item.priority ?? old?.priority) ? { priority: item.priority ?? old?.priority } : {}),
      ...((item.retired ?? old?.retired) !== undefined ? { retired: item.retired ?? old?.retired } : {}),
    };
    if (i !== undefined) {
      directions[i] = body;
      continue;
    }
    at.set(item.id, directions.length);
    directions.push(body);
  }
  return {
    standing: unlabel(draft.standing, '现在到哪了'),
    ...(draft.telemetry !== undefined ? { telemetry: structuredClone(draft.telemetry) } : {}),
    directions,
    tension: [...draft.tension],
    // 和原版 steer.forbid 一样整份重写；省略或清空即撤销，不能沿用上一版的禁扫标记。
    ...(draft.forbid === undefined ? {} : { forbid: unique(draft.forbid.map((item) => item.trim()).filter(Boolean)) }),
    advice: unlabel(draft.advice, '最该注意'),
  };
}

function telemetryIssues(value: unknown): string[] {
  return issues(SemanticDigest, value).map((issue) => `telemetry${issue.path}：${issue.message}`);
}

/** 模型把显示时的标签也写进了正文（「现在到哪了：……」，真模型冒烟里见过）：去掉，不然显示成两遍 */
function unlabel(text: string, label: string): string {
  return text.replace(new RegExp(`^\\s*${label}\\s*[：:]\\s*`), '');
}

function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}
