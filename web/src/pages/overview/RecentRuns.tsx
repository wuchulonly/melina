// 总览上的「最近的任务」：最近 5 个，新的在前（GET /runs 本来就是新的在前）。
// 没有任务在跑时总览不至于空着：回来一眼看到最近几个任务怎么样了，点进去看工作台。

import type { RunListItem } from '../../../../src/core/api.ts';
import { useResource } from '../../api/resource.ts';
import { RUNS } from '../../api/resources.ts';
import { Link } from '../../app/router.tsx';
import { RunGlyph, stateNote } from '../../components/RunGlyph.tsx';
import { cx, RelativeTime } from '../../components/ui.tsx';
import { formatUsd } from '../../lib/format.ts';
import { isEnded } from '../../lib/labels.ts';

const RECENT = 5;

export function RecentRuns() {
  const runs = useResource(RUNS);
  const list = runs.data?.runs.slice(0, RECENT) ?? [];
  // 还没有任务时页头已经说了「还没有任务」，这里不再占一块
  if (list.length === 0) return null;
  const more = (runs.data?.runs.length ?? 0) - list.length;
  return (
    <section className="section" aria-labelledby="recent-title">
      <div className="section-head">
        <h2 className="section-title" id="recent-title">
          最近的任务
        </h2>
        <Link to="/runs" className="section-note">
          {more > 0 ? `全部 ${more + list.length} 个任务` : '去任务页'}
        </Link>
      </div>
      <ul className="card recent-list">
        {list.map((r) => (
          <RecentRow key={r.id} run={r} />
        ))}
      </ul>
    </section>
  );
}

/** 一行：状态的小图形、目标、什么时候、花了多少；在跑和做完了只画图，别的状态在时间前面写出来 */
function RecentRow({ run }: { run: RunListItem }) {
  const ended = isEnded(run.status);
  const note = stateNote(run);
  return (
    <li className="recent">
      <RunGlyph run={run} decorative={note !== undefined} />
      <Link to={`/runs/${run.id}`} className="recent-title" title={run.statement}>
        {run.statement}
      </Link>
      <span className="recent-when">
        {note && <span className={cx('recent-state', `state-${note.tone}`)}>{note.text}</span>}
        <span>
          <RelativeTime iso={ended && run.endedAt ? run.endedAt : run.createdAt} />
          {ended ? '结束' : '开始'}
        </span>
      </span>
      <span className="recent-cost num">{formatUsd(run.usage.usd)}</span>
    </li>
  );
}
