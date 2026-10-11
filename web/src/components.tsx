import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, Check, LoaderCircle, Mail, X } from 'lucide-react';

export function Brand({ large = false }: { large?: boolean }) {
  return <div className={`brand ${large ? 'large' : ''}`}><span className="brand-mark"><Mail size={large ? 28 : 23} strokeWidth={1.6} /><i /></span><span>邮屿<small>MAILNEST</small></span></div>;
}

export function Spinner({ label = '正在加载…' }: { label?: string }) {
  return <span className="spinner" role="status"><LoaderCircle size={18} className="spinning" /><span>{label}</span></span>;
}

export function ErrorNotice({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return <div className="error-notice" role="alert"><AlertCircle size={18} /><span>{children}</span>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>;
}

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [labelId] = useState(() => `dialog-${Math.random().toString(36).slice(2)}`);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter((element) => element.offsetParent !== null);
    requestAnimationFrame(() => (dialog.current?.querySelector<HTMLElement>('[autofocus]') || focusable()[0] || dialog.current)?.focus({ preventScroll: true }));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const items = focusable();
        if (!items.length) { event.preventDefault(); return; }
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = originalOverflow; document.removeEventListener('keydown', keydown); previous?.focus({ preventScroll: true }); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={labelId}><div className="modal-heading"><div><h2 id={labelId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={21} /></button></div>{children}</div></div>;
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => { const timer = setTimeout(onClose, 5500); return () => clearTimeout(timer); }, [message, onClose]);
  return <div className="toast" role="status"><Check size={18} /><span>{message}</span><button className="icon-button" aria-label="关闭提示" onClick={onClose}><X size={16} /></button></div>;
}

export function formatDate(date: string, full = false) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', full ? { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}

export const fileSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
