import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, Bell, Flag, Forward, Inbox, Mail, MoreHorizontal, Reply, Star, Trash2 } from 'lucide-react';
import { PwaInstallButton } from './PwaInstall';
import type { PwaInstallController } from './PwaInstall';
import type { Message } from './types';

export interface MailActionsProps {
  message: Message | null;
  selected: boolean;
  folder: string;
  busy: boolean;
  onBack: () => void;
  onReply: () => void;
  onForward: () => void;
  onMove: (destination: 'archive' | 'trash' | 'INBOX') => void;
  onUnread: () => void;
  onStar: () => void;
  onSettings: () => void;
  install: PwaInstallController;
  unreadCount?: number;
}

export default function MailActions({ message, selected, folder, busy, onBack, onReply, onForward,
  onMove, onUnread, onStar, onSettings, install, unreadCount = 0 }: MailActionsProps) {
  const [menuOpen, setMenuOpen] = useState<'mark' | 'more' | null>(null);
  const markWrap = useRef<HTMLDivElement>(null);
  const markButton = useRef<HTMLButtonElement>(null);
  const moreWrap = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const menuId = useId();
  const unavailable = !selected || !message || busy;
  const unreadLabel = message?.unread ? '标记为已读' : '标记为未读';
  const starLabel = message?.starred ? '取消星标' : '标记星标';
  const unreadBadge = Number.isSafeInteger(unreadCount) && unreadCount > 0 ? unreadCount > 99 ? '99+' : String(unreadCount) : null;

  function visibleItems() {
    return Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      .filter((button) => button.getClientRects().length > 0);
  }

  function closeMenu(restoreFocus = false) {
    setMenuOpen(null);
    if (restoreFocus) (menuOpen === 'mark' ? markButton : moreButton).current?.focus();
  }

  function select(action: () => void) {
    closeMenu(true);
    action();
  }

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const items = visibleItems();
    const first = initialFocus.current === 'last' ? items.at(-1) : items[0];
    first?.focus();
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(null);
  }, [message?.id, selected, folder]);

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      const wrap = menuOpen === 'mark' ? markWrap : moreWrap;
      if (!wrap.current?.contains(event.target as Node)) setMenuOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);

  function navigateMenu(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      // Let the browser move focus before removing the focused menu item.
      requestAnimationFrame(() => setMenuOpen(null));
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = visibleItems();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      event.key === 'ArrowDown' ? (current + 1) % items.length :
        (current <= 0 ? items.length : current) - 1;
    items[next]?.focus();
  }

  function openMenu(kind: 'mark' | 'more', event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
    if (menuOpen === kind) {
      const items = visibleItems();
      (initialFocus.current === 'last' ? items.at(-1) : items[0])?.focus();
    } else setMenuOpen(kind);
  }

  return <div className="reader-toolbar header-mail-actions" role="toolbar" aria-label="邮件操作">
    <button type="button" className="icon-button reader-back" aria-label="返回邮件列表"
      title="返回邮件列表" disabled={!selected} onClick={onBack}><ArrowLeft size={18} /></button>
    <div className="mail-primary-actions">
      <button type="button" className="icon-button" aria-label="回复邮件" title="回复邮件"
        disabled={unavailable} onClick={onReply}><Reply size={18} /></button>
      <button type="button" className="icon-button" aria-label="转发邮件" title="转发邮件"
        disabled={unavailable} onClick={onForward}><Forward size={18} /></button>
      <button type="button" className="icon-button" aria-label="删除邮件" title="移到已删除"
        disabled={unavailable || folder === 'trash'} onClick={() => onMove('trash')}><Trash2 size={18} /></button>
      <div className="mail-mark-wrap" ref={markWrap}>
        <button type="button" className="icon-button mail-mark-button" ref={markButton}
          aria-label="标记邮件" title="标记邮件" disabled={unavailable} aria-haspopup="menu"
          aria-expanded={menuOpen === 'mark'} aria-controls={menuOpen === 'mark' ? menuId : undefined}
          onClick={() => { initialFocus.current = 'first'; setMenuOpen((open) => open === 'mark' ? null : 'mark'); }}
          onKeyDown={(event) => openMenu('mark', event)}>
          <Flag size={18} fill={message?.starred ? 'currentColor' : 'none'} />
        </button>
        {menuOpen === 'mark' && <div className="mail-actions-menu" id={menuId} ref={menu} role="menu"
          aria-label="邮件标记" onKeyDown={navigateMenu}>
          <button type="button" role="menuitem" tabIndex={-1} aria-label={unreadLabel}
            disabled={unavailable} onClick={() => select(onUnread)}><Mail size={16} /><span>{unreadLabel}</span></button>
          <button type="button" role="menuitem" tabIndex={-1} aria-label={starLabel}
            disabled={unavailable} onClick={() => select(onStar)}>
            <Star size={16} fill={message?.starred ? 'currentColor' : 'none'} /><span>{starLabel}</span>
          </button>
        </div>}
      </div>
    </div>
    <div className="toolbar-more mail-more-wrap" ref={moreWrap}>
      <button type="button" className="icon-button mail-more-button" ref={moreButton}
        aria-label="更多邮件操作" title="更多邮件操作" aria-haspopup="menu"
        aria-expanded={menuOpen === 'more'} aria-controls={menuOpen === 'more' ? menuId : undefined}
        onClick={() => {
          initialFocus.current = 'first';
          setMenuOpen((open) => open === 'more' ? null : 'more');
        }}
        onKeyDown={(event) => openMenu('more', event)}><MoreHorizontal size={18} />{unreadBadge && <span className="notification-count" aria-hidden="true">{unreadBadge}</span>}</button>
      {menuOpen === 'more' && <div className="mail-actions-menu" id={menuId} ref={menu} role="menu"
        aria-label="更多邮件操作" onKeyDown={navigateMenu}>
        <button type="button" role="menuitem" tabIndex={-1} aria-label="归档邮件"
          disabled={unavailable || folder === 'archive'} onClick={() => select(() => onMove('archive'))}>
          <Archive size={16} /><span>归档邮件</span></button>
        {folder !== 'INBOX' && <button type="button" role="menuitem" tabIndex={-1}
          disabled={unavailable} onClick={() => select(() => onMove('INBOX'))}>
          <Inbox size={16} /><span>移回收件箱</span>
        </button>}
        <div className="toolbar-utility-install" onClick={() => closeMenu()}>
          <PwaInstallButton install={install} className="toolbar-install-menu-item" role="menuitem" tabIndex={-1} />
        </div>
        <button type="button" role="menuitem" tabIndex={-1} className="toolbar-utility-settings"
          aria-label="邮件提醒设置" onClick={() => select(onSettings)}><Bell size={16} /><span>邮件提醒设置</span>{unreadBadge && <span className="notification-count" aria-hidden="true">{unreadBadge}</span>}</button>
      </div>}
    </div>
  </div>;
}
