// 新建任务：只有一个输入框写目标；附件和工作目录可选；其余用默认配置，完成标准由 Scoper 起草。
// 「接着做」：continueFrom 指向上个任务时，目标预填上个任务的、可以改；工作目录照旧，不能另选；
// 上个任务的附件、知识报告和没做完的改动由 Melina 自动带上。
// 这张表放在弹窗里（NewTaskDialog.tsx），在哪一页点「新建任务」「接着做」都就地弹出来。

import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { DirEntry, RunSummary } from '../../../../src/core/api.ts';
import { api } from '../../api/client.ts';
import { invalidate, useResource } from '../../api/resource.ts';
import { MODELS, RUNS } from '../../api/resources.ts';
import { Link } from '../../app/router.tsx';
import { Icon } from '../../components/Icon.tsx';
import { cx, InlineError, Spinner } from '../../components/ui.tsx';
import { baseName, formatBytes } from '../../lib/format.ts';
import { modKeyLabel } from '../../lib/keys.ts';
import { FRESH_DIR, runStatusLook, workspaceLabel } from '../../lib/labels.ts';
import { blockingSteps, setupSteps } from '../../lib/setup.ts';
import { useSetupSteps } from '../../lib/use-setup.ts';
import { cleanDir, DirPicker } from './DirPicker.tsx';

// ── 附件 ──────────────────────────────────────────────────────────────────

/**
 * 附件的上限，和 Melina 收附件时一样（src/api/multipart.ts DEFAULT_UPLOAD_LIMITS：最多 100 个、单个 2 GiB、一共 4 GiB）。
 * 选的时候当场查，超了的不加进来、说一句；以前要把几个 GB 传完才被拒。Melina 收的时候照样查，这里只是早说
 */
export const UPLOAD_LIMITS = { maxFiles: 100, maxFileBytes: 2 * 1024 ** 3, maxTotalBytes: 4 * 1024 ** 3 } as const;

/** 新选的文件加进附件：同名同大小的算同一个；超了上限的不加，refused 说哪些没加上、为什么 */
export function admitFiles(
  current: readonly File[],
  incoming: readonly File[],
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number } = UPLOAD_LIMITS,
): { files: File[]; refused?: string } {
  const files = [...current];
  const seen = new Set(files.map((f) => `${f.name}:${f.size}`));
  let total = files.reduce((n, f) => n + f.size, 0);
  const tooBig: string[] = [];
  let overCount = 0;
  let overTotal = 0;
  for (const f of incoming) {
    const key = `${f.name}:${f.size}`;
    if (seen.has(key)) continue;
    if (f.size > limits.maxFileBytes) tooBig.push(f.name);
    else if (files.length >= limits.maxFiles) overCount++;
    else if (total + f.size > limits.maxTotalBytes) overTotal++;
    else {
      files.push(f);
      seen.add(key);
      total += f.size;
    }
  }
  const why: string[] = [];
  if (tooBig.length > 0)
    why.push(`${tooBig.map((n) => `「${n}」`).join('')}太大，单个附件最多 ${formatBytes(limits.maxFileBytes)}`);
  if (overCount > 0) why.push(`附件最多 ${limits.maxFiles} 个，${overCount} 个没加上`);
  if (overTotal > 0) why.push(`附件加起来最多 ${formatBytes(limits.maxTotalBytes)}，${overTotal} 个没加上`);
  return why.length > 0 ? { files, refused: `${why.join('；')}。` } : { files };
}

// ── 草稿 ──────────────────────────────────────────────────────────────────
// 写了一半的目标和选好的目录存在这个标签页里（sessionStorage）：切到别的页再回来还在，提交成功就清掉。
// 附件不存（存不进去）。浏览器不让用 sessionStorage（隐私模式、禁了站点数据）时就当没有草稿。

export interface ComposerDraft {
  statement: string;
  dir: string;
}

/** 新建和「接着做」各存各的；接着做按上个任务分开存 */
export function draftKey(previousId?: string | null): string {
  return previousId ? `melina:draft:continue:${previousId}` : 'melina:draft:new';
}

