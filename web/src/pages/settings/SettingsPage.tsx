// 设置页：凭证、通知。
// 凭证以环境变量或文件的形式给容器，值只能写、不能读回；配了哪个系统的凭证，就等于允许 AI 读写它。
// 改了只影响之后启动的容器。通知只有一个开关：页面开着时，任务结束就发浏览器通知。
// episode 长度这类要靠实验校准的参数不进界面；Settings.config（只能全局改的几项）原样带回去，不动它。

import { type FormEvent, useEffect, useId, useState } from 'react';
import type { Credential, Settings } from '../../../../src/core/config.ts';
import { api } from '../../api/client.ts';
import { setResource, useResource } from '../../api/resource.ts';
import { SETTINGS } from '../../api/resources.ts';
import { useToast } from '../../components/feedback.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Callout, cx, InlineError, LoadError, SaveBar, SkeletonCard, Spinner, Switch } from '../../components/ui.tsx';
import { type NotifyPermission, notifyPermission, requestNotifyPermission } from '../../lib/notify.ts';
import { CREDENTIAL_ENV_NAMES, credentialIssue } from './credentials.ts';
import { type CredentialDraft, credentialDrafts, mergeCredentials, sameCredentials, toCredentials } from './draft.ts';
import './settings.css';

/** 有给不进容器的凭证时，Melina 整份设置都不收（src/config/store.ts）：保存前先说清是哪一条 */
function firstIssue(list: readonly Pick<CredentialDraft, 'name' | 'as'>[]): string | undefined {
  for (const c of list) {
    const issue = credentialIssue(c.as);
    if (issue) return `凭证「${c.name}」：${issue}。改好或删掉它，Melina 才收这份设置`;
  }
  return undefined;
}

export function SettingsPage() {
  const settings = useResource(SETTINGS);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-sub">要调的东西很少：给 AI 用的凭证，和要不要发通知。</p>
        </div>
      </header>
      {settings.error && !settings.data ? (
        <LoadError error={settings.error} onRetry={settings.reload} />
      ) : !settings.data ? (
        <div className="stack">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={2} />
        </div>
      ) : (
        <>
          <Credentials settings={settings.data} />
          <Notifications settings={settings.data} />
        </>
      )}
    </div>
  );
}

// ── 凭证 ──────────────────────────────────────────────────────────────────

function Credentials({ settings }: { settings: Settings }) {
  const [base, setBase] = useState(() => credentialDrafts(settings));
  const [draft, setDraft] = useState(base);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  const toast = useToast();
  const dirty = !sameCredentials(draft, base);

  useEffect(() => {
    const next = credentialDrafts(settings);
    if (sameCredentials(next, base)) return;
    setBase(next);
    setDraft((d) => (sameCredentials(d, base) ? next : d));
  }, [settings, base]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // 先拿最新的：页面打开以后别处改过的凭证、通知开关和 config 都留着
      const latest = await api.getSettings();
      const fresh = credentialDrafts(latest);
      const list = sameCredentials(fresh, base) ? draft : mergeCredentials(base, draft, fresh);
      const issue = firstIssue(list);
      if (issue) throw new Error(issue);
      const saved = await api.putSettings({
        credentials: toCredentials(list),
        notify: latest.notify,
        ...(latest.config ? { config: latest.config } : {}),
      });
      const next = credentialDrafts(saved);
      setBase(next);
      setDraft(next);
      setSaves((n) => n + 1);
      setResource('settings', saved);
      toast(list === draft ? '凭证保存了' : '凭证保存了，别处刚改的也留着');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const update = (i: number, next: CredentialDraft | null) =>
    setDraft((d) => (next ? d.map((c, j) => (j === i ? next : c)) : d.filter((_, j) => j !== i)));

  return (
    <section className="section" aria-labelledby="cred-title">
      <div className="section-head">
        <h2 className="section-title" id="cred-title">
          凭证
        </h2>
        <span className="section-note">给 AI 访问外部系统用的 token、密码、连接串</span>
      </div>
      <Callout tone="amber" icon="key" title="配了哪个系统的凭证，就等于允许 AI 读写它" className="cred-warning">
        {'Melina 会在容器启动时把凭证给进去（环境变量或文件），AI 能用它做任何这个凭证允许的事，不再问你。' +
          '只给它该有的权限，比如只读的 token。改了只影响之后启动的容器；工具输出和日志里出现凭证的值会被换掉。'}
      </Callout>
      <div className="cred-list">
        {/* 容器里网络全开：没配凭证也不是隔离的，只是进不了要登录的系统 */}
        {draft.length === 0 && (
          <p className="faint small cred-empty">
            还没有凭证。AI 照样能上网、装包、用附件和工作目录；要登录的系统进不去，除非工作目录或附件里本来就有密钥。
          </p>
        )}
        {draft.map((c, i) => (
          <CredentialRow key={`${c.local}:${saves}`} c={c} onChange={(next) => update(i, next)} />
        ))}
        <AddCredential taken={draft} onAdd={(c) => setDraft((d) => [...d, c])} />
        <EnvNames />
      </div>
      {dirty && (
        <SaveBar
          saving={saving}
          error={error}
          onSave={save}
          onDiscard={() => {
            setDraft(base);
            setError(null);
          }}
          message="凭证改了，还没保存"
        />
      )}
    </section>
  );
}

function deliveryText(as: Credential['as']): { kind: string; target: string } {
  return 'env' in as ? { kind: '环境变量', target: as.env } : { kind: '文件', target: as.file };
}

/**
 * 凭证的值：kubeconfig、证书、私钥都是多行的，input type=password 会把换行吞掉，所以用 textarea，
 * 默认用 CSS 把字遮成圆点，旁边能切换显示。值原样交出去，不 trim（行尾、换行都是内容）
 */
function SecretInput({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret">
      <textarea
        id={id}
        className={cx('textarea input-mono secret-value', !shown && 'secret-masked')}
        rows={3}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-quiet btn-sm secret-toggle"
        aria-controls={id}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? '遮住' : '显示'}
      </button>
    </div>
  );
}

