// 巡检器的看法怎么写给模型看：给主干直解路线的一张短地图
// （watchMap），和给巡检器自己看的上一版（previousWatchSection，方向带编号和尝试）。纯函数，同样的一版写出逐字节相同的文字。
//
// 决策简报：工作假设、实测证据、决策焦点、有限验证、关键疑点及原话冲突。
// 验证给出预期与停止条件；证据和计划分区，不能把未做的实验编成已确认结果。
// 领域命令策略由扩展读取，完整方向历史留给巡检器和按需查询。
// 正文压成一行一条，去掉正文里的地图标签（模型写的字不能把这一块提前关上）。地图每次发请求前现编，作为独立参考材料提供，
// 换掉上一张（models/harness.ts），本分支没发布新版时逐字节相同（缓存前缀），不混入其他分支的主观判断。
//
// 简报直接列当前判断；状态和关键条件写在结果里，不逐行追加免责声明。
//
// 巡检器自己看的上一版：在做的方向带编号、结论，尝试只列最近 WATCH_RECENT_ATTEMPTS 次和一共几次
// （更早的用 observation_context 按编号看）；退休了的一个一行（编号、做法、结论）。

import type { Id } from '../core/ids.ts';
import { WATCH_MAP_TAG } from '../core/interfaces/context.ts';
import type { WatchDirection, WatchNote, WatchStatus } from '../core/types.ts';
import { bruteLaterScore, compareWatchAngles, projectWatchMap } from '../core/watch-map.ts';
import { allWatchAttempts, WATCH_RECENT_ATTEMPTS, watchSourceText } from '../projections/watch.ts';
import { oneLine } from './render.ts';

export const WATCH_STATUS: Record<WatchStatus, string> = {
  untried: '还没试',
  trying: '在试',
  works: '有推进',
  failed: '未奏效',
  unclear: '没有定论',
};

/** 只展示已知版本中的最后一次明确报告；省略不是撤回，旧判断保留原版次与证据水位。 */
export function previousTelemetrySection(notes: readonly WatchNote[], refOf: (id: Id) => string): string {
  const report = notes.findLast((note) => note.telemetry !== undefined);
  if (!report) return '';
  if (report.telemetry === null) return '# 上次态势\n\n已明确撤回；当前没有保留的态势报告。';
  if (!report.telemetry) return '';
  return [
    `# 上次态势（第 ${report.rev} 版，证据水位 ${report.basedOnSeq}；本轮尚未更新）`,
    '',
    JSON.stringify({ ...report.telemetry, evidence: report.telemetry.evidence.map(refOf) }),
    '有新判断时更新 telemetry；没有更新可省略，旧判断失效时提交 null 撤回。',
  ].join('\n');
}

