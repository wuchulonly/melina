// - system：系统提示、目标简述（goalBrief；完成标准还在起草时照实写），同一个 Run 里只在 Scoper 起草完时变一次（缓存前缀）；
// - 开场背景：上一版判断、已覆盖的平台状态和历史提示的短摘要；原字段按 id 查询。
// - 最新提示、宿主状态与回执按 request.state 冻结，宿主统一置顶装箱；不冒充历史 untilSeq 已读。
// - 本窗口的新增提示、工具执行、可见发言和 RunStore 记录按 seq 提供材料身份，宿主预装骨架，原文按需展开。
// 观察会话每轮新开，记忆只有 RunStore 上的上一版。
// 只给上一版之后的：之前的已经在它的上一版看法里，要细节用 observation_context 按 id 查。一轮新看到的一般是十来次工具调用；
// 上一轮没做成的话会多一些，最近 WATCH_FULL_STEPS 次写全，更早的一行一次；原文按引用和行号查询，不把未展示的事件记成已读。
// 不读墙钟：第几分都按事件写进 RunStore 的时刻算（和 marks.ts 的「测于第几分」一个钟，projections/evidence-activity.ts），「这一刻」是 untilSeq
// 那条事件的时刻。

import { fittingPrefix } from '../../core/bytes.ts';
import { invalid, notFound } from '../../core/errors.ts';
import type { MelinaEvent } from '../../core/events.ts';
import type { Id } from '../../core/ids.ts';
import type { Layout, WatchContext, WatchRequest } from '../../core/interfaces/context.ts';
import type { RunStoreQueries, StoreRecord } from '../../core/interfaces/store.ts';
import { observationRef } from '../../core/observation-ref.ts';
import { countsAsToolCall, watcherTools } from '../../core/tools.ts';
import type { Branch, Observation, Run } from '../../core/types.ts';
import { WATCH_CONTEXT_CALLS, WATCH_OVERVIEW_BYTES, WATCH_STATE_BYTES } from '../../core/watch-budget.ts';
import { WATCH_INPUT } from '../../core/watch-input.ts';
import { minuteOf, momentOf } from '../../projections/time.ts';
import { isWatchExecution, watchVersions } from '../../projections/watch.ts';
import { watchRepeatSignals } from '../../projections/watch-signals.ts';
import { freezeWatchSnapshot, watchRecordRef } from '../../projections/watch-snapshot.ts';
import { contentionShown, contentionText, goalBrief } from '../evidence.ts';

import { oneLine, scoped } from '../render.ts';
import { previousTelemetrySection, previousWatchSection } from '../watch.ts';
import { overviewPrefix, packWatchOverview, type WatchOverviewItem } from '../watch-overview.ts';

interface WatchFragment {
  text: string;
  seqs: number[];
}

export interface WatcherSource {
  redact?: (text: string) => string;
  queries: RunStoreQueries;
  prompt: (name: 'watcher') => string;
}

/** 上一版之后的工具调用，最近这么多次写全（命令、预期、结果、输出首尾） */
export const WATCH_FULL_STEPS = 30;
/** 命令、预期最多多少字 */
const CMD_MAX = 400;
const EXPECT_MAX = 300;
/** 长命令、输出保留前 4 行和后 8 行。 */
const HEAD_LINES = 4;
const TAIL_LINES = 8;
const TAIL_MAX = 900;

/** 它的一次工具调用，和写进 RunStore 的时刻（那条 observation.created 的事件时间） */
interface Step {
  o: Observation;
  atMs: number;
}

