// 轻提示（保存好了、删掉了），和要多点一下才生效的危险按钮。

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { cx, Spinner } from './ui.tsx';

interface Toast {
  id: number;
  text: string;
  tone: 'plain' | 'error';
}

const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const show = useCallback((text: string, tone: Toast['tone'] = 'plain') => {
    const id = ++next.current;
    setToasts((all) => [...all.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), tone === 'error' ? 6000 : 2800);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', t.tone === 'error' && 'toast-error')} role="status">
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} size={16} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/**
 * 危险的操作（取消任务、删除）先变成「确定吗」再执行，不弹对话框。
 * 失败时把错误交给 onError（或者轻提示），按钮恢复原样。
 * 问的时候焦点在「算了」上（以前在红色按钮上，连按两下 Enter、按住 Enter 就删了）；Esc 等于「算了」，算了以后焦点回原按钮。
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  onConfirm,
  icon,
  size = 'md',
  iconOnly = false,
  className,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  icon?: IconName;
  size?: 'sm' | 'md';
  iconOnly?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** 问过一次了：收起时把焦点还给原按钮（第一次渲染不抢焦点） */
  const asked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (asking) {
      asked.current = true;
      cancelRef.current?.focus();
    } else if (asked.current) {
      asked.current = false;
      triggerRef.current?.focus();
    }
  }, [asking]);

  if (!asking)
    return iconOnly && icon ? (
      <button
        ref={triggerRef}
        type="button"
        className={cx('icon-btn icon-btn-danger', className)}
        aria-label={label}
        title={label}
        onClick={() => setAsking(true)}
      >
        <Icon name={icon} size={17} />
      </button>
    ) : (
      <button
        ref={triggerRef}
        type="button"
        className={cx('btn btn-danger-soft', size === 'sm' && 'btn-sm', className)}
        onClick={() => setAsking(true)}
      >
        {icon && <Icon name={icon} size={16} />}
        {label}
      </button>
    );

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      if (mounted.current) {
        setBusy(false);
        setAsking(false);
      }
    }
  };

  return (
    <fieldset
      className="confirm"
      aria-label={question}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.preventDefault();
          e.stopPropagation();
          setAsking(false);
        }
      }}
    >
      <span className="confirm-question">{question}</span>
      <button type="button" className={cx('btn btn-danger', 'btn-sm')} onClick={run} disabled={busy}>
        {busy && <Spinner size={14} />}
        {confirmLabel}
      </button>
      <button
        ref={cancelRef}
        type="button"
        className="btn btn-quiet btn-sm"
        onClick={() => setAsking(false)}
        disabled={busy}
      >
        算了
      </button>
    </fieldset>
  );
}
