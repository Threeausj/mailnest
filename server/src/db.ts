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
  mail_cache_epoch?:string;
}
export interface MessageRow {
  id:string; account_id:string; folder:string; uid:number; uid_validity:string; summary:string;
  source:Uint8Array|null; detail:string|null; detail_cached_at?:number|null; unread:number; starred:number; date:string;
}
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
    `);
    const columns=this.db.prepare('PRAGMA table_info(messages)').all() as {name:string}[];
    if(!columns.some(column=>column.name==='detail_cached_at'))this.db.exec('ALTER TABLE messages ADD COLUMN detail_cached_at INTEGER');
    const folderColumns=this.db.prepare('PRAGMA table_info(folders)').all() as {name:string}[];
    if(!folderColumns.some(column=>column.name==='selectable'))this.db.exec('ALTER TABLE folders ADD COLUMN selectable INTEGER NOT NULL DEFAULT 1');
    const accountColumns=this.db.prepare('PRAGMA table_info(accounts)').all() as {name:string}[];
    if(!accountColumns.some(column=>column.name==='mail_cache_epoch'))this.db.exec("ALTER TABLE accounts ADD COLUMN mail_cache_epoch TEXT NOT NULL DEFAULT ''");
    // Old versions stored both complete MIME messages and decoded attachment bytes.
    // The remote mailbox remains the source of truth; keep only bounded body caches.
    this.db.exec("UPDATE messages SET source=NULL WHERE source IS NOT NULL; DELETE FROM attachments; UPDATE messages SET detail=NULL,detail_cached_at=NULL WHERE detail IS NOT NULL AND (json_extract(detail,'$.cacheVersion') IS NOT 2)");
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
  pruneMailCache() {
    this.db.prepare('UPDATE messages SET detail=NULL,detail_cached_at=NULL WHERE detail IS NOT NULL AND (detail_cached_at IS NULL OR detail_cached_at<?)').run(Date.now()-this.config.mailCacheTtlDays*86400_000);
    const rows=this.db.prepare('SELECT id,length(CAST(detail AS BLOB)) AS size FROM messages WHERE detail IS NOT NULL ORDER BY detail_cached_at ASC,id').all() as {id:string;size:number}[];
    let bytes=rows.reduce((sum,row)=>sum+row.size,0);
    for(const row of rows){if(bytes<=this.config.mailCacheMaxBytes)break;this.db.prepare('UPDATE messages SET detail=NULL,detail_cached_at=NULL WHERE id=?').run(row.id);bytes-=row.size;}
  }
  user(id:string) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow|undefined; }
  account(id:string,userId?:string) {
    return this.db.prepare(`SELECT * FROM accounts WHERE id=?${userId?' AND user_id=?':''}`).get(...(userId?[id,userId]:[id])) as AccountRow|undefined;
  }
  accounts(userId?:string) { return this.db.prepare(`SELECT * FROM accounts${userId?' WHERE user_id=?':''} ORDER BY name`).all(...(userId?[userId]:[])) as unknown as AccountRow[]; }
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
