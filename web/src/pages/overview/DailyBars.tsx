// 每天花费的柱状图：一个序列一种颜色，不要图例；柱子最宽 24px、顶上圆角 4px、从同一条基线长出来；
// 网格线是细实线；只在最高的那根上标数字，其余看刻度、悬停或键盘聚焦时的提示，表格给读屏用（dataviz 的规矩）。

import { type KeyboardEvent, useRef, useState } from 'react';
import { formatTokens, formatUsd } from '../../lib/format.ts';

export interface DayUsage {
  day: string; // YYYY-MM-DD，本地日期
  usd: number;
  tokens: number;
}

/** 0 到 max 之间取 3～4 个整齐的刻度 */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function tickLabel(v: number): string {
  if (v === 0) return '$0';
  return v < 1 ? `$${v.toFixed(2)}` : `$${Number.isInteger(v) ? v : v.toFixed(1)}`;
}

export function dayLabel(day: string, today: string): string {
  if (day === today) return '今天';
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 方向键在柱子之间走：左右各一根，Home、End 到头尾；别的键不管（返回 null） */
export function nextBar(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'ArrowRight':
      return Math.min(count - 1, current + 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function DailyBars({ days, today, height = 148 }: { days: DayUsage[]; today: string; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  // 整组柱子只占一个 Tab（roving tabindex）：Tab 进来落在上次停的那根（默认今天），左右方向键换一根
  const [current, setCurrent] = useState(() => Math.max(0, days.length - 1));
  const cols = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIndex = Math.min(current, Math.max(0, days.length - 1));
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = nextBar(e.key, i, days.length);
    if (next === null) return;
    e.preventDefault();
    setCurrent(next);
    cols.current[next]?.focus();
  };
  const max = Math.max(0, ...days.map((d) => d.usd));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? 1;
  const peak = max > 0 ? days.findIndex((d) => d.usd === max) : -1;
  const every = days.length > 10 ? 3 : days.length > 7 ? 2 : 1;
  const shown = (i: number) => i === days.length - 1 || (days.length - 1 - i) % every === 0;
  const tip = active !== null ? days[active] : undefined;

  return (
    <figure className="bars">
      <div className="bars-plot" style={{ height }}>
        {ticks.map((t) => (
          <div key={t} className="bars-grid" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden="true">
            <span className="bars-tick num">{tickLabel(t)}</span>
          </div>
        ))}
        <div className="bars-cols" role="toolbar" aria-label="每天花费，左右方向键换一天">
          {days.map((d, i) => (
            <button
              type="button"
              key={d.day}
              ref={(el) => {
                cols.current[i] = el;
              }}
              className="bars-col"
              tabIndex={i === focusIndex ? 0 : -1}
              aria-label={`${dayLabel(d.day, today)}：${formatUsd(d.usd)}，${formatTokens(d.tokens)} token`}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((a) => (a === i ? null : a))}
              onFocus={() => {
                setActive(i);
                setCurrent(i);
              }}
              onBlur={() => setActive((a) => (a === i ? null : a))}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span
                className="bars-bar"
                data-active={active === i || undefined}
                style={{ height: d.usd > 0 ? `max(2px, ${(d.usd / top) * 100}%)` : 0 }}
              >
                {i === peak && <span className="bars-value num">{formatUsd(d.usd)}</span>}
              </span>
            </button>
          ))}
        </div>
        {tip && active !== null && (
          <div
            className="bars-tip"
            style={{ left: `${Math.min(88, Math.max(12, ((active + 0.5) / days.length) * 100))}%` }}
            aria-hidden="true"
          >
            <b className="num">{formatUsd(tip.usd)}</b>
            <span>
              {dayLabel(tip.day, today)} · {formatTokens(tip.tokens)} token
            </span>
          </div>
        )}
      </div>
      <div className="bars-x" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day}>{shown(i) ? dayLabel(d.day, today) : ''}</span>
        ))}
      </div>
      <div className="visually-hidden">
        <table>
          <caption>每天花费</caption>
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col">费用</th>
              <th scope="col">token</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{formatUsd(d.usd)}</td>
                <td>{formatTokens(d.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