export function watcherLayout(src: WatcherSource, runId: Id, request: WatchRequest): Layout {
  const { queries } = src;
  const redact = src.redact ?? ((text: string) => text);
  const run = queries.getRun(runId);
  if (!run) throw notFound(`Run ${runId} 不存在`);
  const branch = queries.getBranch(request.branchId);
  if (!branch || branch.runId !== runId) throw notFound(`分支 ${request.branchId} 不在任务 ${runId} 里`);
  if (queries.getBet(branch.betId)?.kind !== 'direct') throw invalid('巡检器只看主干直解路线那条路线');
  const since = request.previous?.basedOnSeq ?? 0;
  const until = request.untilSeq;
  const system = [src.prompt('watcher'), goalPart(queries, run)].join('\n\n');
  const snapshot = freezeWatchSnapshot(queries, runId, request);
  const records = new Map(snapshot.records.map((r) => [r.record.id, r]));
  // 跨分支观测可按引用只读查询；不冒充本分支执行，也不形成连续历史缺口。
  const historyRecords = snapshot.records.filter((r) => r.kind !== 'observation' || r.record.branchId === branch.id);
  const refOf = (id: Id) => {
    const r = records.get(id);
    return r ? watchRecordRef(r) : id;
  };
  const events = queries
    .events({ since, runId, types: ['observation.created', 'episode.closed', 'run.recovered'] })
    .filter((e) => e.seq <= until);
  const steps = events.flatMap((e): Step[] =>
    e.type === 'observation.created' &&
    e.data.branchId === branch.id &&
    e.data.role === 'explorer' &&
    e.data.tool !== WATCH_INPUT.speech
      ? [{ o: e.data, atMs: Date.parse(e.at) }]
      : [],
  );
  const state = stateSection(queries, branch, since, until);
  const parts = [
    ...stepsSection(run, steps),
    ...recordsSection(queries, run, branch, events, since, until),
    ...speechSection(events, branch),
    ...state.fresh,
  ];
  const previousRev = request.previous?.rev ?? 0;
  const versions =
    previousRev > 1 ? watchVersions(queries, runId, branch.id).filter((note) => note.rev < previousRev) : [];
  const prior = versions.find((note) => note.rev === previousRev - 1);
  const telemetry = previousTelemetrySection([...versions, ...(request.previous ? [request.previous] : [])], refOf);
  const background = [
    ...(telemetry ? [telemetry] : []),
    previousWatchSection(request.previous, prior, refOf),
    state.history,
    nowSection(
      queries,
      run,
      { ...branch, ...(request.state?.activity ?? request.activity) },
      request.state?.untilSeq ?? until,
    ),
    '# 这一轮\n\n更新工作假设、证据与决策焦点。优先为关键疑点安排一个有限验证及停止条件；材料足够即 observation_submit。',
  ];
  parts.sort((a, b) => Math.min(...a.seqs) - Math.min(...b.seqs));
  const counted = steps.filter((s) => countsAsToolCall(s.o)).length;
  const before = request.previous?.toolCalls ?? 0;
  const range = counted ? `第 ${before + 1} 到第 ${before + counted} 次工具调用` : '没有新的工具调用';
  const covered = new Set<number>();
  const previousStateSeq = request.previous?.stateSeq ?? since;
  const previousRefs = new Set(request.previous?.stateRefs);
  for (const r of snapshot.records) {
    if (snapshot.stateRefs.has(r.record.id) && (previousRefs.has(r.record.id) || r.record.seq <= previousStateSeq))
      covered.add(r.record.seq);
  }
  const current = new Set(request.state?.refs);
  const latest = snapshot.records.filter((r) => current.has(r.record.id) && snapshot.stateRefs.has(r.record.id));
  const linked = new Set(latest.flatMap((r) => (r.kind === 'inbox' && r.record.ref ? [r.record.ref] : [])));
  const itemOf = (r: StoreRecord, text: string, seqs = [r.record.seq]): WatchOverviewItem => ({
    text: redact(text),
    preview: overviewPrefix(redact(text), 400),
    covers: seqs,
    ref: watchRecordRef(r),
    execution: isWatchExecution(r),
    hint: r.kind === 'input' || (r.kind === 'inbox' && r.record.kind === 'human'),
  });
  const items: WatchOverviewItem[] = latest
    .filter(
      (r) =>
        !linked.has(r.record.id) &&
        !(r.kind === 'observation' && r.record.tool === WATCH_INPUT.receipt && covered.has(r.record.seq)),
    )
    .sort(
      (a, b) => Number(covered.has(a.record.seq)) - Number(covered.has(b.record.seq)) || b.record.seq - a.record.seq,
    )
    .map((r) => ({
      ...itemOf(r, recordText(r), relatedSeqs(r, records)),
      preview: overviewPrefix(redact(recordText(r)), 280),
      latest: true,
    }));
  const backgroundText = redact(background.join('\n\n'));
  const backgroundSummary = overviewPrefix(backgroundText, 10000);
  items.push({
    text:
      backgroundSummary === backgroundText
        ? backgroundText
        : `${backgroundSummary}\n完整方向列表用 observation_context({assessmentIds:[]}) 查询，再按方向编号展开。`,
    preview: backgroundSummary,
    covers: [],
  });
  const http = redact(httpSection(request, refOf));
  items.push({ text: http, preview: overviewPrefix(http, 400), covers: [] });
  items.push({
    text: `# 上一版之后的时间线（${range}，按先后）`,
    preview: `# 上一版之后的时间线（${range}，按先后）`,
    covers: [],
  });
  const bySeq = new Map(snapshot.records.map((r) => [r.record.seq, r]));
  const represented = new Set(parts.flatMap((part) => part.seqs));
  for (const r of historyRecords) {
    if (r.record.seq > since && r.record.seq <= until && !represented.has(r.record.seq) && !linked.has(r.record.id))
      parts.push({ text: recordText(r), seqs: relatedSeqs(r, records).filter((seq) => seq > since && seq <= until) });
  }
  parts.sort((a, b) => Math.min(...a.seqs) - Math.min(...b.seqs));
  const stateSeqs = new Set(latest.map((r) => r.record.seq));
  for (const part of parts) {
    if (part.seqs.every((seq) => stateSeqs.has(seq) || covered.has(seq))) continue;
    const r = part.seqs.map((seq) => bySeq.get(seq)).find(Boolean);
    items.push(r ? itemOf(r, part.text, part.seqs) : { text: part.text, preview: part.text, covers: part.seqs });
  }
  const input: WatchContext = {
    records: snapshot.records,
    stateRefs: [...snapshot.stateRefs],
    history: [
      ...new Set([
        ...parts.flatMap((part) => part.seqs),
        ...historyRecords.filter((r) => r.record.seq > since && r.record.seq <= until).map((r) => r.record.seq),
      ]),
    ],
    covered: [],
    delivered: [],
    inspectContext: [],
  };
  const activity = request.state?.activity ?? request.activity ?? branch;
  const task = request.state?.task ?? run;
  const repeats = watchRepeatSignals(
    snapshot.records.flatMap((r) => (r.kind === 'observation' ? [r.record] : [])),
    branch.id,
    since,
    until,
  );
  const header = [
    '# 本轮状态',
    '',
    `上一版：${previousRev}；执行窗口：${since + 1}–${until}（${range}）。`,
    `最新状态截止：${request.state?.untilSeq ?? until}；任务：${task.status}（${task.mode}）；路线：${activity.state}，第 ${activity.episode} 轮，累计 ${activity.toolCalls} 次工具调用。`,
    '摘要可直接支持判断；原文按引用查询。未展示的历史由宿主留给下一轮。',
    `本轮最多补查 ${WATCH_CONTEXT_CALLS} 次；需要多条原文时在同一次 observation_context 中批量引用，预算用完即提交。`,
    ...repeats.map(
      ({ observations }) =>
        `宿主重复检查信号：${observations.length} 次连续调用的命令参数、快照、episode、退出状态与记录摘要相同（最近证据 ${observations
          .slice(-3)
          .map((o) => observationRef(o.seq))
          .join('、')}）。摘要相同不证明原文相同或方向无效；核对是否仍有新信息，必要时改变验证条件，不据次数宣布失败。`,
    ),
  ].join('\n');
  const packet = packWatchOverview(items, WATCH_OVERVIEW_BYTES, header);
  input.covered = [...new Set([...covered, ...packet.covered])];
  input.inspectContext = packet.inspectContext;
  const delivered = new Set(packet.delivered);
  input.delivered = snapshot.records.filter((r) => delivered.has(r.record.seq)).map((r) => r.record.id);
  return {
    role: 'watcher',
    system,
    tools: watcherTools(snapshot.records.map(watchRecordRef)),
    messages: [{ role: 'user', text: packet.content }],
    basedOnSeq: until,
    watch: input,
  };
}

