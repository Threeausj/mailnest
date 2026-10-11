import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Paperclip } from 'lucide-react';
import { ApiError, errorText } from './api';
import { fileSize, Spinner } from './components';
import type { Message } from './types';
import { contentId, imageType, mailDocument, maxBodyHeight, prepareMail } from './mailRenderer';

const maxImageBytes = 8 * 1024 * 1024;
const maxInlineBytes = 16 * 1024 * 1024;

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function imageDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const complete = () => signal.removeEventListener('abort', abort);
    reader.onload = () => { complete(); resolve(String(reader.result)); };
    reader.onerror = () => { complete(); reject(new Error('无法读取图片，请重试。')); };
    reader.onabort = () => { complete(); reject(new DOMException('图片加载已取消', 'AbortError')); };
    if (signal.aborted) { reject(new DOMException('图片加载已取消', 'AbortError')); return; }
    signal.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(blob);
  });
}

export default function MailBody({ message }: { message: Message }) {
  const [retry, setRetry] = useState(0);
  const [bodySize, setBodySize] = useState({ height: 100, capped: false });
  const [inline, setInline] = useState<{ sources: Record<string, string>; failed: string[]; loading: boolean; error: string }>({ sources: {}, failed: [], loading: false, error: '' });
  const frame = useRef<HTMLIFrameElement>(null);
  const security = useMemo(() => ({ nonce: randomToken(), token: randomToken() }), [message.id]);
  const prepared = useMemo(() => prepareMail(message.html || '', message.attachments), [message.html, message.attachments]);
  const document = useMemo(() => mailDocument(prepared, inline.sources, security.nonce, security.token), [prepared, inline.sources, security]);
  useEffect(() => {
    const onSize = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      const value = data as Record<string, unknown>;
      if (value.type !== 'mailnest:body-height' || value.token !== security.token || typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height < 16 || value.height > maxBodyHeight || !Number.isInteger(value.height) || typeof value.capped !== 'boolean' || (value.capped && value.height !== maxBodyHeight)) return;
      setBodySize((previous) => previous.height === value.height && previous.capped === value.capped ? previous : { height: value.height as number, capped: value.capped as boolean });
    };
    window.addEventListener('message', onSize);
    return () => window.removeEventListener('message', onSize);
  }, [security.token]);
  useEffect(() => {
    const controller = new AbortController();
    const sources = Object.create(null) as Record<string, string>;
    const failed: string[] = [];
    let active = true;
    let totalBytes = 0;
    const pending = prepared.inline.filter((attachment) => {
      if (attachment.size > maxImageBytes || totalBytes + attachment.size > maxInlineBytes) { failed.push(attachment.id); return false; }
      totalBytes += attachment.size;
      return true;
    });
    setInline({ sources: {}, failed: [], loading: pending.length > 0, error: '' });
    let failureReason = '';
    async function worker() {
      while (active && pending.length) {
        const attachment = pending.shift()!;
        try {
          const response = await fetch(`/api/v1/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}?inline=true`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
          if (!response.ok) {
            if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
            const body = await response.json().catch(() => ({}));
            throw new ApiError(body.error?.message || `图片加载失败（${response.status}）`, response.status, body.error?.code || 'IMAGE_FAILED');
          }
          const blob = await response.blob();
          if (!imageType.test(blob.type) || blob.size > maxImageBytes) throw new Error('图片格式不支持或文件超过 8 MB');
          if (active) {
            const id = contentId(attachment.contentId!);
            const source = await imageDataUrl(blob, controller.signal);
            if (active) sources[id] = source;
          }
        } catch (error) {
          if (!active) return;
          failed.push(attachment.id); failureReason = errorText(error);
        }
      }
    }
    void Promise.all([worker(), worker()]).then(() => {
      if (active) setInline({ sources: { ...sources }, failed, loading: false, error: failureReason });
    });
    return () => { active = false; controller.abort(); Object.keys(sources).forEach((id) => delete sources[id]); };
  }, [message.id, prepared.inline, retry]);

  const referencedIds = new Set(prepared.inline.map((attachment) => attachment.id));
  const attachments = message.attachments.filter((attachment) => !referencedIds.has(attachment.id) || inline.failed.includes(attachment.id));
  return <>
    {inline.loading && <div className="inline-images-status"><Spinner label="正在加载内嵌图片…" /></div>}
    {inline.failed.length > 0 && <div className="inline-images-status" role="status"><span>{inline.error ? `部分内嵌图片加载失败：${inline.error}` : '部分内嵌图片较大，可从下方附件下载查看。'}</span>{inline.error && <button className="text-button" onClick={() => setRetry((value) => value + 1)}>重试图片</button>}</div>}
    {message.bodyTruncated && <p className="body-truncated-notice">正文较长，已截取显示。</p>}
    <div className="message-body">{message.html ? <><iframe ref={frame} title="邮件正文" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={document} scrolling={bodySize.capped ? 'yes' : 'no'} style={{ height: bodySize.height }} onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'mailnest:measure-request', token: security.token }, '*')} />{bodySize.capped && <p className="body-truncated-notice">正文超长，可在正文区域内继续滚动阅读。</p>}</> : <pre>{message.text || '（这封邮件没有正文）'}</pre>}</div>
    {attachments.length > 0 && <section className="message-attachments" aria-label="邮件附件"><h3><Paperclip size={16} /> {attachments.length} 个附件</h3><div>{attachments.map((attachment) => <a className="attachment-download" key={attachment.id} href={`/api/v1/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}`} download={attachment.filename}><Paperclip size={18} /><span>{attachment.filename}<small>{fileSize(attachment.size)}</small></span><ArrowDownToLine size={16} /></a>)}</div></section>}
  </>;
}
