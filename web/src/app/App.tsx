// 外壳：左边导航（总览、任务、模型、设置）和没结束的任务，右边是页面。
// 工作台页和结果页（/runs/:id）是 的，这里只留入口。
// 新建任务、接着做的弹窗挂在这里（哪一页都能就地弹出来）；开它的按钮在任务页页头和各处「接着做」，侧栏只放导航。

import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import type { RunListItem } from '../../../src/core/api.ts';
import { LiveProvider, useStreamState } from '../api/live.tsx';
import { useResource } from '../api/resource.ts';
import { RUNS } from '../api/resources.ts';
import type { StreamState } from '../api/stream.ts';
import melinaIcon from '../assets/melina.svg?inline';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { ToastProvider } from '../components/feedback.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { glyphLabel, RunGlyph } from '../components/RunGlyph.tsx';
import { cx, EmptyState } from '../components/ui.tsx';
import { isEnded, runningCount } from '../lib/labels.ts';
import { ModelsPage } from '../pages/models/ModelsPage.tsx';
import { OverviewPage } from '../pages/overview/OverviewPage.tsx';
import { RunPage } from '../pages/run/RunPage.tsx';
import { SettingsPage } from '../pages/settings/SettingsPage.tsx';
import { NewTaskDialog } from '../pages/tasks/NewTaskDialog.tsx';
import { TasksPage } from '../pages/tasks/TasksPage.tsx';
import { Link, matchPath, useLocation } from './router.tsx';

type NavKey = 'overview' | 'tasks' | 'models' | 'settings';

interface Page {
  nav: NavKey | null;
  title: string;
  element: ReactNode;
}

function resolve(pathname: string): Page {
  if (pathname === '/') return { nav: 'overview', title: '总览', element: <OverviewPage /> };
  if (pathname === '/runs' || pathname === '/runs/') return { nav: 'tasks', title: '任务', element: <TasksPage /> };
  const run = matchPath('/runs/:id/*', pathname);
  if (run?.id)
    return { nav: 'tasks', title: '任务', element: <RunPage key={run.id} runId={run.id} rest={run['*'] ?? ''} /> };
  if (pathname === '/models') return { nav: 'models', title: '模型', element: <ModelsPage /> };
  if (pathname === '/settings') return { nav: 'settings', title: '设置', element: <SettingsPage /> };
  return { nav: null, title: '找不到这个页面', element: <NotFound /> };
}

export function App() {
  return (
    <ToastProvider>
      <LiveProvider>
        <Shell />
      </LiveProvider>
    </ToastProvider>
  );
}

/** 任务页的标签页标题用这个任务的目标，截到这么多字 */
const TITLE_MAX = 30;

/**
 * 浏览器标签页的标题：「总览 · Melina」；任务页用这个任务的目标代替「任务」，开着几个任务的标签页时分得清。
 * 目标里的换行、连续空白压成一个空格，太长截短加省略号
 */
export function documentTitle(page: string, statement?: string): string {
  const goal = statement?.replace(/\s+/g, ' ').trim();
  const chars = goal ? [...goal] : [];
  const name = !goal ? page : chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : goal;
  return `${name} · Melina`;
}

function Shell() {
  const { pathname, search } = useLocation();
  // 页面按地址记住：外壳跟着任务列表（运行中每条用量事件都改它）、连接状态重画时，同一个页面元素原样交下去，
  // React 不再把整页跟着重画一遍（以前开着总览时约每秒整页重画一次）
  const page = useMemo(() => resolve(pathname), [pathname]);

  const stream = useStreamState();
  // 侧栏本来就在拉任务列表，任务页的标题从这里按 id 找，不另外请求
  const runs = useResource(RUNS);
  const runId = matchPath('/runs/:id/*', pathname)?.id;
  const statement = runId ? runs.data?.runs.find((r) => r.id === runId)?.statement : undefined;
  const title = documentTitle(page.title, statement);

  useEffect(() => {
    document.title = title;
  }, [title]);

  // 换页以后焦点放到正文：点了的链接随旧页面一起没了，焦点会掉到 body，读屏也不知道换了页。
  // 新页面自己把焦点放进了正文（比如标签页的链接还在）就不动；第一次打开页面不抢焦点
  const mainRef = useRef<HTMLElement>(null);
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    const main = mainRef.current;
    const active = document.activeElement;
    if (!main || (active && active !== document.body && active.isConnected && !active.closest('.sidebar'))) return;
    main.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        跳到正文
      </a>
      <Sidebar active={page.nav} runId={runId} stream={stream} />
      <main id="main" className="main" tabIndex={-1} ref={mainRef}>
        {stream === 'reconnecting' && (
          <div className="conn-banner" role="status">
            <Icon name="spinner" size={15} className="spin" />和 Melina
            的连接断了，正在重连。页面上的内容可能不是最新的。
          </div>
        )}
        <ErrorBoundary what="这一页" resetKey={pathname}>
          {page.element}
        </ErrorBoundary>
        {/* 开着时在最上层，放在哪儿都一样；放在正文里，万一画不出来，那句话也落在正文里 */}
        <ErrorBoundary what="新建任务的弹窗" resetKey={search}>
          <NewTaskDialog />
        </ErrorBoundary>
      </main>
    </div>
  );
}