/** 给主干直解路线的决策简报；有界实验与证据缺口始终和实测结论分开。 */
export function watchMap(note: WatchNote | undefined): string {
  if (!note) return '';
  const { confirmed, angles } = projectWatchMap(note);
  const experiments = note.directions
    .filter((d) => !d.retired && d.experiment)
    .sort(compareWatchAngles)
    .slice(0, 3);
  const checks = [...new Map([...experiments, ...angles.filter((d) => !d.experiment)].map((d) => [d.id, d])).values()]
    .sort(
      (a, b) =>
        bruteLaterScore(`${a.direction} ${a.result}`) - bruteLaterScore(`${b.direction} ${b.result}`) ||
        Number(Boolean(b.experiment)) - Number(Boolean(a.experiment)) ||
        compareWatchAngles(a, b),
    )
    .slice(0, 4);
  const selected = new Map([...checks, ...confirmed].map((d) => [d.id, d]));
  const lines = [
    `<${WATCH_MAP_TAG}>`,
    ...mapSection('WORKING_MODEL:', [brief(mapLine(note.standing), 400)]),
    ...mapSection(
      'EVIDENCE:',
      confirmed.map((d) => `${brief(mapLine(d.direction))}（${WATCH_STATUS[d.status]}）：${brief(mapLine(d.result))}`),
    ),
    ...mapSection('DECISION:', [brief(mapLine(note.advice), 400)]),
    ...mapSection(
      'NEXT_CHECKS:',
      checks.map((d) => {
        const e = d.experiment;
        if (!e) return brief(mapLine(d.direction));
        return `${brief(mapLine(d.direction))}：待解 ${brief(mapLine(e.question))}；检查 ${brief(mapLine(e.check))}；预期 ${brief(mapLine(e.expected))}；停止/转向 ${brief(mapLine(e.stopWhen))}`;
      }),
    ),
  ];
  const doubts = [...selected.values()]
    .filter((d) => d.doubt?.trim())
    .slice(0, 3)
    .map((d) => `${brief(mapLine(d.direction))}：${brief(mapLine(d.doubt ?? ''))}`);
  if (doubts.length) lines.push(...mapSection('OPEN_QUESTIONS:', doubts));
  const tension = note.tension.map(mapLine).filter((t) => t !== '');
  if (tension.length > 0) lines.push('CONFLICTS:', ...tension.map((t) => `- ${brief(t, 240)}`));
  lines.push(`</${WATCH_MAP_TAG}>`);
  return lines.join('\n');
}

/**
 * 给巡检器自己看的上一版：所有方向增量更新；活跃方向始终保留最近尝试，
 * 退休了的另列一段、一个一行
 */
export function previousWatchSection(
  note: WatchNote | undefined,
  prior?: WatchNote,
  refOf: (id: Id) => string = (id) => id,
): string {
  if (!note) return '# 你上一版的看法\n\n这是第一轮，还没有。';
  const lines = [`# 你上一版的看法（第 ${note.rev} 版，看到它第 ${note.toolCalls} 次工具调用为止）`, ''];
  lines.push(`WORKING_MODEL：${oneLine(note.standing)}`, `DECISION：${oneLine(note.advice)}`, '');
  if (note.forbid !== undefined) lines.push(`FORBID（本版命令策略标记）：${idList(note.forbid.map(oneLine))}`, '');
  const active = note.directions
    .filter((d) => !d.retired)
    .sort(
      (a, b) =>
        Number(allWatchAttempts(b).length > 0) - Number(allWatchAttempts(a).length > 0) ||
        (a.priority ?? 5) - (b.priority ?? 5),
    );
  const retired = note.directions.filter((d) => d.retired);
  const untried = active.filter((d) => d.status === 'untried' && allWatchAttempts(d).length === 0);
  lines.push(
    `当前在架的未试备选（未提交自动沿用；已试请复用原 id 更新；移出须 retired:true）：${idList(untried.map((d) => `${d.id}：${brief(d.direction)}`))}`,
    '',
    '方向与最近尝试：',
  );
  if (active.length === 0) lines.push(retired.length > 0 ? '（都退休了）' : '（还没有）');
  const priorDirections = new Map(prior?.directions.map((d) => [d.id, d]));
  for (const d of active) {
    if (JSON.stringify(d) === JSON.stringify(priorDirections.get(d.id))) {
      lines.push(
        `- ${d.id}（${WATCH_STATUS[d.status]}，沿用；${allWatchAttempts(d).length} 次尝试）：${brief(d.direction)} → ${brief(d.result)}`,
      );
      if (d.doubt) lines.push(`  关键疑点：${brief(d.doubt)}`);
      lines.push(...experimentLines(d));
      lines.push(...attemptLines(d, WATCH_RECENT_ATTEMPTS, refOf));
    } else {
      lines.push(...directionLines(d, WATCH_RECENT_ATTEMPTS, refOf));
    }
  }
  lines.push('以上只列最近尝试；需要更早历史时，可用 observation_context 的 assessmentIds 按需查询。');
  if (note.flags?.length) {
    lines.push('', '平台已验收的 flag 节点（宿主生成）：');
    for (const flag of note.flags) {
      lines.push(`- ${flag.id}：${flag.label}（回执 ${refOf(flag.receipt)}；本分支关联 ${idList(flag.dependsOn)}）`);
      if (flag.source) lines.push(`  来源：${oneLine(watchSourceText(flag.source))}`);
      if (flag.source?.directionIds?.length) lines.push('  宿主已关联产出分支的方向；来源不依赖本分支重提回执。');
    }
  }
  if (retired.length > 0) {
    lines.push('', '退休了的方向：');
    for (const d of retired) lines.push(`- ${d.id}：${oneLine(d.direction)}：${oneLine(d.result)}`);
  }

  lines.push('', 'CONFLICTS（两句矛盾原话）：');
  if (note.tension.length === 0) lines.push('（没有）');
  for (const text of note.tension) lines.push(`- ${oneLine(text)}`);
  return lines.join('\n');
}