function CredentialRow({ c, onChange }: { c: CredentialDraft; onChange: (next: CredentialDraft | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const [moving, setMoving] = useState(false);
  const id = useId();
  const d = deliveryText(c.as);
  const state = c.newValue ? 'new' : c.dropValue ? 'drop' : c.hasValue ? 'saved' : 'none';
  // 草稿中的注入方式无效时，在对应凭证旁显示具体原因。
  const issue = credentialIssue(c.as);
  return (
    <article className="card cred" aria-labelledby={`${id}-name`}>
      <div className="cred-main">
        <h3 className="cred-name" id={`${id}-name`}>
          {c.name}
          {!c.id && <span className="badge badge-accent">新加的</span>}
        </h3>
        <p className="cred-delivery">
          以{d.kind} <code>{d.target}</code> 给容器
          {!moving && (
            <button type="button" className="btn btn-quiet btn-sm cred-move" onClick={() => setMoving(true)}>
              改给法
            </button>
          )}
        </p>
        {issue && !moving && (
          <p className="cred-issue small" role="alert">
            {issue}。
          </p>
        )}
        {moving && (
          <DeliveryForm
            initial={c.as}
            onCancel={() => setMoving(false)}
            onDone={(as) => {
              onChange({ ...c, as });
              setMoving(false);
            }}
          />
        )}
      </div>
      <div className="cred-side">
        {editing || state === 'none' ? (
          <div className="key-edit">
            <label className="visually-hidden" htmlFor={`${id}-value`}>
              {c.name} 的值
            </label>
            <SecretInput
              id={`${id}-value`}
              placeholder={state === 'none' ? '填上值' : '新的值，保存后替换'}
              value={c.newValue ?? ''}
              onChange={(v) => {
                const { newValue: _n, dropValue: _d, ...rest } = c;
                setEditing(true); // 打了字以后输入框留着，别一下变回徽标
                onChange(v ? { ...rest, newValue: v } : rest);
              }}
            />
            {editing && state !== 'none' && (
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={() => {
                  const { newValue: _n, ...rest } = c;
                  onChange(rest);
                  setEditing(false);
                }}
              >
                不换了
              </button>
            )}
          </div>
        ) : (
          <div className="key-state">
            {state === 'drop' ? (
              <>
                <span className="badge badge-red">保存后清空值</span>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => {
                    const { dropValue: _d, ...rest } = c;
                    onChange(rest);
                  }}
                >
                  撤销
                </button>
              </>
            ) : (
              <>
                <span className="badge badge-green">
                  <Icon name="lock" size={13} />
                  {state === 'new' ? '新的值，保存后生效' : '已保存'}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                  换一个值
                </button>
              </>
            )}
          </div>
        )}
        {askRemove ? (
          <span className="confirm">
            <span className="confirm-question">删掉这条凭证？</span>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => onChange(null)}>
              删掉
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAskRemove(false)}>
              算了
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            aria-label={`删掉凭证 ${c.name}`}
            title="删掉这条凭证"
            onClick={() => setAskRemove(true)}
          >
            <Icon name="trash" size={17} />
          </button>
        )}
      </div>
    </article>
  );
}

