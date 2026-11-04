// 上下文里几种记录的写法：一行一条，带 id（模型引用时原样抄写），其余是人话。纯函数，同样的记录写出逐字节相同的文字。

import type {} from '../core/api.ts';
import type { Id } from '../core/ids.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import type { Run } from '../core/types.ts';

/** Scoper 是否起草完成（completion.drafted，降级也会写）；求解分支开跑时可能仍在起草。 */
export function scoped(queries: Pick<RunStoreQueries, 'events'>, runId: Id): boolean {
  return queries.events({ since: 0, runId, types: ['completion.drafted'], limit: 1 }).length > 0;
}

export function goalSection(
  run: Run,
  opts: { readOnly: boolean; scoping?: boolean; domainDescription?: string },
): string {
  const goal = run.goal;
  const lines = ['# 目标', '', goal.statement];
  const completion = goal.completion;
  if (completion) {
    lines.push('', `对目标的理解：${completion.interpretation}`);
    lines.push('', '## 完成标准', '');
    completion.criteria.forEach((c, i) => {
      lines.push(`${i + 1}. ${c}`);
    });
    const m = completion.metric;
    if (m) {
      const better = m.better === 'lower' ? '越小越好' : '越大越好';
      const unit = m.unit ? `，单位 ${m.unit}` : '';
      lines.push('', '## 主指标', '');
      lines.push(`${m.name}${unit}，${better}，目标 ${formatNumber(m.target)}。${'交接和交付时写清实际测量结果。'}`);
    }
  } else if (opts.scoping && !opts.readOnly) {
    lines.push('', '## 完成标准', '');
    lines.push('还在起草：定好了会追加给你。先照目标做，全部标准通过后用 candidate.claim 说明结果。');
  }
  lines.push('', '## 约束（不许做的事）', '');
  if (opts.scoping) {
    lines.push(
      opts.readOnly
        ? '还在整理：Scoper 正在从目标里整理，照目标原文里说的办。'
        : '还在整理：Scoper 正在从目标里整理，定好了会追加给你；在那之前照目标原文里说的办。',
    );
  } else if (goal.constraints.length === 0) lines.push('没有额外的约束。');
  for (const c of goal.constraints) lines.push(`- ${c}`);
  if (goal.sharedSystems && goal.sharedSystems.length > 0) {
    lines.push('', '## 共用的外部系统', '');
    lines.push(
      `${goal.sharedSystems.join('、')}：没法复制，别的分支也可能在改它们，分支之间会互相影响，workspace 的 snapshot 也恢复不了它们。对它们动手前，先在 workspace 里把路线走通。`,
    );
  }
  lines.push('', '## 环境', '');
  if (goal.domain) {
    lines.push(`领域：${goal.domain}。`);
    if (opts.domainDescription?.trim()) lines.push(`领域说明：${oneLine(opts.domainDescription)}`);
  }
  lines.push(
    `你在自己的容器里，工作目录 /workspace 是这条分支的 workspace${opts.readOnly ? '（只读）' : ''}。原始输出在 /melina/artifacts（只读）。`,
  );
  if (goal.materials.length > 0) {
    lines.push('人给的附件（只读）：');
    for (const m of goal.materials) lines.push(`- /melina/materials/${m.name}`);
  }
  return lines.join('\n');
}

/** 一条记录的文字放进一行：换行连同两边的空白换成一个空格（不用正则：很长的空白串上正则会退化成平方复杂度） */
export function oneLine(text: string): string {
  if (!text.includes('\n')) return text.trim();
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join(' ');
}

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(10)));
}
