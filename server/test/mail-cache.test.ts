import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import type {ImapFlow,MessageStructureObject} from 'imapflow';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/db.js';
import {SecretBox} from '../src/security.js';

async function fixture(run:(project:Awaited<ReturnType<typeof buildApp>>,accountId:string,cookie:string,config:ReturnType<typeof loadConfig>)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-cache-'));
  const config={...loadConfig({APP_URL:'http://localhost:5173',DATA_DIR:directory,ENCRYPTION_KEY:'d'.repeat(64),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:'MailnestCacheTest2026!',MAIL_CACHE_MAX_MIB:'4',MAIL_CACHE_RECENT_COUNT:'0'}),background:false};
  const project=await buildApp(config);
  try {
    const login=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:config.appUrl},payload:{email:config.adminEmail,password:config.adminPassword}});
    const cookie=login.headers['set-cookie']!.toString().split(';')[0];
    const user=project.store.db.prepare('SELECT id FROM users').get() as {id:string};
    const id=randomUUID();
    project.store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,user.id,'Fixture','fixture@example.com','#377a75','imap','fixture','fixture','imap.example.com',993,1,'smtp.example.com',465,1,new SecretBox(config.encryptionKey).encrypt({password:'test-only-password'}));
    await run(project,id,cookie,config);
  }finally{await project.app.close();await rm(directory,{recursive:true,force:true});}
}
function mockClient(project:Awaited<ReturnType<typeof buildApp>>,client:object) {
  (project.mail as unknown as {withClient:(account:unknown,credentials:unknown,work:(client:ImapFlow)=>Promise<unknown>)=>Promise<unknown>}).withClient=async(_account,_credentials,work)=>work(client as ImapFlow);
}
function seed(project:Awaited<ReturnType<typeof buildApp>>,accountId:string,folder='INBOX',uid=1,validity='1') {
  const id=randomUUID();
  project.store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(id,accountId,folder,uid,validity,JSON.stringify({subject:'fixture',size:100,date:'2026-01-01T00:00:00.000Z'}),1,0,'2026-01-01T00:00:00.000Z');
  return id;
}

test('QQ virtual parent without UIDVALIDITY is skipped while its real child synchronizes',async()=>fixture(async(project,id)=>{
  const paths=['INBOX','其他文件夹','其他文件夹/QQ邮件订阅'];
  const selected:string[]=[];
  const client={usable:true,mailbox:{} as object,list:async()=>paths.map(path=>({path,name:path,flags:new Set()})),getMailboxLock:async(path:string)=>{selected.push(path);client.mailbox=path==='其他文件夹'?{exists:0}:{exists:path.includes('/')?1:0,uidValidity:0n,uidNext:2};return{release(){}};},search:async()=>[],fetchAll:async()=>[{uid:1,seq:1,envelope:{subject:'Child folder',date:'2026-01-01'},flags:new Set(),size:100}],status:async()=>({unseen:0})};
  mockClient(project,client);project.mail.schedule(id);await project.mail.waitForSync();
  assert.deepEqual(selected,paths);
  assert.equal(project.store.account(id)!.status,'connected');assert.equal(project.store.account(id)!.error,null);
  const child=project.store.db.prepare('SELECT folder,uid_validity FROM messages WHERE account_id=?').get(id) as {folder:string;uid_validity:string};
  assert.equal(child.folder,paths[2]);assert.equal(child.uid_validity,'0','UIDVALIDITY zero is present, not missing');
  const catalog=project.mail.cachedFolders(id);
  assert.equal(catalog.find(folder=>folder.path==='其他文件夹')!.selectable,false,'QQ virtual parent is a container in the cached catalog');
  assert.equal(catalog.find(folder=>folder.path==='INBOX')!.selectable,true,'empty real directories remain selectable');
  assert.equal(catalog.find(folder=>folder.path===paths[2])!.selectable,true,'real child remains available independently');
}));