function sessionStore(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined; // 禁了站点数据时，连读 sessionStorage 这个属性都会抛
  }
}

export function readDraft(key: string, storage = sessionStore()): ComposerDraft | undefined {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Partial<Record<keyof ComposerDraft, unknown>>;
    return {
      statement: typeof v.statement === 'string' ? v.statement : '',
      dir: typeof v.dir === 'string' ? v.dir : '',
    };
  } catch {
    return undefined; // 读不到或者不是 JSON：当没有草稿
  }
}

/** 和打开时一样（目标还是预填的、没选目录）就不存，免得下次打开把预填的内容当成草稿 */
export function writeDraft(key: string, draft: ComposerDraft, prefilled: string, storage = sessionStore()): void {
  try {
    if (draft.statement === prefilled && !draft.dir) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(draft));
  } catch {
    // 存不进去（满了、被禁了）就算了，草稿只是方便
  }
}

export function clearDraft(key: string, storage = sessionStore()): void {
  try {
    storage?.removeItem(key);
  } catch {
    // 同上
  }
}

const EXAMPLES = [
  '把 search 模块的测试覆盖率提到 80% 以上，不改业务代码',
  '把 api 服务的冷启动降到 200 ms 以内，测试照样全过',
  '写一篇给本科生看的快速傅里叶变换讲解，带一个算好的例子',
];

