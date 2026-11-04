import { fittingPrefix } from '../core/bytes.ts';

/** 摘要优先于内联原文；原文展开只补充细节，不影响提交。 */
export interface WatchOverviewItem {
  text: string;
  preview: string;
  covers: number[];
  ref?: string;
  execution?: boolean;
  latest?: boolean;
  /** 长提示在首屏提供按需展开入口。 */
  hint?: boolean;
}

/** 按最终 Markdown 的 UTF-8 字节装箱；覆盖信息只返回宿主，不混入正文。 */
export function packWatchOverview(
  items: readonly WatchOverviewItem[],
  budget: number,
  header: string,
): { content: string; covered: number[]; delivered: number[]; inspectContext: string[] } {
  const selected: { item: WatchOverviewItem; text: string }[] = [];
  // 固定上限只限制状态索引，给执行历史留位置；余量按展示顺序展开全文。
  const latestBudget = 6000;
  const render = () => {
    const covered = selected.flatMap(({ item }) => item.covers);
    const entry = ({ item, text }: (typeof selected)[number]) =>
      `${item.ref ? `[${item.execution ? '证据ID' : '叙述ID'}: ${item.ref}]\n` : ''}${text}${text !== item.text && item.ref ? `\n  ${item.execution ? '原文' : '叙述全文'}按 ${item.ref} 展开` : ''}`;
    const latest = selected
      .filter(({ item }) => item.latest)
      .map(entry)
      .join('\n\n');
    const history = selected
      .filter(({ item }) => !item.latest)
      .map(entry)
      .join('\n\n');
    const inspectContext = selected.flatMap(({ item, text }) =>
      item.hint && text !== item.text && item.ref ? [item.ref] : [],
    );
    return {
      content: [
        header,
        ...(latest ? [`# 最新提示、状态与回执\n\n${latest}`] : []),
        history,
        ...(selected.length < items.length ? ['部分材料未展示，宿主会保留到下一轮。'] : []),
        ...(inspectContext.length
          ? [`# 可按需展开的要求\n\n${inspectContext.map((ref) => `- ${ref}`).join('\n')}`]
          : []),
      ]
        .filter(Boolean)
        .join('\n\n'),
      covered,
      inspectContext,
      latestBytes: Buffer.byteLength(latest, 'utf8'),
    };
  };
  const fits = (reserveHistory = false) => {
    const result = render();
    return (
      (!reserveHistory || result.latestBytes <= latestBudget) && Buffer.byteLength(result.content, 'utf8') <= budget
    );
  };
  // 先给每一条材料留位置。极端积压的剩余前缀由调度继续，绝不把未展示项算成覆盖。
  for (const item of items) {
    selected.push({ item, text: item.preview });
    if (!fits(true)) {
      selected.pop();
      if (item.latest) continue;
      break;
    }
  }
  // 已选条目可以展开全文，但不会挤掉另一条已经展示的材料。
  for (const row of selected) {
    const old = row.text;
    row.text = row.item.text;
    if (!fits()) row.text = old;
  }
  const { content, covered, inspectContext } = render();
  if (Buffer.byteLength(content, 'utf8') > budget) throw new Error('观察概览元数据超过预算');
  return { content, covered, delivered: selected.flatMap(({ item }) => item.covers), inspectContext };
}

export function overviewPrefix(text: string, bytes: number): string {
  const prefix = fittingPrefix(text, (value) => Buffer.byteLength(value, 'utf8') <= bytes);
  return prefix === text ? text : `${prefix}…`;
}
