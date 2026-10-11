import DOMPurify from 'dompurify';
import { ApiError } from './api';
import type { Address, DraftAttachment, Message } from './types';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 20;

const blocks = new Set(['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DIV', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'P', 'PRE', 'SECTION', 'TABLE', 'TR']);

/** Only text enters the editable draft; original HTML never runs in the composer. */
export function htmlToDraftText(html: string): string {
  const fragment = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'img', 'video', 'audio', 'picture', 'source', 'link', 'meta', 'base'],
  });
  function read(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    const element = node instanceof Element ? node : null;
    if (element?.tagName === 'BR') return '\n';
    const text = Array.from(node.childNodes, read).join('');
    if (element && blocks.has(element.tagName)) return `\n${text}\n`;
    if (element && ['TD', 'TH'].includes(element.tagName)) return `${text}\t`;
    return text;
  }
  return read(fragment).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function addresses(values: Address[]) {
  return values.map(({ name, address }) => name ? `${name} <${address}>` : address).join(', ');
}

export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(?:fw|fwd)\s*:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}

export function forwardText(message: Message): string {
  const date = new Date(message.date);
  const lines = [
    '---------- 转发的邮件 ----------',
    `发件人：${addresses([message.from])}`,
    `日期：${Number.isNaN(date.getTime()) ? message.date : date.toLocaleString('zh-CN', { hour12: false })}`,
    `主题：${message.subject}`,
    `收件人：${addresses(message.to)}`,
    ...(message.cc.length ? [`抄送：${addresses(message.cc)}`] : []),
  ];
  const body = message.text?.trim() ? message.text : message.html ? htmlToDraftText(message.html) : '';
  return `\n\n${lines.join('\n')}\n\n${body}`;
}

export function bytesToAttachment(bytes: Uint8Array, filename: string, contentType: string): DraftAttachment {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return { filename, contentType: contentType || 'application/octet-stream', content: btoa(binary), size: bytes.length };
}

/** Bound streamed responses too: an incorrect source size must not bypass the draft limit. */
export async function loadForwardAttachment(messageId: string, attachment: Message['attachments'][number], availableBytes: number, signal: AbortSignal): Promise<DraftAttachment> {
  const response = await fetch(`/api/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
    const data = await response.json().catch(() => ({}));
    const fallback = response.status === 404 ? '附件不存在或已不可用。' : `请求失败（${response.status}）`;
    throw new ApiError(data.error?.message || fallback, response.status, data.error?.code || 'REQUEST_FAILED');
  }
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > availableBytes) {
    await response.body?.cancel();
    throw new Error('附件总大小不能超过 20 MB，请移除部分附件后重试。');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > availableBytes) {
          await reader.cancel();
          throw new Error('附件总大小不能超过 20 MB，请移除部分附件后重试。');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    length = bytes.length;
    if (length > availableBytes) throw new Error('附件总大小不能超过 20 MB，请移除部分附件后重试。');
    chunks.push(bytes);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytesToAttachment(bytes, attachment.filename, attachment.contentType);
}