function relatedSeqs(r: StoreRecord, records: ReadonlyMap<Id, StoreRecord>): number[] {
  const related = r.kind === 'inbox' && r.record.ref ? records.get(r.record.ref) : undefined;
  return [r.record.seq, ...(related ? [related.record.seq] : [])];
}

function recordText(r: StoreRecord): string {
  const item = r.record;
  const text =
    'summary' in item
      ? item.summary
      : 'text' in item
        ? item.text
        : 'statement' in item
          ? item.statement
          : 'claim' in item
            ? item.claim
            : JSON.stringify(item);
  return `[${watchRecordRef(r)}] ${r.kind === 'observation' ? r.record.tool : r.kind}：${text}`;
}

function stateSection(
  queries: RunStoreQueries,
  branch: Branch,
  since: number,
  until: number,
): {
  fresh: WatchFragment[];
  history: string;
} {
  const inputs = queries
    .events({ runId: branch.runId, since: 0, types: ['observation.created'] })
    .flatMap((e) =>
      e.type === 'observation.created' && e.seq <= until && e.data.branchId === branch.id && e.data.role === 'watcher'
        ? [e.data]
        : [],
    );
  const fresh: WatchFragment[] = [];
  const history = ['# 已覆盖的状态与历史提示（原文可用 observation_context 按 id 查）'];
  for (const o of inputs) {
    if (o.tool !== WATCH_INPUT.platform && o.tool !== WATCH_INPUT.extension) continue;
    if (o.seq > since) {
      fresh.push({
        text: `- [${observationRef(o.seq)}] ${o.tool}（本窗口更新，摘要可能截断；原文按 id 或句柄查）：\n${fittingPrefix(o.summary, (text) => Buffer.byteLength(text, 'utf8') <= WATCH_STATE_BYTES)}\n原文：${o.output}`,
        seqs: [o.seq],
      });
    }
  }
  for (const tool of [WATCH_INPUT.platform, WATCH_INPUT.extension]) {
    const latest = inputs.filter((o) => o.tool === tool && o.seq <= since).at(-1);
    if (latest)
      history.push(
        `- [${observationRef(latest.seq)}] ${tool}（已覆盖）：${clip(oneLine(latest.summary), 240)}；原文：${latest.output}`,
      );
  }
  const hints = queries.inbox(branch.id, 0).filter((i) => i.seq <= since && i.kind === 'human');
  if (hints.length) {
    history.push(`历史提示 ${hints.length} 条已纳入上一版，最近两条索引（更早的用 query 查找）：`);
    for (const i of hints.slice(-2)) history.push(`- [${i.id}] ${clip(oneLine(i.text), 160)}`);
  }
  // 本窗口的 human 提示统一在 recordsSection 全文出现一次。
  return { fresh, history: history.join('\n') };
}

