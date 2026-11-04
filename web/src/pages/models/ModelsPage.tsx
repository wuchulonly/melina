// 模型页：供应商和 API key（只能写，不能读回；一家可以配几个，额度用完或失效时换下一个）、
// strong 和 fast 分档与备用顺序、运行状况（每个 key 在用、备用还是用不了）和用量。
// 只启用 DeepSeek，保留多 Key 管理、分档和用量。历史的其他供应商配置仍可移除。

import { useEffect, useId, useState } from 'react';
import type { ModelCatalogResponse } from '../../../../src/core/api.ts';
import type { ModelsConfig } from '../../../../src/core/config.ts';
import type { ProviderKeyStatus, ProviderStatus } from '../../../../src/core/events.ts';
import type { ModelRef, Tier } from '../../../../src/core/model-ref.ts';
import { api } from '../../api/client.ts';
import { invalidate, setResource, useResource } from '../../api/resource.ts';
import { MODEL_CATALOG, MODELS, STATUS, USAGE } from '../../api/resources.ts';
import { useToast } from '../../components/feedback.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Picker, type PickerGroup } from '../../components/Picker.tsx';
import { ProviderMark } from '../../components/ProviderMark.tsx';
import { Callout, cx, LoadError, SaveBar, SkeletonCard, Spinner, StatusBadge } from '../../components/ui.tsx';
import { formatTokens, formatUsd, totalTokens } from '../../lib/format.ts';
import { breakerLook, keyLook, modelName } from '../../lib/labels.ts';
import { clause } from '../../lib/model-text.ts';
import {
  catalogIssues,
  GROUP_TITLES,
  lookOf,
  modelBrief,
  type ProviderLook,
  priceBrief,
  providerChoices,
} from './catalog.ts';
import {
  draftFrom,
  type KeyDraft,
  keyLabel,
  keysVoided,
  type ModelsDraft,
  mergeModels,
  move,
  newKeyRef,
  type ProviderDraft,
  problems,
  sameDraft,
  tierName,
  toConfig,
  willHaveKey,
} from './draft.ts';
import './models.css';

type CatalogState = { data: ModelCatalogResponse | undefined; error: Error | undefined; reload: () => void };

export function ModelsPage() {
  const models = useResource(MODELS);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">模型</h1>
          <p className="page-sub">Melina 调用的模型都在这里配。API key 只能写进去，存好以后不再显示。</p>
        </div>
      </header>
      {models.error && !models.data ? (
        <LoadError error={models.error} onRetry={models.reload} />
      ) : !models.data ? (
        <div className="stack">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={4} />
        </div>
      ) : (
        <ModelsEditor config={models.data} />
      )}
    </div>
  );
}

