// 系统状态：要你知道的事（容器引擎、镜像、模型、凭证、磁盘），
// 各供应商的熔断和限流、本机能同时跑几段、排队、磁盘。

import type { ModelsConfig } from '../../../../src/core/config.ts';
import type { ProviderStatus, SystemStatus as Status, SystemNotice } from '../../../../src/core/events.ts';
import { useResource } from '../../api/resource.ts';
import { MODELS, STATUS } from '../../api/resources.ts';
import { Icon } from '../../components/Icon.tsx';
import { ProviderMark } from '../../components/ProviderMark.tsx';
import { cx, LoadError, Reading, RelativeTime, SkeletonCard, StatusBadge } from '../../components/ui.tsx';
import { formatBytes } from '../../lib/format.ts';
import { breakerLook, keysNote, modelName } from '../../lib/labels.ts';
import { clause } from '../../lib/model-text.ts';

export function SystemStatus() {
  const status = useResource(STATUS);
  return (
    <section className="section" aria-labelledby="system-title">
      <div className="section-head">
        <h2 className="section-title" id="system-title">
          系统状态
        </h2>
      </div>
      {status.error && !status.data ? (
        <LoadError error={status.error} onRetry={status.reload} />
      ) : !status.data ? (
        <SkeletonCard lines={5} />
      ) : (
        <StatusCard status={status.data} />
      )}
    </section>
  );
}

