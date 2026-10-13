import { ImapFlow, type MessageStructureObject, type FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Config } from './config.js';
import { Store, type AccountRow, type MessageRow, type FolderDto, type FolderKind, summaryDto } from './db.js';
import { ApiError, SecretBox, resolveMailHost, safeMailError } from './security.js';

export const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_NOTIFICATION_BODY_BYTES = 16 * 1024;
const NOTIFICATION_PREVIEW_TIMEOUT = 8_000;
const WARM_MESSAGE_TIMEOUT = 10_000;
const WARM_RETRY_DELAY = 3600_000;
export const INLINE_IMAGE_TYPES = new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp']);
interface CachedAttachment {id:string;filename:string;contentType:string;size:number;contentId:string|null;inline:boolean;part?:string;sourceIndex?:number;transferEncoding?:string}
interface CachedDetail {cacheVersion:2;text:string;html:string|null;messageId:string|null;attachments:CachedAttachment[];bodyTruncated:boolean}
export interface Credentials {password?:string;smtpPassword?:string;smtpSeparate?:boolean;oauth?:{accessToken:string;refreshToken:string;expiresAt:number}}
export interface AccountInput {name:string;email:string;color:string;provider:'gmail'|'imap';username:string;smtpUsername?:string;password:string;smtpPassword?:string;imap:{host:string;port:number;secure:boolean};smtp:{host:string;port:number;secure:boolean}}
export interface AccountUpdateInput {name?:string;email?:string;color?:string;username?:string;password?:string;smtpUsername?:string|null;smtpPassword?:string|null;imap?:{host:string;port:number;secure:boolean};smtp?:{host:string;port:number;secure:boolean}}
export interface SendInput {accountId:string;senderName?:string;to:string;cc?:string;bcc?:string;subject:string;text:string;inReplyTo?:string;references?:string;attachments?:{filename:string;contentType:string;content:string}[]}
export interface MailNotificationDetails {subject:string;preview:string;from:{name:string;address:string}}
function notificationText(value:string,limit:number) {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/gu,' ').trim()).slice(0,limit).join('');
}
async function notificationHtmlPreview(value:string) {
  // MailParser's skipImageLinks affects CID rewriting, not HTML-to-text images.
  // Remove image tags so tracking URLs cannot displace the actual message text.
  const html=Buffer.from(value).subarray(0,MAX_NOTIFICATION_BODY_BYTES).toString('utf8').replace(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi,' ');
  const parsed=await simpleParser(Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${html}`),{skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:MAX_NOTIFICATION_BODY_BYTES});
  return notificationText(parsed.text||'',200);
}
type Emit = (userId:string,event:string,data:unknown)=>void;
interface FolderRow {path:string;name:string;special_use:string|null;selectable?:number}
const logicalUse: Record<string,string> = {sent:'\\Sent',drafts:'\\Drafts',junk:'\\Junk',trash:'\\Trash',archive:'\\Archive',important:'\\Important'};
const fallbackNames: Record<string,string[]> = {
  sent:['sent','sent items','sent messages','已发送','已发送邮件','已发邮件','发件箱'],
  drafts:['drafts','draft','草稿','草稿箱'],
  junk:['junk','junk mail','spam','垃圾邮件','垃圾邮箱','垃圾箱'],
  trash:['trash','deleted items','deleted messages','bin','废纸篓','已删除','已删除邮件','回收站'],
  archive:['archive','archives','all mail','归档','所有邮件','全部邮件'],
  important:['important','重要','重要邮件'],
};
function hasFallbackName(folder:FolderRow,logical:string) {
  const names=fallbackNames[logical]||[];
  return names.includes(folder.name.toLowerCase())||names.includes(folder.path.toLowerCase())||names.includes(folder.path.split(/[\/]/).at(-1)!.toLowerCase());
}
export function folderKind(folder:FolderRow):FolderKind {
  if(folder.path.toUpperCase()==='INBOX')return 'inbox';
  for(const [logical,use] of Object.entries(logicalUse))if(folder.special_use?.toLowerCase()===use.toLowerCase())return logical as FolderKind;
  if(folder.special_use?.toLowerCase()==='\\all')return 'archive';
  for(const logical of Object.keys(logicalUse))if(hasFallbackName(folder,logical))return logical as FolderKind;
  return 'custom';
}
export function findFolder(folders:FolderRow[],logical:string):string|undefined {
  const inbox=logical==='INBOX'?folders.find(folder=>folder.path.toUpperCase()==='INBOX'):undefined;
  if(inbox?.selectable===0)return undefined;
  folders=folders.filter(folder=>folder.selectable!==0);
  if (logical === 'INBOX') return folders.find(f=>f.path.toUpperCase()==='INBOX')?.path || 'INBOX';
  if (!logicalUse[logical]) return folders.find(f=>f.path===logical)?.path;
  return folders.find(f=>f.special_use?.toLowerCase()===logicalUse[logical].toLowerCase())?.path || (logical==='archive'?folders.find(f=>f.special_use?.toLowerCase()==='\\all')?.path:undefined) || folders.find(f=>hasFallbackName(f,logical))?.path;
}
function addresses(value:unknown): {name:string;address:string}[] {
  if (!Array.isArray(value)) return [];
  return value.filter(a=>a?.address).map(a=>({name:String(a.name||''),address:String(a.address)}));
}
function hasAttachments(node:unknown):boolean {
  if (!node || typeof node !== 'object') return false;
  const n=node as {disposition?:string;dispositionParameters?:{filename?:string};parameters?:{name?:string};childNodes?:unknown[]};
  return n.disposition==='attachment'||!!n.dispositionParameters?.filename||!!n.parameters?.name||!!n.childNodes?.some(hasAttachments);
}
export function messageParts(structure:MessageStructureObject|undefined):{bodies:MessageStructureObject[];attachments:MessageStructureObject[]} {
  const bodies:MessageStructureObject[]=[],attachments:MessageStructureObject[]=[];
  const visit=(node:MessageStructureObject)=>{
    const type=node.type.toLowerCase(),filename=node.dispositionParameters?.filename||node.parameters?.name;
    if(node.disposition==='attachment'||filename||type==='message/rfc822'){attachments.push(node);return;}
    if(node.childNodes?.length){for(const child of node.childNodes)visit(child);return;}
    if(type==='text/plain'||type==='text/html')bodies.push(node);
    else if(!type.startsWith('multipart/'))attachments.push(node);
  };
  if(structure)visit(structure);
  return{bodies,attachments};
}
function detailDto(row:MessageRow,detail:CachedDetail) {
  return {...summaryDto(row),text:detail.text,html:detail.html,messageId:detail.messageId,bodyTruncated:detail.bodyTruncated,attachments:detail.attachments.map(({part,sourceIndex,transferEncoding,...attachment})=>attachment)};
}
function boundedGoogleFetch(url:string,init:RequestInit = {}) { return fetch(url,{...init,signal:AbortSignal.timeout(15_000)}); }
export async function googleToken(config:Config,values:Record<string,string>):Promise<{access_token:string;refresh_token?:string;expires_in:number}> {
  const response=await boundedGoogleFetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.googleClientId,client_secret:config.googleClientSecret,...values})});
  if (!response.ok) throw new ApiError(400,'GOOGLE_AUTH_FAILED','Google 授权已失效或被撤销，请重新连接 Google 邮箱。');
  const data=await response.json() as {access_token?:string;refresh_token?:string;expires_in?:number};
  if (!data.access_token || !data.expires_in) throw new ApiError(400,'GOOGLE_AUTH_FAILED','Google 返回的授权信息不完整，请重新授权。');
  return data as {access_token:string;refresh_token?:string;expires_in:number};
}
export async function googleIdentity(accessToken:string):Promise<{email:string;name:string}> {
  const response=await boundedGoogleFetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${accessToken}`}});
  const data=await response.json() as {email?:string;email_verified?:boolean;name?:string};
  if (!response.ok || !data.email || data.email_verified!==true) throw new ApiError(400,'GOOGLE_IDENTITY','Google 邮箱身份验证失败，请使用已验证的邮箱重新授权。');
  return {email:data.email.toLowerCase(),name:data.name||data.email};
}
export class MailService {
  private box:SecretBox;
  private queues = new Map<string,Promise<unknown>>();
  private scheduled = new Map<string,Promise<void>>();
  private activeClients = new Set<ImapFlow>();
  private timedOutClients = new WeakSet<ImapFlow>();
  private smtpClients = new Set<ReturnType<typeof nodemailer.createTransport>>();
  private stopped = false;
  private syncRunning=0;
  private syncWaiters:(()=>void)[]=[];
  private warming?:Promise<void>;
  private warmRequested=false;
  private warmPause?:{timer:ReturnType<typeof setTimeout>;resolve:()=>void};
  private bodyStreams=new Map<ImapFlow,Set<Readable>>();
  private activeWarmOperation?:{accountId:string;cancel:()=>void};
  private interruptedWarmClients=new WeakSet<ImapFlow>();
  constructor(private store:Store,private config:Config,private emit:Emit,private notify:(userId:string,accountId:string,count:number,notificationId?:string,details?:MailNotificationDetails)=>Promise<void>,private stageNotification?:(userId:string,accountId:string,count:number,notificationId:string,details?:MailNotificationDetails)=>void) { this.box=new SecretBox(config.encryptionKey); }
  private currentAccount(account:AccountRow):AccountRow {
    const current=this.store.account(account.id,account.user_id);
    if(!current)throw new ApiError(404,'NOT_FOUND','邮箱不存在。');
    return current;
  }
  private separateSmtp(account:AccountRow,credentials:Credentials) {
    return !credentials.oauth&&(credentials.smtpSeparate??(account.smtp_username!==account.username||!!credentials.smtpPassword&&credentials.smtpPassword!==credentials.password));
  }
  authInfo(account:AccountRow):{authType:'oauth'|'password';hasSeparateSmtpCredentials:boolean} {
    const credentials=this.box.decrypt<Credentials>(account.credentials);
    return{authType:credentials.oauth?'oauth':'password',hasSeparateSmtpCredentials:this.separateSmtp(account,credentials)};
  }
  private async serial<T>(id:string,operation:()=>Promise<T>,background=false):Promise<T> {
    if(!background&&this.activeWarmOperation?.accountId===id)this.activeWarmOperation.cancel();
    const prior=this.queues.get(id)||Promise.resolve();
    const next=prior.catch(()=>{}).then(()=>{if(this.stopped)throw new ApiError(503,'SHUTDOWN','服务正在关闭。');return operation();});
    this.queues.set(id,next);
    try{return await next;}finally{if(this.queues.get(id)===next)this.queues.delete(id);}
  }
  private async credentials(account:AccountRow):Promise<Credentials> {
    const credentials=this.box.decrypt<Credentials>(account.credentials);
    if (credentials.oauth && credentials.oauth.expiresAt < Date.now()+60_000) {
      const token=await googleToken(this.config,{grant_type:'refresh_token',refresh_token:credentials.oauth.refreshToken});
      credentials.oauth={accessToken:token.access_token,refreshToken:token.refresh_token||credentials.oauth.refreshToken,expiresAt:Date.now()+token.expires_in*1000};
      this.store.db.prepare('UPDATE accounts SET credentials=? WHERE id=?').run(this.box.encrypt(credentials),account.id);
    }
    return credentials;
  }
  private async withClient<T>(account:AccountRow,credentials:Credentials,work:(client:ImapFlow)=>Promise<T>):Promise<T> {
    const address=await resolveMailHost(account.imap_host,this.config.allowPrivateMailHosts);
    const client=new ImapFlow({host:address.address,port:account.imap_port,secure:!!account.imap_secure,doSTARTTLS:!account.imap_secure,auth:{user:account.username,...(credentials.oauth?{accessToken:credentials.oauth.accessToken}:{pass:credentials.password||''})},tls:{servername:account.imap_host,rejectUnauthorized:true,minVersion:'TLSv1.2'},logger:false,connectionTimeout:15_000,greetingTimeout:15_000,socketTimeout:20_000,disableAutoIdle:true,maxLiteralSize:MAX_MESSAGE_BYTES+1024,maxResponseSize:MAX_MESSAGE_BYTES+1024*1024,maxLineLength:1024*1024});
    client.on('error',()=>{});
    this.activeClients.add(client);
    let timeout:ReturnType<typeof setTimeout>;
    const expired=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{this.cancelClient(client);reject(new ApiError(504,'MAIL_TIMEOUT','邮箱操作超时，请稍后重试。'));},90_000);timeout.unref();});
    try{return await Promise.race([(async()=>{await client.connect();return work(client);})(),expired]);}
    finally{clearTimeout(timeout!);for(const stream of this.bodyStreams.get(client)||[])stream.destroy();client.close();this.activeClients.delete(client);}
  }
  private cancelClient(client:ImapFlow) {
    this.timedOutClients.add(client);
    for(const stream of this.bodyStreams.get(client)||[])stream.destroy();
    try{client.close();}catch{}
  }
  private assertReadable(client:ImapFlow) {
    if(this.stopped)throw new ApiError(503,'SHUTDOWN','服务正在关闭。');
    if(this.timedOutClients.has(client))throw new ApiError(504,'MAIL_TIMEOUT','邮箱操作超时，请稍后重试。');
  }
  private async smtp(account:AccountRow,credentials:Credentials) {
    const address=await resolveMailHost(account.smtp_host,this.config.allowPrivateMailHosts);
    const transport=nodemailer.createTransport({host:address.address,port:account.smtp_port,secure:!!account.smtp_secure,requireTLS:!account.smtp_secure,tls:{servername:account.smtp_host,rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:credentials.oauth?{type:'OAuth2',user:account.smtp_username,accessToken:credentials.oauth.accessToken}:{user:account.smtp_username,pass:credentials.smtpPassword||credentials.password||''},connectionTimeout:15_000,greetingTimeout:15_000,socketTimeout:25_000,logger:false,debug:false});
    this.smtpClients.add(transport);
    return transport;
  }
  private async boundedSmtp<T>(transport:ReturnType<typeof nodemailer.createTransport>,operation:()=>Promise<T>):Promise<T> {
    let timer:ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{transport.close();reject(new ApiError(504,'MAIL_TIMEOUT','SMTP 操作超时，请检查邮箱服务器后重试。'));},60_000);timer.unref();})]);
    }finally{clearTimeout(timer!);}
  }
  private closeSmtp(transport:ReturnType<typeof nodemailer.createTransport>) {transport.close();this.smtpClients.delete(transport);}
  async create(userId:string,input:AccountInput,oauth?:Credentials['oauth']) {
    if(this.store.accounts(userId).length>=20)throw new ApiError(400,'ACCOUNT_LIMIT','最多可连接 20 个邮箱。');
    if (this.store.db.prepare('SELECT id FROM accounts WHERE user_id=? AND lower(email)=?').get(userId,input.email.toLowerCase())) throw new ApiError(409,'ACCOUNT_EXISTS','此邮箱已连接。');
    const credentials:Credentials=oauth?{oauth}:{password:input.password,...(input.smtpUsername||input.smtpPassword?{smtpSeparate:true,smtpPassword:input.smtpPassword||input.password}:{})};
    const account:AccountRow={id:randomUUID(),user_id:userId,name:input.name,email:input.email.toLowerCase(),color:input.color,provider:input.provider,username:input.username,smtp_username:input.smtpUsername||input.username,imap_host:input.imap.host,imap_port:input.imap.port,imap_secure:Number(input.imap.secure),smtp_host:input.smtp.host,smtp_port:input.smtp.port,smtp_secure:Number(input.smtp.secure),credentials:this.box.encrypt(credentials),status:'connected',last_synced_at:null,error:null,unread:0};
    try {
      await this.withClient(account,credentials,async client=>{await client.list();});
      const smtp=await this.smtp(account,credentials);
      try{await this.boundedSmtp(smtp,()=>smtp.verify());}finally{this.closeSmtp(smtp);}
    }catch(error){throw error instanceof ApiError?error:new ApiError(400,'MAIL_CONNECTION_FAILED',safeMailError(error));}
    if (this.stopped) throw new ApiError(503,'SHUTDOWN','服务正在关闭。');
    this.store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM accounts WHERE user_id=?),0))').run(account.id,userId,account.name,account.email,account.color,account.provider,account.username,account.smtp_username,account.imap_host,account.imap_port,account.imap_secure,account.smtp_host,account.smtp_port,account.smtp_secure,account.credentials,userId);
    this.schedule(account.id);
    return account;
  }
  async update(account:AccountRow,input:AccountUpdateInput) {
    let syncNeeded=false;
    const result=await this.serial(account.id,async()=>{
      const current=this.currentAccount(account);
      const oldCredentials=this.box.decrypt<Credentials>(current.credentials);
      if(oldCredentials.oauth&&Object.keys(input).some(key=>!['name','color'].includes(key)))throw new ApiError(400,'OAUTH_SETTINGS_READ_ONLY','Google 授权邮箱仅支持修改名称和颜色；授权失效时请重新进行 Google 授权。');
      const clearSmtp=input.smtpUsername===null&&input.smtpPassword===null;
      if((input.smtpUsername===null||input.smtpPassword===null)&&!clearSmtp)throw new ApiError(400,'SMTP_CREDENTIALS_INVALID','改为共用登录凭据时需同时清除 SMTP 用户名和密码。');
      const wasSeparate=this.separateSmtp(current,oldCredentials);
      const separate=!oldCredentials.oauth&&!clearSmtp&&(wasSeparate||typeof input.smtpUsername==='string'||!!input.smtpPassword);
      const next:AccountRow={...current,name:input.name??current.name,color:input.color??current.color,email:input.email?.toLowerCase()??current.email,username:input.username??current.username,imap_host:input.imap?.host??current.imap_host,imap_port:input.imap?.port??current.imap_port,imap_secure:input.imap?Number(input.imap.secure):current.imap_secure,smtp_host:input.smtp?.host??current.smtp_host,smtp_port:input.smtp?.port??current.smtp_port,smtp_secure:input.smtp?Number(input.smtp.secure):current.smtp_secure};
      next.smtp_username=oldCredentials.oauth?current.smtp_username:separate?(input.smtpUsername||current.smtp_username):next.username;
      const credentials:Credentials=oldCredentials.oauth?oldCredentials:{password:input.password||oldCredentials.password,...(separate?{smtpSeparate:true,smtpPassword:input.smtpPassword||(wasSeparate?(oldCredentials.smtpPassword||oldCredentials.password):(input.password||oldCredentials.password))}:{})};
      if(this.store.db.prepare('SELECT id FROM accounts WHERE user_id=? AND lower(email)=? AND id<>?').get(current.user_id,next.email,next.id))throw new ApiError(409,'ACCOUNT_EXISTS','此邮箱已连接。');
      if(current.provider==='gmail'&&!oldCredentials.oauth&&(next.imap_host.toLowerCase()!=='imap.gmail.com'||next.smtp_host.toLowerCase()!=='smtp.gmail.com'||next.username.toLowerCase()!==next.email||next.smtp_username.toLowerCase()!==next.email))throw new ApiError(400,'GMAIL_SETTINGS','Google 邮箱需使用 imap.gmail.com / smtp.gmail.com，且用户名与邮箱地址一致。');
      const cacheReset=next.email.toLowerCase()!==current.email.toLowerCase()||next.username!==current.username||next.imap_host.toLowerCase()!==current.imap_host.toLowerCase();
      const connectionChanged=cacheReset||(['smtp_username','imap_port','imap_secure','smtp_host','smtp_port','smtp_secure'] as const).some(key=>next[key]!==current[key])||credentials.password!==oldCredentials.password||separate!==wasSeparate||(separate&&credentials.smtpPassword!==(oldCredentials.smtpPassword||oldCredentials.password));
      if(connectionChanged) {
        try {
          await this.withClient(next,credentials,async client=>{await client.list();});
          const smtp=await this.smtp(next,credentials);
          try{await this.boundedSmtp(smtp,()=>smtp.verify());}finally{this.closeSmtp(smtp);}
        }catch(error){throw error instanceof ApiError?error:new ApiError(400,'MAIL_CONNECTION_FAILED',safeMailError(error));}
      }
      if(this.stopped)throw new ApiError(503,'SHUTDOWN','服务正在关闭。');
      next.credentials=connectionChanged?this.box.encrypt(credentials):current.credentials;
      if(connectionChanged){next.status='connected';next.error=null;}
      if(cacheReset){next.unread=0;next.last_synced_at=null;next.mail_cache_epoch=randomUUID();}
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.db.prepare('UPDATE accounts SET name=?,email=?,color=?,username=?,smtp_username=?,imap_host=?,imap_port=?,imap_secure=?,smtp_host=?,smtp_port=?,smtp_secure=?,credentials=?,status=?,error=?,unread=?,last_synced_at=?,mail_cache_epoch=? WHERE id=? AND user_id=?').run(next.name,next.email,next.color,next.username,next.smtp_username,next.imap_host,next.imap_port,next.imap_secure,next.smtp_host,next.smtp_port,next.smtp_secure,next.credentials,next.status,next.error,next.unread,next.last_synced_at,next.mail_cache_epoch||'',next.id,next.user_id);
        if(cacheReset){this.store.db.prepare('DELETE FROM messages WHERE account_id=?').run(next.id);this.store.db.prepare('DELETE FROM folders WHERE account_id=?').run(next.id);}
        this.store.db.exec('COMMIT');
      }catch(error){this.store.db.exec('ROLLBACK');throw error;}
      syncNeeded=connectionChanged;
      this.emit(next.user_id,'sync',{accountId:next.id,status:next.status});
      return{account:next,cacheReset};
    });
    if(syncNeeded)this.schedule(account.id);
    return result;
  }
  async connectGoogle(userId:string,email:string,name:string,oauth:NonNullable<Credentials['oauth']>) {
    const existing=this.store.accounts(userId).find(a=>a.email===email);
    if(existing) {
      await this.serial(existing.id,async()=>{
        const current=this.currentAccount(existing);
        if(current.email!==email)throw new ApiError(409,'ACCOUNT_CHANGED','邮箱配置已变更，请重新发起 Google 授权。');
        const account={...current,provider:'gmail' as const,username:email,smtp_username:email,imap_host:'imap.gmail.com',imap_port:993,imap_secure:1,smtp_host:'smtp.gmail.com',smtp_port:465,smtp_secure:1};
        await this.withClient(account,{oauth},async()=>{});
        const smtp=await this.smtp(account,{oauth});try{await this.boundedSmtp(smtp,()=>smtp.verify());}finally{this.closeSmtp(smtp);}
        const cacheReset=current.username!==email||current.imap_host.toLowerCase()!=='imap.gmail.com';
        this.store.db.exec('BEGIN IMMEDIATE');
        try {
          this.store.db.prepare("UPDATE accounts SET provider='gmail',username=?,smtp_username=?,imap_host='imap.gmail.com',imap_port=993,imap_secure=1,smtp_host='smtp.gmail.com',smtp_port=465,smtp_secure=1,credentials=?,status='connected',error=NULL,mail_cache_epoch=?,unread=?,last_synced_at=? WHERE id=?").run(email,email,this.box.encrypt({oauth}),cacheReset?randomUUID():current.mail_cache_epoch||'',cacheReset?0:current.unread,cacheReset?null:current.last_synced_at,existing.id);
          if(cacheReset){this.store.db.prepare('DELETE FROM messages WHERE account_id=?').run(existing.id);this.store.db.prepare('DELETE FROM folders WHERE account_id=?').run(existing.id);}
          this.store.db.exec('COMMIT');
        }catch(error){this.store.db.exec('ROLLBACK');throw error;}
      });
      this.schedule(existing.id);return this.currentAccount(existing);
    }
    return this.create(userId,{name,email,color:'#ef4444',provider:'gmail',username:email,password:'',imap:{host:'imap.gmail.com',port:993,secure:true},smtp:{host:'smtp.gmail.com',port:465,secure:true}},oauth);
  }
  folderRows(accountId:string) {return this.store.db.prepare('SELECT path,name,special_use,selectable FROM folders WHERE account_id=? ORDER BY path').all(accountId) as unknown as FolderRow[];}
  cachedFolders(accountId:string):FolderDto[] {
    return this.folderRows(accountId).map(folder=>({path:folder.path,name:folder.name,specialUse:folder.special_use,selectable:folder.selectable!==0,kind:folderKind(folder)}));
  }
  private saveFolders(account:AccountRow,folders:{path:string;name:string;specialUse?:string;flags?:Set<string>}[]) {
    const save=this.store.db.prepare('INSERT INTO folders(account_id,path,name,special_use,selectable) VALUES(?,?,?,?,?) ON CONFLICT(account_id,path) DO UPDATE SET name=excluded.name,special_use=excluded.special_use,selectable=excluded.selectable WHERE folders.name<>excluded.name OR folders.special_use IS NOT excluded.special_use OR folders.selectable<>excluded.selectable');
    const paths=new Set(folders.map(f=>f.path));
    for(const old of this.folderRows(account.id))if(!paths.has(old.path)) {
      this.store.db.prepare('DELETE FROM messages WHERE account_id=? AND folder=?').run(account.id,old.path);
      this.store.db.prepare('DELETE FROM folders WHERE account_id=? AND path=?').run(account.id,old.path);
    }
    for(const f of folders)save.run(account.id,f.path,f.name,f.specialUse||null,Number(!f.flags?.has('\\Noselect')));
  }
  async listFolders(account:AccountRow) {
    return this.cachedFolders(account.id);
  }
  schedule(accountId:string):void {
    if(this.stopped||this.scheduled.has(accountId))return;
    const promise=this.acquireSync().then(()=>this.sync(accountId)).catch(()=>{}).finally(()=>{this.syncRunning--;this.syncWaiters.shift()?.();this.scheduled.delete(accountId);if(!this.stopped){this.store.pruneMailCache();this.scheduleWarm();}});
    this.scheduled.set(accountId,promise);
  }
  private async acquireSync() {if(this.syncRunning>=2)await new Promise<void>(resolve=>this.syncWaiters.push(resolve));this.syncRunning++;}
  async waitForSync() {await Promise.all(this.scheduled.values());}
  /** Explicit force is useful for controlled protocol tests; ordinary triggers honor background=false. */
  scheduleWarm(force=false):void {
    if(this.stopped||!force&&!this.config.background)return;
    this.warmRequested=true;
    if(this.warming)return;
    this.warming=Promise.resolve().then(()=>this.warmCache()).catch(()=>{}).finally(()=>{this.warming=undefined;if(this.warmRequested&&!this.stopped)this.scheduleWarm(force);});
  }
  async waitForWarm() {while(this.warming)await this.warming;}
  private async yieldWarm() {
    await new Promise<void>(resolve=>{const timer=setTimeout(()=>{this.warmPause=undefined;resolve();},50);this.warmPause={timer,resolve};});
  }
  private async boundedWarm<T>(accountId:string,client:ImapFlow,work:()=>Promise<T>):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    const interrupted=new Promise<never>((_,reject)=>{this.activeWarmOperation={accountId,cancel:()=>{this.interruptedWarmClients.add(client);this.cancelClient(client);reject(new ApiError(409,'WARM_INTERRUPTED','前台操作优先。'));}};});
    try{return await Promise.race([work(),interrupted,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{this.cancelClient(client);reject(new ApiError(504,'MAIL_TIMEOUT','正文预热超时。'));},WARM_MESSAGE_TIMEOUT);timer.unref();})]);}
    finally{if(timer)clearTimeout(timer);this.activeWarmOperation=undefined;}
  }
  private async warmCache() {
    while(!this.stopped) {
      const refreshTargets=this.warmRequested;
      this.warmRequested=false;
      this.store.pruneMailCache(refreshTargets);
      const now=Date.now(),targets=this.store.admittedMailCacheTargets();
      const candidates=targets.filter(row=>!row.has_detail&&row.detail_retry_at<=now);
      if(!candidates.length)return;
      const first=candidates.find(row=>!this.queues.has(row.account_id)&&!this.scheduled.has(row.account_id));
      if(!first){await this.yieldWarm();continue;}
      const batch=candidates.filter(row=>row.account_id===first.account_id).slice(0,5);
      let account=this.store.account(first.account_id,first.user_id);if(!account)continue;
      try {
        const credentials=await this.serial(account.id,async()=>{account=this.currentAccount(account!);const credentials=await this.credentials(account);account=this.currentAccount(account);return credentials;},true);
        if(this.queues.has(account.id)||this.scheduled.has(account.id))continue;
        const snapshot=account;
        await this.withClient(snapshot,credentials,async client=>{
          for(const target of batch) {
            // Each message owns only one short account operation. A waiting read,
            // mutation or metadata sync runs before the next background message.
            if(this.stopped||this.queues.has(snapshot.id)||this.scheduled.has(snapshot.id))break;
            try {
              await this.serial(snapshot.id,()=>this.boundedWarm(snapshot.id,client,async()=>{
                const current=this.currentAccount(snapshot),row=this.store.message(target.id,snapshot.user_id);
                if(current.credentials!==snapshot.credentials||current.mail_cache_epoch!==snapshot.mail_cache_epoch||current.imap_host!==snapshot.imap_host||current.imap_port!==snapshot.imap_port||current.imap_secure!==snapshot.imap_secure||current.username!==snapshot.username){this.interruptedWarmClients.add(client);this.cancelClient(client);throw new ApiError(409,'WARM_INTERRUPTED','邮箱配置已更新。');}
                if(!row||!row.cache_priority||this.cachedDetail(row,false)||!this.store.canWarmMail(row))return;
                this.assertReadable(client);
                const lock=await client.getMailboxLock(row.folder,{readOnly:true});
                try {
                  this.assertReadable(client);
                  if(!client.mailbox||client.mailbox.uidValidity?.toString()!==row.uid_validity)throw new ApiError(409,'STALE_MESSAGE','邮箱目录已更新。');
                  const detail=await this.readDetail(client,row,false);
                  if(!detail){this.store.db.prepare('UPDATE messages SET detail_retry_at=? WHERE id=?').run(Date.now()+86400_000,row.id);return;}
                  this.persistDetail(snapshot,row,client,detail);
                }finally{lock.release();}
              }),true);
            }catch {
              if(!this.stopped&&!this.interruptedWarmClients.has(client))this.store.db.prepare('UPDATE messages SET detail_retry_at=MAX(detail_retry_at,?) WHERE id=? AND detail IS NULL').run(Date.now()+WARM_RETRY_DELAY,target.id);
              if(this.timedOutClients.has(client)||client.usable===false)break;
            }
          }
        });
      }catch {
        // Background failures do not change connection status or consume a new-mail baseline.
        if(!this.stopped)this.store.db.prepare('UPDATE messages SET detail_retry_at=MAX(detail_retry_at,?) WHERE account_id=? AND cache_priority>0 AND detail IS NULL').run(Date.now()+WARM_RETRY_DELAY,first.account_id);
      }
      // Give work queued by events or HTTP requests a turn even on a fast LAN.
      if(!this.stopped)await this.yieldWarm();
    }
  }
  private async notificationDetails(client:ImapFlow,message:FetchMessageObject):Promise<MailNotificationDetails> {
    const from=addresses(message.envelope?.from)[0]||{name:'',address:''};
    const details:MailNotificationDetails={subject:notificationText(message.envelope?.subject||'(无主题)',120)||'(无主题)',preview:'',from:{name:notificationText(from.name,80),address:notificationText(from.address,254)}};
    let content:Readable|undefined,timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
    const parseOptions={skipTextToHtml:true,skipHtmlToText:true,skipImageLinks:true,maxHtmlLengthToParse:MAX_NOTIFICATION_BODY_BYTES};
    const extract=(async()=>{
      if(message.bodyStructure) {
        const bodies=messageParts(message.bodyStructure).bodies;
        const part=bodies.find(part=>part.type.toLowerCase()==='text/plain')||bodies.find(part=>part.type.toLowerCase()==='text/html');
        if(!part)return '';
        const download=await client.download(message.uid,part.part||'1',{uid:true,maxBytes:MAX_NOTIFICATION_BODY_BYTES,chunkSize:8*1024});
        if(timedOut){download.content?.destroy();return '';}
        if(!download.content)return '';
        content=download.content;
        const chunks:Buffer[]=[];let bytes=0;
        try {
          for await(const chunk of content) {
            const buffer=Buffer.from(chunk),remaining=MAX_NOTIFICATION_BODY_BYTES-bytes;
            chunks.push(buffer.subarray(0,remaining));bytes+=Math.min(buffer.length,remaining);
            if(bytes>=MAX_NOTIFICATION_BODY_BYTES)break;
          }
        }finally{content.destroy();}
        const body=Buffer.concat(chunks,bytes).toString('utf8');
        if(part.type.toLowerCase()==='text/plain')return notificationText(body,200);
        return notificationHtmlPreview(body);
      }
      // A missing BODYSTRUCTURE is not permission to download attachments. Only
      // fetch a bounded TEXT prefix after confirming a standalone textual body.
      const header=await client.fetchOne(message.uid,{headers:['Content-Type','Content-Transfer-Encoding','Content-Disposition']},{uid:true});
      if(timedOut||!header||!header.headers)return '';
      const headers=header.headers.subarray(0,4096);
      const parsedHeaders=await simpleParser(headers,parseOptions);
      const type=parsedHeaders.headers.get('content-type') as {value?:string}|undefined;
      const disposition=parsedHeaders.headers.get('content-disposition') as {value?:string}|undefined;
      if(disposition?.value?.toLowerCase()==='attachment'||!['text/plain','text/html'].includes(type?.value?.toLowerCase()||'text/plain'))return '';
      if(timedOut)return '';
      const body=await client.fetchOne(message.uid,{bodyParts:[{key:'TEXT',start:0,maxLength:MAX_NOTIFICATION_BODY_BYTES}]},{uid:true});
      if(timedOut||!body)return '';
      const prefix=body.bodyParts?.get('text')||body.bodyParts?.get('TEXT');
      if(!prefix)return '';
      const parsed=await simpleParser(Buffer.concat([headers,Buffer.from('\r\n\r\n'),prefix.subarray(0,MAX_NOTIFICATION_BODY_BYTES)]),parseOptions);
      return typeof parsed.html==='string'?notificationHtmlPreview(parsed.html):notificationText(parsed.text||'',200);
    })();
    try {
      details.preview=await Promise.race([extract,new Promise<string>(resolve=>{timer=setTimeout(()=>{timedOut=true;content?.destroy();try{client.close();}catch{}resolve('');},NOTIFICATION_PREVIEW_TIMEOUT);timer.unref();})]);
    }catch { /* Metadata still supplies a useful notification when its body cannot be read. */ }
    finally {if(timer)clearTimeout(timer);content?.destroy();}
    return details;
  }
  private async sync(id:string) {
    return this.serial(id,async()=>{
      const account=this.store.account(id);if(!account)return;
      this.store.db.prepare("UPDATE accounts SET status='syncing',error=NULL WHERE id=?").run(id);this.emit(account.user_id,'sync',{accountId:id,status:'syncing'});
      let newMail=0,completed=0;
      let notificationDetails:MailNotificationDetails|undefined;
      const notificationId=randomUUID();
      const failures:string[]=[];
      try {
        const credentials=await this.credentials(account);
        await this.withClient(account,credentials,async client=>{
          const folders=await client.list();this.saveFolders(account,folders);
          const rows=this.folderRows(id);
          const primary=[...new Set([...['INBOX','sent','trash','archive'].map(f=>findFolder(rows,f)).filter((f):f is string=>!!f),...folders.filter(f=>!f.flags.has('\\Noselect')).map(f=>f.path)])];
          if(primary.length>100)throw new ApiError(400,'FOLDER_LIMIT','邮箱目录超过 100 个同步上限，请整理远端目录。');
          for(const path of primary) {
            let lock:Awaited<ReturnType<ImapFlow['getMailboxLock']>>|undefined;
            try {
              lock=await client.getMailboxLock(path,{readOnly:true});
              const mailbox=client.mailbox;if(!mailbox)continue;
              if(mailbox.uidValidity===undefined||mailbox.uidValidity===null) {
                const cached=this.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=? AND folder=?').get(id,path) as {n:number};
                // QQ advertises the virtual "其他文件夹" container as selectable, but
                // returns neither UIDVALIDITY nor UIDNEXT. Its children are real folders.
                if(mailbox.exists===0&&mailbox.uidNext===undefined&&cached.n===0) {
                  this.store.db.prepare('UPDATE folders SET selectable=0 WHERE account_id=? AND path=?').run(id,path);
                  continue;
                }
                throw new ApiError(409,'MISSING_UID_VALIDITY','该目录未返回有效的邮件编号信息，已保留原有缓存。');
              }
              const validity=mailbox.uidValidity.toString();
              // Establish an INBOX baseline only after its own successful fetch.
              // Other folders can sync first, and a UIDVALIDITY reset renumbers
              // existing mail; neither should turn old inbox contents into alerts.
              const previous=this.store.db.prepare('SELECT f.uid_validity,COALESCE((SELECT MAX(m.uid) FROM messages m WHERE m.account_id=f.account_id AND m.folder=f.path AND m.uid_validity=?),0) AS max_uid FROM folders f WHERE f.account_id=? AND f.path=?').get(validity,id,path) as {uid_validity:string|null;max_uid:number}|undefined;
              const notifyNewMail=path.toUpperCase()==='INBOX'&&previous?.uid_validity===validity;
              const previousMaxUid=previous?.max_uid||0;
              const metadata={uid:true,envelope:true,flags:true,internalDate:true,bodyStructure:true,size:true};
              const fetched=mailbox.exists?await client.fetchAll(`${Math.max(1,mailbox.exists-this.config.syncMessageLimit+1)}:*`,metadata):[];
              if(fetched.length<Math.min(mailbox.exists,this.config.syncMessageLimit))throw new ApiError(409,'INCOMPLETE_FETCH','目录返回的邮件列表不完整，已保留原有缓存，下次同步将重试。');
              const recentUids=new Set(fetched.map(message=>message.uid));
              const latest=notifyNewMail?fetched.reduce<FetchMessageObject|undefined>((latest,message)=>message.uid>previousMaxUid&&(!latest||message.uid>latest.uid)?message:latest,undefined):undefined;
              const folderNotification=latest?await this.notificationDetails(client,latest):undefined;
              let preserveStarred=false;
              try {
                const flagged=mailbox.exists?await client.search({flagged:true},{uid:true}):[];
                if(!Array.isArray(flagged))throw new Error('Missing flagged UID search result');
                const extra=[...new Set(flagged.filter(uid=>Number.isSafeInteger(uid)&&uid>0&&!recentUids.has(uid)))];
                for(let start=0;start<extra.length;start+=200) {
                  const uids=extra.slice(start,start+200);
                  const messages=await client.fetchAll(uids.join(','),metadata,{uid:true});
                  if(messages.length!==uids.length)throw new ApiError(409,'INCOMPLETE_FETCH','星标邮件列表不完整，下次同步将重试。');
                  fetched.push(...messages);
                }
              }catch(error) {
                // A failed extra search must not erase older stars or prevent an
                // otherwise complete recent INBOX from publishing its arrivals.
                preserveStarred=true;failures.push(`${path.slice(0,100)} 星标：${safeMailError(error)}`);
              }
              if(this.stopped)throw new ApiError(503,'SHUTDOWN','服务正在关闭。');
              if(this.timedOutClients.has(client))throw new ApiError(504,'MAIL_TIMEOUT','邮箱操作超时，请稍后重试。');
              const seen=new Set<string>();
              let folderNewMail=0;
              this.store.db.exec('BEGIN IMMEDIATE');
              try{for(const message of fetched) {
                const messageNamespace=account.mail_cache_epoch?`${id}\0${account.mail_cache_epoch}`:id;
                const messageId=createHash('sha256').update(`${messageNamespace}\0${path}\0${validity}\0${message.uid}`).digest('hex');seen.add(messageId);
                const old=this.store.db.prepare('SELECT id,summary FROM messages WHERE id=?').get(messageId) as {id:string;summary:string}|undefined;
                const envelope=message.envelope;
                const dateValue=new Date(envelope?.date||message.internalDate||Date.now());
                const date=Number.isNaN(dateValue.getTime())?new Date().toISOString():dateValue.toISOString();
                const summary={from:addresses(envelope?.from)[0]||{name:'',address:''},to:addresses(envelope?.to),cc:addresses(envelope?.cc),subject:envelope?.subject||'(无主题)',preview:message.uid===latest?.uid?folderNotification?.preview||'':old?JSON.parse(old.summary).preview||'':'',date,hasAttachments:hasAttachments(message.bodyStructure),size:message.size};
                const unread=!message.flags?.has('\\Seen'),starred=!!message.flags?.has('\\Flagged');
                this.store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,unread=excluded.unread,starred=excluded.starred,date=excluded.date WHERE messages.summary<>excluded.summary OR messages.unread<>excluded.unread OR messages.starred<>excluded.starred OR messages.date<>excluded.date').run(messageId,id,path,message.uid,validity,JSON.stringify(summary),Number(unread),Number(starred),date);
                // A phone or another mail client may mark the new message read
                // before this poll; its arrival should still trigger the alert.
                // Lower UIDs can re-enter the bounded cache after newer mail is
                // deleted; only UIDs above the pre-fetch maximum are arrivals.
                if(!old&&notifyNewMail&&recentUids.has(message.uid)&&message.uid>previousMaxUid)folderNewMail++;
              }
              const cached=this.store.db.prepare('SELECT id,starred,uid_validity FROM messages WHERE account_id=? AND folder=?').all(id,path) as {id:string;starred:number;uid_validity:string}[];
              for(const item of cached)if(!seen.has(item.id)&&!(preserveStarred&&item.starred&&item.uid_validity===validity))this.store.db.prepare('DELETE FROM messages WHERE id=?').run(item.id);
              this.store.db.prepare('UPDATE folders SET uid_validity=? WHERE account_id=? AND path=? AND uid_validity IS NOT ?').run(validity,id,path,validity);
              // Persist the arrival intent with its INBOX cache update. A shutdown
              // while syncing later folders must not consume the new UID silently.
              if(folderNewMail>0)this.stageNotification?.(account.user_id,id,folderNewMail,notificationId,folderNotification);
              this.store.db.exec('COMMIT');
              }catch(error){this.store.db.exec('ROLLBACK');throw error;}
              newMail+=folderNewMail;
              if(folderNewMail>0)notificationDetails=folderNotification;
              completed++;
              if(path.toUpperCase()==='INBOX') {
                const status=await client.status(path,{unseen:true});this.store.db.prepare('UPDATE accounts SET unread=? WHERE id=?').run((status && status.unseen)||0,id);
              }
            }catch(error){
              failures.push(`${path.slice(0,100)}：${safeMailError(error)}`);
              if(!client.usable)throw error;
            }finally{lock?.release();}
          }
        });
        const status=failures.length?(completed?'partial':'error'):'connected';
        const error=failures.length?`部分目录同步未完成（${failures.length} 个）：${failures.slice(0,3).join('；')}`:null;
        this.store.db.prepare('UPDATE accounts SET status=?,error=?,last_synced_at=? WHERE id=?').run(status,error,completed?new Date().toISOString():account.last_synced_at,id);this.emit(account.user_id,'sync',{accountId:id,status});
        if(newMail>0){this.emit(account.user_id,'mail',{accountId:id,count:newMail,notificationId,...(notificationDetails?{notification:notificationDetails}:{})});await this.notify(account.user_id,id,newMail,notificationId,notificationDetails);}
      }catch(error){
        if(this.stopped)return;
        const status=completed?'partial':'error';
        this.store.db.prepare('UPDATE accounts SET status=?,error=?,last_synced_at=? WHERE id=?').run(status,safeMailError(error),completed?new Date().toISOString():account.last_synced_at,id);this.emit(account.user_id,'sync',{accountId:id,status});
        if(newMail>0){this.emit(account.user_id,'mail',{accountId:id,count:newMail,notificationId,...(notificationDetails?{notification:notificationDetails}:{})});await this.notify(account.user_id,id,newMail,notificationId,notificationDetails);}
      }
    });
  }
  private async locked<T>(account:AccountRow,row:MessageRow,work:(client:ImapFlow)=>Promise<T>) {
    account=this.currentAccount(account);
    if(!this.store.message(row.id,account.user_id))throw new ApiError(404,'NOT_FOUND','邮件不存在，请重新同步。');
    return this.withClient(account,await this.credentials(account),async client=>{
      const lock=await client.getMailboxLock(row.folder);
      try {
        if(!client.mailbox || client.mailbox.uidValidity===undefined||client.mailbox.uidValidity===null||client.mailbox.uidValidity.toString()!==row.uid_validity)throw new ApiError(409,'STALE_MESSAGE','邮箱目录已更新，请重新同步后再操作。');
        return await work(client);
      }finally{lock.release();}
    });
  }
  private cachedDetail(row:MessageRow,touch=true):CachedDetail|undefined {
    if(!row.detail||!row.detail_cached_at||!row.starred&&!row.cache_priority&&row.detail_cached_at<Date.now()-this.config.mailCacheTtlDays*86400_000)return;
    const detail=JSON.parse(row.detail) as CachedDetail;
    if(detail.cacheVersion!==2)return;
    if(touch)this.store.db.prepare('UPDATE messages SET detail_cached_at=? WHERE id=?').run(Date.now(),row.id);
    return detail;
  }
  private async downloadPart(client:ImapFlow,uid:number,part:string|undefined,limit:number):Promise<Buffer> {
    this.assertReadable(client);
    const download=await client.download(uid,part,{uid:true,maxBytes:limit+1,chunkSize:64*1024});
    if(!download.content)throw new ApiError(404,'NOT_FOUND','远端邮件内容不存在，请重新同步。');
    if(this.stopped||this.timedOutClients.has(client)){download.content.destroy();this.assertReadable(client);}
    const streams=this.bodyStreams.get(client)||new Set<Readable>();this.bodyStreams.set(client,streams);streams.add(download.content);
    const chunks:Buffer[]=[];let bytes=0;
    try{
      for await(const chunk of download.content){const buffer=Buffer.from(chunk),remaining=limit+1-bytes;chunks.push(buffer.subarray(0,remaining));bytes+=Math.min(buffer.length,remaining);if(bytes>=limit+1)break;}
      this.assertReadable(client);
      return Buffer.concat(chunks,bytes);
    }finally{download.content.destroy();streams.delete(download.content);if(!streams.size)this.bodyStreams.delete(client);}
  }
  private async readDetail(client:ImapFlow,cached:MessageRow,allowFallback=true):Promise<CachedDetail|undefined> {
    this.assertReadable(client);
    const message=await client.fetchOne(cached.uid,{bodyStructure:true,envelope:true,size:true},{uid:true});
    this.assertReadable(client);
    if(!message)throw new ApiError(404,'NOT_FOUND','远端邮件已删除，请重新同步。');
    let detail:CachedDetail;
    if(message.bodyStructure) {
      const parts=messageParts(message.bodyStructure);
      const attachments=parts.attachments.slice(0,100).map((part,index):CachedAttachment=>({id:`${cached.id}-${index}`,filename:part.dispositionParameters?.filename||part.parameters?.name||`attachment-${index+1}`,contentType:part.type.toLowerCase(),size:part.size||0,contentId:part.id?.trim().replace(/^<|>$/g,'')||null,inline:part.disposition!=='attachment'&&(part.disposition==='inline'||!!part.id),part:part.part||'1',transferEncoding:part.encoding?.toLowerCase()}));
      const text:string[]=[],html:string[]=[];let bodyTruncated=parts.bodies.length>16||parts.attachments.length>100;
      let textBytes=0,htmlBytes=0;
      for(const part of parts.bodies.slice(0,16)) {
        const isHtml=part.type.toLowerCase()==='text/html',remaining=(isHtml?MAX_BODY_BYTES-htmlBytes:MAX_TEXT_BYTES-textBytes);
        if(remaining<=0){bodyTruncated=true;continue;}
        // ImapFlow decodes MIME transfer encodings and text charsets to UTF-8.
        const body=await this.downloadPart(client,cached.uid,part.part||'1',remaining);
        const bounded=body.subarray(0,remaining);if(body.length>remaining)bodyTruncated=true;
        (isHtml?html:text).push(bounded.toString('utf8'));
        if(isHtml)htmlBytes+=bounded.length;else textBytes+=bounded.length;
      }
      detail={cacheVersion:2,text:text.join('\n'),html:html.length?html.join('\n'):null,messageId:message.envelope?.messageId||null,attachments,bodyTruncated};
      if(!detail.text&&detail.html){const parsed=await simpleParser(Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${detail.html}`),{skipImageLinks:true,maxHtmlLengthToParse:MAX_BODY_BYTES});const text=Buffer.from(parsed.text||'');detail.text=text.subarray(0,MAX_TEXT_BYTES).toString('utf8');if(text.length>MAX_TEXT_BYTES)detail.bodyTruncated=true;}
    } else {
      if(!allowFallback)return;
      // Some servers omit BODYSTRUCTURE. Use a bounded compatibility fallback,
      // without persisting the MIME source or decoded attachment payloads.
      if((message.size||0)>MAX_MESSAGE_BYTES)throw new ApiError(413,'MESSAGE_TOO_LARGE','服务器未提供邮件结构，且整封邮件超过 30 MiB，请在原邮箱客户端查看。');
      const source=await this.downloadPart(client,cached.uid,undefined,MAX_MESSAGE_BYTES);
      if(source.length>MAX_MESSAGE_BYTES)throw new ApiError(413,'MESSAGE_TOO_LARGE','邮件超过 30 MiB 在线查看上限。');
      const parsed=await simpleParser(source,{skipHtmlToText:false,skipImageLinks:true,maxHtmlLengthToParse:MAX_BODY_BYTES});
      const text=Buffer.from(parsed.text||''),html=parsed.html?Buffer.from(parsed.html):null;
      detail={cacheVersion:2,text:text.subarray(0,MAX_TEXT_BYTES).toString('utf8'),html:html?.subarray(0,MAX_BODY_BYTES).toString('utf8')||null,messageId:parsed.messageId||null,bodyTruncated:text.length>MAX_TEXT_BYTES||(html?.length||0)>MAX_BODY_BYTES||parsed.attachments.length>100,attachments:parsed.attachments.slice(0,100).map((a,index)=>({id:`${cached.id}-${index}`,filename:a.filename||`attachment-${index+1}`,contentType:a.contentType,size:a.size,contentId:a.contentId?.trim().replace(/^<|>$/g,'')||null,inline:a.contentDisposition!=='attachment'&&(a.contentDisposition==='inline'||!!a.contentId),sourceIndex:index}))};
    }
    this.assertReadable(client);
    return detail;
  }
  private persistDetail(account:AccountRow,cached:MessageRow,client:ImapFlow,detail:CachedDetail) {
    this.assertReadable(client);
    const current=this.currentAccount(account),fresh=this.store.message(cached.id,account.user_id);
    if(current.mail_cache_epoch!==account.mail_cache_epoch||current.username!==account.username||current.imap_host!==account.imap_host||current.imap_port!==account.imap_port||current.imap_secure!==account.imap_secure||!fresh||fresh.uid_validity!==cached.uid_validity||fresh.uid!==cached.uid||fresh.folder!==cached.folder)throw new ApiError(409,'STALE_MESSAGE','邮箱或邮件已更新，请重新同步。');
    const summary=JSON.stringify({...JSON.parse(fresh.summary),preview:detail.text.replace(/\s+/g,' ').slice(0,180),hasAttachments:detail.attachments.some(attachment=>!attachment.inline)});
    const serialized=JSON.stringify(detail),detailCachedAt=Date.now();
    this.store.db.prepare('UPDATE messages SET summary=?,source=NULL,detail=?,detail_cached_at=?,detail_size_bytes=?,detail_retry_at=0 WHERE id=?').run(summary,serialized,detailCachedAt,Buffer.byteLength(serialized),fresh.id);
    this.store.pruneMailCache(false);
    return{row:{...fresh,summary,detail:serialized,detail_cached_at:detailCachedAt},detail};
  }
  private async loadDetail(account:AccountRow,row:MessageRow):Promise<{row:MessageRow;detail:CachedDetail}> {
    const ready=this.cachedDetail(row);if(ready)return{row,detail:ready};
    return this.serial(account.id,async()=>{
      account=this.currentAccount(account);
      const cached=this.store.message(row.id,account.user_id);if(!cached)throw new ApiError(404,'NOT_FOUND','邮件不存在。');
      const ready=this.cachedDetail(cached);if(ready)return{row:cached,detail:ready};
      return this.locked(account,cached,async client=>{
        const detail=await this.readDetail(client,cached);
        return this.persistDetail(account,cached,client,detail!);
      });
    });
  }
  async detail(account:AccountRow,row:MessageRow) {const loaded=await this.loadDetail(account,row);return detailDto(loaded.row,loaded.detail);}
  async attachment(account:AccountRow,row:MessageRow,id:string,inline=false) {
    const {detail}=await this.loadDetail(account,row);
    const attachment=detail.attachments.find(item=>item.id===id);if(!attachment)throw new ApiError(404,'NOT_FOUND','附件不存在。');
    if(inline&&!INLINE_IMAGE_TYPES.has(attachment.contentType))throw new ApiError(415,'UNSUPPORTED_INLINE_TYPE','此附件不支持作为内嵌图片显示。');
    if(attachment.size>MAX_MESSAGE_BYTES&&!['base64','quoted-printable'].includes(attachment.transferEncoding||''))throw new ApiError(413,'ATTACHMENT_TOO_LARGE','附件超过 30 MiB 在线下载上限。');
    return this.serial(account.id,async()=>this.locked(account,row,async client=>{
      let content:Buffer;
      if(attachment.part)content=await this.downloadPart(client,row.uid,attachment.part,MAX_MESSAGE_BYTES);
      else {
        const source=await this.downloadPart(client,row.uid,undefined,MAX_MESSAGE_BYTES);
        if(source.length>MAX_MESSAGE_BYTES)throw new ApiError(413,'ATTACHMENT_TOO_LARGE','附件超过 30 MiB 在线下载上限。');
        const parsed=await simpleParser(source,{skipHtmlToText:true,skipImageLinks:true});
        const item=parsed.attachments[attachment.sourceIndex!];if(!item)throw new ApiError(404,'NOT_FOUND','远端附件不存在，请重新同步。');content=item.content;
      }
      if(content.length>MAX_MESSAGE_BYTES)throw new ApiError(413,'ATTACHMENT_TOO_LARGE','附件超过 30 MiB 在线下载上限。');
      return{...attachment,content};
    }));
  }
  private async refreshInboxUnread(account:AccountRow,client:ImapFlow,path:string,delta:number) {
    // Update from the cache state inside the account queue, so concurrent devices
    // repeating the same flag change cannot apply its unread delta twice.
    this.store.db.prepare('UPDATE accounts SET unread=MAX(0,unread+?) WHERE id=?').run(delta,account.id);
    try {
      const status=await client.status(path,{unseen:true});
      const unseen=status&&status.unseen;
      if(typeof unseen!=='number'||!Number.isSafeInteger(unseen)||unseen<0)throw new Error('Missing inbox unread count');
      this.store.db.prepare('UPDATE accounts SET unread=? WHERE id=?').run(unseen,account.id);
    }catch {
      // The remote mutation already succeeded. Keep the local delta and reconcile
      // in the background instead of reporting a failure that invites a retry.
      this.schedule(account.id);
    }
  }
  async flags(account:AccountRow,row:MessageRow,flags:{unread?:boolean;starred?:boolean}) {
    const updated=await this.serial(account.id,async()=>this.locked(account,row,async client=>{
      const existing=await client.fetchOne(row.uid,{flags:true},{uid:true});if(!existing)throw new ApiError(404,'NOT_FOUND','远端邮件已删除。');
      if(flags.unread!==undefined)await (flags.unread?client.messageFlagsRemove(row.uid,['\\Seen'],{uid:true}):client.messageFlagsAdd(row.uid,['\\Seen'],{uid:true}));
      if(flags.starred!==undefined)await (flags.starred?client.messageFlagsAdd(row.uid,['\\Flagged'],{uid:true}):client.messageFlagsRemove(row.uid,['\\Flagged'],{uid:true}));
      const unread=flags.unread??!existing.flags?.has('\\Seen'),starred=flags.starred??!!existing.flags?.has('\\Flagged');
      const cached=this.store.message(row.id,account.user_id)||row;
      this.store.db.prepare('UPDATE messages SET unread=?,starred=?,detail_retry_at=CASE WHEN starred<>? THEN 0 ELSE detail_retry_at END WHERE id=?').run(Number(unread),Number(starred),Number(starred),row.id);
      if(row.folder.toUpperCase()==='INBOX')await this.refreshInboxUnread(account,client,row.folder,Number(unread)-cached.unread);
      this.emit(account.user_id,'sync',{accountId:account.id,status:'connected'});
      return summaryDto({...cached,unread:Number(unread),starred:Number(starred)});
    }));
    if(flags.starred!==undefined){this.store.pruneMailCache();this.scheduleWarm();}
    return updated;
  }
  async move(account:AccountRow,row:MessageRow,destination:string) {
    await this.serial(account.id,async()=>this.locked(account,row,async client=>{
      const folders=await client.list();this.saveFolders(account,folders);
      const path=findFolder(this.folderRows(account.id),destination);if(!path)throw new ApiError(400,'FOLDER_MISSING','远端邮箱未提供此目录，请在原邮箱中创建归档或废纸篓目录。');
      if(path===row.folder)return;
      const result=await client.messageMove(row.uid,path,{uid:true});if(!result)throw new ApiError(400,'MOVE_FAILED','邮件移动失败，请重新同步。');
      const cached=this.store.message(row.id,account.user_id)||row;
      this.store.db.prepare('DELETE FROM messages WHERE id=?').run(row.id);
      const fromInbox=row.folder.toUpperCase()==='INBOX',toInbox=path.toUpperCase()==='INBOX';
      if(fromInbox||toInbox)await this.refreshInboxUnread(account,client,findFolder(this.folderRows(account.id),'INBOX')||'INBOX',(Number(toInbox)-Number(fromInbox))*cached.unread);
    }));
    this.emit(account.user_id,'sync',{accountId:account.id,status:'connected'});
    this.schedule(account.id);
  }
  async send(account:AccountRow,input:SendInput) {
    return this.serial(account.id,async()=>{
      account=this.currentAccount(account);
      const credentials=await this.credentials(account);
      const attachments=(input.attachments||[]).map(a=>({filename:a.filename,contentType:a.contentType,content:Buffer.from(a.content,'base64')}));
      if(attachments.reduce((sum,a)=>sum+a.content.length,0)>20*1024*1024)throw new ApiError(413,'ATTACHMENTS_TOO_LARGE','附件总大小不能超过 20 MiB。');
      const mail={from:{name:input.senderName?.trim()||account.name,address:account.email},to:input.to,cc:input.cc||undefined,bcc:input.bcc||undefined,subject:input.subject,text:input.text,inReplyTo:input.inReplyTo,references:input.references,attachments,disableFileAccess:true,disableUrlAccess:true};
      const transport=await this.smtp(account,credentials);
      let raw:Buffer;
      let messageId:string;
      try {
        // Build a reusable MIME source. SMTP sends its envelope, while IMAP stores a Bcc-free copy.
        const compiled=new MailComposer(mail).compile();
        const envelope=compiled.getEnvelope();
        messageId=compiled.messageId();
        raw=await new Promise<Buffer>((resolve,reject)=>compiled.build((error,result)=>error?reject(error):resolve(result)));
        const info=await this.boundedSmtp(transport,()=>transport.sendMail({envelope,raw,disableFileAccess:true,disableUrlAccess:true}));
        if(!info.accepted?.length)throw new ApiError(400,'SEND_REJECTED','SMTP 服务器拒绝所有收件人，请检查邮件地址。');
        messageId=info.messageId||messageId;
        const rejected=info.rejected?.length?`${info.rejected.length} 个收件人被 SMTP 服务器拒绝，请检查地址。`:undefined;
        let warning=rejected;
        try {
          // Gmail itself creates the sent copy; appending would duplicate outgoing mail.
          if(account.provider!=='gmail')await this.withClient(account,credentials,async client=>{const folders=await client.list();this.saveFolders(account,folders);const sent=findFolder(this.folderRows(account.id),'sent');if(!sent)throw new Error('missing sent');await client.append(sent,raw,['\\Seen'],new Date());});
        }catch{warning=[warning,'邮件已发送，但未能保存到已发送目录，请检查远端目录设置。'].filter(Boolean).join(' ');}
        this.schedule(account.id);
        return {ok:true as const,messageId,...(warning?{warning}:{})};
      }finally{this.closeSmtp(transport);}
    });
  }
  async remove(account:AccountRow) {await this.serial(account.id,async()=>{this.store.db.prepare('DELETE FROM accounts WHERE id=? AND user_id=?').run(account.id,account.user_id);});}
  stop() {this.stopped=true;this.activeWarmOperation?.cancel();if(this.warmPause){clearTimeout(this.warmPause.timer);this.warmPause.resolve();this.warmPause=undefined;}for(const client of this.activeClients)this.cancelClient(client);for(const client of this.smtpClients)client.close();}
  async close() {this.stop();await Promise.allSettled([...this.queues.values(),...this.scheduled.values(),...(this.warming?[this.warming]:[])]);}
}
