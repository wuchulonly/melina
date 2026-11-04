// 工作目录的路径框：边输边补全（GET /dirs），下面是最近用过的目录。
// 回车或点一下选定这个目录；Tab 补全进去接着往下找。
// 离开路径框（Tab 走、点别处）时补全列表收起来，不再盖着下面的「开始」；顺带查一次这个目录在不在，
// 不在就让外面当场说（onChecked），不用等点「开始」被拒。

import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import type { DirEntry, DirsResponse } from '../../../../src/core/api.ts';
import { api } from '../../api/client.ts';
import { Icon } from '../../components/Icon.tsx';
import { cx } from '../../components/ui.tsx';
import { shortPath } from '../../lib/labels.ts';

/** 输入框里的值 → 要交给 POST /runs 的路径：去掉末尾的 /（根目录除外） */
export function cleanDir(value: string): string {
  const v = value.trim();
  return v.length > 1 ? v.replace(/\/+$/, '') : v;
}

/**
 * 新的补全结果回来之前，手上那份（for 是当时的输入）还能给现在的输入用多少：同一层目录、名字往下多打了几个字时，
 * 按新打的开头筛一遍（服务端也是按名字开头、不分大小写列的）；换了一层、或者那份被截断过（50 个以外的可能才对得上），就先不给。
 * 以前直接用上一次的列表：「/home/me/shop」改成「/home/me/no-such-dir」马上按 Tab，钻进了 shop-api
 */
export function stillValid(list: { for: string; res: DirsResponse }, value: string): DirEntry[] {
  if (list.for === value) return list.res.entries;
  const cut = (v: string) => v.lastIndexOf('/') + 1;
  const dir = value.slice(0, cut(value));
  if (list.res.truncated || dir === '' || dir !== list.for.slice(0, cut(list.for))) return [];
  const partial = value.slice(dir.length).toLowerCase();
  return list.res.entries.filter((e) => e.name.toLowerCase().startsWith(partial));
}

/** 补全结果里正好是 want 的那个目录（GET /dirs 列的是它的上一级）；~ 开头的按列出来的目录展开了再比 */
export function exactEntry(want: string, res: DirsResponse): DirEntry | undefined {
  const expanded =
    want.startsWith('~') && res.dir ? `${res.dir === '/' ? '' : res.dir}/${want.split('/').pop() ?? ''}` : want;
  return res.entries.find((e) => e.path === want || e.path === expanded);
}

