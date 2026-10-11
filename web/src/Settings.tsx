import { useEffect, useState } from 'react';
import { Bell, BookOpen, Check, Copy, ExternalLink, KeyRound, Laptop, LogOut, Mail, PencilLine, Plus, RefreshCw, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { api, errorText, post, remove } from './api';
import { ErrorNotice, formatDate, Modal, Spinner } from './components';
import type { Account, Config, Token, User } from './types';
import { PwaInstallButton, PwaInstallGuide } from './PwaInstall';
import type { PwaInstallController } from './PwaInstall';

interface Props {
  accounts: Account[]; user: User; config: Config | null; onClose: () => void; onAddAccount: () => void; onEditAccount: (account: Account) => void;
  onRefresh: () => void; onToast: (message: string) => void; onLogout: () => void;
  install: PwaInstallController;
}
async function registerPush(subscription: PushSubscription) {
  const { keys } = subscription.toJSON();
  await post('/push/subscriptions', { endpoint: subscription.endpoint, keys });
}
export default function Settings({ accounts, user, config, onClose, onAddAccount, onEditAccount, onRefresh, onToast, onLogout, install }: Props) {
  const [tab, setTab] = useState<'accounts' | 'security' | 'app'>('accounts');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [plainToken, setPlainToken] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pushActive, setPushActive] = useState(false);
  const [pushChecking, setPushChecking] = useState(false);
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [copied, setCopied] = useState(false);
  async function fetchTokens() {
    setTokensLoading(true);
    try { const result = await api<{ tokens: Token[] }>('/tokens'); setTokens(result.tokens); }
    catch (error) { setError(errorText(error)); } finally { setTokensLoading(false); }
  }
  useEffect(() => { if (tab === 'security') void fetchTokens(); }, [tab]);
  useEffect(() => {
    if (tab !== 'app') return;
    let active = true;
    setPushChecking(true);
    void (async () => {
      try {
        const registration = 'serviceWorker' in navigator && config?.pushPublicKey ? await navigator.serviceWorker.getRegistration() : undefined;
        const subscription = await registration?.pushManager?.getSubscription();
        if (!active) return;
        if (subscription) await registerPush(subscription);
        if (active) setPushActive(Boolean(subscription));
      } catch (error) {
        if (active) { setPushActive(false); setError(errorText(error)); }
      } finally { if (active) setPushChecking(false); }
    })();
    return () => { active = false; };
  }, [tab, config?.pushPublicKey]);
  async function disconnect(account: Account) {
    if (!window.confirm(`断开「${account.name}」？本地缓存会被清除，邮箱服务器上的邮件会保留。`)) return;
    setBusy(account.id); setError('');
    try { await remove(`/accounts/${encodeURIComponent(account.id)}`); onRefresh(); onToast('邮箱已断开，远端邮件仍然保留。'); }
    catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  async function sync(account: Account) {
    setBusy(account.id); setError('');
    try { await post(`/accounts/${encodeURIComponent(account.id)}/sync`); onToast('已开始同步邮箱。'); onRefresh(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  async function password(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (newPassword !== repeatPassword) { setError('两次输入的新密码不一致。'); return; }
    setBusy('password');
    try { await post('/auth/password', { currentPassword, newPassword }); setCurrentPassword(''); setNewPassword(''); setRepeatPassword(''); window.dispatchEvent(new Event('session-expired')); onToast('密码已更新，所有登录会话和 API 令牌已撤销。请使用新密码重新登录。'); }
    catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  async function createToken(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy('token');
    try { const result = await post<{ token: string; id: string }>('/tokens', { name: tokenName.trim() }); setPlainToken(result.token); setTokenName(''); setCopied(false); await fetchTokens(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  async function revoke(token: Token) {
    if (!window.confirm(`撤销「${token.name}」的 API 令牌？使用该令牌的客户端将失去访问权限。`)) return;
    setError(''); setBusy(token.id);
    try { await remove(`/tokens/${encodeURIComponent(token.id)}`); setTokens((previous) => previous.filter((item) => item.id !== token.id)); onToast('API 令牌已撤销。'); }
    catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  async function notifications() {
    setError(''); setBusy('notifications');
    try {
      if (typeof Notification === 'undefined') throw new Error('此浏览器暂不支持通知。iPhone / iPad 请先将邮屿添加到主屏幕，再开启提醒。');
      if (!window.isSecureContext) throw new Error('开启邮件提醒需要 HTTPS 连接或 localhost。');
      const granted = await Notification.requestPermission(); setPermission(granted);
      if (granted !== 'granted') throw new Error('未获得通知权限。请在浏览器的网站设置中允许通知，然后重试。');
      if (!config?.pushPublicKey) { onToast('已开启浏览器提醒。页面打开时将通知新邮件；后台提醒需要在服务端配置 Web Push。'); return; }
      if (!('serviceWorker' in navigator)) throw new Error('此浏览器不支持后台邮件提醒。');
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration?.active) throw new Error('应用服务尚未就绪，请稍后重试。');
      if (!registration.pushManager) throw new Error('此浏览器不支持 Web Push。请在支持的浏览器中安装应用后重试。');
      const base64 = config.pushPublicKey.replace(/-/g, '+').replace(/_/g, '/');
      const key = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (character) => character.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await registerPush(subscription);
      setPushActive(true); onToast('后台邮件提醒已开启。');
    } catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  async function disablePush() {
    setBusy('notifications'); setError('');
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) { await remove('/push/subscriptions', { endpoint: subscription.endpoint }); await subscription.unsubscribe(); }
      setPushActive(false); onToast('已关闭本设备的后台提醒。');
    } catch (error) { setError(errorText(error)); } finally { setBusy(''); }
  }
  return <Modal title="设置" subtitle="邮箱连接、登录安全与应用偏好。" onClose={onClose} wide><div className="settings-tabs" role="tablist" aria-label="设置分类">{([{ key: 'accounts', label: '邮箱管理', icon: Mail }, { key: 'security', label: '安全与 API', icon: ShieldCheck }, { key: 'app', label: '应用与提醒', icon: Smartphone }] as const).map((item) => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'active' : ''} onClick={() => { setTab(item.key); setError(''); }}><item.icon size={17} />{item.label}</button>)}</div>
    <div className="settings-content">{error && <ErrorNotice>{error}</ErrorNotice>}
      {tab === 'accounts' && <><div className="section-heading"><div><h3>已连接邮箱 <span className="count-label">{accounts.length}</span></h3><p>聚合收件，也可以为每个邮箱保留独立视图。</p></div><button className="button primary" onClick={onAddAccount}><Plus size={16} /> 添加邮箱</button></div>{!accounts.length && <div className="settings-empty"><Mail size={30} /><h3>你的第一个邮箱，从这里开始</h3><p>连接 Gmail 或任何支持 IMAP / SMTP 的邮箱。</p></div>}{accounts.map((account) => <div className="account-settings-card" key={account.id}><div className="account-card-main"><span className="account-avatar" style={{ backgroundColor: account.color }}>{account.name.slice(0, 1).toUpperCase()}</span><div><strong>{account.name}</strong><p>{account.email}</p></div><span className={`status-badge ${account.status}`}>{account.status === 'error' ? '连接异常' : account.status === 'partial' ? '部分已同步' : account.status === 'syncing' ? '同步中' : '已连接'}</span></div>{account.error && <div className="account-error">{account.error}</div>}<div className="account-card-detail"><span>{account.provider === 'gmail' ? 'Google / Gmail' : 'IMAP / SMTP'}<small>{account.lastSyncedAt ? `上次同步 ${formatDate(account.lastSyncedAt)}` : '等待首次同步'}</small></span><div><button className="icon-button" aria-label={`编辑 ${account.name}`} title="编辑配置" disabled={!!busy} onClick={() => onEditAccount(account)}><PencilLine size={16} /></button><button className="icon-button" aria-label={`同步 ${account.name}`} disabled={!!busy} onClick={() => void sync(account)}><RefreshCw size={16} className={busy === account.id ? 'spinning' : ''} /></button><button className="icon-button danger" aria-label={`断开 ${account.name}`} disabled={!!busy} onClick={() => void disconnect(account)}><Trash2 size={16} /></button></div></div></div>)}</>}
      {tab === 'security' && <><section className="settings-section"><h3><KeyRound size={17} /> 修改登录密码</h3><p>登录账户：{user.email}。新密码至少 12 个字符。修改后将退出所有设备，并撤销全部 API 令牌。</p><form onSubmit={password}><label>当前密码<input type="password" required autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label><div className="form-grid"><label>新密码<input type="password" required minLength={12} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></label><label>确认新密码<input type="password" required minLength={12} autoComplete="new-password" value={repeatPassword} onChange={(e) => setRepeatPassword(e.target.value)} /></label></div><button className="button secondary" disabled={!!busy}>{busy === 'password' ? <Spinner label="更新中…" /> : '更新密码'}</button></form></section><section className="settings-section"><div className="section-heading"><div><h3><BookOpen size={17} /> API 访问令牌</h3><p>用于第三方客户端访问你的邮箱；令牌仅在创建时显示一次。</p></div><a className="button secondary" href="/api/v1/docs" target="_blank" rel="noopener noreferrer">接口文档 <ExternalLink size={14} /></a></div><form className="token-form" onSubmit={createToken}><label className="sr-only" htmlFor="token-name">令牌名称</label><input id="token-name" required maxLength={80} placeholder="令牌名称，例如：自动化脚本" value={tokenName} onChange={(e) => setTokenName(e.target.value)} /><button className="button primary" disabled={!!busy}><Plus size={16} /> 创建令牌</button></form>{plainToken && <div className="new-token"><strong>请立即复制并妥善保存</strong><p>关闭设置后，将无法再次查看完整令牌。</p><div><code>{plainToken}</code><button className="icon-button" aria-label="复制 API 令牌" onClick={() => { navigator.clipboard.writeText(plainToken).then(() => { setCopied(true); onToast('令牌已复制。'); }).catch(() => setError('浏览器无法自动复制，请手动选中并复制令牌。')); }}>{copied ? <Check size={17} /> : <Copy size={17} />}</button></div></div>}{tokensLoading ? <Spinner /> : tokens.length ? <div className="tokens-list">{tokens.map((token) => <div key={token.id}><span><strong>{token.name}</strong><small>创建于 {formatDate(token.createdAt)} · {token.lastUsedAt ? `最近使用 ${formatDate(token.lastUsedAt)}` : '尚未使用'}</small></span><button className="icon-button danger" disabled={!!busy} aria-label={`撤销令牌 ${token.name}`} onClick={() => void revoke(token)}><Trash2 size={16} /></button></div>)}</div> : <p className="small-muted">尚未创建 API 令牌。</p>}</section></>}
      {tab === 'app' && <><section className="settings-section"><div className="section-heading"><div><h3><Bell size={18} /> 邮件提醒</h3><p>{pushChecking ? '正在检查本设备的后台提醒。' : pushActive ? '本设备已开启后台邮件提醒。' : permission === 'granted' ? '已允许浏览器通知，可继续开启后台提醒。' : '有新邮件时，让邮屿轻轻提醒你。'}</p></div><button className={`button ${pushActive ? 'secondary' : 'primary'}`} onClick={() => void (pushActive ? disablePush() : notifications())} aria-label={pushChecking ? '检查中…' : busy === 'notifications' ? '处理中…' : pushActive ? '关闭后台提醒' : '开启提醒'} disabled={!!busy || pushChecking}>{pushChecking ? <Spinner label="检查中…" /> : busy === 'notifications' ? <Spinner label="处理中…" /> : pushActive ? '关闭后台提醒' : '开启提醒'}</button></div><div className="hint-panel"><ShieldCheck size={18} /><span>{config?.pushPublicKey ? 'Web Push 已配置。支持的设备可在应用关闭时接收提醒。' : '后台推送尚未配置。允许通知后，在页面打开时仍可收到新邮件提醒。'}</span></div>{permission === 'denied' && <p className="warning-text">浏览器已阻止通知，请在网站设置中修改通知权限。</p>}</section><section className="settings-section"><div className="section-heading"><div><h3><Laptop size={18} /> 把邮屿带到桌面</h3><p>作为独立应用打开，更快回到你的邮箱。</p></div><PwaInstallButton install={install} /></div><PwaInstallGuide install={install} inline />{!install.secure && !install.guideOpen && <p className="warning-text">当前为 HTTP 地址，完整 PWA 安装需要 HTTPS；点击“安装应用”查看操作方式。</p>}<div className="install-guide"><span><Smartphone size={20} /><strong>iPhone / iPad</strong><p>在 Safari 中打开，点击「分享」→「添加到主屏幕」。使用 HTTPS 地址安装后，可在这里开启邮件提醒。</p></span><span><Laptop size={20} /><strong>电脑 / Android</strong><p>点击“安装应用”，或使用浏览器菜单中的安装选项。读取新邮件和发送邮件仍需联网。</p></span></div></section><div className="logout-row"><span><strong>个人工作空间</strong><small>{user.email}</small></span><button className="button secondary" onClick={onLogout}><LogOut size={16} /> 退出登录</button></div></>}
    </div>
  </Modal>;
}
