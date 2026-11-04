// 新建任务、接着做的弹窗：外壳里挂一个，地址里有 ?new 或 ?continue=<上个任务> 时打开（app/new-task.tsx）。
// 用原生 <dialog>（showModal）：焦点圈在里面、Esc 关、点外面关，关上以后焦点回到打开它的按钮（浏览器自己做）。
//
// 关上时不卸掉里面的表：写了一半的目标、选好的目录、加了的附件都还在，再打开同一张接着写；开始以后才清空。
// 目标和目录另外存在 sessionStorage 里（Composer.tsx 的草稿），刷新也还在；附件存不进去，只能靠不卸掉。

import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useResource } from '../../api/resource.ts';
import { runResource } from '../../api/resources.ts';
import {
  closeNewTask,
  goToNewRun,
  newTaskHref,
  newTaskTarget,
  plainClick,
  switchNewTask,
} from '../../app/new-task.tsx';
import { Link, useLocation } from '../../app/router.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Callout } from '../../components/ui.tsx';
import { isEnded } from '../../lib/labels.ts';
import { clause } from '../../lib/model-text.ts';
import { Composer, clearDraft, draftKey } from './Composer.tsx';
import './tasks.css';

const CONTINUE = 'continue:';

export function NewTaskDialog() {
  const { search } = useLocation();
  const target = newTaskTarget(search);
  const open = target !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  // 最近开过的那一张：关上以后它还留在关着的 dialog 里
  const [kept, setKept] = useState<string | null>(null);
  // 开始以后加一，表重新来过（草稿 Composer 已经清了）
  const [round, setRound] = useState(0);
  const key = target?.key ?? kept;
  const continueFrom = key?.startsWith(CONTINUE) ? key.slice(CONTINUE.length) : undefined;

  useEffect(() => {
    if (target?.key) setKept(target.key);
  }, [target?.key]);

  // layout effect：Composer 把光标放进目标框的 effect 在它之后跑，那时 dialog 已经开了（关着的 dialog 里 focus 不上）
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);

  useFitViewport(ref, open);

  // 地址已经说关了（后退了、开始以后换了页），浏览器随后还会发一个原生 close 事件：那时不能再改地址
  const close = () => {
    if (openRef.current) closeNewTask();
  };
  // 在弹窗里按下、拖到外面松开（比如选目标框里的字）也会在 dialog 本身上触发 click：只认按下和松开都在外面的
  const pressedOutside = useRef(false);

  const closeButton = (
    <button type="button" className="icon-btn new-task-close" aria-label="关上" onClick={close}>
      <Icon name="close" size={18} />
    </button>
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 点外面关只是鼠标的捷径；键盘用 Esc 关（下面的 cancel 事件）
    <dialog
      ref={ref}
      className="new-task-dialog"
      aria-label={continueFrom ? '接着做' : '新建任务'}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={() => {
        // 原生 close 事件排在任务队列里、晚一拍到：这期间又开了（关上马上再开、后退再前进），弹窗已经开着，
        // 这一下是上一次关的，再改地址就把刚开的又关了。浏览器自己关的（比如连按两下 Esc）那时弹窗是关着的，照旧同步地址
        if (ref.current?.open) return;
        close();
      }}
      onPointerDown={(e) => {
        pressedOutside.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (e.target === ref.current && pressedOutside.current) close();
      }}
    >
      {key && (
        <Sheet
          key={`${key}:${round}`}
          continueFrom={continueFrom}
          active={open}
          close={closeButton}
          onCreated={(runId) => {
            setKept(null);
            setRound((r) => r + 1);
            goToNewRun(runId);
          }}
        />
      )}
    </dialog>
  );
}

/** 弹窗离屏幕下沿至少留这么多（和 tasks.css 里矮屏时的 calc(100dvh - 32px) 一样，上下各 16px） */
const EDGE = 16;

/**
 * 表放不下就在弹窗里滚：弹窗平时不限高、不裁边（工作目录的补全列表能伸出下沿），窗口不够高、表又长
 * （接着做的横幅、长的目标、展开的工作目录、几个附件）时「开始」会掉到屏幕外面，页面在弹窗后面又滚不动。
 * 打开期间量表的高度（不算浮在上面的补全列表），按平时的上边距放不下就加 data-scroll，tasks.css 照矮屏的样子限高、在里面滚
 */
function useFitViewport(ref: { current: HTMLDialogElement | null }, open: boolean) {
  useEffect(() => {
    const d = ref.current;
    if (!d || !open || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      const kids = [...d.children];
      const first = kids[0];
      const last = kids.at(-1);
      const height = first && last ? last.getBoundingClientRect().bottom - first.getBoundingClientRect().top : 0;
      const top = Math.max(40, window.innerHeight * 0.11); // 平时的上边距：tasks.css 的 max(40px, 11vh)
      d.toggleAttribute('data-scroll', top + height + EDGE > window.innerHeight);
    };
    const sizes = new ResizeObserver(check);
    const watch = () => {
      sizes.disconnect();
      for (const el of d.children) sizes.observe(el);
      check();
    };
    // 里面换了一张表（接着做读完了、开始以后重来）：换着量
    const swaps = new MutationObserver(watch);
    swaps.observe(d, { childList: true });
    watch();
    window.addEventListener('resize', check);
    return () => {
      sizes.disconnect();
      swaps.disconnect();
      window.removeEventListener('resize', check);
      d.removeAttribute('data-scroll');
    };
  }, [ref, open]);
}

/** 弹窗里的一张表；接着做时先确认上个任务拿得到、已经结束了 */
function Sheet({
  continueFrom,
  active,
  close,
  onCreated,
}: {
  continueFrom?: string;
  active: boolean;
  close: ReactNode;
  onCreated: (runId: string) => void;
}) {
  const previous = useResource(continueFrom ? runResource(continueFrom) : null);
  if (!continueFrom) return <Composer active={active} onCreated={onCreated} close={close} />;
  if (previous.error && !previous.data)
    return (
      <Notice close={close}>
        <Callout tone="red" icon="alert" title="接不上这个任务">
          {clause(previous.error.message)}。<ToNew continueFrom={continueFrom}>新建一个任务</ToNew>
        </Callout>
      </Notice>
    );
  if (!previous.data)
    return (
      <Notice close={close}>
        <div className="composer-loading" aria-busy="true" />
      </Notice>
    );
  if (!isEnded(previous.data.run.status))
    return (
      <Notice close={close}>
        <Callout tone="amber" icon="info" title="这个任务还没结束">
          结束以后才能接着做。<Link to={`/runs/${continueFrom}`}>去看看它</Link>
        </Callout>
      </Notice>
    );
  return (
    <>
      <Composer previous={previous.data} active={active} onCreated={onCreated} close={close} />
      <p className="composer-cancel small">
        <ToNew continueFrom={continueFrom}>不接着做了，新建一个</ToNew>
      </p>
    </>
  );
}

/** 接着做接不上、还在读的时候：标题「接着做」，下面一条说明 */
function Notice({ close, children }: { close: ReactNode; children: ReactNode }) {
  return (
    <div className="new-task-notice">
      <div className="composer-head">
        <h2 className="composer-label">接着做</h2>
        {close}
      </div>
      {children}
    </div>
  );
}

/** 从接着做换成新建：换掉地址里的参数（不多推一条历史），接着做的草稿清掉 */
function ToNew({ continueFrom, children }: { continueFrom: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    clearDraft(draftKey(continueFrom));
    switchNewTask();
  };
  return (
    <a href={newTaskHref()} onClick={onClick}>
      {children}
    </a>
  );
}