test('missing UIDVALIDITY or incomplete FETCH preserves existing cached messages and continues other folders',async()=>fixture(async(project,id)=>{
  const virtual=seed(project,id,'其他文件夹'),incomplete=seed(project,id,'INBOX',99,'old');
  const paths=['INBOX','其他文件夹','其他文件夹/子目录'];
  const client={usable:true,mailbox:{} as object,current:'',list:async()=>paths.map(path=>({path,name:path,flags:new Set()})),getMailboxLock:async(path:string)=>{client.current=path;client.mailbox=path==='其他文件夹'?{exists:0}:{exists:path==='INBOX'?2:1,uidValidity:1n,uidNext:3};return{release(){}};},search:async()=>[],fetchAll:async()=>client.current==='INBOX'?[]:[{uid:1,seq:1,envelope:{date:'2026-01-01'},flags:new Set(),size:100}],status:async()=>({unseen:0})};
  mockClient(project,client);project.mail.schedule(id);await project.mail.waitForSync();
  assert.equal(project.store.account(id)!.status,'partial');assert.match(project.store.account(id)!.error!,/列表不完整/);
  assert.ok(project.store.db.prepare('SELECT id FROM messages WHERE id=?').get(virtual));assert.ok(project.store.db.prepare('SELECT id FROM messages WHERE id=?').get(incomplete));
  assert.equal((project.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=? AND folder=?').get(id,paths[2]) as {n:number}).n,1);
}));

test('body parts load without raw MIME or attachment persistence; CID download is authenticated and typed',async()=>fixture(async(project,accountId,cookie)=>{
  const id=seed(project,accountId),requested:string[]=[];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const structure:MessageStructureObject={type:'multipart/mixed',childNodes:[{type:'text/plain',part:'1',size:12},{type:'text/html',part:'2',size:28},{type:'image/png',part:'3',id:'<image-1>',disposition:'inline',size:png.length},{type:'application/zip',part:'4',disposition:'attachment',size:100*1024*1024,dispositionParameters:{filename:'large.zip'}},{type:'image/svg+xml',part:'5',id:'<svg-1>',size:100},{type:'image/png',part:'6',id:'<explicit-attachment>',disposition:'attachment',size:png.length}]};
  const client={mailbox:{uidValidity:1n},getMailboxLock:async()=>({release(){}}),fetchOne:async()=>({uid:1,seq:1,size:120*1024*1024,bodyStructure:structure,envelope:{messageId:'<fixture@example.com>'}}),download:async(_uid:number,part:string,options:{maxBytes:number})=>{requested.push(part);assert.ok(options.maxBytes<=30*1024*1024+1);return{meta:{},content:Readable.from(part==='1'?Buffer.from('Hello fixture'):part==='2'?Buffer.from('<img src="cid:image-1">'):png)};}};
  mockClient(project,client);
  const detail=await project.app.inject({url:`/api/v1/messages/${id}`,headers:{cookie}});assert.equal(detail.statusCode,200,detail.body);
  const message=detail.json().message;assert.equal(message.text,'Hello fixture');assert.equal(message.attachments[0].contentId,'image-1');assert.equal(message.attachments[0].inline,true);assert.equal(message.cacheVersion,undefined);assert.equal(message.attachments[0].part,undefined);
  assert.equal(message.attachments[3].inline,false,'explicit attachment disposition takes precedence over Content-ID');assert.equal(message.hasAttachments,true);
  assert.deepEqual(requested,['1','2'],'opening a large message must not download its attachment or complete source');
  assert.equal(project.store.db.prepare('SELECT source FROM messages WHERE id=?').get(id)!.source,null);assert.equal((project.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as {n:number}).n,0);
  const url=`/api/v1/messages/${id}/attachments/${message.attachments[0].id}?inline=1`;
  assert.equal((await project.app.inject({url})).statusCode,401);
  const image=await project.app.inject({url,headers:{cookie}});assert.equal(image.statusCode,200);assert.equal(image.headers['content-type'],'image/png');assert.match(image.headers['content-disposition']!.toString(),/^inline;/);assert.deepEqual(image.rawPayload,png);assert.deepEqual(requested,['1','2','3']);
  assert.equal((await project.app.inject({url:`/api/v1/messages/${id}/attachments/${message.attachments[2].id}?inline=true`,headers:{cookie}})).statusCode,415);
  assert.equal((await project.app.inject({url:`/api/v1/messages/${id}/attachments/${message.attachments[1].id}`,headers:{cookie}})).statusCode,413,'known oversized attachments are rejected before fetching');
  assert.deepEqual(requested,['1','2','3']);
}));

test('single-part bodies are requested as part 1 and truncated within the text cache bound',async()=>fixture(async(project,accountId,cookie)=>{
  const id=seed(project,accountId);let downloads=0;
  mockClient(project,{mailbox:{uidValidity:1n},getMailboxLock:async()=>({release(){}}),fetchOne:async()=>({uid:1,seq:1,bodyStructure:{type:'text/plain',size:900000}}),download:async(_uid:number,part:string,options:{maxBytes:number})=>{downloads++;assert.equal(part,'1');assert.equal(options.maxBytes,512*1024+1);return{meta:{},content:Readable.from(Buffer.alloc(900000,'a'))};}});
  const first=await project.app.inject({url:`/api/v1/messages/${id}`,headers:{cookie}});assert.equal(first.statusCode,200);assert.equal(first.json().message.text.length,512*1024);assert.equal(first.json().message.bodyTruncated,true);
  assert.equal((await project.app.inject({url:`/api/v1/messages/${id}`,headers:{cookie}})).statusCode,200);assert.equal(downloads,1,'cached bodies avoid another IMAP download');
}));

test('mail cache evicts expired and least recently used bodies while keeping summaries',async()=>fixture(async(project,accountId)=>{
  const ids=[0,1,2,3].map(index=>seed(project,accountId,'INBOX',index+1));
  const detail=JSON.stringify({cacheVersion:2,text:'a'.repeat(1536*1024),html:null,messageId:null,attachments:[],bodyTruncated:false});
  for(const [index,id] of ids.entries())project.store.db.prepare('UPDATE messages SET detail=?,detail_cached_at=? WHERE id=?').run(detail,index===0?Date.now()-8*86400_000:Date.now()-10_000+index,id);
  project.store.pruneMailCache();
  const retained=project.store.db.prepare('SELECT id FROM messages WHERE detail IS NOT NULL ORDER BY detail_cached_at').all() as {id:string}[];assert.deepEqual(retained.map(row=>row.id),ids.slice(2));
  assert.equal((project.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as {n:number}).n,4,'cache eviction leaves mail summary records intact');
  assert.ok(Number(project.store.db.prepare('SELECT SUM(length(CAST(detail AS BLOB))) AS bytes FROM messages').get()!.bytes)<=4*1024*1024);
}));

test('upgrade drops duplicated MIME and attachment caches and invalidates legacy body metadata',async()=>fixture(async(project,accountId,_cookie,config)=>{
  const id=seed(project,accountId);project.store.db.prepare('UPDATE messages SET source=?,detail=? WHERE id=?').run(Buffer.alloc(128),JSON.stringify({text:'legacy',attachments:[{id:`${id}-0`}]}),id);
  project.store.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?)').run(`${id}-0`,id,'legacy.bin','application/octet-stream',128,Buffer.alloc(128));
  const reopened=new Store(config);
  try{const row=reopened.db.prepare('SELECT source,detail FROM messages WHERE id=?').get(id)!;assert.equal(row.source,null);assert.equal(row.detail,null);assert.equal((reopened.db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as {n:number}).n,0);}finally{reopened.close();}
}));
