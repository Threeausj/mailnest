import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ImapFlow} from 'imapflow';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/db.js';
import {MailService} from '../src/mail.js';
import {SecretBox} from '../src/security.js';

async function fixture(run:(f:{store:Store;mail:MailService;accountId:string;userId:string;events:{name:string;unread:number}[];scheduled:string[];state:{statusError?:Error;statusResult?:number|false;moves:number;failMove:boolean;flagsError?:Error;statusPaths:string[]};seed:(folder:string,unread:number)=>NonNullable<ReturnType<Store['message']>>})=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-realtime-'));
  const config={...loadConfig({APP_URL:'http://localhost:5173',DATA_DIR:directory,ENCRYPTION_KEY:'d'.repeat(64),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:'SyntheticRealtime2026!'}),background:false};
  const store=new Store(config);await store.bootstrap(config);
  const userId=store.db.prepare('SELECT id FROM users').get()!.id as string,accountId=randomUUID();
  store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials,unread) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(accountId,userId,'Synthetic','synthetic@example.com','#377a75','imap','synthetic','synthetic','imap.example.com',993,1,'smtp.example.com',465,1,new SecretBox(config.encryptionKey).encrypt({password:'test-only-password'}),4);
  const folders=[{path:'INBOX',name:'INBOX',flags:new Set<string>()},{path:'Archive',name:'Archive',specialUse:'\\Archive',flags:new Set<string>()},{path:'Trash',name:'Trash',specialUse:'\\Trash',flags:new Set<string>()}];
  for(const folder of folders)store.db.prepare('INSERT INTO folders(account_id,path,name,special_use,uid_validity) VALUES(?,?,?,?,?)').run(accountId,folder.path,folder.name,folder.specialUse||null,'1');
  const remote=new Map<string,Set<string>>(),events:{name:string;unread:number}[]=[],scheduled:string[]=[];
  const state={statusError:undefined as Error|undefined,statusResult:undefined as number|false|undefined,moves:0,failMove:false,flagsError:undefined as Error|undefined,statusPaths:[] as string[]};
  let selected='INBOX',nextUid=1;
  const client={mailbox:{uidValidity:1n},getMailboxLock:async(path:string)=>{selected=path;return{release(){}};},list:async()=>folders,fetchOne:async(uid:number)=>({uid,flags:new Set(remote.get(`${selected}:${uid}`)||[])}),messageFlagsAdd:async(uid:number,flags:string[])=>{if(state.flagsError)throw state.flagsError;const current=remote.get(`${selected}:${uid}`)!;for(const flag of flags)current.add(flag);},messageFlagsRemove:async(uid:number,flags:string[])=>{if(state.flagsError)throw state.flagsError;const current=remote.get(`${selected}:${uid}`)!;for(const flag of flags)current.delete(flag);},status:async(path:string)=>{state.statusPaths.push(path);if(state.statusError)throw state.statusError;return state.statusResult===false?false:{unseen:state.statusResult};},messageMove:async(uid:number,path:string)=>{state.moves++;if(state.failMove)return false;const key=`${selected}:${uid}`,flags=remote.get(key)!;remote.delete(key);remote.set(`${path}:${uid+10000}`,flags);return{destination:path};}};
  const mail=new MailService(store,config,(_user,name)=>events.push({name,unread:store.account(accountId)!.unread}),async()=>{});
  (mail as unknown as {withClient:(account:unknown,credentials:unknown,work:(client:ImapFlow)=>Promise<unknown>)=>Promise<unknown>}).withClient=async(_account,_credentials,work)=>work(client as unknown as ImapFlow);
  const schedule=mock.method(mail,'schedule',(id:string)=>{scheduled.push(id);});
  const seed=(folder:string,unread:number)=>{
    const id=randomUUID(),uid=nextUid++;
    store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(id,accountId,folder,uid,'1',JSON.stringify({from:{name:'Synthetic',address:'sender@example.com'},to:[],cc:[],subject:'Synthetic realtime message',preview:'Current cached preview',hasAttachments:false}),unread,0,'2026-01-01');
    remote.set(`${folder}:${uid}`,new Set(unread?[]:['\\Seen']));return store.message(id,userId)!;
  };
  try{await run({store,mail,accountId,userId,events,scheduled,state,seed});}finally{await mail.close();schedule.mock.restore();store.close();await rm(directory,{recursive:true,force:true});}
}

