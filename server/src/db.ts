import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { hashPassword } from './security.js';

export interface UserRow { id:string; email:string; name:string; password_hash:string }
export interface AccountRow {
  id:string; user_id:string; name:string; email:string; color:string; provider:'gmail'|'imap'; username:string; smtp_username:string;
  imap_host:string; imap_port:number; imap_secure:number; smtp_host:string; smtp_port:number; smtp_secure:number; credentials:string;
  status:'connected'|'partial'|'error'|'syncing'; last_synced_at:string|null; error:string|null; unread:number;
  mail_cache_epoch?:string;sort_order?:number;
}
export interface MessageRow {
  id:string; account_id:string; folder:string; uid:number; uid_validity:string; summary:string;
  source:Uint8Array|null; detail:string|null; detail_cached_at?:number|null; unread:number; starred:number; date:string;
  cache_priority?:number; detail_size_bytes?:number; detail_retry_at?:number;
}
export interface MailCacheTarget extends MessageRow {user_id:string;cache_priority:number;detail_size_bytes:number;detail_retry_at:number;has_detail:number}
export type FolderKind = 'inbox'|'sent'|'drafts'|'junk'|'trash'|'archive'|'important'|'custom';
export interface FolderDto { path:string; name:string; specialUse:string|null; selectable:boolean; kind:FolderKind }
export class Store {
  db: DatabaseSync;
  constructor(private config: Config) {
    mkdirSync(config.dataDir, {recursive:true,mode:0o700});
    const path = join(config.dataDir, 'mailnest.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,email TEXT NOT NULL,color TEXT NOT NULL,provider TEXT NOT NULL,username TEXT NOT NULL,smtp_username TEXT NOT NULL,imap_host TEXT NOT NULL,imap_port INTEGER NOT NULL,imap_secure INTEGER NOT NULL,smtp_host TEXT NOT NULL,smtp_port INTEGER NOT NULL,smtp_secure INTEGER NOT NULL,credentials TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'connected',last_synced_at TEXT,error TEXT,unread INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,email));
      CREATE TABLE IF NOT EXISTS folders(account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,path TEXT NOT NULL,name TEXT NOT NULL,special_use TEXT,uid_validity TEXT,PRIMARY KEY(account_id,path));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,folder TEXT NOT NULL,uid INTEGER NOT NULL,uid_validity TEXT NOT NULL,summary TEXT NOT NULL,source BLOB,detail TEXT,unread INTEGER NOT NULL,starred INTEGER NOT NULL,date TEXT NOT NULL,UNIQUE(account_id,folder,uid_validity,uid));
      CREATE INDEX IF NOT EXISTS messages_account_date ON messages(account_id,date DESC);
      CREATE INDEX IF NOT EXISTS messages_folder ON messages(account_id,folder);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,filename TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,content BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,subscription TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_deliveries(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,notification_id TEXT NOT NULL,endpoint_hash TEXT NOT NULL,subscription_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_status INTEGER,last_category TEXT,last_accepted_at INTEGER,UNIQUE(user_id,notification_id,endpoint_hash));
      CREATE INDEX IF NOT EXISTS push_deliveries_due ON push_deliveries(status,next_attempt_at,expires_at);
      CREATE INDEX IF NOT EXISTS push_deliveries_owner ON push_deliveries(user_id,expires_at);
    `);
    const columns=this.db.prepare('PRAGMA table_info(messages)').all() as {name:string}[];
    if(!columns.some(column=>column.name==='detail_cached_at'))this.db.exec('ALTER TABLE messages ADD COLUMN detail_cached_at INTEGER');
    for(const column of ['cache_priority','detail_size_bytes','detail_retry_at'])if(!columns.some(existing=>existing.name===column))this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_cache_targets ON messages(cache_priority DESC,date DESC,id); UPDATE messages SET detail_size_bytes=length(CAST(detail AS BLOB)) WHERE detail IS NOT NULL AND detail_size_bytes=0');
    const folderColumns=this.db.prepare('PRAGMA table_info(folders)').all() as {name:string}[];
    if(!folderColumns.some(column=>column.name==='selectable'))this.db.exec('ALTER TABLE folders ADD COLUMN selectable INTEGER NOT NULL DEFAULT 1');
    const accountColumns=this.db.prepare('PRAGMA table_info(accounts)').all() as {name:string}[];
    if(!accountColumns.some(column=>column.name==='mail_cache_epoch'))this.db.exec("ALTER TABLE accounts ADD COLUMN mail_cache_epoch TEXT NOT NULL DEFAULT ''");
    if(!accountColumns.some(column=>column.name==='sort_order'))this.db.exec('ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    const tokenColumns = this.db.prepare('PRAGMA table_info(api_tokens)').all() as { name: string }[];
    if (!tokenColumns.some(column => column.name === 'scope')) {
      this.db.exec("ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'api' CHECK(scope IN ('api','mcp-read'))");
    }
    // Old versions stored both complete MIME messages and decoded attachment bytes.
    // The remote mailbox remains the source of truth; keep only bounded body caches.
    this.db.exec("UPDATE messages SET source=NULL WHERE source IS NOT NULL; DELETE FROM attachments; UPDATE messages SET detail=NULL,detail_cached_at=NULL,detail_size_bytes=0,detail_retry_at=0 WHERE detail IS NOT NULL AND (json_extract(detail,'$.cacheVersion') IS NOT 2)");
  }
  async bootstrap(config: Config) {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as {n:number};
    if (!count.n) this.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(randomUUID(),config.adminEmail,config.adminName,await hashPassword(config.adminPassword));
    this.cleanup();
  }
  cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
    this.pruneMailCache();
  }
  pruneMailCache(refreshTargets=true) {
    if(refreshTargets)this.refreshMailCacheTargets();
    const now=Date.now();
    this.db.exec('UPDATE messages SET detail_size_bytes=length(CAST(detail AS BLOB)) WHERE detail IS NOT NULL AND detail_size_bytes=0');
    this.db.prepare('UPDATE messages SET detail=NULL,detail_cached_at=NULL WHERE cache_priority=0 AND detail IS NOT NULL AND (detail_cached_at IS NULL OR detail_cached_at<?)').run(now-this.config.mailCacheTtlDays*86400_000);
    const rows=this.db.prepare('SELECT id,cache_priority,detail_size_bytes AS size FROM messages WHERE detail IS NOT NULL ORDER BY cache_priority DESC,CASE WHEN cache_priority>0 THEN date END DESC,CASE WHEN cache_priority=0 THEN detail_cached_at END DESC,id').all() as {id:string;cache_priority:number;size:number}[];
    let retained=0;
    const evict=this.db.prepare('UPDATE messages SET detail=NULL,detail_cached_at=NULL,detail_size_bytes=?,detail_retry_at=MAX(detail_retry_at,?) WHERE id=?');
    for(const row of rows){if(retained+row.size<=this.config.mailCacheMaxBytes){retained+=row.size;continue;}evict.run(row.size,row.cache_priority?now+3600_000:0,row.id);}
  }
  refreshMailCacheTargets() {
    // Rank across all mailboxes/folders of each owner, matching list ordering.
    this.db.prepare(`WITH ranked AS (SELECT m.id,ROW_NUMBER() OVER(PARTITION BY a.user_id ORDER BY m.date DESC,m.id) AS position FROM messages m JOIN accounts a ON a.id=m.account_id), priorities AS (SELECT m.id,CASE WHEN m.starred=1 THEN 2 WHEN r.position<=? THEN 1 ELSE 0 END AS priority FROM messages m JOIN ranked r ON r.id=m.id) UPDATE messages SET cache_priority=(SELECT priority FROM priorities WHERE priorities.id=messages.id) WHERE cache_priority<>(SELECT priority FROM priorities WHERE priorities.id=messages.id)`).run(this.config.mailCacheRecentCount);
  }
  mailCacheTargets():MailCacheTarget[] {
    // Do not materialize up to the entire body budget just to plan background work.
    return this.db.prepare('SELECT m.id,m.account_id,m.folder,m.uid,m.uid_validity,m.summary,m.unread,m.starred,m.date,m.detail_cached_at,m.cache_priority,m.detail_size_bytes,m.detail_retry_at,m.detail IS NOT NULL AS has_detail,NULL AS detail,NULL AS source,a.user_id FROM messages m JOIN accounts a ON a.id=m.account_id WHERE m.cache_priority>0 ORDER BY m.cache_priority DESC,m.date DESC,m.id').all() as unknown as MailCacheTarget[];
  }
  canWarmMail(row:MessageRow) {
    return this.admittedMailCacheTargets().some(target=>target.id===row.id);
  }
  admittedMailCacheTargets():MailCacheTarget[] {
    // Previously measured sizes keep admission stable after a body is evicted.
    // Unmeasured bodies reserve a small allowance until their exact size is known.
    let retained=0;const admitted:MailCacheTarget[]=[];
    for(const target of this.mailCacheTargets()){
      const size=target.detail_size_bytes||64*1024;
      if(retained+size<=this.config.mailCacheMaxBytes){retained+=size;admitted.push(target);}
    }
    return admitted;
  }
  user(id:string) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow|undefined; }
  account(id:string,userId?:string) {
    return this.db.prepare(`SELECT * FROM accounts WHERE id=?${userId?' AND user_id=?':''}`).get(...(userId?[id,userId]:[id])) as AccountRow|undefined;
  }
  accounts(userId?:string) { return this.db.prepare(`SELECT * FROM accounts${userId?' WHERE user_id=?':''} ORDER BY sort_order,name,id`).all(...(userId?[userId]:[])) as unknown as AccountRow[]; }
  message(id:string,userId:string) {
    return this.db.prepare('SELECT m.* FROM messages m JOIN accounts a ON a.id=m.account_id WHERE m.id=? AND a.user_id=?').get(id,userId) as MessageRow|undefined;
  }
  close() { this.db.close(); }
}
export function userDto(user:UserRow) { return {id:user.id,email:user.email,name:user.name}; }
export function accountDto(account:AccountRow,folders:FolderDto[],auth:{authType:'oauth'|'password';hasSeparateSmtpCredentials:boolean}) {
  return {id:account.id,name:account.name,email:account.email,color:account.color,provider:account.provider,username:account.username,smtpUsername:account.smtp_username,imap:{host:account.imap_host,port:account.imap_port,secure:!!account.imap_secure},smtp:{host:account.smtp_host,port:account.smtp_port,secure:!!account.smtp_secure},status:account.status,lastSyncedAt:account.last_synced_at,error:account.error,unread:account.unread,folders,...auth};
}
export function summaryDto(row:MessageRow) { return {...JSON.parse(row.summary),id:row.id,accountId:row.account_id,folder:row.folder,unread:!!row.unread,starred:!!row.starred}; }
