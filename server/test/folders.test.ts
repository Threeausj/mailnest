import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/db.js';
import {SecretBox} from '../src/security.js';

type Project = Awaited<ReturnType<typeof buildApp>>;
async function fixture(run:(project:Project,userId:string,cookie:string)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-folders-'));
  const config={...loadConfig({APP_URL:'http://localhost:5173',DATA_DIR:directory,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'MailnestFolderTest2026!'}),background:false};
  const project=await buildApp(config);
  try {
    const login=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:config.appUrl},payload:{email:config.adminEmail,password:config.adminPassword}});
    assert.equal(login.statusCode,200);
    const cookie=login.headers['set-cookie']!.toString().split(';')[0];
    await run(project,login.json().user.id,cookie);
  }finally{await project.app.close();await rm(directory,{recursive:true,force:true});}
}
function account(project:Project,userId:string,name:string) {
  const id=randomUUID();
  project.store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,name,`${name}@example.com`,'#1677ff','imap',name,name,'imap.example.com',993,1,'smtp.example.com',465,1,new SecretBox('a'.repeat(64)).encrypt({password:'fixture-catalog-password'}));
  return id;
}
function folder(project:Project,accountId:string,path:string,specialUse:string|null=null,selectable=true,name=path.split('/').at(-1)!) {
  project.store.db.prepare('INSERT INTO folders(account_id,path,name,special_use,selectable) VALUES(?,?,?,?,?)').run(accountId,path,name,specialUse,Number(selectable));
}
function message(project:Project,accountId:string,path:string) {
  const id=randomUUID();
  project.store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(id,accountId,path,1,'1',JSON.stringify({subject:'Synthetic folder test',from:{name:'Fixture',address:'fixture@example.com'},date:'2026-01-01T00:00:00Z'}),1,0,'2026-01-01T00:00:00Z');
  return id;
}

test('account catalogs include empty and custom folders from cache without network and enforce ownership',async()=>fixture(async(project,userId,cookie)=>{
  const first=account(project,userId,'first'),second=account(project,userId,'second'),pending=account(project,userId,'pending');
  const foreignUser=randomUUID();project.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(foreignUser,'other@example.com','Other fixture owner','not-a-login-hash');
  const foreign=account(project,foreignUser,'foreign');
  folder(project,first,'INBOX');folder(project,first,'[Gmail]/Drafts','\\Drafts');folder(project,first,'Projects',null,false);folder(project,first,'Projects/2026');
  folder(project,second,'INBOX');folder(project,second,'垃圾邮件');folder(project,foreign,'Private');
  let networkCalls=0;
  (project.mail as unknown as {withClient:()=>Promise<never>}).withClient=async()=>{networkCalls++;throw new Error('Cached catalog must not connect to IMAP');};
  const response=await project.app.inject({url:'/api/v1/accounts',headers:{cookie}});
  assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');
  const accounts=response.json().accounts;
  assert.equal(accounts.length,3);assert.equal(accounts.some((row:{id:string})=>row.id===foreign),false);
  const catalog=accounts.find((row:{id:string})=>row.id===first).folders;
  assert.deepEqual(catalog,[
    {path:'INBOX',name:'INBOX',specialUse:null,selectable:true,kind:'inbox'},
    {path:'Projects',name:'Projects',specialUse:null,selectable:false,kind:'custom'},
    {path:'Projects/2026',name:'2026',specialUse:null,selectable:true,kind:'custom'},
    {path:'[Gmail]/Drafts',name:'Drafts',specialUse:'\\Drafts',selectable:true,kind:'drafts'},
  ]);
  assert.deepEqual(accounts.find((row:{id:string})=>row.id===pending).folders,[],'new accounts have no fabricated directory catalog');
  assert.deepEqual(accounts.find((row:{id:string})=>row.id===second).folders.map((row:{kind:string})=>row.kind),['inbox','junk']);
  const folders=await project.app.inject({url:`/api/v1/accounts/${first}/folders`,headers:{cookie}});
  assert.equal(folders.statusCode,200);assert.deepEqual(folders.json().folders,catalog);
  assert.equal((await project.app.inject({url:`/api/v1/accounts/${first}/folders`})).statusCode,401);
  assert.equal((await project.app.inject({url:`/api/v1/accounts/${foreign}/folders`,headers:{cookie}})).statusCode,404);
  assert.equal(networkCalls,0);
  assert.equal(response.body.includes('fixture-catalog-password'),false,'catalogs do not expose credentials');
  assert.equal(catalog.some((row:object)=>'unread' in row||'total' in row),false,'empty catalog entries are not estimated message counts');
}));

