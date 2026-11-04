// 用量：累计花了多少、每天花多少、按模型分、按角色分（含缓存命中率）。
// Run 没有预算，这里只给人看着。

import type { UsageResponse } from '../../../../src/core/api.ts';
import { useResource } from '../../api/resource.ts';
import { USAGE } from '../../api/resources.ts';
import { roleRows, UsageTable } from '../../components/UsageTables.tsx';
import { cx, EmptyState, LoadError, Reading, SkeletonCard } from '../../components/ui.tsx';
import { cacheHitRate, formatPercent, formatTokens, formatUsd, totalTokens } from '../../lib/format.ts';
import { modelName } from '../../lib/labels.ts';
import { DailyBars, type DayUsage } from './DailyBars.tsx';

const DAYS = 14;

export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 最近 n 天，以今天结尾，没有记录的天补 0 */
export function lastDays(byDay: UsageResponse['byDay'], n: number, now = Date.now()): DayUsage[] {
  const found = new Map(byDay.map((d) => [d.day, d]));
  const out: DayUsage[] = [];
  const today = new Date(now);
  for (let i = n - 1; i >= 0; i--) {
    const day = localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime());
    const d = found.get(day);
    out.push({ day, usd: d?.usd ?? 0, tokens: d ? totalTokens(d) : 0 });
  }
  return out;
}

export function Usage() {
  const usage = useResource(USAGE);
  return (
    <section className="section" aria-labelledby="usage-title">
      <div className="section-head">
        <h2 className="section-title" id="usage-title">
          用量
        </h2>
        <span className="section-note">任务没有预算上限，花多少都记在这里</span>
      </div>
      {usage.error && !usage.data ? (
        <LoadError error={usage.error} onRetry={usage.reload} />
      ) : !usage.data ? (
        <SkeletonCard lines={6} />
      ) : (
        <UsageCard usage={usage.data} />
      )}
    </section>
  );
}

function UsageCard({ usage }: { usage: UsageResponse }) {
  // 一分钱、一个 token 都还没花（刚装好）：不画 $0、0 token、一排空柱子和空表，一句话说这里以后记什么
  if (usage.total.usd === 0 && totalTokens(usage.total) === 0 && usage.byModel.length === 0)
    return (
      <div className="card">
        <EmptyState icon="chart" title="还没有用量">
          任务跑起来以后，这里按天记花了多少，再按模型、按角色分开算。
        </EmptyState>
      </div>
    );
  const now = Date.now();
  const today = localDay(now);
  const days = lastDays(usage.byDay, DAYS, now);
  const todayUsd = days.at(-1)?.usd ?? 0;
  const models = [...usage.byModel].sort((a, b) => b.usd - a.usd);
  const maxUsd = Math.max(0, ...models.map((m) => m.usd));
  const roles = roleRows(usage.byRole ?? []);
  const t = usage.total;
  const hit = cacheHitRate(t);
  // 两行，每行宽的时候左右两栏（overview.css 按卡的宽度切）：上面累计和每天的柱子，下面按模型、按角色两张表。
  // 以前左边累计加柱子、右边两张表叠着，右栏比左栏高出一倍，左下空一大块
  return (
    <div className="card usage">
      <div className="usage-row usage-top">
        <div className="usage-cell usage-summary">
          <div className="usage-total">
            <span className="tile-label">累计花费</span>
            <Reading className="hero num" value={formatUsd(t.usd)} />
            <span className="tile-sub">今天 {formatUsd(todayUsd)}</span>
          </div>
          <div className="usage-tokens">
            <span className="tile-label">token</span>
            <Reading className="usage-tokens-total num" value={formatTokens(totalTokens(t))} />
            <span className="tile-sub">
              输入 {formatTokens(t.input)} · 缓存命中 {formatTokens(t.cacheRead)}
              {hit !== undefined && `（${formatPercent(hit)}）`}
              {t.cacheWrite > 0 && ` · 缓存写入 ${formatTokens(t.cacheWrite)}`} · 输出 {formatTokens(t.output)}
            </span>
          </div>
        </div>
        <div className="usage-cell usage-chart">
          <h3 className="usage-subtitle">最近 {DAYS} 天，每天花费</h3>
          <DailyBars days={days} today={today} />
        </div>
      </div>
      <div className={cx('usage-row usage-tables', roles.length === 0 && 'is-single')}>
        <div className="usage-cell usage-models">
          <h3 className="usage-subtitle">按模型</h3>
          <ModelTable models={models} maxUsd={maxUsd} />
        </div>
        {roles.length > 0 && (
          <div className="usage-cell usage-roles">
            <h3 className="usage-subtitle">按角色</h3>
            <UsageTable rows={roles} head="角色" />
          </div>
        )}
      </div>
    </div>
  );
}

function ModelTable({ models, maxUsd }: { models: UsageResponse['byModel']; maxUsd: number }) {
  return models.length === 0 ? (
    <p className="faint small">还没有用量。</p>
  ) : (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">模型</th>
          <th scope="col" className="r">
            token
          </th>
          <th scope="col" className="r">
            费用
          </th>
          <th scope="col" className="share-col">
            <span className="visually-hidden">占比</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => (
          <tr key={modelName(m)}>
            {/* 供应商放淡，窄了在斜杠后面折行（以前截成「deepseek/deepseek…」，两个 deepseek 的模型看着一样）。
                模型那半是 inline-block，读屏算名字时会在斜杠后面插个空格，所以整串写进 aria-label */}
            <td className="mono model-cell" aria-label={modelName(m)}>
              <span className="model-provider">{m.provider}/</span>
              <wbr />
              <span className="model-id">{m.model}</span>
            </td>
            <td className="r">{formatTokens(totalTokens(m))}</td>
            <td className="r">{formatUsd(m.usd)}</td>
            <td className="share-col" aria-hidden="true">
              <span className="share">
                <span style={{ width: `${maxUsd > 0 ? (m.usd / maxUsd) * 100 : 0}%` }} />
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