function speechSection(events: readonly MelinaEvent[], branch: Branch): WatchFragment[] {
  return events.flatMap((e) =>
    e.type === 'observation.created' &&
    e.data.branchId === branch.id &&
    e.data.role === 'explorer' &&
    e.data.tool === WATCH_INPUT.speech
      ? [
          {
            text: `- [${observationRef(e.data.seq)}] 主代理可见发言（原话，不含隐藏推理）：\n${clip(e.data.summary, 4000)}\n  原文：${e.data.output}`,
            seqs: [e.seq],
          },
        ]
      : [],
  );
}

function httpSection(request: WatchRequest, refOf: (id: Id) => string): string {
  return [
    '# 本窗口 HTTP 原始材料（从工具产物摘录，可能截断）',
    '',
    ...(request.http?.length
      ? request.http.map((h) => `- [${refOf(h.observation)}]\n${h.text}\n原文：${h.output}`)
      : ['（没有独立摘录；工具原文仍可按句柄读取）']),
  ].join('\n');
}

/** 目标简述；Scoper 还在起草时（主干直解路线不等它）照实写 */
function goalPart(queries: RunStoreQueries, run: Run): string {
  const brief = goalBrief(run.goal);
  if (scoped(queries, run.id)) return brief;
  return `${brief}\n\n（完成标准还在起草：起草完以后，它的收件箱里会收到完成标准，下一轮你这里也会写上。）`;
}

