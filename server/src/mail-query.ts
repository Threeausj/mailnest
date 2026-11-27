import { z } from 'zod';
import { summaryDto, type MessageRow, type Store } from './db.js';
import { findFolder, type MailService } from './mail.js';
import { ApiError } from './security.js';

export const mailListFilters = {
  accountId: z.string().max(100).optional(),
  folder: z.string().min(1).max(200).default('INBOX'),
  filter: z.enum(['all', 'unread', 'starred']).default('all'),
  q: z.string().max(200).default(''),
};

export const mailListQuery = z.object({
  ...mailListFilters,
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

export function ownedAccount(store: Store, userId: string, id: string) {
  const row = store.account(id, userId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', '邮箱不存在。');
  return row;
}

export function ownedMessage(store: Store, userId: string, id: string) {
  const row = store.message(id, userId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', '邮件不存在。');
  return row;
}

export function listMessages(store: Store, mail: MailService, userId: string, query: z.output<typeof mailListQuery>) {
  const { accountId, folder, filter, q, page, pageSize } = query;
  const accounts = accountId ? [ownedAccount(store, userId, accountId)] : store.accounts(userId);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  for (const account of accounts) {
    const folders = mail.folderRows(account.id);
    // A specific mailbox supplies actual server paths, including paths that
    // happen to match another folder's logical alias (for example "drafts").
    const exact = accountId ? folders.find(item => item.path === folder) : undefined;
    if (exact?.selectable === 0) continue;
    const path = exact?.path ?? findFolder(folders, folder);
    if (!path) continue;
    conditions.push('(m.account_id=? AND m.folder=?)');
    values.push(account.id, path);
  }
  if (!conditions.length) return { messages: [], total: 0, page, pageSize };
  let where = `(${conditions.join(' OR ')}) AND a.user_id=?`;
  values.push(userId);
  if (filter === 'unread') where += ' AND m.unread=1';
  if (filter === 'starred') where += ' AND m.starred=1';
  if (q) {
    where += ` AND (
      json_extract(m.summary,'$.subject') LIKE ? ESCAPE '\\'
      OR json_extract(m.summary,'$.from.address') LIKE ? ESCAPE '\\'
      OR json_extract(m.summary,'$.from.name') LIKE ? ESCAPE '\\'
      OR json_extract(m.detail,'$.text') LIKE ? ESCAPE '\\'
    )`;
    const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(term, term, term, term);
  }
  const count = store.db.prepare(`SELECT COUNT(*) AS total FROM messages m JOIN accounts a ON a.id=m.account_id WHERE ${where}`)
    .get(...values) as { total: number };
  const rows = store.db.prepare(`
    SELECT m.id,m.account_id,m.folder,m.summary,m.unread,m.starred
    FROM messages m JOIN accounts a ON a.id=m.account_id WHERE ${where}
    ORDER BY m.date DESC,m.id LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize) as unknown as MessageRow[];
  return { messages: rows.map(summaryDto), total: count.total, page, pageSize };
}
