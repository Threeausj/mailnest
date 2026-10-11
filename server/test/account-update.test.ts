import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {ImapFlow} from 'imapflow';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {SecretBox} from '../src/security.js';
import type {AccountRow} from '../src/db.js';
import type {Credentials} from '../src/mail.js';

type Project=Awaited<ReturnType<typeof buildApp>>;
type MailHooks={
  withClient:(account:AccountRow,credentials:Credentials,work:(client:ImapFlow)=>Promise<unknown>)=>Promise<unknown>;
  smtp:(account:AccountRow,credentials:Credentials)=>Promise<object>;
};
const origin='http://localhost:5173';
const secretBox=new SecretBox('e'.repeat(64));
async function fixture(run:(project:Project,userId:string,cookie:string)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-account-update-'));
  const config={...loadConfig({APP_URL:origin,DATA_DIR:directory,ENCRYPTION_KEY:'e'.repeat(64),ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'MailnestAccountTest2026!'}),background:false};
  const project=await buildApp(config);
  try {
    const response=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:config.adminEmail,password:config.adminPassword}});
    assert.equal(response.statusCode,200);
    await run(project,response.json().user.id,response.headers['set-cookie']!.toString().split(';')[0]);
  }finally{await project.app.close();await rm(directory,{recursive:true,force:true});}
}
function seedAccount(project:Project,userId:string,credentials:Credentials={password:'old-main',smtpPassword:'old-main'},smtpUsername='fixture') {
  const id=randomUUID();
  project.store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials,unread,last_synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,'Fixture',`${id}@example.com`,'#1677ff',credentials.oauth?'gmail':'imap','fixture',smtpUsername,'imap.example.com',993,1,'smtp.example.com',465,1,secretBox.encrypt(credentials),3,'2026-01-01T00:00:00Z');
  return project.store.account(id)!;
}
function seedCache(project:Project,account:AccountRow) {
  const id=createHash('sha256').update(`${account.id}\0INBOX\0${1}\0${1}`).digest('hex');
  project.store.db.prepare('INSERT INTO folders(account_id,path,name,special_use,uid_validity) VALUES(?,?,?,?,?)').run(account.id,'INBOX','INBOX',null,'1');
  project.store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(id,account.id,'INBOX',1,'1',JSON.stringify({subject:'Old synthetic message',date:'2026-01-01T00:00:00Z'}),1,0,'2026-01-01T00:00:00Z');
  project.store.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?)').run(`${id}-file`,id,'synthetic.txt','text/plain',1,Buffer.from('a'));
  return project.store.message(id,account.user_id)!;
}
function hooks(project:Project,options:{imapError?:boolean;smtpError?:boolean;smtpWait?:Promise<void>}={}) {
  const calls:{type:string;account:AccountRow;credentials:Credentials}[]=[];
  const scheduled:string[]=[];
  (project.mail as unknown as MailHooks).withClient=async(account,credentials,work)=>{
    calls.push({type:'imap',account,credentials});
    if(options.imapError)throw Object.assign(new Error('secret protocol details'),{code:'EAUTH'});
    return work({list:async()=>[{path:'INBOX',name:'INBOX',flags:new Set()}]} as unknown as ImapFlow);
  };
  (project.mail as unknown as MailHooks).smtp=async(account,credentials)=>{
    calls.push({type:'smtp',account,credentials});
    return{verify:async()=>{await options.smtpWait;if(options.smtpError)throw Object.assign(new Error('secret protocol details'),{code:'EAUTH'});return true;},close(){},sendMail:async()=>({accepted:['recipient@example.com'],messageId:'<synthetic@example.com>'})};
  };
  project.mail.schedule=id=>{scheduled.push(id);};
  return{calls,scheduled};
}
function patch(project:Project,id:string,cookie:string,payload:object) {
  return project.app.inject({method:'PATCH',url:`/api/v1/accounts/${id}`,headers:{cookie,origin},payload});
}