// ── 它做了什么 ──────────────────────────────────────────────────────────────

function stepsSection(run: Run, steps: readonly Step[]): WatchFragment[] {
  return steps.map((s, index) => ({
    text: index < steps.length - WATCH_FULL_STEPS ? briefStep(run, s) : fullStep(run, s),
    seqs: [s.o.seq],
  }));
}

function fullStep(run: Run, { o, atMs }: Step): string {
  const lines = [`- [${observationRef(o.seq)}] 第 ${minuteOf(run, atMs)} 分 · ${actionOf(o, CMD_MAX)}`];
  const args = (o.args ?? {}) as Record<string, unknown>;
  const cmd = o.tool === 'sh' && typeof args.cmd === 'string' ? args.cmd : '';
  if (cmd.includes('\n') || cmd.length > CMD_MAX) {
    lines.push('  命令首尾：', ...excerptLines(cmd.split('\n'), CMD_MAX * 3).map((line) => `    ${line}`));
  }
  if (o.expect) lines.push(`  预期：${clip(oneLine(o.expect), EXPECT_MAX)}`);
  lines.push(`  结果：${resultOf(o)}`);
  const tail = tailOf(o);
  if (tail.length > 0) {
    lines.push(o.tool === 'sh' ? '  输出首尾：' : '  摘要：');
    for (const l of tail) lines.push(`    ${l}`);
  }
  if (
    cmd &&
    (cmd.includes('\n') ||
      cmd.length > CMD_MAX ||
      tail.some((line) => line.includes('…')) ||
      /\bcurl\b[\s\S]*\bcurl\b|\b(?:for|while)\b|(?:^|\s)(?:-H|--header)(?:\s|=)/.test(cmd))
  )
    lines.push(
      '  摘要有省略或包含多组测试；影响当前判断的细节可用 observation_context 按需展开，不确定的覆盖范围写入 doubt。',
    );
  lines.push(`  原文：${o.output}`);
  return lines.join('\n');
}

function briefStep(run: Run, { o, atMs }: Step): string {
  return `- [${observationRef(o.seq)}] 第 ${minuteOf(run, atMs)} 分 · ${actionOf(o, 120)} → ${resultOf(o)}`;
}

/** 用了什么工具、做了什么 */
function actionOf(o: Observation, max: number): string {
  const args = (o.args ?? {}) as Record<string, unknown>;
  if (o.tool === 'sh' && typeof args.cmd === 'string') {
    const bg = args.background === true ? '，后台' : '';
    return `sh${bg}：「${clipEnds(oneLine(args.cmd), max)}」`;
  }
  if (typeof args.path === 'string') return `${o.tool}：${args.path}`;
  return o.tool;
}

/** 结果：runtime 记下的第一行（退出码、用时、超时、没跑起来、读了哪几行、改了几处），出错的原话，撞到的资源上限 */
function resultOf(o: Observation): string {
  const head = clip(oneLine(o.summary.split('\n')[0] ?? ''), 200) || '（没有记下结果）';
  const error = o.error && !head.includes(o.error) ? `；出错：${clip(oneLine(o.error), 200)}` : '';
  const shown = o.contention && contentionShown(o.contention, { reading: false });
  const hit = shown ? `；跑的时候${contentionText(shown)}` : '';
  return `${head}${error}${hit}`;
}

/** 长命令和输出兼顾首尾；标明省略的行数，单行超长也显式截断。 */
function excerptLines(lines: string[], max: number): string[] {
  const limit = HEAD_LINES + TAIL_LINES;
  const width = Math.floor(max / Math.min(lines.length || 1, limit));
  const shown =
    lines.length <= limit
      ? lines
      : [...lines.slice(0, HEAD_LINES), `…（中段省略 ${lines.length - limit} 行）…`, ...lines.slice(-TAIL_LINES)];
  return shown.map((line) => clipEnds(line, Math.min(width, 300)));
}

function clipEnds(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = Math.ceil(max / 3);
  return `${chars.slice(0, head).join('')}…${chars.slice(-(max - head)).join('')}`;
}

