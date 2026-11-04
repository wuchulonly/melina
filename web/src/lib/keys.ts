// 快捷键的说法：发送是 Ctrl + Enter，Mac 上是 ⌘ + Enter（按键处理两种都认）。

/** 这台机器是不是 Mac（iPad 接键盘也算） */
export function isMac(nav: Pick<Navigator, 'platform' | 'userAgent'> | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  const platform =
    (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? nav.platform;
  return /mac|iphone|ipad/i.test(platform || nav.userAgent);
}

/** 写在 <kbd> 里的那个修饰键 */
export function modKeyLabel(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