test('name and color edits stay offline, preserve cached mail and expose safe authentication metadata',async()=>fixture(async(project,userId,cookie)=>{
  const account=seedAccount(project,userId),row=seedCache(project,account),mock=hooks(project);
  const response=await patch(project,account.id,cookie,{name:'Personal',color:'#abcdef'});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().cacheReset,false);
  assert.equal(response.json().account.name,'Personal');assert.equal(response.json().account.authType,'password');assert.equal(response.json().account.hasSeparateSmtpCredentials,false);
  assert.equal(project.store.account(account.id)!.credentials,account.credentials,'metadata-only edits leave encrypted credentials untouched');
  assert.ok(project.store.message(row.id,userId));assert.equal(project.mail.cachedFolders(account.id).length,1);assert.equal(project.store.account(account.id)!.unread,3);
  assert.deepEqual(mock.calls,[]);assert.deepEqual(mock.scheduled,[]);
  const listed=await project.app.inject({url:'/api/v1/accounts',headers:{cookie}});
  assert.equal(listed.statusCode,200);assert.equal(listed.json().accounts[0].authType,'password');
  assert.equal(listed.body.includes('old-main'),false);assert.equal(response.body.includes(account.credentials),false);
}));

test('rotating a shared password updates both transports; blank passwords preserve credentials',async()=>fixture(async(project,userId,cookie)=>{
  const account=seedAccount(project,userId),row=seedCache(project,account),mock=hooks(project);
  const response=await patch(project,account.id,cookie,{password:'new-main'});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().cacheReset,false);assert.equal(response.json().account.hasSeparateSmtpCredentials,false);
  assert.deepEqual(mock.calls.map(call=>call.type),['imap','smtp']);
  for(const call of mock.calls){assert.equal(call.credentials.password,'new-main');assert.equal(call.credentials.smtpPassword,undefined,'legacy duplicate SMTP password must not override the new shared password');}
  const saved=secretBox.decrypt<Credentials>(project.store.account(account.id)!.credentials);
  assert.deepEqual(saved,{password:'new-main'});assert.ok(project.store.message(row.id,userId));assert.equal(mock.scheduled.length,1);
  mock.calls.length=0;mock.scheduled.length=0;
  const blank=await patch(project,account.id,cookie,{password:'',smtpPassword:''});
  assert.equal(blank.statusCode,200);assert.deepEqual(mock.calls,[]);assert.deepEqual(mock.scheduled,[]);assert.deepEqual(secretBox.decrypt(project.store.account(account.id)!.credentials),saved);
}));

test('separate SMTP credentials persist independently and can be reset to shared credentials',async()=>fixture(async(project,userId,cookie)=>{
  const account=seedAccount(project,userId,{password:'old-main',smtpPassword:'independent-smtp'},'smtp-login'),mock=hooks(project);
  const rotated=await patch(project,account.id,cookie,{password:'new-main',smtpPassword:''});
  assert.equal(rotated.statusCode,200,rotated.body);assert.equal(rotated.json().account.hasSeparateSmtpCredentials,true);
  assert.equal(mock.calls[1].account.smtp_username,'smtp-login');assert.equal(mock.calls[1].credentials.smtpPassword,'independent-smtp');
  const reset=await patch(project,account.id,cookie,{smtpUsername:null,smtpPassword:null});
  assert.equal(reset.statusCode,200,reset.body);assert.equal(reset.json().account.hasSeparateSmtpCredentials,false);assert.equal(reset.json().account.smtpUsername,'fixture');
  assert.deepEqual(secretBox.decrypt(project.store.account(account.id)!.credentials),{password:'new-main'});
  const invalid=await patch(project,account.id,cookie,{smtpUsername:null});assert.equal(invalid.statusCode,400);assert.equal(invalid.json().error.code,'SMTP_CREDENTIALS_INVALID');
  const explicit=await patch(project,account.id,cookie,{smtpUsername:'fixture',smtpPassword:'new-main'});
  assert.equal(explicit.statusCode,200);assert.equal(explicit.json().account.hasSeparateSmtpCredentials,true,'an explicitly separate identical password remains independent');
  await patch(project,account.id,cookie,{password:'later-main'});
  assert.equal(secretBox.decrypt<Credentials>(project.store.account(account.id)!.credentials).smtpPassword,'new-main');
}));

