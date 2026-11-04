// 任务状态的小图形：侧栏、总览「最近的任务」、任务列表每一行左边一个，形状和颜色一起说状态。
// 圈是还没完：在跑半满、收尾四分之三满、暂停两道竖线；实心是到头了：完成打勾、取消打叉、出错感叹号。
// 旁边写了字的地方传 decorative，图只是陪着字，读屏不念两遍。

import type { ReactNode } from 'react';
import type { RunListItem } from '../../../src/core/api.ts';
import { runStatusLook } from '../lib/labels.ts';
import { cx } from './ui.tsx';

export type GlyphKind = 'running' | 'settling' | 'paused' | 'done' | 'cancelled' | 'failed';

type GlyphRun = Pick<RunListItem, 'status' | 'mode'>;

/** 一个任务该画哪个：按状态和收尾模式判断 */
export function glyphKind(run: GlyphRun): GlyphKind {
  if (run.status === 'running') return run.mode === 'settling' ? 'settling' : 'running';
  // 暂停着时交了结果也进收尾（labels.ts runStatusLook）
  if (run.status === 'paused' && run.mode === 'settling') return 'settling';
  return run.status;
}

/** 图的名字：读屏念的、指上去提示的 */
export function glyphLabel(run: GlyphRun): string {
  return runStatusLook(run.status, run.mode).label;
}

// 16 格。圈半径 6.25、线宽 1.5（外沿 7，和实心的一样大）；里面的记号用卡片的底色（--surface）挖出来
const RING = <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />;
const DISC = <circle cx="8" cy="8" r="7" fill="currentColor" />;
const ON = 'var(--surface)';
const bars = (color: string) => (
  <path d="M6.5 5.9v4.2M9.5 5.9v4.2" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
);

const SHAPES: Record<GlyphKind, ReactNode> = {
  running: (
    <>
      {RING}
      <path d="M8 4.75a3.25 3.25 0 0 1 0 6.5Z" fill="currentColor" />
    </>
  ),
  settling: (
    <>
      {RING}
      <path d="M8 8V4.75A3.25 3.25 0 1 1 4.75 8Z" fill="currentColor" />
    </>
  ),
  paused: (
    <>
      {RING}
      {bars('currentColor')}
    </>
  ),
  done: (
    <>
      {DISC}
      <path
        d="M5.1 8.2l1.95 1.95 3.85-3.9"
        fill="none"
        stroke={ON}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  cancelled: (
    <>
      {DISC}
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" stroke={ON} strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  failed: (
    <>
      {DISC}
      <path d="M8 4.5v4.3" stroke={ON} strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="8" cy="11.15" r="0.95" fill={ON} />
    </>
  ),
};

/** 画一枚；label 是它的名字，decorative 时只是陪着旁边的字 */
export function Glyph({
  kind,
  label,
  size = 16,
  decorative = false,
  className,
}: {
  kind: GlyphKind;
  label: string;
  size?: number;
  decorative?: boolean;
  className?: string;
}) {
  const common = {
    className: cx('glyph', `glyph-${kind}`, className),
    width: size,
    height: size,
    viewBox: '0 0 16 16',
  };
  if (decorative)
    return (
      <svg {...common} aria-hidden="true">
        {SHAPES[kind]}
      </svg>
    );
  // 名字只放在 aria-label 里、不画 <title>：<title> 的字会被当成这一行的文字（任务页「进行中」那组的行里不再写「进行中」）
  return (
    <svg {...common} role="img" aria-label={label}>
      {SHAPES[kind]}
    </svg>
  );
}

/**
 * 列表里图旁边还要写出字的状态：正常在跑、做完了是常态，只画图不写字（几十行一长列「进行中」「完成了」很吵）；
 * 收尾、暂停、取消、出错照写。tone 是字的颜色
 */
export function stateNote(run: GlyphRun): { text: string; tone: 'amber' | 'red' | 'gray' } | undefined {
  const kind = glyphKind(run);
  if (kind === 'running' || kind === 'done') return undefined;
  const text = glyphLabel(run);
  return { text, tone: kind === 'failed' ? 'red' : 'gray' };
}

/** 一个任务的状态图 */
export function RunGlyph({
  run,
  size,
  decorative,
  className,
}: {
  run: GlyphRun;
  size?: number;
  decorative?: boolean;
  className?: string;
}) {
  return (
    <Glyph kind={glyphKind(run)} label={glyphLabel(run)} size={size} decorative={decorative} className={className} />
  );
}
