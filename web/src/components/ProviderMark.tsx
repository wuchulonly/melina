// 供应商的字母头像：
// 名字的第一个字，底色按 id 算一个色相、淡淡的（亮度和彩度是令牌 --mark-*，样子在 ui.css .provider-mark），
// 几家排在一起一眼分得开；不用各家的商标。

import type { CSSProperties } from 'react';
import { cx } from './ui.tsx';

/** 色相按 id 算：同一家每次一样，几家之间不保证不撞色 */
export function markHue(provider: string): number {
  let hue = 0;
  for (const ch of provider) hue = (hue * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return hue;
}

/** 头像上的字：名字的第一个字，西文大写 */
export function markInitial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? '?';
}

/** name：给人看的名字（模型页是目录里的名字，自定义的是人填的）；没有就传 id */
export function ProviderMark({ provider, name, small }: { provider: string; name: string; small?: boolean }) {
  return (
    <span
      className={cx('provider-mark', small && 'provider-mark-sm')}
      style={{ '--mark-h': markHue(provider) } as CSSProperties}
      aria-hidden="true"
    >
      {markInitial(name)}
    </span>
  );
}