test('failed connection checks roll back config and cache; validation and ownership fail before network',async()=>fixture(async(project,userId,cookie)=>{
  const account=seedAccount(project,userId),row=seedCache(project,account),mock=hooks(project,{smtpError:true});
  const failed=await patch(project,account.id,cookie,{email:'changed@example.com',username:'changed',imap:{host:'new-imap.example.com',port:993,secure:true},password:'wrong'});
  assert.equal(failed.statusCode,400,failed.body);assert.equal(failed.json().error.code,'MAIL_CONNECTION_FAILED');assert.equal(failed.body.includes('secret protocol'),false);
  assert.deepEqual(project.store.account(account.id),account);assert.ok(project.store.message(row.id,userId));assert.equal(project.mail.cachedFolders(account.id).length,1);assert.deepEqual(mock.scheduled,[]);
  mock.calls.length=0;
  for(const payload of [{},{provider:'gmail'},{imap:{host:'new.example.com',port:0,secure:true}},{name:''}])assert.equal((await patch(project,account.id,cookie,payload)).statusCode,400);
  const other=seedAccount(project,userId);
  assert.equal((await patch(project,account.id,cookie,{email:other.email})).statusCode,409);
  const foreignUser=randomUUID();project.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(foreignUser,'foreign@example.com','Foreign','not-a-login-hash');
  const foreign=seedAccount(project,foreignUser);
  assert.equal((await patch(project,foreign.id,cookie,{name:'No access'})).statusCode,404);
  assert.equal((await project.app.inject({method:'PATCH',url:`/api/v1/accounts/${account.id}`,headers:{origin},payload:{name:'Anonymous'}})).statusCode,401);
  assert.deepEqual(mock.calls,[]);
}));

test('OAuth edits only allow display fields and retain tokens without refreshing or exposing them',async()=>fixture(async(project,userId,cookie)=>{
  const account=seedAccount(project,userId,{oauth:{accessToken:'secret-access',refreshToken:'secret-refresh',expiresAt:0}}),mock=hooks(project);
  const response=await patch(project,account.id,cookie,{name:'Google personal',color:'#ff8800'});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().account.authType,'oauth');assert.equal(response.json().account.hasSeparateSmtpCredentials,false);
  assert.equal(project.store.account(account.id)!.credentials,account.credentials);
  for(const payload of [{password:''},{email:account.email},{username:account.username},{smtpUsername:null,smtpPassword:null},{imap:{host:account.imap_host,port:993,secure:true}}]){
    const rejected=await patch(project,account.id,cookie,payload);assert.equal(rejected.statusCode,400);assert.equal(rejected.json().error.code,'OAUTH_SETTINGS_READ_ONLY');
  }
  assert.deepEqual(mock.calls,[]);assert.deepEqual(mock.scheduled,[]);assert.equal(response.body.includes('secret-access'),false);assert.equal(response.body.includes('secret-refresh'),false);
}));

test('identity changes isolate cached UIDs and reject queued old-message operations before network',async()=>fixture(async(project,userId,cookie)=>{
  const account=seedAccount(project,userId),row=seedCache(project,account);
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
  const mock=hooks(project,{smtpWait:wait});
  const update=project.mail.update(account,{email:'changed@example.com',username:'changed',imap:{host:'new-imap.example.com',port:993,secure:true}});
  const oldFlags=project.mail.flags(account,row,{unread:false});
  const rejection=assert.rejects(oldFlags,(error:{code?:string})=>error.code==='NOT_FOUND');
  release();const result=await update;await rejection;
  assert.equal(result.cacheReset,true);assert.equal(result.account.id,account.id);assert.equal(result.account.unread,0);assert.equal(result.account.last_synced_at,null);assert.ok(result.account.mail_cache_epoch);
  assert.equal(project.store.message(row.id,userId),undefined);assert.deepEqual(project.mail.cachedFolders(account.id),[]);assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get()!.n,0);assert.equal(mock.calls.length,2,'queued old-message operation must not open IMAP against the new mailbox');
  const client={usable:true,mailbox:{exists:1,uidValidity:1n,uidNext:2},list:async()=>[{path:'INBOX',name:'INBOX',flags:new Set()}],getMailboxLock:async()=>({release(){}}),fetchAll:async()=>[{uid:1,seq:1,envelope:{subject:'New synthetic mailbox',date:'2026-01-02'},flags:new Set(['\\Seen'])}],status:async()=>({unseen:0})};
  (project.mail as unknown as MailHooks).withClient=async(_account,_credentials,work)=>work(client as unknown as ImapFlow);
  // Re-enable only the synthetic sync; no real mail server is contacted.
  Object.getPrototypeOf(project.mail).schedule.call(project.mail,account.id);await project.mail.waitForSync();
  const current=project.store.db.prepare('SELECT id FROM messages WHERE account_id=?').get(account.id)!;
  assert.notEqual(current.id,row.id,'matching folder/UIDVALIDITY/UID in a different mailbox must not reuse an old message ID');
  await assert.rejects(project.mail.flags(account,row,{unread:false}),(error:{code?:string})=>error.code==='NOT_FOUND');
  const response=await project.app.inject({url:`/api/v1/messages/${row.id}`,headers:{cookie}});assert.equal(response.statusCode,404);
}));

