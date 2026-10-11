import { Star } from 'lucide-react';
import { formatDate } from './components';
import type { Account, Message } from './types';

export default function MessageHeader({ message, account, folderLabel, busy, onStar }: {
  message: Message;
  account?: Account;
  folderLabel: string;
  busy: boolean;
  onStar: () => void;
}) {
  const sender = message.from.name || message.from.address;
  const subject = message.subject || '（无主题）';
  const recipients = message.to.map(address => address.name || address.address).join('，') || '未知收件人';
  return <section className="message-metadata" aria-label="邮件信息">
    <span className="sender-avatar" style={{ backgroundColor: account?.color }} aria-hidden="true">{sender.slice(0, 1).toUpperCase()}</span>
    <div className="message-metadata-main">
      <div className="message-sender-block">
        <strong title={sender}>{sender}</strong>
        <span className="sender-address" title={message.from.address}>&lt;{message.from.address}&gt;</span>
      </div>
      <div className="message-heading"><h2 title={subject}>{subject}</h2></div>
      <details className="message-recipient-details">
        <summary title={recipients}>收件人：{recipients}</summary>
        <dl>
          <dt>发件人</dt><dd>{message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address}</dd>
          <dt>收件人</dt><dd>{message.to.map(address => address.name ? `${address.name} <${address.address}>` : address.address).join('，') || '未知收件人'}</dd>
          {message.cc?.length > 0 && <><dt>抄送</dt><dd>{message.cc.map(address => address.name ? `${address.name} <${address.address}>` : address.address).join('，')}</dd></>}
          <dt>主题</dt><dd>{subject}</dd>
          <dt>日期</dt><dd>{formatDate(message.date, true)}</dd>
        </dl>
      </details>
    </div>
    <div className="message-metadata-side">
      <span className="metadata-mailbox" title={`${folderLabel} · ${account?.name || '邮箱'}`}>{folderLabel} · {account?.name || '邮箱'}</span>
      <time dateTime={message.date} title={formatDate(message.date, true)}>{formatDate(message.date)}</time>
      <button className={`icon-button ${message.starred ? 'is-starred' : ''}`} aria-label={message.starred ? '取消星标' : '标记星标'} aria-pressed={message.starred} disabled={busy} onClick={onStar}>
        <Star size={16} fill={message.starred ? 'currentColor' : 'none'} />
      </button>
    </div>
  </section>;
}