function Sidebar({ active, runId, stream }: { active: NavKey | null; runId: string | undefined; stream: StreamState }) {
  const runs = useResource(RUNS);
  const running = runs.data ? runningCount(runs.data.runs) : 0;
  return (
    <aside className="sidebar">
      <Link to="/" className="brand" aria-label="Melina 总览">
        {/* 和标签页上的图标是同一张（assets/melina.svg）；内嵌进脚本，刷新时不会先空一下再冒出来 */}
        <img className="brand-mark" src={melinaIcon} alt="" width={32} height={32} />
        <span className="brand-name">Melina</span>
      </Link>
      <nav className="nav" aria-label="主导航">
        <NavItem to="/" icon="overview" label="总览" current={active === 'overview'}></NavItem>
        <NavItem to="/runs" icon="tasks" label="任务" current={active === 'tasks'}>
          {running > 0 && <span className="nav-meta">{running} 个在跑</span>}
        </NavItem>
        <NavItem to="/models" icon="models" label="模型" current={active === 'models'} />
        <NavItem to="/settings" icon="settings" label="设置" current={active === 'settings'} />
      </nav>
      {runs.data && <SideRuns runs={runs.data.runs} current={runId} />}
      <div className="sidebar-foot">
        <Connection state={stream} />
      </div>
    </aside>
  );
}

/** 侧栏最多列这么多个没结束的任务，多的去任务页看 */
const SIDE_RUNS_MAX = 6;

/**
 * 侧栏里列出没结束的任务（在跑、收尾、暂停的），新的在前：开着几个任务时不用先回任务页再找。
 * 前面是状态的小图形（components/RunGlyph.tsx）：蓝圈半满在跑、灰圈暂停
 */
function SideRuns({ runs, current }: { runs: readonly RunListItem[]; current: string | undefined }) {
  const open = runs.filter((r) => !isEnded(r.status));
  if (open.length === 0) return null;
  const shown = open.slice(0, SIDE_RUNS_MAX);
  return (
    <nav className="side-runs" aria-labelledby="side-runs-title">
      {/* 和任务页的分组一个叫法：没结束的（含暂停、收尾）都算「进行中」 */}
      <h2 className="side-runs-title" id="side-runs-title">
        进行中
        <span className="side-runs-count num">{open.length}</span>
      </h2>
      {shown.map((r) => (
        <Link
          key={r.id}
          to={`/runs/${r.id}`}
          className="side-run"
          aria-current={r.id === current ? 'page' : undefined}
          title={r.statement}
        >
          {/* 图只是看的；读屏念后面括号里的字，和以前一样 */}
          <RunGlyph run={r} size={14} decorative />
          <span className="side-run-text">{r.statement}</span>
          <span className="visually-hidden">（{glyphLabel(r)}）</span>
        </Link>
      ))}
      {open.length > shown.length && (
        <Link to="/runs" className="side-runs-more">
          还有 {open.length - shown.length} 个
        </Link>
      )}
    </nav>
  );
}

function NavItem({
  to,
  icon,
  label,
  current,
  children,
}: {
  to: string;
  icon: IconName;
  label: string;
  current: boolean;
  children?: ReactNode;
}) {
  return (
    <Link to={to} className="nav-link" aria-current={current ? 'page' : undefined}>
      <Icon name={icon} size={18} />
      <span className="nav-label">{label}</span>
      {children}
    </Link>
  );
}

const CONNECTION: Record<StreamState, { text: string; tone: string }> = {
  open: { text: '已连上 Melina，实时更新', tone: 'tone-green' },
  connecting: { text: '正在连接 Melina…', tone: 'tone-gray' },
  reconnecting: { text: '连接断了，正在重连…', tone: 'tone-amber' },
};

function Connection({ state }: { state: StreamState }) {
  const c = CONNECTION[state];
  return (
    <span className="conn" role="status" data-state={state}>
      <span className={cx('dot', c.tone, state !== 'open' && 'dot-live')} aria-hidden="true" />
      <span className="conn-text">{c.text}</span>
    </span>
  );
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState icon="question" title="这里什么都没有">
        <Link to="/">回到总览</Link>
      </EmptyState>
    </div>
  );
}
