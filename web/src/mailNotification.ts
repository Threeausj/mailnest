function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : text;
}

// Keep the presentation identical to the server's Web Push payload, so whichever
// delivery arrives first displays the same subject and plain-text excerpt.
export function mailNotificationText(count: number, notification?: unknown): { title: string; body: string } {
  if (!notification || typeof notification !== 'object') {
    return { title: 'MailNest 新邮件', body: `有 ${count} 封新邮件等待查看` };
  }
  const mail = notification as Record<string, unknown>;
  const from = mail.from && typeof mail.from === 'object' ? mail.from as Record<string, unknown> : {};
  const sender = clean(from.name, 80) || clean(from.address, 80) || '未知发件人';
  const preview = clean(mail.preview, 200) || '（无正文摘要）';
  return {
    title: clean(mail.subject, 120) || '无主题',
    body: `${sender}：${preview}${count > 1 ? ` · 另有 ${count - 1} 封新邮件` : ''}`,
  };
}
