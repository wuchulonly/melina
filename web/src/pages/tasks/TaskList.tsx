// 任务列表：可以同时跑多个；结束的可以删除（连同 workspace 和产物）、接着做。
// 结束的写一句结果（RunListItem.outcome），按天分组；任务多了能搜、按结果筛（GET /runs 不分页，一次全拿，在这里筛）。

import { useDeferredValue, useId, useState } from 'react';
import type { RunListItem } from '../../../../src/core/api.ts';
import { api } from '../../api/client.ts';
import { invalidate, useResource } from '../../api/resource.ts';
import { RUNS } from '../../api/resources.ts';
import { NewTaskLink } from '../../app/new-task.tsx';
import { Link } from '../../app/router.tsx';
import { ConfirmButton, useToast } from '../../components/feedback.tsx';
import { Icon } from '../../components/Icon.tsx';
import { ModelText } from '../../components/ModelText.tsx';
import { RunGlyph, stateNote } from '../../components/RunGlyph.tsx';
import { EmptyState, LoadError, RelativeTime, SkeletonCard, useNow } from '../../components/ui.tsx';
import { formatDuration, formatTokens, formatUsd, totalTokens } from '../../lib/format.ts';
import { domainLabel, isEnded, modeLabel, workspaceLabel } from '../../lib/labels.ts';
import { filterRuns, groupByDay, RUN_FILTERS, type RunFilter, SEARCH_FROM } from './filter.ts';

export function TaskList() {
  const runs = useResource(RUNS);
  if (runs.error && !runs.data)
    return (
      <section className="section" aria-label="任务列表">
        <LoadError error={runs.error} onRetry={runs.reload} />
      </section>
    );
  if (!runs.data)
    return (
      <section className="section stack" aria-label="任务列表">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </section>
    );
  const all = runs.data.runs;
  const active = all.filter((r) => !isEnded(r.status));
  const ended = all.filter((r) => isEnded(r.status));
  if (all.length === 0)
    return (
      <section className="section" aria-label="任务列表">
        <div className="card">
          <EmptyState icon="tasks" title="还没有任务">
            <p>写下目标就开始，可以同时跑好几个。</p>
            <NewTaskLink className="btn btn-primary empty-action">
              <Icon name="plus" size={16} />
              新建任务
            </NewTaskLink>
          </EmptyState>
        </div>
      </section>
    );
  return (
    <>
      <TaskGroup title="进行中" runs={active} empty="现在没有在跑的任务。" />
      <EndedGroup runs={ended} />
    </>
  );
}

/** 已结束的：按天分组；多了能搜、按结果筛 */
function EndedGroup({ runs }: { runs: RunListItem[] }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RunFilter>('all');
  const deferred = useDeferredValue(query);
  const searchable = runs.length >= SEARCH_FROM;
  const shown = searchable ? filterRuns(runs, deferred, filter) : runs;
  const days = groupByDay(shown);
  return (
    <section className="section" aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <h2 className="section-title" id={`${id}-title`}>
          已结束
          <span className="faint num" style={{ fontWeight: 400 }}>
            {runs.length}
          </span>
        </h2>
        {searchable && (
          <div className="task-tools">
            <label className="visually-hidden" htmlFor={`${id}-q`}>
              搜任务
            </label>
            <input
              id={`${id}-q`}
              className="input task-search"
              type="search"
              placeholder="搜目标、结果、目录"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <fieldset className="seg">
              <legend className="visually-hidden">按结果筛</legend>
              {RUN_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={filter === f.key ? 'seg-btn is-on' : 'seg-btn'}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </fieldset>
          </div>
        )}
      </div>
      {runs.length === 0 ? (
        <p className="faint small group-empty">还没有结束的任务。</p>
      ) : shown.length === 0 ? (
        <p className="faint small group-empty">没有对得上的任务。</p>
      ) : (
        days.map((d) => (
          <div key={d.day} className="task-day">
            <h3 className="task-day-title">{d.day}</h3>
            <ul className="task-list">
              {d.runs.map((r) => (
                <TaskRow key={r.id} run={r} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function TaskGroup({ title, runs, empty }: { title: string; runs: RunListItem[]; empty: string }) {
  const id = `tasks-${title}`;
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h2 className="section-title" id={id}>
          {title}
          <span className="faint num" style={{ fontWeight: 400 }}>
            {runs.length}
          </span>
        </h2>
      </div>
      {runs.length === 0 ? (
        <p className="faint small group-empty">{empty}</p>
      ) : (
        <ul className="task-list">
          {runs.map((r) => (
            <TaskRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskRow({ run }: { run: RunListItem }) {
  const now = useNow();
  const toast = useToast();
  const ended = isEnded(run.status);
  const elapsed = (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.createdAt);
  const domain = domainLabel(run.domain);
  // 状态是左边一列小图形（components/RunGlyph.tsx），标题都对齐在它右边。
  // 正常在跑、做完了是常态，只画图（「进行中」组里每行写「进行中」、二十几行「完成了」一长列都很吵）；
  // 收尾、暂停、取消、出错在下面那行开头写出来。
  const note = stateNote(run);
  return (
    <li className="task">
      <RunGlyph run={run} decorative={note !== undefined} className="task-glyph" />
      <div className="task-main">
        <Link to={`/runs/${run.id}`} className="task-title">
          {run.statement}
        </Link>
        {ended && run.outcome && (
          <p className="task-outcome">
            <ModelText text={run.outcome} />
          </p>
        )}
        <div className="task-meta">
          {note && <span className={`state-${note.tone}`}>{note.text}</span>}
          {!ended && <span>{modeLabel(run.mode)}</span>}
          {domain && <span>{domain}</span>}
          <span className="task-dir" title={run.workspace}>
            <Icon name="folder" size={14} />
            {workspaceLabel(run.workspace)}
          </span>
          <span>
            <RelativeTime iso={run.createdAt} />
            开始
          </span>
          <span>
            {ended ? '用了' : '已跑'}
            {spaced(formatDuration(elapsed))}
          </span>
        </div>
      </div>
      <div className="task-side">
        <div className="task-usage">
          <span className="num">{formatUsd(run.usage.usd)}</span>
          <span className="faint num">{formatTokens(totalTokens(run.usage))} token</span>
        </div>
        {ended && (
          <div className="task-actions">
            <NewTaskLink continueFrom={run.id} className="btn btn-sm">
              <Icon name="continue" size={15} />
              接着做
            </NewTaskLink>
            <ConfirmButton
              iconOnly
              icon="trash"
              label="删除这个任务"
              question="连同它的副本和产物一起删？写回你仓库的分支不动；普通目录的交付物只存在这里，删了就下载不到了。"
              confirmLabel="删除"
              onConfirm={async () => {
                await api.deleteRun(run.id);
                toast('任务删掉了');
                invalidate('runs');
              }}
            />
          </div>
        )}
      </div>
    </li>
  );
}

/** 「用了 4 分钟」「用了不到 1 分钟」：数字开头才隔一个空格 */
function spaced(text: string): string {
  return /^[0-9]/.test(text) ? ` ${text}` : text;
}