function ModelsEditor({ config }: { config: ModelsConfig }) {
  const [base, setBase] = useState(() => draftFrom(config));
  const [draft, setDraft] = useState(base);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  // 刚从面板里挑的那家：它的 key 输入框拿到焦点
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const toast = useToast();
  const status = useResource(STATUS);
  const usage = useResource(USAGE);
  const catalogState = useResource(MODEL_CATALOG);
  const catalog = catalogState.data;
  const dirty = !sameDraft(draft, base);

  // 别处改了（或者保存回来了）、这里又没在改：换成新的
  useEffect(() => {
    const next = draftFrom(config);
    if (sameDraft(next, base)) return;
    setBase(next);
    setDraft((d) => (sameDraft(d, base) ? next : d));
  }, [config, base]);

  const issues = [...problems(draft), ...catalogIssues(draft, catalog)];
  const blocking = issues.some((i) => i.level === 'error');

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // 先拿最新的：页面打开以后别处改过的供应商和分档按三方合并留下来
      const fresh = draftFrom(await api.getModels());
      const toSave = sameDraft(fresh, base) ? draft : mergeModels(base, draft, fresh);
      const saved = await api.putModels(toConfig(toSave));
      const next = draftFrom(saved);
      setBase(next);
      setDraft(next);
      setSaves((n) => n + 1);
      setResource('models', saved);
      setJustAdded(null);
      invalidate('status');
      invalidate('model-catalog'); // Key 状态变了
      toast(toSave === draft ? '模型配置保存了' : '模型配置保存了，别处刚改的也留着');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 「现在就试」：用不了的 key 越隔越久才再试，充了值、换了套餐的人不想干等。
   * 原样存一次模型配置，Melina 存模型配置时清掉熔断和 key 的状况（src/api/sdk.ts），下一次调用就再试一遍。
   * 页面上有没保存的改动时不给（那时点「保存」是一样的效果）
   */
  const retryKeys = dirty
    ? undefined
    : async () => {
        try {
          const saved = await api.putModels(await api.getModels());
          setResource('models', saved);
          invalidate('status');
          toast('Melina 清掉了用不了的记录，下一次调用就再试这些 key');
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      };
  const update = (fn: (d: ModelsDraft) => ModelsDraft) => setDraft((d) => fn(d));
  const statusOf = (provider: string) => status.data?.providers.find((p) => p.provider === provider);
  const spendOf = (provider: string) =>
    (usage.data?.byModel ?? []).filter((m) => m.provider === provider).reduce((s, m) => s + m.usd, 0);
  const add = (p: ProviderDraft) => {
    update((d) => ({ ...d, providers: [...d.providers, p] }));
    setJustAdded(p.provider);
  };

  return (
    <>
      <Callout tone="accent" icon="info" title="DeepSeek" className="models-callout">
        当前使用 DeepSeek。可以配置多把 API key；失效或额度不足时自动切换，调用用量和费用照常记录。
      </Callout>

      <section className="section" aria-labelledby="providers-title">
        <div className="section-head">
          <h2 className="section-title" id="providers-title">
            供应商
          </h2>
          <span className="section-note">DeepSeek key 保存后加密存在本机</span>
        </div>
        <div className="stack">
          {draft.providers.map((p, i) => (
            <ProviderCard
              key={`${p.provider}:${saves}`}
              p={p}
              look={lookOf(catalog, p)}
              focusKey={p.provider === justAdded}
              status={statusOf(p.provider)}
              spend={spendOf(p.provider)}
              models={[...draft.strong, ...draft.fast].filter((m) => m.provider === p.provider).length}
              {...(retryKeys ? { onRetryKeys: retryKeys } : {})}
              onChange={(next) => update((d) => ({ ...d, providers: d.providers.map((x, j) => (j === i ? next : x)) }))}
              onRemove={() =>
                update((d) => ({
                  providers: d.providers.filter((_, j) => j !== i),
                  strong: d.strong.filter((m) => m.provider !== p.provider),
                  fast: d.fast.filter((m) => m.provider !== p.provider),
                }))
              }
            />
          ))}
          <AddProvider catalog={catalogState} taken={draft.providers.map((p) => p.provider)} onAdd={add} />
        </div>
      </section>

      <section className="section" aria-labelledby="tiers-title">
        <div className="section-head">
          <h2 className="section-title" id="tiers-title">
            分档
          </h2>
          <span className="section-note">每档第一个 DeepSeek 模型是首选；同一个模型可以两档都放。</span>
        </div>
        <div className="tiers">
          {(['strong', 'fast'] as const).map((tier) => (
            <TierCard
              key={tier}
              tier={tier}
              models={draft[tier]}
              providers={draft.providers}
              catalog={catalog}
              catalogState={catalogState}
              spendOf={(m) => usage.data?.byModel.find((u) => u.provider === m.provider && u.model === m.model)}
              onChange={(list) => update((d) => ({ ...d, [tier]: list }))}
            />
          ))}
        </div>
      </section>

      {issues.length > 0 && (
        <ul className="problems" aria-label="还要注意的">
          {issues.map((i) => (
            <li key={i.text} className={cx('problem', i.level === 'error' && 'problem-error')}>
              <Icon name="alert" size={15} />
              {i.text}
            </li>
          ))}
        </ul>
      )}

      {dirty && (
        <SaveBar
          saving={saving}
          canSave={!blocking}
          error={saveError}
          onSave={save}
          onDiscard={() => {
            setDraft(base);
            setSaveError(null);
          }}
          message={blocking ? '有改动，先把上面标红的地方改好再保存' : '模型配置改了，还没保存'}
        />
      )}
    </>
  );
}

function ProviderCard({
  p,
  look,
  focusKey,
  status,
  spend,
  models,
  onRetryKeys,
  onChange,
  onRemove,
}: {
  p: ProviderDraft;
  look: ProviderLook;
  /** 刚加上的：key 输入框拿焦点 */
  focusKey: boolean;
  status?: ProviderStatus;
  spend: number;
  models: number;
  /** 用不了的 key 现在就再试；有没保存的改动时没有 */
  onRetryKeys?: () => Promise<void>;
  onChange: (p: ProviderDraft) => void;
  onRemove: () => void;
}) {
  const [askRemove, setAskRemove] = useState(false);
  const id = useId();
  const named = look.name !== p.provider;
  // 接口地址换了域名、端口或协议：存过的 key 保存时作废
  const voided = keysVoided(p);

  return (
    <article className="card provider-card" aria-labelledby={`${id}-name`}>
      <div className="provider-card-head">
        <div className="provider-card-id">
          <ProviderMark provider={look.provider} name={look.name} />
          <div className="provider-card-title">
            <div className="row-wrap">
              <h3 className={cx('provider-card-name', !named && 'mono')} id={`${id}-name`}>
                {look.name}
              </h3>
              {look.cn && <span className="provider-card-cn">{look.cn}</span>}
              {look.group === 'custom' && <span className="tag">自定义</span>}
              {status && <StatusBadge look={breakerLook(status)} />}
            </div>
            {(named || look.host) && (
              <span className="provider-card-sub">
                {named && <span className="mono">{p.provider}</span>}
                {named && look.host && ' · '}
                {look.host && <span className="mono">{look.host}</span>}
              </span>
            )}
          </div>
        </div>
        <div className="row">
          {spend > 0 && <span className="faint small num">累计 {formatUsd(spend)}</span>}
          {askRemove ? (
            <span className="confirm">
              <span className="confirm-question">
                {models > 0 ? `它的 ${models} 个模型也会从分档里去掉` : '去掉这家？'}
              </span>
              <button type="button" className="btn btn-danger btn-sm" onClick={onRemove}>
                去掉
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAskRemove(false)}>
                算了
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="icon-btn icon-btn-danger"
              aria-label={`去掉供应商 ${p.provider}`}
              title="去掉这家供应商"
              onClick={() => setAskRemove(true)}
            >
              <Icon name="trash" size={17} />
            </button>
          )}
        </div>
      </div>

      <div className="provider-card-body">
        {p.custom && (
          <Callout tone="amber" icon="info" title="旧接口已停用">
            请移除此自定义供应商，使用 DeepSeek 模型目录。
          </Callout>
        )}

        <span className="field-label" id={`${id}-key-label`}>
          API key
        </span>
        <KeyList
          p={p}
          status={status}
          voided={voided}
          labelledBy={`${id}-key-label`}
          autoFocus={focusKey}
          {...(onRetryKeys ? { onRetry: onRetryKeys } : {})}
          onChange={onChange}
        />

        <span className="field-label">限速</span>
        <Limits p={p} onChange={onChange} />

        {status && (status.breaker !== 'ok' || status.inFlight > 0 || status.episodes.running > 0) && (
          <>
            <span className="field-label">现在</span>
            <p className="provider-live">
              {status.inFlight} 个调用在途
              {status.limit === null ? '，不限并发' : `，上限 ${status.limit}`}
              {status.queued > 0 && `，${status.queued} 个排队`}
              {status.episodes.running > 0 && `；${status.episodes.running} 条路线在用它`}
              {status.breaker !== 'ok' && status.reason && `。熔断原因：${status.reason}`}
            </p>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * 一家的 API key：按顺序，第一个是首选，后面是额度用完或失效时的备用。
 * 存过的只显示名字和状态，key 本身不再显示；可以换值、改名、挪顺序、去掉。改动都在草稿里，点保存才生效。
 */
function KeyList({
  p,
  status,
  voided,
  labelledBy,
  autoFocus,
  onRetry,
  onChange,
}: {
  p: ProviderDraft;
  status?: ProviderStatus;
  /** 接口地址换了地方：存过、没重新填的 key 保存时作废 */
  voided: boolean;
  labelledBy: string;
  /** 刚从面板里挑的这家：一个 key 都没有时摆的那个空输入框拿焦点 */
  autoFocus: boolean;
  /** 用不了的 key 现在就再试 */
  onRetry?: () => Promise<void>;
  onChange: (p: ProviderDraft) => void;
}) {
  // 正在改的 key（按 ref）：新加的、没填值的一直开着
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set());
  const setKeys = (keys: KeyDraft[]) => onChange({ ...p, keys });
  const open = (ref: string, on: boolean) =>
    setEditing((s) => {
      const next = new Set(s);
      if (on) next.add(ref);
      else next.delete(ref);
      return next;
    });
  const add = () => {
    const ref = newKeyRef();
    setKeys([...p.keys, { ref, hasKey: false }]);
    open(ref, true);
  };
  // 一个 key 都没有：直接摆一个空的输入框（不进草稿）。打了字才变成草稿里的第一个 key，ref 不变，输入框还是同一个、焦点不丢
  const [blankRef] = useState(newKeyRef);
  const empty = p.keys.length === 0;
  const rows: KeyDraft[] = empty ? [{ ref: blankRef, hasKey: false }] : p.keys;
  const several = p.keys.length > 1;

  return (
    <fieldset className="key-list" aria-labelledby={labelledBy}>
      <ol className="key-rows">
        {rows.map((k, i) => (
          <KeyRow
            key={k.ref}
            k={k}
            index={i}
            count={p.keys.length}
            live={k.id !== undefined ? status?.keys?.find((s) => s.id === k.id) : undefined}
            queued={status !== undefined && status.breaker !== 'ok' && !status.fallbackTo}
            voided={voided}
            editing={editing.has(k.ref) || (!k.id && !k.newKey)}
            autoFocus={autoFocus && empty}
            {...(onRetry ? { onRetry } : {})}
            onEdit={(on) => open(k.ref, on)}
            onChange={(next) => {
              if (empty) open(k.ref, true);
              setKeys(empty ? [next] : p.keys.map((x, j) => (j === i ? next : x)));
            }}
            onMove={(to) => setKeys(move(p.keys, i, to))}
            {...(empty
              ? {}
              : {
                  onRemove: () => {
                    setKeys(p.keys.filter((_, j) => j !== i));
                    open(k.ref, false);
                  },
                })}
          />
        ))}
      </ol>
      {empty ? (
        <span className="faint small">还没有 key：粘贴一个，这家的模型才能用。</span>
      ) : (
        <div className="key-foot">
          <button type="button" className="btn btn-quiet btn-sm" onClick={add}>
            <Icon name="plus" size={14} />
            加一个备用 key
          </button>
          <span className="faint small">
            {several
              ? '按顺序用：第一个是首选，额度用完或失效时换下一个，排在前面的恢复了再用回它。'
              : '想在额度用完时自动换，就再加一个别的账号的 key。'}
          </span>
        </div>
      )}
    </fieldset>
  );
}

function KeyRow({
  k,
  index,
  count,
  live,
  queued,
  voided,
  editing,
  autoFocus,
  onRetry,
  onEdit,
  onChange,
  onMove,
  onRemove,
}: {
  k: KeyDraft;
  index: number;
  count: number;
  live?: ProviderKeyStatus;
  /** 这家熔断了、又没有备用模型可换：调用在排队，用不了的 key 每分钟都试（有别的顶着时越试越疏） */
  queued: boolean;
  /** 这家的接口地址换了地方：存过的这个不重新填，保存时作废 */
  voided: boolean;
  editing: boolean;
  /** key 的输入框一出来就拿焦点（刚挑的供应商） */
  autoFocus: boolean;
  /** 用不了时「现在就试」；页面有没保存的改动时没有 */
  onRetry?: () => Promise<void>;
  onEdit: (on: boolean) => void;
  onChange: (k: KeyDraft) => void;
  onMove: (to: number) => void;
  /** 没有就是那一行还没进草稿（一个 key 都没有时摆的空输入框），不给去掉 */
  onRemove?: () => void;
}) {
  const id = useId();
  const label = keyLabel(k, index);
  const saved = k.id !== undefined;
  return (
    <li className="key-row">
      <div className="key-line">
        {count > 1 && (
          <span className="key-rank num" aria-hidden="true">
            {index + 1}
          </span>
        )}
        <span className={cx('key-name', !k.name?.trim() && 'faint')}>{label}</span>
        {live && <StatusBadge look={keyLook(live.state)} />}
        {saved && !k.newKey && voided && <span className="tag tag-warn">换了地址，保存时作废</span>}
        {saved && !k.newKey && !voided && !k.hasKey && <span className="tag tag-warn">解不开，要重新填</span>}
        {k.newKey ? (
          <span className="badge badge-green">
            <Icon name="key" size={13} />
            {saved ? '新值，保存后替换' : '保存后生效'}
          </span>
        ) : (
          saved &&
          k.hasKey &&
          !voided && (
            <span className="key-saved faint small">
              <Icon name="lock" size={13} />
              已保存，不再显示
            </span>
          )
        )}
        <span className="key-actions">
          {count > 1 && (
            <>
              <button
                type="button"
                className="icon-btn"
                aria-label={`把 ${label} 往前挪`}
                disabled={index === 0}
                onClick={() => onMove(index - 1)}
              >
                <Icon name="up" size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`把 ${label} 往后挪`}
                disabled={index === count - 1}
                onClick={() => onMove(index + 1)}
              >
                <Icon name="down" size={16} />
              </button>
            </>
          )}
          {saved && !editing && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => onEdit(true)}>
              修改
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="icon-btn icon-btn-danger"
              aria-label={`去掉 ${label}`}
              title="去掉这个 key（保存后删掉）"
              onClick={onRemove}
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </span>
      </div>
      {live?.state === 'down' && live.reason && (
        <p className="key-why small">
          用不了：{clause(live.reason)}。
          {k.hasKey &&
            (queued
              ? '这家的调用在排队，每分钟试一次，好了就用回它。'
              : '过一阵再试，一直不行就隔得越来越久（最长一小时），好了就用回它。')}
          {k.hasKey && onRetry && <RetryNow onRetry={onRetry} />}
        </p>
      )}
      {editing && (
        <div className="key-edit">
          <label className="visually-hidden" htmlFor={`${id}-name`}>
            {label}的名字
          </label>
          <input
            id={`${id}-name`}
            className="input key-name-input"
            placeholder="名字，比如公司账号"
            autoComplete="off"
            value={k.name ?? ''}
            onChange={(e) => {
              const { name: _n, ...rest } = k;
              onChange(e.target.value ? { ...rest, name: e.target.value } : rest);
            }}
          />
          <label className="visually-hidden" htmlFor={`${id}-value`}>
            {label}的值
          </label>
          <input
            id={`${id}-value`}
            className="input input-mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: 刚从面板里挑了这家，下一步就是粘贴 key
            autoFocus={autoFocus}
            placeholder={
              saved ? (voided ? '粘贴新地址用的 key，不填就作废' : '粘贴新的 key，留空就不换') : '粘贴 API key'
            }
            value={k.newKey ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              const { newKey: _drop, ...rest } = k;
              onChange(v ? { ...rest, newKey: v } : rest);
            }}
          />
          {saved && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => onEdit(false)}>
              收起
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** 用不了的 key 旁边的「现在就试」：点了把模型配置原样存一次，Melina 清掉用不了的记录、下一次调用再试 */
function RetryNow({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm key-retry"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onRetry();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner size={13} /> : null}
      现在就试
    </button>
  );
}

function Limits({ p, onChange }: { p: ProviderDraft; onChange: (p: ProviderDraft) => void }) {
  const [open, setOpen] = useState(false);
  const none = p.rpm === undefined && p.tpm === undefined;
  const summary = none
    ? '不限：只看供应商回的限流信号，自动收紧和放宽'
    : [
        p.rpm !== undefined && `每分钟最多 ${p.rpm} 次请求`,
        p.tpm !== undefined && `每分钟最多 ${formatTokens(p.tpm)} token`,
      ]
        .filter(Boolean)
        .join('，');
  return (
    <div className="limits">
      <div className="limits-row">
        <span className={none ? 'faint small' : 'small'}>{summary}</span>
        <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? '收起' : '设置'}
        </button>
      </div>
      {open && (
        <div className="limits-fields">
          <NumberField
            label="每分钟请求数"
            value={p.rpm}
            onChange={(rpm) => {
              const { rpm: _r, ...rest } = p;
              onChange(rpm === undefined ? rest : { ...rest, rpm });
            }}
          />
          <NumberField
            label="每分钟 token 数"
            value={p.tpm}
            onChange={(tpm) => {
              const { tpm: _t, ...rest } = p;
              onChange(tpm === undefined ? rest : { ...rest, tpm });
            }}
          />
        </div>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const bad = text.trim() !== '' && !/^[1-9]\d*$/.test(text.trim());
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input num"
        inputMode="numeric"
        placeholder="不限"
        value={text}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          const t = v.trim();
          if (t === '') onChange(undefined);
          else if (/^[1-9]\d*$/.test(t)) onChange(Number(t));
        }}
      />
      {bad && <span className="field-error">写一个正整数，或者留空</span>}
    </div>
  );
}

/** 目录还没取到、取失败：面板里顶替列表的那块 */
function CatalogStatus({ catalog }: { catalog: CatalogState }) {
  if (catalog.data) return null;
  if (!catalog.error)
    return (
      <div className="picker-empty">
        <Spinner size={14} /> 在取 Melina 的模型目录…
      </div>
    );
  return (
    <div className="picker-empty">
      模型目录没取到：{catalog.error.message}
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => void catalog.reload()}>
        再试一次
      </button>
    </div>
  );
}

/**
 * 从 DeepSeek 目录添加配置，添加后将焦点放到 Key 输入框。
 */
function AddProvider({
  catalog,
  taken,
  onAdd,
}: {
  catalog: CatalogState;
  taken: string[];
  onAdd: (p: ProviderDraft) => void;
}) {
  const groups: PickerGroup[] = catalog.data
    ? providerChoices(catalog.data, taken).map(({ group, items }) => ({
        key: group,
        title: GROUP_TITLES[group],
        items: items.map((c) => ({
          key: c.provider,
          label: (
            <>
              <span className="pick-name">{c.name}</span>
              {c.cn && <span className="pick-cn">{c.cn}</span>}
            </>
          ),
          detail: (
            <span className="mono">
              {c.name !== c.provider ? c.provider : ''}
              {c.name !== c.provider && c.host ? ' · ' : ''}
              {c.host}
            </span>
          ),
          aside: c.added ? (
            <span className="pick-added">
              <Icon name="check" size={14} />
              已加
            </span>
          ) : (
            `${c.models} 个模型`
          ),
          disabled: c.added,
          haystack: c.haystack,
        })),
      }))
    : [];

  return (
    <Picker
      label="加一家供应商"
      triggerClassName="add-row"
      trigger={
        <>
          <Icon name="plus" size={16} />
          加一家供应商
        </>
      }
      placeholder="搜索 DeepSeek"
      groups={groups}
      status={catalog.data ? undefined : <CatalogStatus catalog={catalog} />}
      onPick={(provider) => onAdd({ provider, keys: [] })}
      empty={(query) => <>没有找到「{query.trim()}」。当前仅支持 DeepSeek。</>}
    />
  );
}

function TierCard({
  tier,
  models,
  providers,
  catalog,
  catalogState,
  spendOf,
  onChange,
}: {
  tier: Tier;
  models: ModelRef[];
  providers: ProviderDraft[];
  /** 盖上了草稿里自定义供应商的目录 */
  catalog: ModelCatalogResponse | undefined;
  catalogState: CatalogState;
  spendOf: (
    m: ModelRef,
  ) => { usd: number; input: number; cacheRead: number; cacheWrite: number; output: number } | undefined;
  onChange: (models: ModelRef[]) => void;
}) {
  const id = useId();

  // 面板：页面上配了的每家一组（按卡片的顺序），列它在目录里的模型，带上下文和价格；这一档已经有的列着、不能再选
  const groups: PickerGroup[] = providers.flatMap((p) => {
    const listed = catalog?.providers.find((x) => x.provider === p.provider);
    if (!listed || listed.models.length === 0) return [];
    const look = lookOf(catalog, p);
    return [
      {
        key: p.provider,
        title: (
          <>
            {look.name}
            {look.cn && <span className="pick-cn">{look.cn}</span>}
            {!willHaveKey(p) && <span className="tag tag-warn">还没有 key</span>}
          </>
        ),
        items: listed.models.map((m) => {
          const taken = models.some((x) => x.provider === p.provider && x.model === m.model);
          const brief = modelBrief(m);
          const named = Boolean(m.name && m.name !== m.model);
          const price = priceBrief(m);
          return {
            key: `${p.provider}\n${m.model}`,
            label: <span className="pick-name">{m.name ?? m.model}</span>,
            detail: (
              <>
                {named && <span className="mono">{m.model}</span>}
                {named && brief && ' · '}
                {brief}
              </>
            ),
            ...(taken
              ? {
                  aside: (
                    <span className="pick-added">
                      <Icon name="check" size={14} />
                      已在这一档
                    </span>
                  ),
                }
              : price
                ? {
                    aside: (
                      <span className="pick-price" title="每百万 token 输入 / 输出的美元">
                        {price}
                      </span>
                    ),
                  }
                : {}),
            disabled: taken,
            haystack: [p.provider, look.name, look.cn, m.model, m.name].filter(Boolean).join(' ').toLowerCase(),
          };
        }),
      },
    ];
  });

  return (
    <section className="card tier" aria-labelledby={`${id}-title`}>
      <div className="tier-head">
        <h3 className="tier-title" id={`${id}-title`}>
          {tierName(tier)}
        </h3>
        <span className="faint small">
          {tier === 'strong' ? '主力：求解、起草标准、挑选版本' : '快速：用于轻量调用'}
        </span>
      </div>
      {models.length === 0 ? (
        <p className="tier-empty faint small">这一档还没有模型。</p>
      ) : (
        <ol className="tier-list">
          {models.map((m, i) => {
            const p = providers.find((x) => x.provider === m.provider);
            const spent = spendOf(m);
            return (
              <li key={modelName(m)} className="tier-item">
                <span className="tier-rank num" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="tier-model">
                  <span className="mono">{modelName(m)}</span>
                  <span className="tier-sub">
                    {i === 0 ? '首选' : `备用 ${i}`}
                    {p && !willHaveKey(p) && <span className="tag tag-warn">这家没有 key</span>}
                    {!p && <span className="tag tag-warn">供应商没配</span>}
                    {spent && (
                      <span className="faint num">
                        {formatTokens(totalTokens(spent))} token · {formatUsd(spent.usd)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="tier-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`把 ${modelName(m)} 往前挪`}
                    disabled={i === 0}
                    onClick={() => onChange(move(models, i, i - 1))}
                  >
                    <Icon name="up" size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`把 ${modelName(m)} 往后挪`}
                    disabled={i === models.length - 1}
                    onClick={() => onChange(move(models, i, i + 1))}
                  >
                    <Icon name="down" size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-danger"
                    aria-label={`从这一档去掉 ${modelName(m)}`}
                    onClick={() => onChange(models.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="tier-add">
        <Picker
          label={`往${tierName(tier)}档加模型`}
          triggerClassName="btn btn-quiet btn-sm tier-add-btn"
          trigger={
            <>
              <Icon name="plus" size={15} />
              加模型
            </>
          }
          disabled={providers.length === 0}
          placeholder="搜模型：flash、glm、kimi、claude…"
          groups={groups}
          status={catalogState.data ? undefined : <CatalogStatus catalog={catalogState} />}
          onPick={(key) => {
            const [provider = '', model = ''] = key.split('\n');
            onChange([...models, { provider, model, tier }]);
          }}
          empty={(query) =>
            query.trim()
              ? `上面配的几家里没有对得上「${query.trim()}」的模型。要别家的，先在「供应商」那里加上它。`
              : '上面配的几家在目录里都没有模型。'
          }
          footer={() => <p className="picker-foot-note">右边是每百万 token 输入 / 输出的价格（美元）。</p>}
        />
        {providers.length === 0 && <span className="faint small">先在上面加一家供应商</span>}
      </div>
    </section>
  );
}