export function Composer({
  previous,
  active,
  onCreated,
  close,
}: {
  previous?: RunSummary;
  /** 弹窗开着。一打开（或者开着时换了这张表）就把光标放进目标框 */
  active: boolean;
  /** 建好了：草稿已经清掉，接下来进到这个任务 */
  onCreated: (runId: string) => void;
  /** 标题那一行右边的「关上」 */
  close?: ReactNode;
}) {
  const key = draftKey(previous?.run.id);
  const prefilled = previous?.run.goal.statement ?? '';
  // 开工清单（lib/setup.ts）：带附件时先查会不会被拒，免得传完才知道
  const setup = useSetupSteps();
  const models = useResource(MODELS);
  const runCount = useResource(RUNS).data?.runs.length;
  const [saved] = useState(() => readDraft(key));
  const [statement, setStatement] = useState(saved?.statement || prefilled);
  const [files, setFiles] = useState<File[]>([]);
  const [dirOpen, setDirOpen] = useState(false);
  const [dir, setDir] = useState(previous ? '' : (saved?.dir ?? ''));
  // 补全结果里对上的那个目录（for 是当时的输入）：知道是不是 git 仓库，~ 开头的也有了绝对路径
  const [known, setKnown] = useState<{ for: string; entry: DirEntry } | undefined>();
  // 离开路径框时查过、没找到的那个目录（DirPicker onChecked）：改了路径就不算了
  const [missing, setMissing] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // 附件上传到哪了（0 到 1）；没附件、或者还没开始传时没有
  const [sent, setSent] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  // 光标放在已经写了的字后面（接着做预填了上次的目标，草稿也可能写了一半）。
  // 弹窗在外层的 layout effect 里 showModal，这里的 effect 在它之后跑，关着的 dialog 里 focus 不上
  useEffect(() => {
    const text = textRef.current;
    if (!active || !text) return;
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }, [active]);

  useEffect(() => writeDraft(key, { statement, dir }, prefilled), [key, statement, dir, prefilled]);

  const chosen = cleanDir(dir);
  const dirKnown = known && known.for === chosen ? known.entry : undefined;
  const dirMissing = !!chosen && !dirKnown && missing === chosen;

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const { files: next, refused } = admitFiles(files, [...list]);
    setFiles(next);
    setError(refused ?? null);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const goal = statement.trim();
    if (!goal || busy) {
      if (!goal) {
        setError('先写下目标');
        textRef.current?.focus();
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 带附件、而且看着会被拒时，先拿最新的系统状态再查一次：Melina 先收完附件才查跑不跑得起来（src/api/http.ts），
      // 几个 G 的附件传完才被拒。没带附件的照常发，Melina 当场就说为什么
      if (files.length > 0 && blockingSteps(setup).length > 0) {
        const fresh = blockingSteps(setupSteps(models.data, await api.status(), runCount));
        if (fresh.length > 0) {
          setError(`还不能开始：${fresh.map((s) => (s.key === 'sandbox' ? s.detail : s.title)).join('；')}`);
          setBusy(false);
          return;
        }
      }
      const { runId } = await api.createRun(
        {
          statement: goal,
          ...(previous ? { continueFrom: previous.run.id } : chosen ? { workspace: dirKnown?.path ?? chosen } : {}),
        },
        files,
        (done, total) => setSent(total > 0 ? done / total : undefined),
      );
      clearDraft(key);
      invalidate('runs');
      onCreated(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    } finally {
      setSent(undefined);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <form
      className={cx('composer', dragging && 'composer-drop')}
      onSubmit={submit}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {/* 问句就是弹窗的标题，「关上」在同一行右边；接着做的说明、没配好模型的提示放在问句和目标框之间 */}
      <div className="composer-head">
        <label className="composer-label" htmlFor={`${ids}-goal`}>
          {previous ? '这次要做成什么？' : '要做成什么？'}
        </label>
        {close}
      </div>
      {previous && <ContinueBanner previous={previous} />}
      <SetupHint />
      <textarea
        ref={textRef}
        id={`${ids}-goal`}
        className="composer-text"
        rows={3}
        value={statement}
        placeholder={`说清楚目标就行，比如：${EXAMPLES[0]}`}
        onChange={(e) => {
          setStatement(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={onKeyDown}
        disabled={busy}
      />

      {files.length > 0 && (
        <ul className="attachments" aria-label="附件">
          {files.map((f) => (
            <li key={`${f.name}:${f.size}`} className="attachment">
              <Icon name="file" size={15} />
              <span className="attachment-name">{f.name}</span>
              <span className="faint">{formatBytes(f.size)}</span>
              <button
                type="button"
                className="icon-btn attachment-remove"
                aria-label={`去掉附件 ${f.name}`}
                onClick={() => setFiles((all) => all.filter((x) => x !== f))}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {!previous && dirOpen && (
        <div className="composer-dir">
          <div className="composer-dir-head">
            <label className="field-label" htmlFor={`${ids}-dir`}>
              工作目录
            </label>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => {
                setDir('');
                setKnown(undefined);
                setDirOpen(false);
              }}
            >
              不选了
            </button>
          </div>
          <DirPicker
            inputId={`${ids}-dir`}
            describedBy={`${ids}-delivery`}
            value={dir}
            autoFocus
            onChange={(value, entry) => {
              setDir(value);
              if (entry) setKnown({ for: cleanDir(value), entry });
            }}
            onPick={(entry) => {
              setDir(entry.path);
              setKnown({ for: entry.path, entry });
            }}
            onChecked={(checked, entry) => setMissing(entry ? undefined : checked)}
          />
          <p className="delivery" id={`${ids}-delivery`}>
            <DeliveryHint dir={chosen} entry={dirKnown} missing={dirMissing} />
          </p>
        </div>
      )}

      <div className="composer-bar">
        <div className="composer-tools">
          {previous ? (
            <span className="tool-static" title={previous.run.workspace.root}>
              <Icon name="folder" size={16} />
              工作目录照旧：{workspaceName(previous)}
            </span>
          ) : (
            <button
              type="button"
              className={cx('tool', (dirOpen || chosen) && 'tool-on')}
              aria-expanded={dirOpen}
              title={chosen ? (dirKnown?.path ?? chosen) : undefined}
              onClick={() => setDirOpen((o) => !o)}
            >
              <Icon name={dirKnown?.git ? 'branch' : 'folder'} size={16} />
              {chosen ? baseName(dirKnown?.path ?? chosen) : '工作目录'}
              {!chosen && <span className="faint">可选</span>}
            </button>
          )}
          <button
            type="button"
            className={cx('tool', files.length > 0 && 'tool-on')}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="attach" size={16} />
            {files.length > 0 ? `附件 ${files.length}` : '附件'}
            {files.length === 0 && <span className="faint">可选</span>}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        <div className="composer-go">
          <span className="faint small composer-kbd">
            <kbd>{modKeyLabel()}</kbd> + <kbd>Enter</kbd>
          </span>
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !statement.trim()}>
            {busy ? <Spinner size={16} /> : <Icon name="right" size={17} />}
            {/* 附件传着的时候写传了多少；传完了 Melina 还要收进来、建任务，回到原来的字 */}
            {busy && sent !== undefined && sent < 1 ? (
              <span className="num">上传附件 {Math.floor(sent * 100)}%</span>
            ) : previous ? (
              '接着做'
            ) : (
              '开始'
            )}
          </button>
        </div>
      </div>
      {!previous && !dirOpen && (
        <p className="composer-note faint small">
          {chosen ? (
            <DeliveryHint dir={chosen} entry={dirKnown} missing={dirMissing} />
          ) : (
            '不选目录就新建一个空目录来做。完成标准由 Melina 自己起草，不用你写。'
          )}
        </p>
      )}
      <InlineError message={error} />
    </form>
  );
}

function DeliveryHint({ dir, entry, missing }: { dir: string; entry?: DirEntry | undefined; missing?: boolean }) {
  if (!dir) return <>不选目录：Melina 新建一个空目录来做，做完在结果页下载。</>;
  // 离开路径框时查过、没找到：当场说，不等点「开始」被拒
  if (missing)
    return (
      <span className="delivery-missing">
        <Icon name="alert" size={14} />
        <span>
          <b>没找到这个目录</b>：检查一下路径；不选目录就新建一个空目录来做。
        </span>
      </span>
    );
  if (entry?.git)
    return (
      <>
        <b>git 仓库</b>：Melina 在副本里做，不动你当前的分支和没提交的改动；做完写回成一个新分支 <code>melina/…</code>。
      </>
    );
  if (entry)
    return (
      <>
        <b>普通目录</b>：Melina 在副本里做，不改原目录；做完在结果页下载。
      </>
    );
  return <>开始前 Melina 会检查这个目录在不在；是 git 仓库就交付成新分支，否则在结果页下载。</>;
}

function workspaceName(s: RunSummary): string {
  const label = workspaceLabel(s.run.workspace.root);
  return label === FRESH_DIR ? '上次新建的目录' : label;
}

function ContinueBanner({ previous }: { previous: RunSummary }) {
  const look = runStatusLook(previous.run.status, previous.run.mode);
  const done = previous.run.status === 'done';
  return (
    <div className="continue-banner">
      <Icon name="continue" size={18} />
      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
        <span>
          接着「<b>{previous.run.goal.statement}</b>」做
          <span className="faint">（上次{look.label}）</span>
        </span>
        <span className="faint small">
          {done ? '从上次交付的结果起步' : '从上次的起点起步'}；上次的附件、知识报告
          {!done && '和没做完的改动'}
          会一起带上，用不用由新任务自己定。
        </span>
      </div>
    </div>
  );
}

/**
 * 没配好时先说一句（以前写完目标点开始才报错）：会被拒的写「还不能开始」，容器引擎、镜像的问题照抄 Melina 那句话
 * ；镜像没建不挡建任务，只提醒
 */
function SetupHint() {
  const steps = useSetupSteps();
  const blocking = blockingSteps(steps);
  const soft = (steps ?? []).filter((s) => !s.done && !s.blocks && s.key !== 'goal');
  if (blocking.length === 0 && soft.length === 0) return null;
  const why = [...blocking, ...soft].filter((s) => s.key === 'sandbox' || s.key === 'images');
  return (
    <p className="composer-setup" role="note">
      <Icon name="alert" size={15} />
      <span>
        {blocking.length > 0
          ? `还不能开始：${blocking.map((s) => s.title).join('；')}。`
          : `${soft.map((s) => s.title).join('；')}：任务建得出来，用到它的路线起不来。`}
        {why.map((s) => (
          <span key={s.key} className="composer-setup-why">
            {/[。.！!]$/.test(s.detail) ? s.detail : `${s.detail}。`}
          </span>
        ))}
        {blocking.some((s) => s.to) && <Link to="/models">去模型页</Link>}
      </span>
    </p>
  );
}