export function DirPicker({
  value,
  onChange,
  onPick,
  onChecked,
  inputId,
  describedBy,
  autoFocus,
}: {
  value: string;
  onChange: (value: string, known?: DirEntry) => void;
  onPick: (entry: DirEntry) => void;
  /** 离开路径框时查过了：dir 是查的那个路径（cleanDir 过的），entry 是找到的目录，没找到是 undefined */
  onChecked?: (dir: string, entry: DirEntry | undefined) => void;
  inputId: string;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  // 补全结果和它是哪次输入的（stillValid）
  const [list, setList] = useState<{ for: string; res: DirsResponse } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // 补全结果回来时告诉外面「这个目录是不是 git 仓库」；用 ref，免得外面每次重画都重新请求
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCheckedRef = useRef(onChecked);
  onCheckedRef.current = onChecked;
  const checking = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        api
          .dirs(value, controller.signal)
          .then((res) => {
            setList({ for: value, res });
            setActive(-1);
            // 输入的正好是列出来的某个目录：顺带知道它是不是 git 仓库，~ 开头的也换成绝对路径
            const exact = exactEntry(cleanDir(value), res);
            if (exact) onChangeRef.current(value, exact);
          })
          .catch(() => {});
      },
      value ? 120 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  useEffect(() => () => checking.current?.abort(), []);

  /**
   * 查这个目录在不在：按去掉末尾 / 的路径列它的上一级，看有没有正好这个名字（以 / 结尾时补全列的是它里面，看不出它自己在不在）。
   * 根目录和 ~ 本身不查
   */
  const check = () => {
    const want = cleanDir(value);
    if (!want || want === '/' || want === '~') return;
    checking.current?.abort();
    const controller = new AbortController();
    checking.current = controller;
    api
      .dirs(want, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        const exact = exactEntry(want, res);
        if (exact) onChangeRef.current(value, exact);
        onCheckedRef.current?.(want, exact);
      })
      .catch(() => {}); // 连不上 Melina：不下结论，点「开始」时照样会报
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const typed = value.trim() !== '';
  const fresh = list?.for === value;
  const options: { entry: DirEntry; group: 'match' | 'recent' }[] = typed
    ? (list ? stillValid(list, value) : []).map((entry) => ({ entry, group: 'match' as const }))
    : (list?.res.recent ?? []).map((entry) => ({ entry, group: 'recent' as const }));
  // 输入的正好就是列表里唯一的那个目录：列表只是把输入重说一遍，还盖着下面「git 仓库：…」的说明和「开始」，不弹；
  // 这时 Tab 也照常去下一项，不再钻进去（要往里找就打一个 /）
  const onlyItself =
    typed && fresh && options.length === 1 && !!list && exactEntry(cleanDir(value), list.res) === options[0]?.entry;
  const shown = open && options.length > 0 && !onlyItself;

  const pick = (entry: DirEntry) => {
    onPick(entry);
    setOpen(false);
  };
  const dive = (entry: DirEntry) => {
    onChange(entry.path === '/' ? '/' : `${entry.path}/`, entry);
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(-1, a - 1));
    } else if (e.key === 'Enter') {
      if (e.metaKey || e.ctrlKey) return; // Ctrl+Enter 照常提交整个表单
      e.preventDefault(); // 回车只管选目录，不提交
      const o = options[active];
      if (open && o) pick(o.entry);
      else setOpen(false);
    } else if (e.key === 'Tab' && shown && !e.shiftKey) {
      const o = options[active] ?? (options.length === 1 ? options[0] : undefined);
      if (o) {
        e.preventDefault();
        dive(o.entry);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  const activeId = shown && active >= 0 ? `${listId}-${active}` : undefined;
  // 「没有对得上的」只按这次输入的结果说：旧的筛完是空的，可能只是新的还没回来
  const noMatch = typed && fresh && options.length === 0;
  const noMatchText = list?.res.dir ? `${list.res.dir} 下面没有对得上的目录` : '写一个以 / 或 ~ 开头的路径';

  return (
    <div className="dirpicker" ref={boxRef}>
      <div className="dir-input">
        <Icon name="folder" size={17} className="dir-input-icon" />
        <input
          ref={inputRef}
          id={inputId}
          className="input input-mono"
          type="text"
          role="combobox"
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={describedBy}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: 展开路径框时直接能输入
          autoFocus={autoFocus}
          placeholder="/home/me/project 或 ~/project"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            // 焦点离开路径框（点补全里的项、「进到里面找」不算：它们按下时不抢焦点，焦点一直在这个框里）
            if (boxRef.current?.contains(e.relatedTarget as Node | null)) return;
            setOpen(false);
            check();
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {shown && (
        <div className="popover dir-popover">
          {!typed && <div className="option-group">最近用过</div>}
          {typed && list?.res.dir && <div className="option-group mono">{list.res.dir}</div>}
          <div role="listbox" id={listId} aria-label={typed ? '对得上的目录' : '最近用过的目录'}>
            {options.map(({ entry }, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘用输入框上的上下键和回车
              <div
                key={entry.path}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className="option dir-option"
                onPointerDown={(e) => e.preventDefault()}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(entry)}
              >
                <Icon
                  name={entry.git ? 'branch' : 'folder'}
                  size={16}
                  className={cx(entry.git ? 'tone-accent' : 'faint')}
                />
                {/* 最近用过的写全路径：太长从中间省略，留住结尾那几段，几个目录才分得清；全路径放在 title 里 */}
                <span className="dir-option-name" title={typed ? undefined : entry.path}>
                  {typed ? entry.name : shortPath(entry.path)}
                </span>
                {entry.git && <span className="tag">git</span>}
                {typed && (
                  <button
                    type="button"
                    className="icon-btn dir-dive"
                    tabIndex={-1}
                    aria-label={`进到 ${entry.name} 里面找`}
                    title="进到里面找（Tab）"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      dive(entry);
                    }}
                  >
                    <Icon name="chevronRight" size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {typed && fresh && list?.res.truncated && <div className="option-group">还有更多，接着输入缩小范围</div>}
        </div>
      )}
      {open && noMatch && (
        <div className="popover dir-popover">
          <div className="option-group">{noMatchText}</div>
        </div>
      )}
      {/* 读屏：一直在的播报区，没有对得上的目录时念一声（新插进来的 role=status 多半不念） */}
      <span className="visually-hidden" role="status">
        {open && noMatch ? noMatchText : ''}
      </span>
    </div>
  );
}