function brief(text: string, max = 120): string {
  const chars = [...oneLine(text)];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function experimentLines(d: WatchDirection): string[] {
  const e = d.experiment;
  return e
    ? [
        `  待验证：${oneLine(e.question)}`,
        `  有限检查：${oneLine(e.check)}`,
        `  预期分歧：${oneLine(e.expected)}`,
        `  停止/转向：${oneLine(e.stopWhen)}`,
      ]
    : [];
}

/**
 * 一个方向写给巡检器看：编号、状态、结论、疑点，尝试最多列最近 recent 次（不给就全列，observation_context 用）
 */
export function directionLines(d: WatchDirection, recent?: number, refOf: (id: Id) => string = (id) => id): string[] {
  const lines = [`- ${d.id}（${WATCH_STATUS[d.status]}${d.retired ? '，已退休' : ''}）${oneLine(d.direction)}`];
  lines.push(`  结论：${oneLine(d.result)}${evidenceNote(d.evidence.map(refOf))}`);
  if (d.doubt) lines.push(`  还不确定：${oneLine(d.doubt)}`);
  if (d.priority !== undefined) lines.push(`  推荐优先级：${d.priority}`);
  return [...lines, ...experimentLines(d), ...attemptLines(d, recent, refOf)];
}

function attemptLines(d: WatchDirection, recent: number | undefined, refOf: (id: Id) => string): string[] {
  const lines: string[] = [];
  const attempts = allWatchAttempts(d);
  const shown = recent === undefined ? attempts : attempts.slice(-recent);
  if (attempts.length > shown.length) {
    lines.push(
      `  试过 ${allWatchAttempts(d).length} 次，下面是最近 ${shown.length} 次（更早的用 observation_context 按方向编号看，旧尝试自动归档）：`,
    );
  } else if (attempts.length > 0) {
    lines.push(`  试过 ${allWatchAttempts(d).length} 次：`);
  }
  for (const a of shown) {
    lines.push(`  ${a.id}：${oneLine(a.action)} → ${oneLine(a.result)}${evidenceNote(a.evidence.map(refOf))}`);
  }
  return lines;
}

// ── 内部 ────────────────────────────────────────────────────────────────────

const MAP_TAG = new RegExp(`</?${WATCH_MAP_TAG}>`, 'gi');

/** 地图里的一条：去掉正文里的地图标签，压成一行 */
function mapLine(text: string): string {
  return oneLine(text.replace(MAP_TAG, '').replace(/\r\n?/g, '\n'));
}

/** 地图里的一段：标题一行，下面一条一行；空的条去掉，整段空了也留标题 */
function mapSection(title: string, items: readonly string[]): string[] {
  return [title, ...items.filter((t) => t !== '').map((t) => `- ${t}`)];
}

function idList(ids: readonly string[] | undefined): string {
  return ids && ids.length > 0 ? ids.join('、') : '（没有）';
}

function evidenceNote(ids: readonly Id[]): string {
  return ids.length > 0 ? `（依据 ${ids.join('、')}）` : '';
}
