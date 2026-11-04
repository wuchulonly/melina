// 用量的分项表：总览按角色，任务页按角色、按路线。

import type { UsageTotals } from '../../../src/core/events.ts';
import type { Role } from '../../../src/core/types.ts';
import { cacheHitRate, formatPercent, formatTokens, formatUsd, totalTokens } from '../lib/format.ts';
import { roleLabel } from '../lib/labels.ts';

export interface UsageRow extends UsageTotals {
  key: string;
  /** 给人看的名字：角色的叫法、路线的短名 */
  name: string;
  /** 名字后面淡一点的补充，比如「主路线」 */
  note?: string;
}

/** 按角色：花在谁身上、缓存命中多少；按费用从多到少 */
export function roleRows(byRole: readonly ({ role: Role } & UsageTotals)[]): UsageRow[] {
  return byRole.map((r) => ({ ...r, key: r.role, name: roleLabel(r.role) })).sort((a, b) => b.usd - a.usd);
}

/** 一张分项表：名字、token、费用、缓存命中 */
export function UsageTable({ rows, head }: { rows: readonly UsageRow[]; head: string }) {
  return (
    <table className="table usage-table">
      <thead>
        <tr>
          <th scope="col">{head}</th>
          <th scope="col" className="r">
            token
          </th>
          <th scope="col" className="r">
            费用
          </th>
          <th scope="col" className="r">
            缓存命中
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              {r.name}
              {r.note && <span className="faint">（{r.note}）</span>}
            </td>
            <td className="r">{formatTokens(totalTokens(r))}</td>
            <td className="r">{formatUsd(r.usd)}</td>
            <td className="r">{formatPercent(cacheHitRate(r))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
