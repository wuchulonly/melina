// 新建任务、接着做的弹窗开着哪个，记在地址里：?new 是新建，?continue=<上个任务> 是接着做，挂在哪一页后面都行。
// 弹窗本身在 pages/tasks/NewTaskDialog.tsx，外壳里只挂一个；这里是开、关它的链接和地址的读写。
// 和任务页的抽屉一样（RunPage.tsx）：浏览器后退先关弹窗，刷新以后还开着，按住 Ctrl 点「接着做」能在新标签页打开。

import type { MouseEvent, ReactNode } from 'react';
import { navigate } from './router.tsx';

/** 就地打开弹窗时推进历史的标记：关的时候看到它就用后退关，历史里不多留一条「开着弹窗」 */
const PUSHED = { melinaNewTask: true };

function pushedHere(): boolean {
  return (window.history.state as { melinaNewTask?: boolean } | null)?.melinaNewTask === true;
}

export interface NewTaskTarget {
  /** 弹窗里那张表是哪一张：新建是 new，接着做是 continue:<上个任务>；换了一张，表重新来过 */
  key: string;
  continueFrom?: string;
}

/** 地址里开着哪个弹窗；没开是 null */
export function newTaskTarget(search: string): NewTaskTarget | null {
  const params = new URLSearchParams(search);
  const continueFrom = params.get('continue');
  if (continueFrom) return { key: `continue:${continueFrom}`, continueFrom };
  if (params.has('new')) return { key: 'new' };
  return null;
}

/**
 * 开弹窗的地址：只写查询串，浏览器按当前这一页补全（在 /runs 上是 /runs?new，在结果页是 /runs/X/result?continue=X）。
 * 这一页别的参数（开着的抽屉）不带过去；也不用读当前地址，单测里在 Node 渲染也行
 */
export function newTaskHref(continueFrom?: string): string {
  return continueFrom ? `?continue=${encodeURIComponent(continueFrom)}` : '?new';
}

/** 去掉开弹窗的参数，别的照旧 */
export function closedHref(pathname: string, search: string, hash = ''): string {
  const params = new URLSearchParams(search);
  params.delete('new');
  params.delete('continue');
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}

/** 就地打开：推进一条历史，不回到顶上 */
export function openNewTask(continueFrom?: string): void {
  navigate(newTaskHref(continueFrom), { keepScroll: true, state: PUSHED });
}

/** 弹窗开着时从接着做换成新建：换掉当前这一条历史，关的时候一次后退就回到打开之前 */
export function switchNewTask(continueFrom?: string): void {
  navigate(newTaskHref(continueFrom), { replace: true, keepScroll: true, state: window.history.state });
}

/** 关上：是就地打开的就后退；刷新过、从链接直接进来的，把参数从地址里去掉 */
export function closeNewTask(): void {
  if (pushedHere()) window.history.back();
  else
    navigate(closedHref(window.location.pathname, window.location.search, window.location.hash), {
      replace: true,
      keepScroll: true,
    });
}

/** 开始以后进到新任务：换掉「开着弹窗」那一条历史，从新任务后退回到打开之前的那页，弹窗不会再弹出来 */
export function goToNewRun(runId: string): void {
  navigate(`/runs/${encodeURIComponent(runId)}`, { replace: true });
  window.scrollTo({ top: 0 });
}

/** 普通的左键点击（没按 Ctrl、Cmd、Shift、Alt）：就地处理；别的交给浏览器（开新标签） */
export function plainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * 开弹窗的链接（「新建任务」「接着做」）：普通点击就地打开，页面不动；
 * 按着 Ctrl、Cmd、Shift 或中键还是浏览器自己开新标签，新标签页里这一页的弹窗也开着
 */
export function NewTaskLink({
  continueFrom,
  className,
  children,
}: {
  continueFrom?: string;
  className?: string;
  children: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    openNewTask(continueFrom);
  };
  return (
    <a href={newTaskHref(continueFrom)} className={className} aria-haspopup="dialog" onClick={onClick}>
      {children}
    </a>
  );
}