test('queued sends reload saved credentials after an account update',async()=>fixture(async(project,userId)=>{
  const account=seedAccount(project,userId);
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
  const mock=hooks(project,{smtpWait:wait});
  const update=project.mail.update(account,{password:'saved-new-password'});
  const send=project.mail.send(account,{accountId:account.id,to:'recipient@example.com',subject:'Synthetic test',text:'Synthetic fixture only'});
  release();await update;const sent=await send;
  assert.equal(sent.ok,true);const smtpCalls=mock.calls.filter(call=>call.type==='smtp');assert.equal(smtpCalls.length,2);assert.equal(smtpCalls[1].credentials.password,'saved-new-password');assert.equal(smtpCalls[1].credentials.smtpPassword,undefined);
}));

test('new connections distinguish shared and explicitly separate SMTP credentials',async()=>fixture(async(project,userId,cookie)=>{
  hooks(project);
  const input={name:'Created',email:'created@example.com',provider:'imap',username:'created',password:'new-connection-password',imap:{host:'imap.example.com',port:993,secure:true},smtp:{host:'smtp.example.com',port:465,secure:true}};
  const shared=await project.app.inject({method:'POST',url:'/api/v1/accounts',headers:{cookie,origin},payload:input});
  assert.equal(shared.statusCode,201,shared.body);assert.equal(shared.json().account.hasSeparateSmtpCredentials,false);assert.deepEqual(secretBox.decrypt(project.store.account(shared.json().account.id,userId)!.credentials),{password:input.password});
  const separate=await project.app.inject({method:'POST',url:'/api/v1/accounts',headers:{cookie,origin},payload:{...input,email:'separate@example.com',smtpUsername:'created',smtpPassword:input.password}});
  assert.equal(separate.statusCode,201,separate.body);assert.equal(separate.json().account.hasSeparateSmtpCredentials,true);
}));

test('Google reauthorization keeps the current account name, cache epoch and messages for the same identity',async()=>fixture(async(project,userId)=>{
  const seeded=seedAccount(project,userId,{oauth:{accessToken:'old-access',refreshToken:'old-refresh',expiresAt:0}});
  project.store.db.prepare("UPDATE accounts SET username=email,smtp_username=email,imap_host='imap.gmail.com',smtp_host='smtp.gmail.com',mail_cache_epoch='existing-cache-namespace' WHERE id=?").run(seeded.id);
  const account=project.store.account(seeded.id)!,row=seedCache(project,account),mock=hooks(project);
  // The reauthorization is queued while the metadata update still owns the
  // account queue, so it captures an older name before entering its work.
  const renamed=project.mail.update(account,{name:'Latest personal name',color:'#112233'});
  const oauth={accessToken:'new-access',refreshToken:'new-refresh',expiresAt:Date.now()+3600_000};
  const reauthorized=project.mail.connectGoogle(userId,account.email,'Ignored Google profile name',oauth);
  await renamed;const saved=await reauthorized;
  assert.equal(saved.name,'Latest personal name');assert.equal(saved.color,'#112233');assert.equal(saved.mail_cache_epoch,'existing-cache-namespace');assert.equal(saved.unread,3);assert.equal(saved.last_synced_at,account.last_synced_at);
  assert.ok(project.store.message(row.id,userId));assert.equal(project.mail.cachedFolders(account.id).length,1);assert.equal(mock.calls[0].account.name,'Latest personal name');assert.deepEqual(secretBox.decrypt<Credentials>(saved.credentials).oauth,oauth);
}));