test('concurrent devices marking the same message read apply one unread delta even when STATUS fails',async()=>fixture(async f=>{
  const row=f.seed('INBOX',1),account=f.store.account(f.accountId)!;f.state.statusError=new Error('Synthetic STATUS failure');
  const results=await Promise.all([f.mail.flags(account,row,{unread:false}),f.mail.flags(account,row,{unread:false})]);
  assert.ok(results.every(row=>row.unread===false));assert.equal(f.store.account(f.accountId)!.unread,3);assert.equal(f.store.message(row.id,f.userId)!.unread,0);
  assert.deepEqual(f.events,[{name:'sync',unread:3},{name:'sync',unread:3}]);assert.deepEqual(f.scheduled,[f.accountId,f.accountId]);
  await Promise.all([f.mail.flags(account,row,{unread:true}),f.mail.flags(account,row,{unread:true})]);assert.equal(f.store.account(f.accountId)!.unread,4,'repeated unread changes also use the current cache rather than the stale request row');
  const starred=await f.mail.flags(account,row,{starred:true});assert.equal(starred.starred,true);assert.equal(starred.preview,'Current cached preview');assert.equal(f.store.account(f.accountId)!.unread,4);
}));

test('authoritative STATUS refreshes unread counts while missing or invalid results keep the successful mutation delta',async()=>{
  for(const result of [42,false,undefined,-1,1.5])await fixture(async f=>{
    const row=f.seed('INBOX',1);f.state.statusResult=result;await f.mail.flags(f.store.account(f.accountId)!,row,{unread:false});
    assert.equal(f.store.account(f.accountId)!.unread,result===42?42:3);assert.equal(f.events[0].unread,result===42?42:3);assert.equal(f.scheduled.length,result===42?0:1);
  });
});

test('a successful MOVE publishes its unread delta despite STATUS failure and a concurrent retry cannot move it twice',async()=>fixture(async f=>{
  const row=f.seed('INBOX',1),account=f.store.account(f.accountId)!;f.state.statusError=new Error('Synthetic STATUS failure');
  const results=await Promise.allSettled([f.mail.move(account,row,'trash'),f.mail.move(account,row,'trash')]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(f.state.moves,1);assert.equal(f.store.account(f.accountId)!.unread,3);assert.equal(f.store.message(row.id,f.userId),undefined);
  assert.deepEqual(f.events,[{name:'sync',unread:3}]);assert.ok(f.scheduled.length>0);assert.deepEqual(f.state.statusPaths,['INBOX']);
}));

test('moving mail into the INBOX adjusts only its unread contribution and still reconciles in the background',async()=>{
  for(const unread of [0,1])await fixture(async f=>{
    const row=f.seed('Archive',unread);f.state.statusError=new Error('Synthetic STATUS failure');await f.mail.move(f.store.account(f.accountId)!,row,'INBOX');
    assert.equal(f.store.account(f.accountId)!.unread,4+unread);assert.equal(f.events[0].unread,4+unread);assert.ok(f.scheduled.length>0);assert.deepEqual(f.state.statusPaths,['INBOX']);
  });
});

test('rejected remote flag and MOVE operations preserve cached unread counts and emit no success event',async()=>fixture(async f=>{
  const row=f.seed('INBOX',1),account=f.store.account(f.accountId)!;f.state.flagsError=new Error('Synthetic flag rejection');
  await assert.rejects(f.mail.flags(account,row,{unread:false}));assert.equal(f.store.account(f.accountId)!.unread,4);assert.equal(f.store.message(row.id,f.userId)!.unread,1);
  f.state.failMove=true;await assert.rejects(f.mail.move(account,row,'trash'));assert.equal(f.store.account(f.accountId)!.unread,4);assert.ok(f.store.message(row.id,f.userId));assert.equal(f.events.length,0);assert.equal(f.scheduled.length,0);
}));