function StatusCard({ status }: { status: Status }) {
  const { toolExec, disk, runs } = status;
  // 自定义供应商人填的名字（模型页卡片上也是它）；别的家照旧写 id。模型配置总览本来就拉着（开工清单要用）
  const models = useResource(MODELS);
  const notices = sortNotices(status.notices ?? []);
  // 磁盘告警优先显示 notices 中的说明，避免与磁盘卡片的提示重复。
  const diskNoticed = notices.some((n) => n.kind === 'disk');
  return (
    <div className="card">
      {/* 任务页的开工清单讲第一次用要做的几步；这里列出各项系统状态 */}
      {notices.length > 0 && <Notices notices={notices} />}
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">任务</span>
          <span className="tile-value">
            {runs.running}
            <span className="tile-unit"> 个在跑</span>
          </span>
          <span className="tile-sub">{runs.paused > 0 ? `${runs.paused} 个暂停着` : '没有暂停的'}</span>
        </div>
        <div className="tile">
          <span className="tile-label">本机</span>
          <span className="tile-value">
            {toolExec.running}
            <span className="tile-unit"> / {toolExec.limit} 条命令在执行</span>
          </span>
          <Slots used={toolExec.running} limit={toolExec.limit} />
          <span className="tile-sub">
            {toolExec.queued > 0 ? `${toolExec.queued} 条在排队` : '没有排队的'}
            {toolExec.auto && ' · 并发上限随资源压力调整'}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">磁盘</span>
          <span className={cx('tile-value', !disk.ok && 'tone-red')}>
            <Reading value={formatBytes(disk.freeBytes)} />
            <span className="tile-unit"> 可用</span>
          </span>
          <span className="tile-sub">低于 {formatBytes(disk.minBytes)} 就不再开新路线</span>
        </div>
      </div>
      {!disk.ok && !diskNoticed && (
        <div className="status-alert" role="alert">
          <Icon name="alert" size={16} />
          磁盘只剩 {formatBytes(disk.freeBytes)}，不再启动新的路线；在跑的不受影响。腾出空间后自动恢复。
        </div>
      )}
      <hr className="divider" />
      <div className="providers">
        <div className="providers-head">
          <span className="tile-label">模型供应商</span>
        </div>
        {status.providers.length === 0 ? (
          <p className="faint small">还没配模型。到「模型」页加一家供应商和它的 API key。</p>
        ) : (
          <ul className="provider-list">
            {status.providers.map((p) => (
              <ProviderRow
                key={p.provider}
                p={p}
                name={customName(models.data, p.provider)}
                unreadable={unreadableKeys(models.data, p.provider)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** error 在前（建任务会被拒、路线跑不起来），warning 在后；同一级保持 Melina 给的顺序 */
export function sortNotices(list: readonly SystemNotice[]): SystemNotice[] {
  return [...list.filter((n) => n.level === 'error'), ...list.filter((n) => n.level !== 'error')];
}

/** 要你知道的事：一条一行人话，放在卡片顶上 */
function Notices({ notices }: { notices: readonly SystemNotice[] }) {
  const errors = notices.some((n) => n.level === 'error');
  return (
    <ul className="status-notices" aria-label={errors ? '要先处理的事' : '要你看一眼的事'}>
      {notices.map((n) => (
        <li
          key={`${n.kind}-${n.level}-${n.text}`}
          className={cx('status-notice', n.level === 'error' ? 'status-notice-error' : 'status-notice-warning')}
        >
          <Icon name="alert" size={16} />
          {/* alert 放在里面那层：放在 li 上它就不算列表项了 */}
          <span role={n.level === 'error' ? 'alert' : undefined}>
            <span className="visually-hidden">{n.level === 'error' ? '要先处理：' : '看一眼：'}</span>
            {n.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 自定义供应商的名字；不是自定义的、或者配置还没拉回来是 undefined */
function customName(models: ModelsConfig | undefined, provider: string): string | undefined {
  return models?.providers.find((x) => x.provider === provider)?.custom?.name?.trim() || undefined;
}

/** 这一家存着却解不开的 key（hasKey 是 false）：Melina 不会再试，要重新填 */
function unreadableKeys(models: ModelsConfig | undefined, provider: string): ReadonlySet<string> {
  const keys = models?.providers.find((x) => x.provider === provider)?.keys ?? [];
  return new Set(keys.flatMap((k) => (k.id !== undefined && k.hasKey === false ? [k.id] : [])));
}

/**
 * 本机能同时执行几条命令：上限不大时一条一格（两条就两格），占着几格一眼看得出；上限很大时
 * 画成一整条。占满了也是强调色：命令排队不用你做什么（任务页那条「命令在排队」也是灰的），琥珀色只留给需要你的事。
 * 用 role="meter" 的 div、不用原生 <meter>：原生的在各浏览器里样式没法统一，也画不出一格一格的
 */
function Slots({ used, limit }: { used: number; limit: number }) {
  const n = Math.max(1, limit);
  const meter = {
    role: 'meter',
    'aria-label': '本机容量',
    'aria-valuemin': 0,
    'aria-valuemax': limit,
    'aria-valuenow': Math.min(used, limit),
    'aria-valuetext': `${used} 条正在执行，当前并发上限 ${limit} 条`,
  } as const;
  if (n > 16)
    return (
      <div className="meter" {...meter}>
        <span style={{ width: `${Math.min(100, (used / n) * 100)}%` }} />
      </div>
    );
  return (
    <div className="meter-slots" {...meter}>
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 格子就是第几格，没有别的身份
        <span key={i} data-on={i < used || undefined} />
      ))}
    </div>
  );
}

function ProviderRow({
  p,
  name,
  unreadable,
}: {
  p: ProviderStatus;
  name: string | undefined;
  unreadable: ReadonlySet<string>;
}) {
  const look = breakerLook(p);
  const limited = p.retryAt && Date.parse(p.retryAt) > Date.now();
  const keys = keysNote(p.keys ?? [], unreadable);
  return (
    <li className="provider">
      <ProviderMark provider={p.provider} name={name ?? p.provider} small />
      <div className="provider-body">
        <div className="provider-main">
          <span className="provider-name">{name ?? p.provider}</span>
          <StatusBadge look={look} />
        </div>
        <div className="provider-facts">
          <span>
            调用 <b className="num">{p.inFlight}</b>
            {p.limit === null ? ' 个在途，不限并发' : ` / ${p.limit} 个在途`}
            {p.queued > 0 && `，${p.queued} 个排队`}
          </span>
          <span>
            路线 <b className="num">{p.episodes.running}</b> 条在跑
            {p.episodes.queued > 0 && `，${p.episodes.queued} 条排队`}
          </span>
        </div>
        {(p.reason || p.fallbackTo || limited || keys) && (
          <div className="provider-note">
            {p.breaker !== 'ok' && p.reason && <span>原因：{clause(p.reason)}。</span>}
            {keys && <span>{keys}</span>}
            {p.fallbackTo && (
              <span>
                这期间改用 <span className="mono">{modelName(p.fallbackTo)}</span>。
              </span>
            )}
            {p.breaker === 'open' && !p.fallbackTo && <span>没有备用模型的调用在排队，每分钟试一次。</span>}
            {limited && p.retryAt && (
              <span>
                被限流了，
                <RelativeTime iso={p.retryAt} />
                再发新的调用。
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