test('unified logical folders resolve across accounts while account lists honor exact paths',async()=>fixture(async(project,userId,cookie)=>{
  const first=account(project,userId,'first'),second=account(project,userId,'second');
  folder(project,first,'[Gmail]/Drafts','\\Drafts');folder(project,second,'草稿箱');
  folder(project,first,'drafts');folder(project,first,'[Gmail]/Spam','\\Junk');folder(project,second,'垃圾邮件');
  folder(project,first,'Important','\\Important');folder(project,second,'重要邮件');
  folder(project,first,'Projects',null,false);folder(project,first,'Projects/2026');
  const draftIds=[message(project,first,'[Gmail]/Drafts'),message(project,second,'草稿箱')];
  const aliasPath=message(project,first,'drafts');
  const junkIds=[message(project,first,'[Gmail]/Spam'),message(project,second,'垃圾邮件')];
  const importantIds=[message(project,first,'Important'),message(project,second,'重要邮件')];
  const custom=message(project,first,'Projects/2026');message(project,first,'Projects');
  const list=async(query:Record<string,string>)=>{
    const response=await project.app.inject({url:`/api/v1/messages?${new URLSearchParams(query)}`,headers:{cookie}});
    assert.equal(response.statusCode,200);return response.json().messages.map((row:{id:string})=>row.id).sort();
  };
  assert.deepEqual(await list({folder:'drafts'}),draftIds.sort());
  assert.deepEqual(await list({folder:'junk'}),junkIds.sort());
  assert.deepEqual(await list({folder:'important'}),importantIds.sort());
  assert.deepEqual(await list({accountId:first,folder:'drafts'}),[aliasPath],'actual server path wins over logical alias for a single account');
  assert.deepEqual(await list({accountId:first,folder:'[Gmail]/Drafts'}),[draftIds.find(id=>project.store.message(id,userId)!.account_id===first)]);
  assert.deepEqual(await list({accountId:first,folder:'Projects/2026'}),[custom]);
  assert.deepEqual(await list({accountId:first,folder:'Projects'}),[],'non-selectable containers cannot list messages');
  assert.deepEqual(await list({folder:'sent'}),[],'unavailable logical directories yield an empty list');
}));

test('legacy folder caches gain selectable metadata while retaining existing paths',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mailnest-legacy-folders-'));
  const config=loadConfig({DATA_DIR:directory,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'MailnestFolderTest2026!'});
  const legacy=new DatabaseSync(join(directory,'mailnest.sqlite'));
  legacy.exec('CREATE TABLE folders(account_id TEXT NOT NULL,path TEXT NOT NULL,name TEXT NOT NULL,special_use TEXT,uid_validity TEXT,PRIMARY KEY(account_id,path))');
  legacy.prepare('INSERT INTO folders VALUES(?,?,?,?,?)').run('fixture','Old path','Old name',null,'123');legacy.close();
  const store=new Store(config);
  try{assert.deepEqual({...store.db.prepare('SELECT path,name,uid_validity,selectable FROM folders').get()},{path:'Old path',name:'Old name',uid_validity:'123',selectable:1});}
  finally{store.close();await rm(directory,{recursive:true,force:true});}
});