/** sh 看输出首尾；改文件看改动附近的开头几行；读、写文件只看结果那一行 */
function tailOf(o: Observation): string[] {
  const body = o.summary
    .split('\n')
    .slice(1)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  if (o.tool === 'sh') return excerptLines(body, TAIL_MAX);
  if (o.tool === 'edit') return body.slice(0, 8).map((l) => clip(l, 200));
  return [];
}

// ── RunStore 上新的记录 ────────────────────────────────────────────────────────

function recordsSection(
  queries: RunStoreQueries,
  run: Run,
  branch: Branch,
  events: readonly MelinaEvent[],
  since: number,
  until: number,
): WatchFragment[] {
  const items: { seq: number; line: string; refs?: number[] }[] = [];
  const within = (seq: number) => seq > since && seq <= until;
  for (const i of queries.inbox(branch.id, since)) {
    if (within(i.seq))
      items.push({
        seq: i.seq,
        line: `- ${i.text}（它的收件箱）`,
        refs: i.ref ? [queries.getRecord(i.ref)?.record.seq ?? i.seq] : [],
      });
  }
  for (const c of queries.candidates(run.id)) {
    if (c.branchId !== branch.id || !within(c.seq)) continue;
    const what = c.interim ? '存了阶段版（保底，任务接着跑）' : '交了候选（任务以它结束）';
    items.push({ seq: c.seq, line: `- [${c.id}] 它${what}：${oneLine(c.claim)}` });
  }
  for (const e of events) {
    if (e.type === 'episode.closed' && e.data.branchId === branch.id) {
      items.push({
        seq: e.seq,
        line: `- 它的第 ${e.data.episode} 个 episode ${closedText(e.data.outcome, e.data.failure)}`,
      });
    } else if (e.type === 'run.recovered') {
      items.push({
        seq: e.seq,
        line: '- Melina 重启过：没收尾的那个 episode 丢了，workspace 回到了它上次收尾（或存个阶段版）时的样子',
      });
    }
  }
  items.sort((a, b) => a.seq - b.seq);
  return items.map((i) => ({ text: i.line, seqs: [i.seq, ...(i.refs ?? [])].filter(within) }));
}

function closedText(outcome: string, failure: string | undefined): string {
  if (outcome === 'failed') {
    const why: Record<string, string> = {
      model_error: '模型的回复用不了',
      no_close: '停下了却没收尾',
      context_overflow: '上下文撑爆了',
    };
    return `没有正常收尾（${why[failure ?? ''] ?? '原因没记下'}）：workspace 里的改动留着`;
  }
  if (outcome === 'submitted') return '收尾时交了候选';
  return '收尾了，下一段从干净的上下文接着做';
}

// ── 这一刻 ──────────────────────────────────────────────────────────────────

function nowSection(queries: RunStoreQueries, run: Run, branch: Branch, until: number): string {
  const lines = ['# 这一刻', ''];
  const now = momentOf(queries, until);
  const at = now !== undefined ? `第 ${minuteOf(run, now)} 分，` : '';
  lines.push(`- ${at}它一共做了 ${branch.toolCalls} 次工具调用，现在在第 ${branch.episode} 个 episode`);
  // 正在跑的命令只算这个 episode 的、路线在跑的时候（同 live.ts 的 routeLive：排队、暂停时命令不会在跑）
  if (branch.state !== 'running' || branch.queued) return lines.join('\n');
  const intents = queries
    .events({ since: 0, runId: run.id, types: ['sh.intent', 'run.recovered'] })
    .filter((e) => e.seq <= until);
  const running = intents
    .filter(
      (e) =>
        e.type === 'sh.intent' &&
        e.data.branchId === branch.id &&
        e.data.episode === branch.episode &&
        !queries.getObservation(e.data.id),
    )
    .at(-1);
  if (running?.type === 'sh.intent') {
    lines.push(
      `- 正在跑（第 ${minuteOf(run, Date.parse(running.at))} 分开始，还没有结果）：「${clip(oneLine(running.data.cmd), CMD_MAX)}」` +
        (running.data.expect ? `，预期「${clip(oneLine(running.data.expect), EXPECT_MAX)}」` : ''),
    );
  }
  return lines.join('\n');
}

/** 截到 max 个字（按码点，不切开代理对） */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}
