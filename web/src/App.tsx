import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, Bell, Inbox, Mail, Menu, Paperclip, PenLine, Plus, RefreshCw, Reply, Search, Settings as SettingsIcon, ShieldCheck, Star, WifiOff, X } from 'lucide-react';
import { api, ApiError, errorText, patch, post } from './api';
import { Brand, ErrorNotice, formatDate, Spinner, Toast } from './components';
import AccountForm from './AccountForm';
import Compose from './Compose';
import Settings from './Settings';
import MailBody from './MailBody';
import MailActions from './MailActions';
import MessageHeader from './MessageHeader';
import MailNavigation, { folderInfo, inboxFolder } from './MailNavigation';
import { PwaInstallButton, PwaInstallGuide, usePwaInstall } from './PwaInstall';
import { PaneDivider, PaneDragShield, usePaneSizes } from './PaneResize';
import { useAppHistory, withoutOverlay, type AppHistoryView } from './useAppHistory';
import { useAppBadge } from './useAppBadge';
import { ensureExistingPushSubscription } from './pushSubscription';
import { mailNotificationText } from './mailNotification';
import { useInfiniteMessages } from './useInfiniteMessages';
import type { Account, Config, Message, MessageSummary, User } from './types';

function EmptyIllustration() {
  const gradient = useId();
  return <svg className="empty-illustration" viewBox="0 0 260 190" fill="none" aria-hidden="true">
    <defs><linearGradient id={gradient} x1="69" y1="52" x2="190" y2="146" gradientUnits="userSpaceOnUse"><stop stopColor="#fff" /><stop offset="1" stopColor="#e9eff8" /></linearGradient></defs>
    <ellipse cx="130" cy="155" rx="69" ry="7" fill="#e9edf3" />
    <rect x="59" y="55" width="142" height="94" rx="18" fill="#e9eef7" fillOpacity=".6" />
    <rect x="63" y="49" width="134" height="94" rx="16" fill={`url(#${gradient})`} stroke="#cbd6e6" />
    <rect x="65" y="51" width="130" height="90" rx="14" stroke="#fff" strokeOpacity=".85" />
    <path d="m67 56 54 42a15 15 0 0 0 18 0l54-42M67 136l40-31m86 31-40-31" stroke="#a0b3ce" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="194" cy="137" r="20" fill="#fff" stroke="#dde6f3" />
    <circle cx="194" cy="137" r="16" fill="#edf4ff" />
    <path d="m187 137 5 5 9-10" stroke="#3478f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await post<{ user: User }>('/auth/login', { email: email.trim(), password }); onLogin(result.user); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <div className="login-page"><div className="login-story"><Brand large /><div className="login-copy"><span className="eyebrow">YOUR CALM CORNER OF THE INTERNET</span><h1>每一封来信，<br />都值得好好安放。</h1><p>工作、生活，或是另一个自己。<br />让多个邮箱，在这里汇成一片安静的岛屿。</p><div className="login-art"><EmptyIllustration /></div></div><div className="login-caption"><span>多个邮箱 · 一个工作空间</span><span>MAILNEST / 01</span></div></div><main className="login-main"><Brand /><form className="login-form" onSubmit={submit}><span className="eyebrow">欢迎回到邮屿</span><h2>登录你的工作空间</h2><p>登录你的个人邮箱工作空间。</p><label>登录邮箱<input type="email" name="email" required placeholder="admin@example.com" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label><label>登录密码<input type="password" name="password" required placeholder="输入你的登录密码" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <ErrorNotice>{error}</ErrorNotice>}<button type="submit" className="button primary" disabled={busy}>{busy ? <Spinner label="正在登录…" /> : <>登录工作空间 <ArrowRight size={17} /></>}</button><div className="login-security"><ShieldCheck size={16} /><span>私有工作空间 · 安全连接你的邮箱</span></div></form><footer>邮屿 MailNest <span>让收件，更从容。</span></footer></main></div>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null); const [authLoading, setAuthLoading] = useState(true); const [authError, setAuthError] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]); const [accountsLoading, setAccountsLoading] = useState(true); const [accountsError, setAccountsError] = useState('');
  const [config, setConfig] = useState<Config | null>(null); const [accountId, setAccountId] = useState('');
  const [folder, setFolder] = useState('INBOX'); const [filter, setFilter] = useState('all'); const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [badgeSnapshot, setBadgeSnapshot] = useState<{ owner: string; count: number } | null>(null);
  const unreadRevision = useRef(0);
  const [selectedId, setSelectedId] = useState(''); const [message, setMessage] = useState<Message | null>(null); const [detailLoading, setDetailLoading] = useState(false); const [detailError, setDetailError] = useState('');
  const selectedMessage = useRef<Message | null>(null); selectedMessage.current = message;
  const latestDetailSummary = useRef<MessageSummary | null>(null);
  const [revision, setRevision] = useState(0); const [detailRevision, setDetailRevision] = useState(0); const [syncing, setSyncing] = useState(false); const [actionBusy, setActionBusy] = useState(false);
  const [drawer, setDrawer] = useState(false); const [settings, setSettings] = useState(false); const [addAccount, setAddAccount] = useState(false); const [compose, setCompose] = useState(false); const [reply, setReply] = useState<Message | null>(null);
  const [forward, setForward] = useState<Message | null>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const composeClose = useRef<(() => boolean) | null>(null);
  const registerComposeClose = useCallback((close: (() => boolean) | null) => { composeClose.current = close; }, []);
  const accountFormClose = useRef<(() => boolean) | null>(null);
  const registerAccountFormClose = useCallback((close: (() => boolean) | null) => { accountFormClose.current = close; }, []);
  const [toast, setToast] = useState(''); const [online, setOnline] = useState(navigator.onLine);
  const pwaInstall = usePwaInstall();
  const panes = usePaneSizes();
  const workspaceScroll = useRef<HTMLDivElement>(null);
  const overviewScroll = useRef(0);
  const viewKey = JSON.stringify([accountId, folder, filter, search]);
  const messageListScroll = useRef<HTMLDivElement>(null);
  const loadMoreSentinel = useRef<HTMLDivElement>(null);
  const listAnchor = useRef<{ key: string; id: string; top: number; scrollTop: number; root: HTMLDivElement } | null>(null);
  const beforeListUpdate = useCallback(() => {
    const root = panes.isDesktop ? messageListScroll.current : workspaceScroll.current;
    if (!root || (!panes.isDesktop && selectedId)) return;
    const viewport = root.getBoundingClientRect();
    const covered = panes.isDesktop ? 0 : root.querySelector('.workspace-header')?.getBoundingClientRect().height || 0;
    const row = Array.from(messageListScroll.current?.querySelectorAll<HTMLElement>('.message-row') || []).find(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.bottom > viewport.top + covered && bounds.top < viewport.bottom;
    });
    if (row?.dataset.messageId) listAnchor.current = { key: viewKey, id: row.dataset.messageId, top: row.getBoundingClientRect().top, scrollTop: root.scrollTop, root };
  }, [panes.isDesktop, selectedId, viewKey]);
  const { messages, total, loaded: hasLoadedMessages, loading: messagesLoading, error: currentMessagesError,
    loadingMore, moreError, hasMore, loadMore, setMessages } = useInfiniteMessages({
      owner: user?.id || '', accountId, folder, filter, search, revision, beforeUpdate: beforeListUpdate,
    });
  const listLoading = !hasLoadedMessages && (!currentMessagesError || messagesLoading);
  const visibleTotal = hasLoadedMessages ? total : 0;
  useLayoutEffect(() => {
    const anchor = listAnchor.current; listAnchor.current = null;
    if (!anchor || anchor.key !== viewKey || Math.abs(anchor.root.scrollTop - anchor.scrollTop) > 1) return;
    const row = Array.from(messageListScroll.current?.querySelectorAll<HTMLElement>('.message-row') || []).find(element => element.dataset.messageId === anchor.id);
    if (row) anchor.root.scrollTop += row.getBoundingClientRect().top - anchor.top;
  }, [messages, viewKey]);
  useEffect(() => {
    const root = panes.isDesktop ? messageListScroll.current : workspaceScroll.current;
    const sentinel = loadMoreSentinel.current;
    if (!root || !sentinel || !hasLoadedMessages || !hasMore || loadingMore || messagesLoading || moreError || (!panes.isDesktop && selectedId)) return;
    const check = () => {
      if (!sentinel.getClientRects().length || !root.clientHeight) return;
      const bounds = sentinel.getBoundingClientRect(), viewport = root.getBoundingClientRect();
      if (bounds.top <= viewport.bottom + 180 && bounds.bottom >= viewport.top) loadMore();
    };
    const observer = new IntersectionObserver(check, { root, rootMargin: '180px 0px' });
    observer.observe(sentinel); root.addEventListener('scroll', check, { passive: true });
    const frame = requestAnimationFrame(check);
    return () => { observer.disconnect(); root.removeEventListener('scroll', check); cancelAnimationFrame(frame); };
  }, [panes.isDesktop, selectedId, hasLoadedMessages, hasMore, loadingMore, messagesLoading, moreError, messages.length, loadMore]);
  const previousView = useRef(viewKey);
  const currentMessage = useRef(''); currentMessage.current = selectedId;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const closeToast = useCallback(() => setToast(''), []);
  const activeAccount = accounts.find((account) => account.id === accountId);
  const unread = accounts.reduce((sum, account) => sum + account.unread, 0);
  const badgeUnread = badgeSnapshot?.owner === user?.id ? badgeSnapshot?.count : accountsLoading ? undefined : unread;
  useAppBadge(authLoading ? undefined : user ? badgeUnread : null);
  useEffect(() => {
    document.title = user && badgeUnread ? `(${badgeUnread}) 邮屿 MailNest` : '邮屿 MailNest';
  }, [user, badgeUnread]);
  const activeFolder = folderInfo(accounts, accountId, folder);
  const activeInbox = inboxFolder(accounts, accountId);
  const title = filter === 'starred' ? '星标邮件' : filter === 'unread' ? '未读邮件' : activeFolder.label;
  const visibleAccounts = accountId ? accounts.filter((account) => account.id === accountId) : accounts;
  const erroredAccounts = visibleAccounts.filter((account) => account.status === 'error' || account.status === 'partial');

  const historyView: AppHistoryView = {
    accountId,folder,filter,page:1,selectedId,
    overlay:compose ? 'compose' : editingAccount ? 'edit-account' : addAccount ? 'add-account' : settings ? 'settings' : drawer ? 'navigation' : pwaInstall.guideOpen ? 'install' : '',
    editingAccountId:editingAccount?.id || '',composeKind:compose && forward ? 'forward' : compose && reply ? 'reply' : 'new',composeMessageId:compose ? (forward || reply)?.id || '' : '',
  };
  useAppHistory({
    owner:user?.id || '',view:historyView,
    onRestore:(view) => {
      let restored = {...view,page:1};
      const editing = view.overlay === 'edit-account' ? accounts.find(account => account.id === view.editingAccountId) : undefined;
      if (view.overlay === 'edit-account' && !editing) restored = {...withoutOverlay(view),overlay:'settings'};
      if (view.overlay === 'compose' && view.composeKind !== 'new' && (view.composeKind === 'reply' ? reply?.id : forward?.id) !== view.composeMessageId) restored = withoutOverlay(view);
      // Installation prompts cannot be replayed by browser Forward.
      if (view.overlay === 'install') restored = withoutOverlay(view);
      if (!selectedId && restored.selectedId) overviewScroll.current = workspaceScroll.current?.scrollTop || 0;
      if (accountId !== restored.accountId || folder !== restored.folder || filter !== restored.filter) { setQuery(''); setSearch(''); }
      setAccountId(restored.accountId); setFolder(restored.folder); setFilter(restored.filter); setSelectedId(restored.selectedId);
      setDrawer(restored.overlay === 'navigation'); setSettings(restored.overlay === 'settings'); setAddAccount(restored.overlay === 'add-account');
      setEditingAccount(restored.overlay === 'edit-account' ? editing || null : null);
      setCompose(restored.overlay === 'compose');
      if (restored.overlay === 'compose') { if (restored.composeKind !== 'reply') setReply(null); if (restored.composeKind !== 'forward') setForward(null); }
      if (pwaInstall.guideOpen && restored.overlay !== 'install') pwaInstall.closeGuide();
      return restored;
    },
    onCloseOverlay:(view) => {
      switch (view.overlay) {
        case 'compose': return composeClose.current?.() ? withoutOverlay(view) : null;
        case 'edit-account': return accountFormClose.current?.() ? {...withoutOverlay(view),overlay:'settings'} : null;
        case 'add-account': return accountFormClose.current?.() ? withoutOverlay(view) : null;
        case 'settings': setSettings(false); if (pwaInstall.guideOpen) pwaInstall.closeGuide(); break;
        case 'navigation': setDrawer(false); break;
        case 'install': pwaInstall.closeGuide(); break;
        default: return null;
      }
      return withoutOverlay(view);
    },
    onRootBack:() => setToast('再次返回退出应用'),
  });

  useLayoutEffect(() => {
    if (previousView.current !== viewKey) {
      overviewScroll.current = 0;
      previousView.current = viewKey;
    }
    workspaceScroll.current?.scrollTo({ top: selectedId ? 0 : overviewScroll.current, behavior: 'instant' });
  }, [selectedId, viewKey]);

  const checkSession = useCallback(async () => {
    setAuthLoading(true); setAuthError('');
    try { const result = await api<{ user: User }>('/auth/me'); setUser(result.user); }
    catch (error) { if (!(error instanceof ApiError && error.status === 401)) setAuthError(errorText(error)); }
    finally { setAuthLoading(false); }
  }, []);
  useEffect(() => { void checkSession(); }, [checkSession]);
  useEffect(() => {
    const onExpired = () => { setUser(null); setAccounts([]); setAccountsLoading(true); setConfig(null); setBadgeSnapshot(null); setMessage(null); setSettings(false); setCompose(false); setAddAccount(false); setEditingAccount(null); setSelectedId(''); setToast('登录已失效，请重新登录。'); };
    const onOnline = () => { setOnline(true); refresh(); }; const onOffline = () => setOnline(false);
    window.addEventListener('session-expired', onExpired); window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('session-expired', onExpired); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [refresh]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth')) { setToast(params.get('oauth') === 'success' ? 'Google 邮箱连接成功。' : `Google 授权未完成：${params.get('reason') || '请重试'}`); window.history.replaceState(window.history.state, '', window.location.pathname); }
  }, []);
  useEffect(() => {
    const nextSearch = query.trim();
    if (nextSearch === search) return;
    const timer = setTimeout(() => { setSearch(nextSearch); setSelectedId(''); }, 300);
    return () => clearTimeout(timer);
  }, [query, search]);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    api<Config>('/config', { signal: controller.signal }).then(setConfig).catch((error) => { if (error.name !== 'AbortError') setAccountsError(errorText(error)); });
    return () => controller.abort();
  }, [user]);
  useEffect(() => {
    if (!user || !config?.pushPublicKey || !('serviceWorker' in navigator)) return;
    let closed = false; let registering = false;
    const restoreSubscription = () => {
      if (closed || registering || document.hidden || !navigator.onLine) return;
      registering = true;
      void ensureExistingPushSubscription(config.pushPublicKey!)
        .catch(() => { /* Settings offers an explicit retry if registration fails. */ })
        .finally(() => { registering = false; });
    };
    restoreSubscription();
    window.addEventListener('focus', restoreSubscription); window.addEventListener('online', restoreSubscription);
    document.addEventListener('visibilitychange', restoreSubscription);
    navigator.serviceWorker.addEventListener('controllerchange', restoreSubscription);
    return () => {
      closed = true;
      window.removeEventListener('focus', restoreSubscription); window.removeEventListener('online', restoreSubscription);
      document.removeEventListener('visibilitychange', restoreSubscription);
      navigator.serviceWorker.removeEventListener('controllerchange', restoreSubscription);
    };
  }, [user, config?.pushPublicKey]);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController(); const badgeVersion = unreadRevision.current; setAccountsError('');
    api<{ accounts: Account[] }>('/accounts', { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      // A newer SSE count takes precedence over an older in-flight snapshot.
      if (badgeVersion === unreadRevision.current) setBadgeSnapshot({ owner: user.id, count: result.accounts.reduce((sum, account) => sum + account.unread, 0) });
      setAccounts(result.accounts); if (accountId && !result.accounts.some((account) => account.id === accountId)) changeView('INBOX', 'all', '');
      if (selectedMessage.current && !result.accounts.some(account => account.id === selectedMessage.current!.accountId)) setSelectedId('');
    }).catch((error) => { if (error.name !== 'AbortError') setAccountsError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setAccountsLoading(false); });
    return () => controller.abort();
  }, [user, revision, accountId]);
  useEffect(() => {
    if (!user || !selectedId) { setMessage(null); return; }
    const controller = new AbortController(); latestDetailSummary.current = null; setDetailLoading(true); setDetailError(''); setMessage(null);
    api<{ message: Message }>(`/messages/${encodeURIComponent(selectedId)}`, { signal: controller.signal }).then(({ message: value }) => {
      if (controller.signal.aborted || currentMessage.current !== selectedId) return;
      const latest = latestDetailSummary.current;
      const displayed = latest?.id === value.id ? { ...value, ...latest } : value;
      setMessage(displayed); setDetailLoading(false);
      if (displayed.unread) {
        // Display the body before the remote flag operation, which can wait for
        // an IMAP connection or another operation on this mailbox.
        void patch<{ message: MessageSummary }>(`/messages/${encodeURIComponent(selectedId)}`, { unread: false }).then(updated => {
          if (!controller.signal.aborted && currentMessage.current === selectedId) { setMessage((current) => current?.id === updated.message.id ? { ...current, ...updated.message } : current); setMessages((previous) => previous.map((item) => item.id === updated.message.id ? updated.message : item)); refresh(); }
        }).catch(error => { if (!controller.signal.aborted && currentMessage.current === selectedId) setToast(`邮件已打开，但标记已读失败：${errorText(error)}`); });
      }
    }).catch((error) => { if (error.name !== 'AbortError') setDetailError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [user, selectedId, detailRevision, refresh]);
  useEffect(() => {
    const summary = messages.find(item => item.id === selectedId);
    if (summary) {
      latestDetailSummary.current = summary;
      setMessage(previous => previous?.id === summary.id ? { ...previous, ...summary } : previous);
    }
  }, [messages]);
  useEffect(() => {
    if (!user) return;
    const source = new EventSource('/api/v1/events');
    const updateUnread = (event: Event) => {
      try {
        const { unreadCount } = JSON.parse((event as MessageEvent).data);
        if (Number.isSafeInteger(unreadCount) && unreadCount >= 0) {
          unreadRevision.current++;
          setBadgeSnapshot({ owner: user.id, count: unreadCount });
        }
      } catch { /* Older servers and invalid events are handled by polling. */ }
    };
    const onSync = (event: Event) => { updateUnread(event); refresh(); };
    const onChange = (event: Event) => {
      updateUnread(event);
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (data.action === 'message-updated' && data.message?.id) {
          const updated = data.message as MessageSummary;
          if (currentMessage.current === updated.id) latestDetailSummary.current = updated;
          setMessages(previous => previous.map(item => item.id === updated.id ? { ...item, ...updated } : item));
          // A summary update must retain the already rendered body and iframe.
          setMessage(previous => previous?.id === updated.id ? { ...previous, ...updated } : previous);
        } else if (data.action === 'message-moved' && typeof data.messageId === 'string') {
          setMessages(previous => previous.filter(item => item.id !== data.messageId));
          if (currentMessage.current === data.messageId) setSelectedId('');
        }
      } catch { /* Refresh repairs missing or older event payloads. */ }
      refresh();
    };
    const onMail = (event: Event) => {
      updateUnread(event);
      refresh();
      try {
        const data = JSON.parse((event as MessageEvent).data);
        const count = Number.isSafeInteger(data.count) && data.count > 0 ? data.count : 1;
        setToast(`收到 ${count} 封新邮件。`);
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          navigator.serviceWorker?.getRegistration().then((registration) => {
            // The worker deduplicates this SSE event and its matching Web Push.
            registration?.active?.postMessage({ type: 'MAIL_NOTIFICATION', payload: {
              ...mailNotificationText(count, data.notification),
              accountId: data.accountId, notificationId: data.notificationId, unreadCount: data.unreadCount,
            } });
          }).catch(() => {});
        }
      } catch { /* A refresh still handles an invalid event payload. */ }
    };
    source.addEventListener('ready', onSync); source.addEventListener('mail', onMail); source.addEventListener('sync', onSync); source.addEventListener('change', onChange);
    const interval = window.setInterval(() => { if (navigator.onLine && !document.hidden) refresh(); }, Math.max(config?.pollingInterval || 60, 30) * 1000);
    const onVisible = () => { if (!document.hidden) refresh(); }; document.addEventListener('visibilitychange', onVisible);
    return () => { source.close(); clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [user, config?.pollingInterval, refresh, setMessages]);
  useEffect(() => {
    if (!drawer) return;
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown);
  }, [drawer]);

  function changeView(nextFolder: string, nextFilter = 'all', nextAccount = accountId) { setFolder(nextFolder); setFilter(nextFilter); setAccountId(nextAccount); setQuery(''); setSearch(''); setSelectedId(''); setDrawer(false); }
  function openMessage(id: string) {
    if (!selectedId) overviewScroll.current = workspaceScroll.current?.scrollTop || 0;
    setSelectedId(id);
  }
  async function sync() {
    setSyncing(true);
    try { await post('/sync', accountId ? { accountId } : {}); setToast('同步已开始，收到新邮件后会自动更新。'); refresh(); }
    catch (error) { setToast(errorText(error)); } finally { setSyncing(false); }
  }
  async function updateMessage(item: MessageSummary, changes: { unread?: boolean; starred?: boolean }) {
    setActionBusy(true);
    try {
      const result = await patch<{ message: MessageSummary }>(`/messages/${encodeURIComponent(item.id)}`, changes);
      setMessages((previous) => previous.map((value) => value.id === item.id ? result.message : value));
      if (currentMessage.current === item.id) setMessage((previous) => previous ? { ...previous, ...result.message } : previous);
      if (changes.unread !== undefined) setToast(changes.unread ? '已标记为未读。' : '已标记为已读。'); refresh();
    } catch (error) { setToast(errorText(error)); } finally { setActionBusy(false); }
  }
  async function move(destination: 'archive' | 'trash' | 'INBOX') {
    if (!message) return;
    setActionBusy(true);
    try { await post(`/messages/${encodeURIComponent(message.id)}/move`, { destination }); setSelectedId(''); refresh(); setToast(destination === 'archive' ? '邮件已归档。' : destination === 'trash' ? '邮件已移到已删除。' : '邮件已移回收件箱。'); }
    catch (error) { setToast(errorText(error)); } finally { setActionBusy(false); }
  }
  async function logout() {
    try {
      try {
        const registration = await navigator.serviceWorker?.getRegistration();
        const subscription = await registration?.pushManager?.getSubscription();
        if (subscription) {
          try { await api('/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) }); } catch { /* Session logout must still proceed. */ }
          try { await subscription.unsubscribe(); } catch { /* Server-side session revocation takes priority. */ }
        }
      } catch { /* Browser notification cleanup must never block logout. */ }
      await post('/auth/logout'); setUser(null); setSettings(false); setAccounts([]); setBadgeSnapshot(null); setMessage(null); setSelectedId(''); setAccountId(''); setConfig(null); setQuery(''); setAccountsLoading(true); setCompose(false); setAddAccount(false);
    } catch (error) { setToast(errorText(error)); }
  }
  function openCompose(replyTo: Message | null = null) { setForward(null); setReply(replyTo); setCompose(true); }
  function openForward(source: Message) { setReply(null); setForward(source); setCompose(true); }

  if (authLoading) return <div className="startup"><Brand large /><Spinner label="正在打开你的工作空间…" /></div>;
  if (!user && authError) return <div className="startup"><Brand large /><ErrorNotice onRetry={() => void checkSession()}>{authError}</ErrorNotice><p>邮件内容仅在身份验证后读取。</p></div>;
  if (!user) return <><Login onLogin={(value) => { setUser(value); setAccountsLoading(true); refresh(); }} />{toast && <Toast message={toast} onClose={closeToast} />}</>;

  return <div ref={panes.rootRef} style={panes.style} className={`mail-app ${accounts.length ? 'has-mailboxes' : ''} ${selectedId ? 'has-selection' : ''} ${panes.isDesktop ? 'panes-desktop' : ''}`}>
    {drawer && <button className="drawer-scrim" aria-label="关闭导航菜单" onClick={() => setDrawer(false)} />}
    <aside id="mail-sidebar" className={`sidebar ${drawer ? 'open' : ''}`} aria-label="邮箱导航">
      <div className="sidebar-actions">
        <button className="button compose-button" onClick={() => { if (accounts.length) openCompose(); else setAddAccount(true); setDrawer(false); }}><PenLine size={18} /> 写邮件 <span>＋</span></button>
        <button className="icon-button sidebar-close" aria-label="关闭导航" onClick={() => setDrawer(false)}><X size={20} /></button>
      </div>
      <div className="sidebar-scroll">
        <MailNavigation accounts={accounts} selectedAccount={accountId} folder={folder} filter={filter} onChange={changeView} />
        <div className="nav-caption mailbox-add-heading"><span>邮箱</span><button className="icon-button" aria-label="添加邮箱" onClick={() => { setAddAccount(true); setDrawer(false); }}><Plus size={16} /></button></div>
        {accountsLoading && <Spinner label="加载邮箱…" />}
        {!accountsLoading && !accounts.length && <button className="add-mailbox" onClick={() => { setAddAccount(true); setDrawer(false); }}><Plus size={15} /> 连接你的第一个邮箱</button>}
      </div>
      <div className="sidebar-bottom"><button className="nav-item" onClick={() => { setSettings(true); setDrawer(false); }}><SettingsIcon size={17} /><span>设置</span></button></div>
    </aside>
    <PaneDivider controller={panes} kind="sidebar" />
    <div className="workspace"><div className="workspace-scroll" ref={workspaceScroll}><header className="workspace-header">
        <div className="workspace-heading">
          <button className="icon-button mobile-menu" aria-label="打开导航菜单" onClick={() => setDrawer(true)}><Menu size={19} /></button>
          <div className="folder-heading-copy">
            <h1 title={`${title} — ${activeAccount?.name || '所有邮箱'}`}>{title}<span> — {activeAccount?.name || '所有邮箱'}</span></h1>
            <div className="workspace-breadcrumb">{visibleTotal} 封邮件{(activeAccount?.unread ?? unread) > 0 && <> · {activeAccount?.unread ?? unread} 封未读</>}</div>
          </div>
        </div>
        <div className="header-reading"><div className="header-reading-inner">
          <MailActions message={message} selected={!!selectedId} folder={activeFolder.id} busy={actionBusy || detailLoading}
            onBack={() => setSelectedId('')} onReply={() => message && openCompose(message)}
            onForward={() => message && openForward(message)}
            onMove={(destination) => void move(destination)}
            onUnread={() => message && void updateMessage(message, { unread: !message.unread })}
            onStar={() => message && void updateMessage(message, { starred: !message.starred })}
            onSettings={() => setSettings(true)} install={pwaInstall} unreadCount={badgeUnread} />
          <div className="header-actions">
            <label className="search-box"><Search size={16} /><input aria-label="搜索邮件" placeholder="搜索邮件…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button>}</label>
            <PwaInstallButton install={pwaInstall} className="icon-button header-install" iconOnly />
            <button className="icon-button header-sync" title="同步邮件" aria-label="同步邮件" disabled={syncing || !accounts.length || !online} onClick={() => void sync()}><RefreshCw size={17} className={syncing || accounts.some((account) => account.status === 'syncing') ? 'spinning' : ''} /></button>
            <button className="icon-button notification-settings" title="邮件提醒设置" aria-label="邮件提醒设置" onClick={() => setSettings(true)}><Bell size={17} />{!!badgeUnread && <span className="notification-count" aria-hidden="true">{badgeUnread > 99 ? '99+' : badgeUnread}</span>}</button>
          </div>
        </div></div>
      </header>
      {!online && <div className="offline-banner" role="status"><WifiOff size={16} /> 你现在处于离线状态。连接网络后即可读取和发送邮件。</div>}{accountsError && <div className="workspace-notice"><ErrorNotice onRetry={refresh}>{accountsError}</ErrorNotice></div>}{erroredAccounts.length > 0 && <div className="sync-error-banner" role="status"><div>{erroredAccounts.map((account) => <p key={account.id}><strong>{account.name}</strong> {account.status === 'partial' ? '部分目录未同步' : '连接异常'}{account.error ? `：${account.error}` : '，稍后重试同步。'}</p>)}</div><button onClick={() => setSettings(true)}>查看并处理 <ArrowRight size={13} /></button></div>}
      <div className="mail-content"><section id="mail-message-list" className="message-list-pane" aria-label="邮件列表"><div className="list-toolbar"><div className="list-filter" role="tablist" aria-label="邮件筛选"><button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => { setFilter('all'); setSelectedId(''); }}>全部</button><button role="tab" aria-selected={filter === 'unread'} className={filter === 'unread' ? 'active' : ''} onClick={() => { setFilter('unread'); setSelectedId(''); }}>未读<span>{activeAccount?.unread ?? unread}</span></button><button role="tab" aria-selected={filter === 'starred'} className={filter === 'starred' ? 'active' : ''} onClick={() => { setFilter('starred'); setSelectedId(''); }}>星标</button></div><span className="list-count">{visibleTotal} 封</span></div>
        {hasLoadedMessages && currentMessagesError && <div className="list-refresh-error"><span role="status">{currentMessagesError} · 当前仍显示上次加载的邮件。</span><button type="button" onClick={refresh}>重试</button></div>}<div className="message-list-scroll" ref={messageListScroll} aria-busy={listLoading}>{listLoading ? <div className="list-loading"><Spinner label="正在获取邮件…" /></div> : !hasLoadedMessages && currentMessagesError ? <div className="list-error"><ErrorNotice onRetry={refresh}>{currentMessagesError}</ErrorNotice></div> : messages.length ? <div className="message-list">{messages.map((item) => {
          const account = accounts.find((value) => value.id === item.accountId); const sender = folder === 'sent' ? item.to[0]?.name || item.to[0]?.address || '收件人' : item.from.name || item.from.address;
          return <div key={item.id} data-message-id={item.id} className={`message-row ${item.unread ? 'unread' : ''} ${selectedId === item.id ? 'selected' : ''}`}><button className="message-row-main" aria-label={`打开邮件：${item.subject || '无主题'}`} onClick={() => openMessage(item.id)}><div className="message-row-top">
            <span className="sender" title={sender}>{sender}</span>
            <span className="message-row-meta"><span className="mailbox-label" title={account?.email}><i style={{ backgroundColor: account?.color || '#729184' }} /><span>{account?.name || '邮箱'}</span></span><time dateTime={item.date}>{formatDate(item.date)}</time></span>
          </div><div className="message-row-content"><div className="message-row-subject">{item.unread && <i className="unread-dot" />}<strong>{item.subject || '（无主题）'}</strong>{item.hasAttachments && <Paperclip size={13} />}</div><p className="message-preview">{item.preview || '（无邮件摘要）'}</p></div></button><button className={`message-star icon-button ${item.starred ? 'is-starred' : ''}`} aria-label={`${item.starred ? '取消星标' : '标记星标'}：${item.subject || '无主题'}`} aria-pressed={item.starred} disabled={actionBusy} onClick={() => void updateMessage(item, { starred: !item.starred })}><Star size={15} fill={item.starred ? 'currentColor' : 'none'} /></button></div>;
        })}</div> : <div className="list-empty"><Inbox size={30} strokeWidth={1.2} /><h3>{search ? '没有找到相关邮件' : !accounts.length ? '还没有连接邮箱' : filter === 'unread' ? '未读邮件已清空' : filter === 'starred' ? '这里会留住重要的邮件' : '收件箱很安静'}</h3><p>{search ? '试试其他关键词，或查看所有邮箱。' : !accounts.length ? '添加邮箱后，邮件会出现在这里。' : '同步完成后的邮件会自动显示在这里。'}</p>{!accounts.length && <button className="text-button" onClick={() => setAddAccount(true)}>连接邮箱 <ArrowRight size={14} /></button>}</div>}<div ref={loadMoreSentinel} className="list-load-more" aria-live="polite">{loadingMore ? <Spinner label="正在加载更多邮件…" /> : moreError ? <><span>{moreError}</span><button type="button" className="text-button" onClick={() => loadMore(true)}>重试加载</button></> : hasLoadedMessages && messages.length > 0 && !hasMore ? <span>已显示全部邮件</span> : null}</div></div>
        <div className="list-pagination"><span>{visibleTotal ? `已加载 ${messages.length} / 共 ${visibleTotal} 封` : '没有邮件'}</span></div>
      </section>
      <PaneDivider controller={panes} kind="list" />
      <main className="reader-pane" aria-label="邮件内容">{!selectedId ? <div className="reader-welcome"><div className="welcome-date">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</div><div className="reader-welcome-main"><EmptyIllustration /><span className="eyebrow">A LITTLE SPACE, A LITTLE CLARITY</span><h2>{!accounts.length ? '欢迎来到，你的邮屿。' : '留一点空间，给重要的来信。'}</h2><p>{!accounts.length ? <>连接你的邮箱，将工作与生活的来信汇集于此。<br />从此，收件更从容。</> : <>从左侧选择一封邮件，开始阅读。<br />所有来信，都在这里等你。</>}</p><button className="button primary" onClick={() => accounts.length ? openCompose() : setAddAccount(true)}>{accounts.length ? <><PenLine size={17} /> 写一封邮件</> : <><Plus size={17} /> 连接第一个邮箱</>}</button>{!accounts.length && <span className="supported-mail">支持 Gmail 及 IMAP / SMTP 邮箱</span>}</div><div className="welcome-footer"><span><ShieldCheck size={15} /> 私密连接 · 安心阅读</span><span>MAKE ROOM FOR WHAT MATTERS</span></div></div> : <>{detailLoading ? <div className="reader-loading"><Spinner label="正在打开邮件…" /></div> : detailError ? <div className="reader-loading"><ErrorNotice onRetry={() => setDetailRevision((value) => value + 1)}>{detailError}</ErrorNotice></div> : message && <article className="message-detail"><MessageHeader message={message} account={accounts.find((account) => account.id === message.accountId)} folderLabel={activeFolder.label} busy={actionBusy} onStar={() => void updateMessage(message, { starred: !message.starred })} /><MailBody key={message.id} message={message} /><div className="reply-actions"><button className="button secondary" onClick={() => openCompose(message)}><Reply size={17} /> 回复邮件</button><span className="small-muted">使用当前邮箱回复</span></div></article>}</>}</main>
      </div>
      </div>
      <nav className="mobile-bottom-nav" aria-label="快捷导航"><button className={folder === activeInbox && filter === 'all' ? 'active' : ''} onClick={() => changeView(activeInbox, 'all')}><Inbox size={20} /><span>收件箱</span>{!!badgeUnread && <span className="notification-count" aria-hidden="true">{badgeUnread > 99 ? '99+' : badgeUnread}</span>}</button><button className={filter === 'starred' ? 'active' : ''} onClick={() => changeView(activeInbox, 'starred')}><Star size={20} /><span>星标</span></button><button className="mobile-compose" aria-label="写邮件" onClick={() => accounts.length ? openCompose() : setAddAccount(true)}><PenLine size={22} /></button><button onClick={() => setDrawer(true)}><Mail size={20} /><span>邮箱</span></button><button onClick={() => setSettings(true)}><SettingsIcon size={20} /><span>设置</span></button></nav>
    </div>
    {settings && <Settings accounts={accounts} user={user} config={config} onClose={() => setSettings(false)} onAddAccount={() => { setSettings(false); setAddAccount(true); }} onEditAccount={(account) => { setSettings(false); setEditingAccount(account); }} onRefresh={refresh} onAccountsUpdated={setAccounts} onToast={setToast} onLogout={() => void logout()} install={pwaInstall} />}
    {addAccount && <AccountForm config={config} onRegisterClose={registerAccountFormClose} onClose={() => setAddAccount(false)} onSaved={(account) => { setAccounts((previous) => [...previous, account]); setAddAccount(false); setToast('邮箱连接成功，正在同步邮件。'); refresh(); }} />}
    {editingAccount && <AccountForm key={editingAccount.id} account={editingAccount} config={config} onRegisterClose={registerAccountFormClose} onClose={() => { setEditingAccount(null); setSettings(true); }} onSaved={(account, cacheReset) => {
      setAccounts((previous) => previous.map((item) => item.id === account.id ? account : item));
      if (cacheReset && (!accountId || accountId === account.id)) { changeView('INBOX', 'all', accountId); setMessage(null); }
      setEditingAccount(null); setSettings(true); setToast(cacheReset ? '邮箱配置已保存，正在重新同步邮件。' : '邮箱配置已保存。'); refresh();
    }} />}
    {compose && <Compose accounts={accounts} defaultAccount={accountId} reply={reply} forward={forward} onRegisterClose={registerComposeClose} onClose={() => setCompose(false)} onSent={(warning) => { setCompose(false); setToast(warning ? `邮件已发送。${warning}` : '邮件已成功发送。'); refresh(); }} />}
    {!settings && !addAccount && !editingAccount && !compose && <PwaInstallGuide install={pwaInstall} />}
    {toast && <Toast message={toast} onClose={closeToast} />}
    <PaneDragShield controller={panes} />
  </div>;
}
