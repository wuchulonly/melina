// 浏览器通知：页面开着时，任务结束就弹。
// 人正看着这个页面时不弹（页面上已经看得到了），切到别的标签页或窗口时才弹。

import melinaIcon from '../assets/melina.svg';

export type NotifyPermission = NotificationPermission | 'unsupported';

export function notifyPermission(): NotifyPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** 要在点击之类的操作里调用，浏览器才会弹出授权框 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function pageInFocus(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function showNotification(title: string, body: string, opts: { tag?: string; onClick?: () => void } = {}): void {
  if (notifyPermission() !== 'granted' || pageInFocus()) return;
  try {
    const n = new Notification(title, { body, tag: opts.tag, icon: melinaIcon });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    // 有的浏览器只许 service worker 弹通知，弹不出来就算了
  }
}
