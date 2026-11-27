export interface User { id: string; email: string; name: string }
export type MailFolderKind = 'inbox' | 'sent' | 'drafts' | 'junk' | 'trash' | 'archive' | 'important' | 'custom';
export interface MailFolder {
  path: string; name: string; specialUse: string | null; selectable: boolean; kind: MailFolderKind;
}
export interface Account {
  id: string; name: string; email: string; color: string; provider: 'gmail' | 'imap'; username: string;
  smtpUsername?: string; imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean }; status: 'connected' | 'partial' | 'error' | 'syncing';
  lastSyncedAt: string | null; error: string | null; unread: number;
  folders?: MailFolder[];
  authType?: 'oauth' | 'password'; hasSeparateSmtpCredentials?: boolean;
}
export interface Address { name: string; address: string }
export interface MessageSummary {
  id: string; accountId: string; folder: string; from: Address; to: Address[]; cc: Address[];
  subject: string; preview: string; date: string; unread: boolean; starred: boolean; hasAttachments: boolean;
}
export interface Message extends MessageSummary {
  text: string; html: string | null; messageId: string | null; bodyTruncated?: boolean;
  attachments: { id: string; filename: string; contentType: string; size: number; contentId?: string | null; inline?: boolean }[];
}
export interface Config { googleConfigured: boolean; pushPublicKey: string | null; pollingInterval: number }
export type TokenScope = 'api' | 'mcp-read';
export interface Token { id: string; name: string; scope: TokenScope; createdAt: string; lastUsedAt: string | null }
export interface DraftAttachment { filename: string; contentType: string; content: string; size: number }
export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
