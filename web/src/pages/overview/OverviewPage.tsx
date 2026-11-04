// 总览：页头一排关键数字，下面是最近的任务、系统状态和用量。

import { useResource } from '../../api/resource.ts';
import { RUNS, STATUS, USAGE } from '../../api/resources.ts';
import { Link } from '../../app/router.tsx';
import { Reading } from '../../components/ui.tsx';
import { formatUsd } from '../../lib/format.ts';
import { runningCount } from '../../lib/labels.ts';
import { useSetupSteps } from '../../lib/use-setup.ts';
import { RecentRuns } from './RecentRuns.tsx';
import { SystemStatus } from './SystemStatus.tsx';
import { lastDays, Usage } from './Usage.tsx';
import './overview.css';

export function OverviewPage() {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">总览</h1>
          <Summary />
        </div>
        <Kpis />
      </header>
      <RecentRuns />
      {/* 系统状态、用量各占一整行，卡里面再分栏（以前左右两栏一高一矮，左边下面空出一大块） */}
      <SystemStatus />
      <Usage />
    </div>
  );
}

/**
 * 页头右边一排关键数字：在跑的任务、今天和累计花了多少。还没有任务时不画。
 */
function Kpis() {
  const runs = useResource(RUNS);
  const usage = useResource(USAGE);
  if (!runs.data || runs.data.runs.length === 0) return null;
  const today = usage.data ? (lastDays(usage.data.byDay, 1).at(-1)?.usd ?? 0) : undefined;
  return (
    <dl className="kpis">
      <div className="kpi">
        <dt>在跑的任务</dt>
        <dd className="num">{runningCount(runs.data.runs)}</dd>
      </div>
      {today !== undefined && (
        <div className="kpi">
          <dt>今天花费</dt>
          <dd>
            <Reading className="num" value={formatUsd(today)} />
          </dd>
        </div>
      )}
      {usage.data && (
        <div className="kpi">
          <dt>累计花费</dt>
          <dd>
            <Reading className="num" value={formatUsd(usage.data.total.usd)} />
          </dd>
        </div>
      )}
    </dl>
  );
}

function Summary() {
  const runs = useResource(RUNS);
  const status = useResource(STATUS);
  const setup = useSetupSteps();
  if (!runs.data) return <p className="page-sub">&nbsp;</p>;
  // 差的不一定是模型：容器引擎、镜像也在开工清单里
  if (runs.data.runs.length === 0 && setup)
    return <p className="page-sub">还没有任务。先把下面开工清单里还差的几步做完，再写第一个目标。</p>;
  if (runs.data.runs.length === 0)
    return (
      <p className="page-sub">
        还没有任务。<Link to="/runs?new">写下第一个目标</Link>，Melina 会自己摸清情况、一步步推进。
      </p>
    );
  const running = runs.data.runs.filter((r) => r.status === 'running').length;
  const paused = runs.data.runs.filter((r) => r.status === 'paused').length;
  const parts = [running > 0 ? `${running} 个任务在跑` : '现在没有任务在跑'];
  if (paused > 0) parts.push(`${paused} 个暂停着`);
  const queued = status.data?.toolExec.queued ?? 0;
  if (queued > 0) parts.push(`${queued} 条命令在排队等机器`);
  return <p className="page-sub">{parts.join('，')}。</p>;
}
