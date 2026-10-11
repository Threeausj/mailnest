import { useState } from 'react';
import { ArrowRight, Check, ExternalLink, Globe2, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, errorText, patch, post } from './api';
import { ErrorNotice, Modal, Spinner } from './components';
import type { Account, Config } from './types';

export default function AccountForm({ account: existing, config, onClose, onSaved }: {
  account?: Account; config: Config | null; onClose: () => void;
  onSaved: (account: Account, cacheReset?: boolean) => void;
}) {
  const editing = Boolean(existing);
  const oauthConnected = existing?.authType === 'oauth';
  const hadSeparateSmtp = existing?.hasSeparateSmtpCredentials ?? Boolean(existing?.smtpUsername && existing.smtpUsername !== existing.username);
  const [provider, setProvider] = useState<'gmail' | 'imap'>(existing?.provider || 'gmail');
  const [name, setName] = useState(existing?.name || '');
  const [email, setEmail] = useState(existing?.email || '');
  const [username, setUsername] = useState(existing?.username || '');
  const [password, setPassword] = useState('');
  const [smtpUsername, setSmtpUsername] = useState(existing?.smtpUsername || '');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [separateSmtp, setSeparateSmtp] = useState(hadSeparateSmtp);
  const [imapHost, setImapHost] = useState(existing?.imap.host || '');
  const [imapPort, setImapPort] = useState(existing?.imap.port || 993);
  const [imapSecure, setImapSecure] = useState(existing?.imap.secure ?? true);
  const [smtpHost, setSmtpHost] = useState(existing?.smtp.host || '');
  const [smtpPort, setSmtpPort] = useState(existing?.smtp.port || 465);
  const [smtpSecure, setSmtpSecure] = useState(existing?.smtp.secure ?? true);
  const [color, setColor] = useState(existing?.color || '#377a75');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loginUsername = provider === 'gmail' ? email.trim() : username.trim() || email.trim();
  const identityChanged = existing && !oauthConnected && (
    email.trim().toLowerCase() !== existing.email.toLowerCase() || loginUsername !== existing.username ||
    imapHost.trim().toLowerCase() !== existing.imap.host.toLowerCase()
  );
  async function submit(event: React.FormEvent) {
    if (busy) { event.preventDefault(); return; }
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (existing) {
        const changes: Record<string, unknown> = { name: name.trim() || email.split('@')[0], color };
        if (!oauthConnected) {
          if (email.trim() !== existing.email) changes.email = email.trim();
          if (loginUsername !== existing.username) changes.username = loginUsername;
          if (password) changes.password = password;
          const imap = { host: imapHost.trim(), port: imapPort, secure: imapSecure };
          const smtp = { host: smtpHost.trim(), port: smtpPort, secure: smtpSecure };
          if (imap.host !== existing.imap.host || imap.port !== existing.imap.port || imap.secure !== existing.imap.secure) changes.imap = imap;
          if (smtp.host !== existing.smtp.host || smtp.port !== existing.smtp.port || smtp.secure !== existing.smtp.secure) changes.smtp = smtp;
          if (separateSmtp) {
            if (!hadSeparateSmtp || smtpUsername.trim() !== existing.smtpUsername) changes.smtpUsername = smtpUsername.trim();
            if (smtpPassword) changes.smtpPassword = smtpPassword;
          } else if (hadSeparateSmtp) {
            changes.smtpUsername = null; changes.smtpPassword = null;
          }
        }
        const result = await patch<{ account: Account; cacheReset: boolean }>(`/accounts/${encodeURIComponent(existing.id)}`, changes);
        onSaved(result.account, result.cacheReset);
        return;
      }
      const { account } = await post<{ account: Account }>('/accounts', {
        name: name.trim() || email.split('@')[0], email: email.trim(), color, provider,
        username: provider === 'gmail' ? email.trim() : username.trim() || email.trim(), password,
        imap: { host: provider === 'gmail' ? 'imap.gmail.com' : imapHost.trim(), port: provider === 'gmail' ? 993 : imapPort, secure: provider === 'gmail' || imapSecure },
        smtp: { host: provider === 'gmail' ? 'smtp.gmail.com' : smtpHost.trim(), port: provider === 'gmail' ? 465 : smtpPort, secure: provider === 'gmail' || smtpSecure },
        ...(separateSmtp && provider === 'imap' ? { smtpUsername: smtpUsername.trim(), smtpPassword } : {}),
      });
      onSaved(account);
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  async function oauth() {
    setError(''); setBusy(true);
    try { const { url } = await api<{ url: string }>('/oauth/google/start'); window.location.assign(url); }
    catch (error) { setError(errorText(error)); setBusy(false); }
  }
  return <Modal title={editing ? '编辑邮箱' : '连接一个邮箱'} subtitle={editing ? oauthConnected ? '更新名称与标记颜色，或重新授权 Google。' : '更新邮箱配置，密码留空则保持原有凭据。' : '让每一封邮件，都有自己的位置。'} onClose={() => { if (!busy) onClose(); }} wide>
    {!editing && <div className="provider-tabs" role="tablist" aria-label="邮箱类型"><button type="button" role="tab" aria-selected={provider === 'gmail'} className={provider === 'gmail' ? 'selected' : ''} disabled={busy} onClick={() => setProvider('gmail')}><span className="google-letter">G</span> Google / Gmail</button><button type="button" role="tab" aria-selected={provider === 'imap'} className={provider === 'imap' ? 'selected' : ''} disabled={busy} onClick={() => setProvider('imap')}><Globe2 size={18} /> IMAP / SMTP</button></div>}
    <form onSubmit={submit} className={`account-form ${editing ? 'account-edit-form' : ''}`}><fieldset className="account-fields" disabled={busy}>
      {provider === 'gmail' && !editing && <><div className="oauth-option"><div><strong>使用 Google 安全授权</strong><p>{config?.googleConfigured ? '通过 Google 登录授权，无需保存邮箱密码。' : '配置 Google OAuth 后，即可使用一键授权。'}</p></div><button type="button" className="button secondary" onClick={oauth} disabled={busy || !config?.googleConfigured}>连接 Google <ArrowRight size={16} /></button></div><div className="divider-label"><span>或使用应用专用密码</span></div><div className="hint-panel"><ShieldCheck size={19} /><div>在 Google 账户中开启两步验证，然后创建应用专用密码。<a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">获取应用专用密码 <ExternalLink size={12} /></a></div></div></>}
      {oauthConnected && <div className="oauth-option"><div><strong>Google 授权邮箱</strong><p>重新授权时请选择 {existing?.email}，以更新此邮箱的访问权限。</p></div><button type="button" className="button secondary" onClick={oauth} disabled={busy || !config?.googleConfigured}>重新授权 Google <ArrowRight size={16} /></button></div>}
      <div className="form-grid"><label>邮箱名称<input placeholder="例如：工作邮箱" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" /></label><label>邮箱地址<input type="email" placeholder="you@example.com" required readOnly={oauthConnected} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label></div>
      {!oauthConnected && <>
        {(provider === 'imap' || editing) && <label>登录用户名<input placeholder="通常与邮箱地址相同" readOnly={provider === 'gmail'} value={provider === 'gmail' ? email : username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>}
        <label>{provider === 'gmail' ? '应用专用密码' : '邮箱密码 / 授权码'}<input type="password" required={!editing} placeholder={editing ? '留空保持原有密码 / 授权码' : provider === 'gmail' ? 'Google 生成的 16 位应用专用密码' : '请输入邮箱密码或服务商授权码'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        {(provider === 'imap' || editing) && <><div className="protocol-card"><h3><Mail size={16} /> 收信服务器 · IMAP</h3><div className="host-grid"><label>服务器地址<input required readOnly={provider === 'gmail'} placeholder="imap.example.com" value={imapHost} onChange={(e) => setImapHost(e.target.value)} /></label><label>端口<input type="number" min={1} max={65535} required value={imapPort} onChange={(e) => setImapPort(Number(e.target.value))} /></label><label>加密<select value={imapSecure ? 'tls' : 'starttls'} onChange={(e) => { setImapSecure(e.target.value === 'tls'); setImapPort(e.target.value === 'tls' ? 993 : 143); }}><option value="tls">SSL / TLS</option><option value="starttls">STARTTLS</option></select></label></div></div><div className="protocol-card"><h3><ArrowRight size={16} /> 发信服务器 · SMTP</h3><div className="host-grid"><label>服务器地址<input required readOnly={provider === 'gmail'} placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} /></label><label>端口<input type="number" min={1} max={65535} required value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} /></label><label>加密<select value={smtpSecure ? 'tls' : 'starttls'} onChange={(e) => { setSmtpSecure(e.target.value === 'tls'); setSmtpPort(e.target.value === 'tls' ? 465 : 587); }}><option value="tls">SSL / TLS</option><option value="starttls">STARTTLS</option></select></label></div><label className="checkbox-label"><input type="checkbox" checked={separateSmtp} onChange={(e) => setSeparateSmtp(e.target.checked)} /> SMTP 使用不同的登录凭据</label>{separateSmtp && <div className="form-grid"><label>SMTP 用户名<input required value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} autoComplete="off" /></label><label>SMTP 密码<input type="password" required={!editing || !hadSeparateSmtp} placeholder={editing && hadSeparateSmtp ? '留空保持原有 SMTP 密码' : '请输入 SMTP 密码 / 授权码'} value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} autoComplete="new-password" /></label></div>}</div></>}
      </>}
      <div className="color-picker"><span>标记颜色</span>{['#377a75', '#627dcc', '#b88749', '#af7486', '#7a8b55', '#7c6a9e'].map((value) => <button key={value} type="button" aria-label={`选择颜色 ${value}`} aria-pressed={color === value} style={{ backgroundColor: value }} onClick={() => setColor(value)}>{color === value && <Check size={13} />}</button>)}</div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {identityChanged && <div className="hint-panel account-cache-notice"><RefreshCw size={17} /><span>邮箱身份或收信服务器已更改。保存成功后会重建此账号的本地缓存并重新同步，服务器上的邮件会保留。</span></div>}
      <div className="modal-footer"><span className="small-muted"><ShieldCheck size={14} /> {editing ? oauthConnected ? 'Google 授权凭据保持不变' : '连接配置验证成功后保存' : '凭据加密保存，连接前验证服务器'}</span><button className="button primary" disabled={busy} type="submit">{busy ? <Spinner label={editing ? '正在保存…' : '正在验证连接…'} /> : <>{editing ? '保存修改' : '连接邮箱'} <ArrowRight size={16} /></>}</button></div>
    </fieldset></form>
  </Modal>;
}
