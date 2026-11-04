import { useEffect, useRef, useState } from 'react';
import type { BranchCard, BranchDetail, RunResultResponse } from '../../../../src/core/api.ts';
import type { Handle } from '../../../../src/core/ids.ts';
import { api, artifactUrl, fetchArtifactText } from '../../api/client.ts';
import { useMelinaEvents } from '../../api/live.tsx';
import { invalidate, useResource } from '../../api/resource.ts';
import { runResource } from '../../api/resources.ts';
import { Link } from '../../app/router.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { EmptyState, LoadError, SkeletonCard, StatusBadge } from '../../components/ui.tsx';
import { formatUsd } from '../../lib/format.ts';
import { isEnded, runStatusLook } from '../../lib/labels.ts';
import './run.css';

export function RunPage({ runId, rest }: { runId: string; rest: string }) {
  const resource = runResource(runId);
  const summary = useResource(resource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [hint, setHint] = useState('');
  useMelinaEvents((e) => {
    if (e.runId === runId && e.type !== 'usage.updated') invalidate(`run:${runId}`);
  });
  const data = summary.data;
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      invalidate(`run:${runId}`);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return <div className="page">{summary.error ? <LoadError error={summary.error} /> : <SkeletonCard />}</div>;
  const { run } = data;
  const ended = isEnded(run.status);
  const settling = run.mode === 'settling';
  const tabs = [
    ['', '路线'],
    ['result', '结果'],
    ['config', '配置'],
  ] as const;
  const tab = tabs.some(([path]) => path === rest) ? rest : '';
  return (
    <div className="page direct-run">
      <header className="page-head">
        <div>
          <Link to="/runs">任务</Link>
          <h1 className="page-title">{run.goal.statement}</h1>
          <StatusBadge look={runStatusLook(run.status, run.mode)} />
        </div>
        <span>已用 {formatUsd(data.usage.usd)}</span>
      </header>
      {error && <LoadError error={error} />}
      {!ended && (
        <div className="direct-actions">
          <button
            type="button"
            className="btn"
            disabled={busy || settling}
            onClick={() => void act(() => (run.status === 'paused' ? api.resume(runId) : api.pause(runId)))}
          >
            {run.status === 'paused' ? '恢复' : '暂停'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || settling}
            onClick={() => void act(() => api.cancel(runId))}
          >
            取消任务
          </button>
        </div>
      )}
      <nav className="direct-tabs" aria-label="任务详情">
        {tabs.map(([path, label]) => (
          <Link
            key={path}
            to={`/runs/${runId}${path ? `/${path}` : ''}`}
            aria-current={path === tab ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
      {tab === 'config' ? (
        <pre className="direct-output">{JSON.stringify(run.config, null, 2)}</pre>
      ) : tab === 'result' ? (
        <Result runId={runId} ended={ended} />
      ) : (
        <>
          <section className="card card-body">
            <h2>目标与完成标准</h2>
            <ol>
              {(run.goal.completion?.criteria ?? [run.goal.statement]).map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
            {run.goal.constraints.map((c) => (
              <p key={c}>{c}</p>
            ))}
          </section>
          <div className="direct-routes">
            {data.branches.map((card) => (
              <Route key={card.branch.id} card={card} runId={runId} revision={data.lastSeq} />
            ))}
          </div>
          {!data.branches.length && <EmptyState title="正在准备工作目录" />}
          {!ended && !settling && (
            <form
              className="card card-body stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (hint.trim())
                  void act(async () => {
                    await api.input(runId, { kind: 'hint', text: hint.trim() });
                    setHint('');
                  });
              }}
            >
              <label htmlFor="run-hint">追加指令</label>
              <textarea id="run-hint" rows={3} value={hint} onChange={(e) => setHint(e.target.value)} disabled={busy} />
              <button className="btn" type="submit" disabled={busy || !hint.trim() || data.branches.length === 0}>
                发送给正在执行的路线
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
function Route({ runId, card, revision }: { runId: string; card: BranchCard; revision: number }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<BranchDetail>();
  const [error, setError] = useState<Error>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => olderRequest.current?.abort(), []);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    api.branch(runId, card.branch.id, { limit: 30 }, abort.signal).then(
      (next) => {
        if (abort.signal.aborted || next.lastSeq < revision) return;
        setError(undefined);
        setDetail((old) => mergeDetail(old, next, false));
      },
      (e) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return () => abort.abort();
  }, [open, runId, card.branch.id, revision]);
  async function older() {
    if (!detail?.observations.next || loadingOlder) return;
    const abort = new AbortController();
    olderRequest.current = abort;
    setLoadingOlder(true);
    try {
      const next = await api.branch(
        runId,
        card.branch.id,
        { cursor: detail.observations.next, limit: 30 },
        abort.signal,
      );
      setDetail((old) => mergeDetail(old, next, true));
      setError(undefined);
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoadingOlder(false);
    }
  }
  const watch = detail?.watch;
  const states: Record<string, string> = {
    starting: '准备中',
    running: '执行中',
    paused: '已暂停',
    pendingPause: '正在暂停',
    succeeded: '已提交结果',
    cancelled: '已取消',
    failed: '执行出错',
  };
  return (
    <section className="card card-body stack">
      <h2>
        <button type="button" className="direct-route-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {card.bet.label}
        </button>
      </h2>
      <p>
        {states[card.branch.state]} · 环境调用 {card.branch.toolCalls} 次{card.bet.continuation ? ' · 接力' : ''}
      </p>
      {card.branch.stateNote && <p>{card.branch.stateNote}</p>}
      {card.bet.continuation && <p>{card.bet.continuation.direction}</p>}
      {open && (
        <>
          {error && <LoadError error={error} />}
          <p>{card.branch.handoff ?? card.bet.continuation?.handoff}</p>
          {watch && (
            <details open>
              <summary>观察地图</summary>
              <p>{watch.standing}</p>
              {watch.directions
                .filter((d) => !d.retired)
                .map((d) => (
                  <p key={d.id}>
                    {d.direction} · {d.status}：{d.result}
                  </p>
                ))}
              <p>{watch.advice}</p>
            </details>
          )}
          {!detail && !error && <SkeletonCard />}
          {detail?.observations.items.map((o) => (
            <details key={o.id}>
              <summary>
                {o.tool} · {o.expect ?? o.summary.split('\n')[0]}
              </summary>
              <pre className="direct-output">
                {JSON.stringify(o.args, null, 2)}
                {'\n'}
                {o.summary}
              </pre>
              <a href={artifactUrl(runId, o.output)} target="_blank" rel="noreferrer">
                完整输出
              </a>
            </details>
          ))}
          {detail?.observations.next && (
            <button type="button" className="btn" disabled={loadingOlder} onClick={() => void older()}>
              {loadingOlder ? '正在加载…' : '更早的执行记录'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
function mergeDetail(old: BranchDetail | undefined, next: BranchDetail, older: boolean): BranchDetail {
  if (!old) return next;
  const items = [
    ...new Map([...old.observations.items, ...next.observations.items].map((item) => [item.id, item])).values(),
  ].sort((a, b) => b.seq - a.seq);
  const oldTail = old.observations.items.at(-1)?.seq ?? Infinity;
  const nextTail = next.observations.items.at(-1)?.seq ?? Infinity;
  const cursor = older || nextTail <= oldTail ? next.observations.next : old.observations.next;
  return { ...next, observations: { items, ...(cursor ? { next: cursor } : {}) } };
}
function Result({ runId, ended }: { runId: string; ended: boolean }) {
  const [result, setResult] = useState<RunResultResponse>();
  const [error, setError] = useState<Error>();
  useEffect(() => {
    if (!ended) return;
    const abort = new AbortController();
    api.result(runId, abort.signal).then(setResult, (e) => {
      if (!abort.signal.aborted) setError(e);
    });
    return () => abort.abort();
  }, [runId, ended]);
  if (!ended) return <EmptyState title="任务结束后可查看交付结果" />;
  if (error) return <LoadError error={error} />;
  if (!result) return <SkeletonCard />;
  return (
    <div className="stack">
      <p>{result.endReason ?? result.candidate?.claim}</p>
      {result.artifact && (
        <section className="card card-body">
          <h2>交付物</h2>
          <Artifact runId={runId} handle={result.artifact.handle} />
        </section>
      )}
      {result.patch && (
        <section className="card card-body">
          <h2>{result.unfinished ? '未完成的改动' : '工作区改动'}</h2>
          <Artifact runId={runId} handle={result.patch} />
        </section>
      )}
      <section className="card card-body">
        <h2>任务记录</h2>
        <Artifact runId={runId} handle={result.knowledgeReport} />
      </section>
      <Link className="btn" to={`/runs?continue=${runId}`}>
        接着做
      </Link>
    </div>
  );
}
function Artifact({ runId, handle }: { runId: string; handle: Handle }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<Error>();
  useEffect(() => {
    const abort = new AbortController();
    fetchArtifactText(runId, handle, abort.signal).then(setText, (e) => {
      if (!abort.signal.aborted) setError(e);
    });
    return () => abort.abort();
  }, [runId, handle]);
  return (
    <>
      {error ? <LoadError error={error} /> : text === undefined ? <SkeletonCard /> : <Markdown source={text} />}
      <a href={artifactUrl(runId, handle)} download>
        下载原文
      </a>
    </>
  );
}
