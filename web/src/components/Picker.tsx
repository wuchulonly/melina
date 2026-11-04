// 选择面板：点按钮在下面弹出一块，顶上搜索、下面分组的列表，上下键挑、回车选、Esc 关。
// 模型页「加一家供应商」「加模型」用它（以前是浏览器自带的 datalist：样式跟页面不搭、框里有字就只剩匹配的那几项）。
// 列表项给的是 haystack（小写的一串字），搜索按空格分开的每一截都要对得上；太多时只画前面一截，叫人接着输入缩小范围。

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import { cx } from './ui.tsx';

export interface PickerItem {
  key: string;
  /** 主行 */
  label: ReactNode;
  /** 第二行，淡一点 */
  detail?: ReactNode;
  /** 右边：几个模型、已加 */
  aside?: ReactNode;
  /** 已经加过的这类：列着但不能选 */
  disabled?: boolean;
  /** 搜索用：小写的一串字 */
  haystack: string;
}

export interface PickerGroup {
  key: string;
  title: ReactNode;
  items: PickerItem[];
}

/** 一次最多画这么多项（OpenRouter 一家就有四百个模型），多的叫人接着输入 */
const MAX_SHOWN = 120;

export function Picker({
  label,
  trigger,
  triggerClassName,
  disabled,
  placeholder,
  groups,
  onPick,
  status,
  empty,
  footer,
}: {
  /** 面板和搜索框的名字（读屏念），比如「加一家供应商」 */
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  disabled?: boolean;
  placeholder: string;
  groups: PickerGroup[];
  onPick: (key: string) => void;
  /** 列表出不来时（目录没取到、还在取）顶替列表的一块 */
  status?: ReactNode;
  /** 搜不到时说什么 */
  empty?: (query: string, close: () => void) => ReactNode;
  /** 列表下面一直在的一块（自定义接口的入口、没列出来的几家） */
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const id = useId();
  const listId = `${id}-list`;
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery('');
    setActive(0);
    if (refocus) triggerRef.current?.focus();
  };

  // 搜索：每组留下对得上的；整体最多画 MAX_SHOWN 项
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let budget = MAX_SHOWN;
  let hidden = 0;
  const shown = groups.flatMap((g) => {
    const hits = g.items.filter((i) => terms.every((t) => i.haystack.includes(t)));
    const take = hits.slice(0, Math.max(0, budget));
    budget -= take.length;
    hidden += hits.length - take.length;
    return take.length > 0 ? [{ ...g, items: take }] : [];
  });
  const options = shown.flatMap((g) => g.items);
  const enabled = options.flatMap((o, i) => (o.disabled ? [] : [i]));
  const activeIndex = enabled.includes(active) ? active : (enabled[0] ?? -1);
  const optionId = (i: number) => `${id}-o${i}`;
  const activeId = activeIndex >= 0 ? optionId(activeIndex) : undefined;

  // 打开：焦点进搜索框，整块面板滚进视野（按钮在页面底下时，面板不会一半在屏幕外）
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
    popRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  // 点在面板外面、Tab 出了面板就关上（不抢焦点：人可能是去点别的输入框）
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (e.target instanceof Node && boxRef.current?.contains(e.target)) return;
      setOpen(false);
      setQuery('');
      setActive(0);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('focusin', away);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('focusin', away);
    };
  }, [open]);

  // 键盘挑到的那项滚进视野
  useEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId]);

  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    close(false);
    onPick(o.key);
  };

  const step = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(activeIndex);
    const next = enabled[(at + dir + enabled.length) % enabled.length];
    if (next !== undefined) setActive(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // 回车只管选，不提交外面的表单
      if (activeIndex >= 0) pick(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  let index = -1;
  return (
    <div className="picker" ref={boxRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        // 弹出来的是一个对话框（搜索框加列表），不是光秃秃的列表：读屏按 dialog 报
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {trigger}
      </button>
      {open && (
        <div className="popover picker-pop" role="dialog" aria-label={label} ref={popRef}>
          <div className="picker-search">
            <Icon name="search" size={16} className="picker-search-icon" />
            <input
              ref={searchRef}
              className="input"
              type="text"
              role="combobox"
              aria-label={label}
              aria-expanded={!status}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          {status ?? (
            <div className="picker-list" role="listbox" id={listId} aria-label={label}>
              {shown.map((g) => (
                // biome-ignore lint/a11y/useSemanticElements: listbox 里的分组只能是 role=group，fieldset 放不进 listbox
                <div key={g.key} role="group" aria-labelledby={`${id}-g-${g.key}`}>
                  <div className="option-group" id={`${id}-g-${g.key}`}>
                    {g.title}
                  </div>
                  {g.items.map((o) => {
                    index += 1;
                    const i = index;
                    return (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘用搜索框上的上下键和回车
                      <div
                        key={o.key}
                        id={optionId(i)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={i === activeIndex}
                        aria-disabled={o.disabled || undefined}
                        className={cx('option', 'picker-option', o.disabled && 'picker-option-off')}
                        onPointerDown={(e) => e.preventDefault()}
                        onPointerEnter={() => !o.disabled && setActive(i)}
                        onClick={() => pick(i)}
                      >
                        <span className="picker-option-main">
                          <span className="picker-option-label">{o.label}</span>
                          {o.detail && <span className="picker-option-detail">{o.detail}</span>}
                        </span>
                        {o.aside && <span className="picker-option-aside">{o.aside}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
              {options.length === 0 && (
                <div className="picker-empty">{empty ? empty(query, () => close(false)) : '没有对得上的'}</div>
              )}
              {hidden > 0 && <div className="option-group">还有 {hidden} 个没列出来，接着输入缩小范围</div>}
            </div>
          )}
          {footer && <div className="picker-foot">{footer(() => close(false))}</div>}
          {/* 读屏：一直在的播报区，搜不到时念一声 */}
          <span className="visually-hidden" role="status">
            {!status && options.length === 0 && query ? '没有对得上的' : ''}
          </span>
        </div>
      )}
    </div>
  );
}