function AddCredential({ taken, onAdd }: { taken: CredentialDraft[]; onAdd: (c: CredentialDraft) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'env' | 'file'>('env');
  const [target, setTarget] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  if (!open)
    return (
      <button type="button" className="add-row" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} />
        加一条凭证
      </button>
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const t = target.trim();
    if (!n) return setError('起个名字，比如「GitHub 只读 token」');
    const problem = deliveryError(kind, t);
    if (problem) return setError(problem);
    const clash = taken.find((c) =>
      'env' in c.as ? kind === 'env' && c.as.env === t : kind === 'file' && c.as.file === t,
    );
    if (clash) return setError(`「${clash.name}」已经用了这个${kind === 'env' ? '环境变量' : '文件'}`);
    if (!value) return setError('填上凭证的值');
    onAdd({
      name: n,
      as: kind === 'env' ? { env: t } : { file: t },
      hasValue: false,
      newValue: value,
      local: `new-${Date.now()}`,
    });
    setName('');
    setTarget('');
    setValue('');
    setError(null);
    setOpen(false);
  };

  return (
    <form className="card card-body add-form" onSubmit={submit} aria-label="加一条凭证">
      <div className="cred-form">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-name`}>
            名字
          </label>
          <input
            id={`${id}-name`}
            className="input"
            placeholder="GitHub 只读 token"
            // biome-ignore lint/a11y/noAutofocus: 点了「加一条」就是要填
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <span className="field-hint">给你自己看的，写清楚是哪个系统、什么权限</span>
        </div>
        <DeliveryFields id={id} kind={kind} target={target} onKind={setKind} onTarget={setTarget} />
        <div className="field">
          <label className="field-label" htmlFor={`${id}-value`}>
            值
          </label>
          <SecretInput id={`${id}-value`} value={value} onChange={setValue} />
          <span className="field-hint">可以多行（证书、kubeconfig 原样粘进来）；保存后只存不显示</span>
        </div>
      </div>
      <InlineError message={error} />
      <div className="row">
        <button type="submit" className="btn btn-primary btn-sm">
          加上
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(false)}>
          算了
        </button>
      </div>
    </form>
  );
}

/** 环境变量名的候选：Melina 认的凭证名单（credentials.ts），整页只放一份，输入框用 list 指向它 */
const ENV_LIST_ID = 'melina-credential-env-names';

function EnvNames() {
  return (
    <datalist id={ENV_LIST_ID}>
      {CREDENTIAL_ENV_NAMES.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}

/** 这样给行不行：没填、不在名单里、放在不能放的目录（credentials.ts） */
function deliveryError(kind: 'env' | 'file', target: string): string | undefined {
  if (!target)
    return kind === 'env' ? '填上环境变量名，比如 GITHUB_TOKEN' : '填上容器里的文件路径，比如 /run/secrets/token';
  return credentialIssue(kind === 'env' ? { env: target } : { file: target });
}

/** 怎么给容器：环境变量（只能用名单里的名字）或文件（容器里的绝对路径）。加凭证、改给法都用它 */
function DeliveryFields({
  id,
  kind,
  target,
  onKind,
  onTarget,
}: {
  id: string;
  kind: 'env' | 'file';
  target: string;
  onKind: (kind: 'env' | 'file') => void;
  onTarget: (target: string) => void;
}) {
  return (
    <fieldset className="field cred-fieldset">
      <legend className="field-label">怎么给容器</legend>
      <div className="row-wrap">
        <div className="radio-row">
          <label>
            <input type="radio" name={`${id}-kind`} checked={kind === 'env'} onChange={() => onKind('env')} />
            环境变量
          </label>
          <label>
            <input type="radio" name={`${id}-kind`} checked={kind === 'file'} onChange={() => onKind('file')} />
            文件
          </label>
        </div>
        <label className="visually-hidden" htmlFor={`${id}-target`}>
          {kind === 'env' ? '环境变量名' : '容器里的文件路径'}
        </label>
        <input
          id={`${id}-target`}
          className="input input-mono cred-target"
          placeholder={kind === 'env' ? 'GITHUB_TOKEN' : '/run/secrets/token'}
          autoComplete="off"
          spellCheck={false}
          list={kind === 'env' ? ENV_LIST_ID : undefined}
          value={target}
          onChange={(e) => onTarget(e.target.value)}
        />
      </div>
      <span className="field-hint">
        {kind === 'env'
          ? `只能用 Melina 认的凭证名（${CREDENTIAL_ENV_NAMES.slice(0, 4).join('、')} 这些，点输入框看全部 ${CREDENTIAL_ENV_NAMES.length} 个）；别的系统的凭证用文件形式`
          : '写容器里的绝对路径；不能放在 /workspace、/melina、/run/melina 下面'}
      </span>
    </fieldset>
  );
}

/** 就地改一条凭证怎么给容器，值留着（Melina 按 id 存值，改给法不动它） */
function DeliveryForm({
  initial,
  onCancel,
  onDone,
}: {
  initial: Credential['as'];
  onCancel: () => void;
  onDone: (as: Credential['as']) => void;
}) {
  const [kind, setKind] = useState<'env' | 'file'>('env' in initial ? 'env' : 'file');
  const [target, setTarget] = useState('env' in initial ? initial.env : initial.file);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const done = () => {
    const t = target.trim();
    const problem = deliveryError(kind, t);
    if (problem) return setError(problem);
    onDone(kind === 'env' ? { env: t } : { file: t });
  };
  return (
    <fieldset className="cred-move-form">
      <legend className="visually-hidden">改给法</legend>
      <DeliveryFields id={id} kind={kind} target={target} onKind={setKind} onTarget={setTarget} />
      <InlineError message={error} />
      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" onClick={done}>
          改好了
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>
          算了
        </button>
      </div>
    </fieldset>
  );
}

// ── 通知 ──────────────────────────────────────────────────────────────────

const PERMISSION_TEXT: Record<NotifyPermission, string> = {
  granted: '浏览器已经允许通知。',
  default: '浏览器还没允许通知。',
  denied: '浏览器拦住了这个网站的通知：到浏览器的网站设置里允许以后才弹得出来。',
  unsupported: '这个浏览器不支持通知。',
};

function Notifications({ settings }: { settings: Settings }) {
  const [permission, setPermission] = useState<NotifyPermission>(() => notifyPermission());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const id = useId();

  const set = async (notify: boolean) => {
    if (notify) setPermission(await requestNotifyPermission());
    setSaving(true);
    setError(null);
    try {
      // 先拿最新的凭证和 config 原样带回去，只改通知（凭证不带 value 就是保留原值）。
      const latest = await api.getSettings();
      const saved = await api.putSettings({
        credentials: latest.credentials.map(({ id: cid, name, as }) => ({ ...(cid ? { id: cid } : {}), name, as })),
        notify,
        ...(latest.config ? { config: latest.config } : {}),
      });
      setResource('settings', saved);
      toast(notify ? '通知打开了' : '通知关了');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="section" aria-labelledby="notify-title">
      <div className="section-head">
        <h2 className="section-title" id="notify-title">
          通知
        </h2>
      </div>
      <div className="card card-body notify">
        <div className="notify-main">
          <Icon name="bell" size={20} className="notify-icon" />
          <div className="stack" style={{ gap: 2 }}>
            <label className="notify-label" htmlFor={`${id}-switch`}>
              任务结束时，发浏览器通知
            </label>
            <span className="faint small">
              Melina 的网页开着时才弹，开在哪一页都行；你正看着它时不弹。
              {settings.notify && PERMISSION_TEXT[permission]}
            </span>
            {settings.notify && permission === 'default' && (
              <span>
                <button
                  type="button"
                  className="btn btn-sm notify-allow"
                  onClick={async () => setPermission(await requestNotifyPermission())}
                >
                  <Icon name="bell" size={15} />
                  让浏览器允许通知
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="row">
          {saving && <Spinner size={15} label="正在保存" />}
          <Switch id={`${id}-switch`} checked={settings.notify} label="浏览器通知" onChange={set} disabled={saving} />
        </div>
      </div>
      <InlineError message={error} />
    </section>
  );
}
