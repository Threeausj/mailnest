import { useEffect, useRef, useState } from 'react';
import { ChevronDown, File, Paperclip, Send, X } from 'lucide-react';
import { api, errorText } from './api';
import { ErrorNotice, fileSize, Modal, Spinner } from './components';
import { bytesToAttachment, forwardSubject, forwardText, loadForwardAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from './composeForward';
import type { Account, DraftAttachment, Message } from './types';

export default function Compose({ accounts, defaultAccount, reply, forward, onClose, onSent }: { accounts: Account[]; defaultAccount: string; reply: Message | null; forward: Message | null; onClose: () => void; onSent: (warning?: string) => void }) {
  const [initial] = useState(() => ({
    accountId: (forward || reply)?.accountId || defaultAccount || accounts[0]?.id || '',
    to: forward ? '' : reply?.from.address || '',
    subject: forward ? forwardSubject(forward.subject) : reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : '',
    text: forward ? forwardText(forward) : '',
    sourceAttachments: forward?.attachments || [],
  }));
  const [accountId, setAccountId] = useState(initial.accountId);
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState(initial.subject);
  const [text, setText] = useState(initial.text);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [sourceAttachments, setSourceAttachments] = useState(initial.sourceAttachments);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const attachmentRead = useRef(false);
  const downloaded = useRef(new Map<string, DraftAttachment>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  const attachmentCount = attachments.length + sourceAttachments.length;
  const totalBytes = [...attachments, ...sourceAttachments].reduce((sum, item) => sum + item.size, 0);
  const limitError = attachmentCount > MAX_ATTACHMENT_COUNT ? '一封邮件最多添加 20 个附件，请移除部分原邮件附件。' : totalBytes > MAX_ATTACHMENT_BYTES ? '附件总大小不能超过 20 MB，请移除部分原邮件附件。' : '';
  function close() {
    if (request.current || attachmentRead.current) return;
    const changed = accountId !== initial.accountId || to !== initial.to || cc.trim() || bcc.trim() || subject !== initial.subject || text !== initial.text || attachments.length || sourceAttachments.length !== initial.sourceAttachments.length;
    if (changed && !window.confirm('关闭后，此封邮件的草稿将被丢弃。确定关闭？')) return;
    onClose();
  }
  async function attach(files: FileList | null) {
    if (!files?.length || attachmentRead.current || request.current) return;
    setError('');
    const newFiles = Array.from(files);
    if (attachmentCount + newFiles.length > MAX_ATTACHMENT_COUNT) { setError('一封邮件最多添加 20 个附件。'); if (fileInput.current) fileInput.current.value = ''; return; }
    if (newFiles.reduce((sum, file) => sum + file.size, totalBytes) > MAX_ATTACHMENT_BYTES) { setError('附件总大小不能超过 20 MB。'); if (fileInput.current) fileInput.current.value = ''; return; }
    attachmentRead.current = true;
    setAttaching(true);
    try {
      const converted = await Promise.all(newFiles.map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return bytesToAttachment(bytes, file.name, file.type);
      }));
      if (mounted.current) setAttachments((previous) => [...previous, ...converted]);
    } catch { if (mounted.current) setError('无法读取附件，请重新选择文件。'); } finally { attachmentRead.current = false; if (mounted.current) { setAttaching(false); if (fileInput.current) fileInput.current.value = ''; } }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (request.current || attachmentRead.current) return;
    const addresses = [to, cc, bcc].flatMap((field) => field.split(/[;,，；]/).map((value) => value.trim()).filter(Boolean));
    if (!addresses.length || addresses.some((address) => !/^(?:[^<>]+\s*)?<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))) { setError('请输入有效的收件人地址，多个地址用英文逗号分隔。'); return; }
    if (!text.trim() && !attachmentCount) { setError('请填写邮件正文或添加附件。'); return; }
    if (limitError) { setError(limitError); return; }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const readyAttachments = [...attachments];
      let readyBytes = attachments.reduce((sum, item) => sum + item.size, 0);
      if (forward && sourceAttachments.length) {
        setPreparing(true);
        for (const attachment of sourceAttachments) {
          let loaded = downloaded.current.get(attachment.id);
          if (!loaded) {
            try { loaded = await loadForwardAttachment(forward.id, attachment, MAX_ATTACHMENT_BYTES - readyBytes, controller.signal); }
            catch (error) {
              if (controller.signal.aborted) throw error;
              throw new Error(`无法读取原邮件附件“${attachment.filename}”：${errorText(error)}`);
            }
            downloaded.current.set(attachment.id, loaded);
          }
          readyBytes += loaded.size;
          if (readyBytes > MAX_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 20 MB，请移除部分附件后重试。');
          readyAttachments.push(loaded);
        }
        if (mounted.current) setPreparing(false);
      }
      if (controller.signal.aborted || !mounted.current) return;
      const result = await api<{ ok: true; messageId: string; warning?: string }>('/messages/send', { method: 'POST', signal: controller.signal, body: JSON.stringify({
        accountId, to: to.replace(/[，；;]/g, ','), cc: cc.replace(/[，；;]/g, ','), bcc: bcc.replace(/[，；;]/g, ','), subject: subject.trim(), text,
        ...(!forward && reply?.messageId ? { inReplyTo: reply.messageId, references: reply.messageId } : {}),
        attachments: readyAttachments.map(({ filename, contentType, content }) => ({ filename, contentType, content })),
      }) });
      if (mounted.current) onSent(result.warning);
    } catch (error) { if (mounted.current && !controller.signal.aborted) setError(errorText(error)); }
    finally { request.current = null; if (mounted.current) { setBusy(false); setPreparing(false); } }
  }
  return <Modal title={forward ? '转发邮件' : reply ? '回复邮件' : '写一封新邮件'} subtitle="把想说的话，认真送达。" onClose={close} wide><form className="compose-form" onSubmit={send}>
    <label className="compose-row"><span>发件人</span><select aria-label="发件人" value={accountId} onChange={(e) => setAccountId(e.target.value)} required disabled={busy}>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name} &lt;{account.email}&gt;</option>)}</select><ChevronDown size={14} className="select-decoration" /></label>
    <label className="compose-row"><span>收件人</span><input required value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" disabled={busy} autoComplete="off" /><button type="button" className="text-button" onClick={() => setShowCopies(!showCopies)}>{showCopies ? '收起' : '抄送 / 密送'}</button></label>
    {showCopies && <><label className="compose-row"><span>抄送</span><input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="多个地址以英文逗号分隔" disabled={busy} /></label><label className="compose-row"><span>密送</span><input value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="密送地址不会向其他收件人显示" disabled={busy} /></label></>}
    <label className="compose-row"><span>主题</span><input required maxLength={500} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="给这封邮件一个主题" disabled={busy} /></label>
    <textarea className="compose-body" aria-label="邮件正文" placeholder="从这里开始书写…" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} autoFocus />
    {reply && !forward && <details className="quoted-message"><summary>原邮件 · {reply.from.name || reply.from.address}</summary><pre>{reply.text}</pre></details>}
    {forward?.bodyTruncated && <p className="small-muted quoted-message">原邮件正文已被截断，转发将包含当前已加载的部分。</p>}
    {attachmentCount > 0 && <div className="draft-attachments">{sourceAttachments.map((file) => <div className="attachment-chip" key={`source-${file.id}`}><File size={16} /><span>{file.filename}<small>{fileSize(file.size)} · 原邮件附件 · 点击发送时载入</small></span><button type="button" className="icon-button" aria-label={`移除附件 ${file.filename}`} disabled={busy || attaching} onClick={() => setSourceAttachments((previous) => previous.filter((item) => item.id !== file.id))}><X size={15} /></button></div>)}{attachments.map((file, index) => <div className="attachment-chip" key={`${index}-${file.filename}`}><File size={16} /><span>{file.filename}<small>{fileSize(file.size)}</small></span><button type="button" className="icon-button" aria-label={`移除附件 ${file.filename}`} disabled={busy || attaching} onClick={() => setAttachments((previous) => previous.filter((_, item) => item !== index))}><X size={15} /></button></div>)}</div>}
    {limitError && <ErrorNotice>{limitError}</ErrorNotice>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
    <div className="modal-footer"><div className="compose-attachment-control"><input hidden ref={fileInput} type="file" multiple onChange={(e) => void attach(e.target.files)} /><button type="button" className="button secondary" onClick={() => fileInput.current?.click()} disabled={busy || attaching}><Paperclip size={17} /> {attaching ? '读取中…' : '添加附件'}</button><span className="small-muted">{attachmentCount ? `${fileSize(totalBytes)} / ` : '最多 ' }20 MB</span></div><button type="submit" className="button primary" disabled={busy || attaching || Boolean(limitError)}>{busy ? <Spinner label={preparing ? '准备附件…' : '正在发送…'} /> : <><Send size={16} /> 发送邮件</>}</button></div>
  </form></Modal>;
}
