// 几个到处用的小部件。

import { type ReactNode, useEffect, useState } from 'react';
import { formatFullTime, formatRelative, splitReading } from '../lib/format.ts';
import type { StatusLook } from '../lib/labels.ts';
import { Icon, type IconName } from './Icon.tsx';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** 状态徽标：圆点 + 字；在动的圆点会呼吸 */
export function StatusBadge({ look, className }: { look: StatusLook; className?: string }) {
  return (
    <span className={cx('badge', `badge-${look.tone === 'gray' ? 'outline' : look.tone}`, className)}>
      <span className={cx('dot', look.live && 'dot-live', `tone-${look.tone}`)} aria-hidden="true" />
      {look.label}
    </span>
  );
}

/**
 * 读数：数字是主角，$、万、ms、% 这些小一号放淡（ui.css 的 .rd-*）；指标的名字（「冷启动」）在前面，放轻一档。
 * 只是分段上样式，字和原文一样（读屏、复制出来都是「冷启动 640 ms」）；不是「数字 + 单位」的照原样写
 */
export function Reading({ value, name, className }: { value: string; name?: string; className?: string }) {
  const p = splitReading(value);
  return (
    <span className={cx('rd', className)}>
      {name && <span className="rd-name">{name} </span>}
      {p ? (
        <>
          {p.pre && <span className="rd-pre">{p.pre}</span>}
          <span className="rd-num">{p.num}</span>
          {p.unit && (
            <span className="rd-unit">
              {p.gap}
              {p.unit}
            </span>
          )}
        </>
      ) : (
        value
      )}
    </span>
  );
}

let tick = 0;
const tickers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

/** 每 30 秒变一次，让「3 分钟前」这类字自己更新 */
export function useNow(): number {
  const [, setTick] = useState(tick);
  useEffect(() => {
    const cb = () => setTick(tick);
    tickers.add(cb);
    ticker ??= setInterval(() => {
      tick++;
      for (const t of tickers) t();
    }, 30_000);
    return () => {
      tickers.delete(cb);
      if (tickers.size === 0 && ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    };
  }, []);
  return Date.now();
}

export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={iso} title={formatFullTime(iso)} className={className}>
      {formatRelative(iso, now)}
    </time>
  );
}

export function EmptyState({ icon, title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={26} className="empty-icon" />}
      <p className="empty-title">{title}</p>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

/** 读不到数据时的说法，带一个重试 */
export function LoadError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="callout callout-red" role="alert">
      <Icon name="alert" className="callout-icon" />
      <div className="stack" style={{ gap: 8 }}>
        <span>{error.message}</span>
        {onRetry && (
          <span>
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              再试一次
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

export function InlineError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p className="inline-error" role="alert">
      <Icon name="alert" size={16} />
      <span>{message}</span>
    </p>
  );
}

export function Skeleton({
  width = '100%',
  height = 14,
  style,
}: {
  width?: number | string;
  height?: number;
  style?: object;
}) {
  return <span className="skeleton" style={{ display: 'block', width, height, ...style }} aria-hidden="true" />;
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card card-body stack" role="status" aria-busy="true">
      <span className="visually-hidden">正在读取</span>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 占位行没有身份
        <Skeleton key={i} width={i === 0 ? '45%' : i === lines - 1 ? '70%' : '100%'} height={i === 0 ? 16 : 13} />
      ))}
    </div>
  );
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return <Icon name="spinner" size={size} className="spin" label={label} />;
}

/** 开关：role="switch"，键盘空格能切 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Callout({
  tone = 'plain',
  icon = 'info',
  title,
  children,
  className,
}: {
  tone?: 'plain' | 'amber' | 'red' | 'accent';
  icon?: IconName;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('callout', tone !== 'plain' && `callout-${tone}`, className)}>
      <Icon name={icon} className="callout-icon" />
      <div className="stack" style={{ gap: 4, minWidth: 0 }}>
        {title && <div className="callout-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/** 有改动没保存时贴在底部的条 */
export function SaveBar({
  saving,
  onSave,
  onDiscard,
  message = '改动还没保存',
  error,
  canSave = true,
}: {
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  message?: string;
  error?: string | null;
  canSave?: boolean;
}) {
  return (
    <section className="savebar" aria-label="保存改动">
      <div className="stack" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500 }}>{message}</span>
        {error && (
          <span className="small" style={{ color: 'var(--red)' }} role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="row">
        <button type="button" className="btn btn-quiet" onClick={onDiscard} disabled={saving}>
          放弃改动
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving || !canSave}>
          {saving ? <Spinner /> : <Icon name="check" size={16} />}
          保存
        </button>
      </div>
    </section>
  );
}
