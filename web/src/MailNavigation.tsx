import { useId, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, File, Folder, Inbox, Mail, Send, ShieldAlert, Star, Trash2 } from 'lucide-react';
import type { Account, MailFolder, MailFolderKind } from './types';

export const standardFolders = [
  { id: 'INBOX', kind: 'inbox', label: '收件箱', icon: Inbox },
  { id: 'drafts', kind: 'drafts', label: '草稿', icon: File },
  { id: 'sent', kind: 'sent', label: '已发送', icon: Send },
  { id: 'junk', kind: 'junk', label: '垃圾邮件', icon: ShieldAlert },
  { id: 'trash', kind: 'trash', label: '已删除', icon: Trash2 },
  { id: 'archive', kind: 'archive', label: '归档邮件', icon: Archive },
  { id: 'important', kind: 'important', label: '重要邮件', icon: Folder },
] as const;

export function accountFolders(account: Account): MailFolder[] {
  if (account.folders?.length) return account.folders;
  // Older responses have no catalogue; a new account may be waiting for its first sync.
  const initial = account.folders ? ['INBOX'] : ['INBOX', 'sent', 'trash', 'archive'];
  return standardFolders.filter(item => initial.includes(item.id)).map(item => ({
    path: item.id, name: item.label, kind: item.kind, specialUse: null, selectable: true,
  }));
}

export function inboxFolder(accounts: Account[], accountId: string) {
  const account = accounts.find(item => item.id === accountId);
  return account ? accountFolders(account).find(item => item.kind === 'inbox' && item.selectable)?.path || 'INBOX' : 'INBOX';
}

export function folderInfo(accounts: Account[], accountId: string, path: string) {
  const account = accounts.find(item => item.id === accountId);
  const folder = account && accountFolders(account).find(item => item.path === path);
  const standard = standardFolders.find(item => folder ? item.kind === folder.kind : item.id === path);
  return { id: standard?.id || path, label: standard?.label || folder?.name || path };
}

interface GroupProps {
  account?: Account;
  accounts: Account[];
  selectedAccount: string;
  folder: string;
  filter: string;
  onChange: (folder: string, filter: string, accountId: string) => void;
}

function FolderGroup({ account, accounts, selectedAccount, folder, filter, onChange }: GroupProps) {
  const [expanded, setExpanded] = useState(!account);
  const [customExpanded, setCustomExpanded] = useState(true);
  const id = useId();
  const scope = account?.id || '';
  const name = account?.name || '所有邮箱';
  const rows = account ? accountFolders(account) : [];
  const kinds = new Set<MailFolderKind>(account ? rows.filter(item => item.selectable).map(item => item.kind) : accounts.flatMap(item => accountFolders(item).filter(folder => folder.selectable).map(folder => folder.kind)));
  kinds.add('inbox');
  const custom = rows.filter(item => item.kind === 'custom');
  const count = account?.unread ?? accounts.reduce((sum, item) => sum + item.unread, 0);
  const inbox = inboxFolder(accounts, scope);
  const activeScope = scope === selectedAccount;

  function row(path: string, label: string, Icon: typeof Inbox, rowFilter = 'all', unreadCount = 0) {
    const active = activeScope && folder === path && filter === rowFilter;
    return <button key={`${rowFilter}:${path}`} type="button" className={`nav-item mailbox-folder ${active ? 'active' : ''}`}
      title={label} aria-label={label} aria-current={active ? 'page' : undefined}
      onClick={() => onChange(path, rowFilter, scope)}>
      <Icon size={17} strokeWidth={1.65} /><span>{label}</span>{unreadCount > 0 && <b>{unreadCount}</b>}
    </button>;
  }

  return <nav className={`mailbox-folder-group ${account ? '' : 'unified-folder-group'}`} aria-label={`${name}文件夹`}>
    <button type="button" className="mailbox-group-heading" aria-label={`${expanded ? '收起' : '展开'} ${name}文件夹`}
      aria-expanded={expanded} aria-controls={id} title={account ? `${name} · ${account.email}` : '汇总所有邮箱的常用文件夹'}
      onClick={() => setExpanded(value => !value)}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      {account && <i className="mailbox-group-dot" style={{ background: account.color }} />}
      <span>{name}</span>
      {account && (account.status === 'error' || account.status === 'partial') && <i className="connection-error-dot" title={account.status === 'partial' ? '部分目录未同步' : '连接异常'} />}
    </button>
    <div id={id} hidden={!expanded} className="mailbox-group-folders">
      {standardFolders.filter(item => kinds.has(item.kind)).map(item => {
        const actual = account ? rows.filter(folder => folder.kind === item.kind && folder.selectable) : [];
        if (!actual.length) return row(item.id, item.label, item.icon, 'all', item.kind === 'inbox' ? count : 0);
        return actual.map((folder, index) => row(folder.path,
          index === 0 ? item.label : `${item.label} · ${folder.name || folder.path}`,
          item.icon, 'all', item.kind === 'inbox' ? count : 0));
      })}
      {row(inbox, '星标邮件', Star, 'starred')}
      {row(inbox, '未读邮件', Mail, 'unread', count)}
      {custom.length > 0 && <div className="custom-mail-folders">
        <button type="button" className="mailbox-custom-heading" aria-expanded={customExpanded}
          aria-controls={`${id}-custom`} onClick={() => setCustomExpanded(value => !value)}>
          {customExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={16} /><span>其他文件夹</span>
        </button>
        <div id={`${id}-custom`} hidden={!customExpanded}>
          {custom.map(item => item.selectable ? <div key={item.path} title={item.path}>{row(item.path, item.name || item.path, Folder)}</div> :
            <div key={item.path} className="mailbox-folder-container" title={item.path}><Folder size={15} /><span>{item.name || item.path}</span></div>)}
        </div>
      </div>}
    </div>
  </nav>;
}

export default function MailNavigation(props: Omit<GroupProps, 'account'>) {
  return <>
    <FolderGroup {...props} />
    {props.accounts.map(account => <FolderGroup key={account.id} {...props} account={account} />)}
  </>;
}
