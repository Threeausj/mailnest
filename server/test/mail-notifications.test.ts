import test from 'node:test';
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

interface SyntheticMessage {uid:number;flags:Set<string>;envelope:{date:string;subject:string};size:number}
interface Folder {path:string;validity?:bigint;messages:SyntheticMessage[];exists?:number;error?:Error;disconnect?:boolean;statusError?:Error;beforeLock?:()=>void}
interface Event {name:string;data:{accountId:string;status?:string;count?:number;notificationId?:string}}
interface Fixture {store:Store;mail:MailService;id:string;events:Event[];notifications:{userId:string;accountId:string;count:number;notificationId?:string}[];folders:Folder[];client:{usable:boolean};sync:()=>Promise<void>;restart:()=>Promise<void>}
type StageNotification=(store:Store,userId:string,accountId:string,count:number,notificationId:string)=>void;
function assertNotificationIds(events:Event[],notifications:Fixture['notifications']) {
  const mailEvents=events.filter(event=>event.name==='mail');assert.equal(mailEvents.length,notifications.length);
  for(const [index,notification] of notifications.entries()){
    assert.match(notification.notificationId||'',/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
    assert.equal(mailEvents[index].data.notificationId,notification.notificationId);
  }
}
function message(uid:number,seen=false):SyntheticMessage {return{uid,flags:new Set(seen?['\\Seen']:[]),envelope:{date:'2026-01-01T00:00:00Z',subject:'Synthetic message'},size:100};}
async function fixture(run:(project:Fixture)=>Promise<void>,stage?:StageNotification) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-mail-notifications-'));
  const config={...loadConfig({APP_URL:'http://localhost:5173',DATA_DIR:directory,ENCRYPTION_KEY:'d'.repeat(64),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:'SyntheticNotifications2026!',VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:''}),background:false};
  let store=new Store(config);await store.bootstrap(config);
  store.db.exec('CREATE TABLE test_notification_intents(notification_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_id TEXT NOT NULL,count INTEGER NOT NULL)');
  const userId=store.db.prepare('SELECT id FROM users').get()!.id as string,id=randomUUID();
  store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,'Synthetic','synthetic@example.com','#377a75','imap','synthetic','synthetic','imap.example.com',993,1,'smtp.example.com',465,1,new SecretBox(config.encryptionKey).encrypt({password:'test-only-password'}));
  const events:Event[]=[],notifications:Fixture['notifications']=[],folders:Folder[]=[{path:'INBOX',validity:1n,messages:[]}];
  let current=folders[0];
  const client={usable:true,mailbox:{} as object,list:async()=>folders.map(folder=>({path:folder.path,name:folder.path,flags:new Set<string>()})),getMailboxLock:async(path:string)=>{
    current=folders.find(folder=>folder.path===path)!;
    if(!current)throw new Error('Unknown synthetic folder');
    current.beforeLock?.();
    client.mailbox={exists:current.exists??current.messages.length,uidValidity:current.validity,uidNext:Math.max(0,...current.messages.map(item=>item.uid))+1};
    return{release(){}};
  },fetchAll:async(range:string)=>{if(current.error){if(current.disconnect)client.usable=false;throw current.error;}return current.messages.slice(Number(range.split(':')[0])-1);},status:async()=>{if(current.statusError)throw current.statusError;return{unseen:current.messages.filter(item=>!item.flags.has('\\Seen')).length};}};
  const createService=()=>{
    const service=new MailService(store,config,(_userId,name,data)=>events.push({name,data:data as Event['data']}),async(userId,accountId,count,notificationId)=>{notifications.push({userId,accountId,count,notificationId});},stage?(...args)=>stage(store,...args):undefined);
    (service as unknown as {withClient:(account:unknown,credentials:unknown,work:(client:ImapFlow)=>Promise<unknown>)=>Promise<unknown>}).withClient=async(_account,_credentials,work)=>work(client as unknown as ImapFlow);
    return service;
  };
  let mail=createService();
  try{await run({get store(){return store;},get mail(){return mail;},id,events,notifications,folders,client,sync:async()=>{mail.schedule(id);await mail.waitForSync();},restart:async()=>{await mail.close();store.close();store=new Store(config);await store.bootstrap(config);mail=createService();}});}finally{mail.stop();await mail.close();store.close();await rm(directory,{recursive:true,force:true});}
}

function stageIntent(store:Store,userId:string,accountId:string,count:number,notificationId:string) {
  store.db.prepare('INSERT INTO test_notification_intents(notification_id,user_id,account_id,count) VALUES(?,?,?,?)').run(notificationId,userId,accountId,count);
}

test('initial INBOX load is silent; a later new unread message notifies exactly once',async()=>fixture(async({store,id,folders,sync,notifications,events})=>{
  folders[0].messages=[message(1)];await sync();assert.equal(notifications.length,0);assert.ok(store.account(id)!.last_synced_at);
  folders[0].messages.push(message(2));await sync();assert.equal(notifications.length,1);assert.equal(notifications[0].count,1);assert.equal(notifications[0].accountId,id);assert.equal(store.account(id)!.unread,2);
  assert.deepEqual(events.filter(event=>event.name==='mail').map(event=>event.data.count),[1]);
  await sync();assert.equal(notifications.length,1,'cached messages must not notify again on an unchanged poll');
  folders[0].messages.push(message(3));await sync();assert.equal(notifications.length,2);assertNotificationIds(events,notifications);assert.notEqual(notifications[0].notificationId,notifications[1].notificationId,'separate arrival batches must have distinct notification IDs');
}));

test('a new message already marked seen by another client still notifies once without creating an unread count',async()=>fixture(async({store,id,folders,sync,notifications})=>{
  folders[0].messages=[message(1,true)];await sync();folders[0].messages.push(message(2,true));await sync();assert.equal(notifications.length,1);assert.equal(notifications[0].count,1);assert.equal(store.account(id)!.unread,0);
  await sync();assert.equal(notifications.length,1);
}));

test('old lower-UID mail refilling the bounded cache after expunge is silent; a new seen UID still notifies',async()=>fixture(async({store,id,folders,sync,notifications,events})=>{
  folders[0].messages=Array.from({length:201},(_,index)=>message(index+1));await sync();
  const cachedUids=()=>store.db.prepare('SELECT uid FROM messages WHERE account_id=? AND folder=? ORDER BY uid').all(id,'INBOX').map(row=>row.uid);
  assert.equal(cachedUids().length,200);assert.equal(cachedUids()[0],2);assert.equal(notifications.length,0);
  folders[0].messages.pop();await sync();assert.equal(cachedUids().length,200);assert.equal(cachedUids()[0],1);assert.equal(notifications.length,0,'UID 1 is older mail newly refilling the cache, not a new arrival');
  folders[0].messages.pop();folders[0].messages.push(message(202,true));await sync();assert.equal(notifications.length,1);assert.equal(notifications[0].count,1);assert.equal(store.account(id)!.unread,199);assertNotificationIds(events,notifications);
  await sync();assert.equal(notifications.length,1);
}));

test('an initialized empty INBOX uses a zero maximum and ignores cached UIDs from another validity',async()=>fixture(async({store,id,folders,sync,notifications})=>{
  await sync();assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=?').get(id)!.n,0);
  store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,'INBOX',999,'stale-validity','{}',0,0,'2026-01-01');
  folders[0].messages=[message(7,true)];await sync();assert.equal(notifications.length,1);assert.equal(notifications[0].count,1);assert.equal(store.account(id)!.unread,0);
}));

test('a successful INBOX still notifies when a later folder fails, including connection loss',async()=>{
  for(const disconnect of [false,true])await fixture(async({store,id,folders,sync,notifications,events})=>{
    folders[0].messages=[message(1)];folders.push({path:'Archive',validity:1n,messages:[]});await sync();
    folders[0].messages.push(message(2));folders[1].messages=[message(1)];folders[1].error=new Error('Synthetic folder failure');folders[1].disconnect=disconnect;
    await sync();assert.equal(store.account(id)!.status,'partial');assert.equal(notifications.length,1);assert.equal(notifications[0].count,1);
    assertNotificationIds(events,notifications);
  });
});

test('incomplete INBOX fetch preserves the cache and retries its new mail notification on recovery',async()=>fixture(async({store,id,folders,sync,notifications})=>{
  folders[0].messages=[message(1)];folders.push({path:'Archive',validity:1n,messages:[]});await sync();
  folders[0].exists=2;await sync();assert.equal(store.account(id)!.status,'partial');assert.equal(notifications.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=?').get(id)!.n,1);
  folders[0].messages.push(message(2));await sync();assert.equal(notifications.length,1);assert.equal(notifications[0].count,1);assert.equal(store.account(id)!.status,'connected');
}));

test('INBOX status failure after a committed fetch still notifies once and keeps cached new mail',async()=>fixture(async({store,id,folders,sync,notifications})=>{
  folders[0].messages=[message(1)];await sync();folders[0].messages.push(message(2));folders[0].statusError=new Error('Synthetic STATUS failure');
  await sync();assert.equal(store.account(id)!.status,'partial');assert.equal(notifications.length,1);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=?').get(id)!.n,2);
  delete folders[0].statusError;await sync();assert.equal(notifications.length,1);assert.equal(store.account(id)!.unread,2);
}));

test('first INBOX recovery after another folder initialized the account establishes its own silent baseline',async()=>fixture(async({store,id,folders,sync,notifications})=>{
  folders[0].messages=[message(1)];folders[0].error=new Error('Synthetic first INBOX failure');folders.push({path:'Archive',validity:1n,messages:[]});
  await sync();assert.equal(store.account(id)!.status,'partial');assert.ok(store.account(id)!.last_synced_at);assert.equal(notifications.length,0);
  delete folders[0].error;await sync();assert.equal(notifications.length,0,'the first successful INBOX fetch must not notify existing messages');
  folders[0].messages.push(message(2));await sync();assert.equal(notifications.length,1);assert.equal(notifications[0].count,1);
}));

test('UIDVALIDITY reset rebuilds a silent baseline instead of announcing renumbered old mail',async()=>fixture(async({folders,sync,notifications})=>{
  folders[0].messages=[message(1),message(2)];await sync();folders[0].validity=2n;await sync();assert.equal(notifications.length,0);
  folders[0].messages.push(message(3));await sync();assert.equal(notifications.length,1);assert.equal(notifications[0].count,1);
}));

test('exception cleanup reuses the same notification ID when a batch entered the success delivery path',async()=>fixture(async({mail,folders,sync,notifications,events})=>{
  folders[0].messages=[message(1)];await sync();
  const hooks=mail as unknown as {notify:(userId:string,accountId:string,count:number,notificationId?:string)=>Promise<void>};
  const originalNotify=hooks.notify;let attempts=0;
  hooks.notify=async(...args)=>{await originalNotify(...args);if(++attempts===1)throw new Error('Synthetic notifier failure');};
  folders[0].messages.push(message(2));await sync();assert.equal(notifications.length,2);assertNotificationIds(events,notifications);assert.equal(notifications[0].notificationId,notifications[1].notificationId,'success and exception cleanup refer to the same batch for delivery deduplication');
}));

test('committed new mail retains its notification intent when shutdown interrupts a later folder and the database reopens',async()=>fixture(async project=>{
  project.folders[0].messages=[message(1)];project.folders.push({path:'Archive',validity:1n,messages:[]});await project.sync();
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM test_notification_intents').get()!.n,0,'initial history must not stage an alert');
  project.folders[0].messages.push(message(2));
  project.folders[1].beforeLock=()=>{project.mail.stop();project.client.usable=false;throw new Error('Synthetic shutdown after INBOX commit');};
  await project.sync();
  assert.equal(project.notifications.length,0,'shutdown interrupted the eventual delivery callback');
  assert.ok(project.store.db.prepare('SELECT uid FROM messages WHERE account_id=? AND folder=? AND uid=2').get(project.id,'INBOX'));
  const intent=project.store.db.prepare('SELECT * FROM test_notification_intents').get()!;
  assert.equal(intent.account_id,project.id);assert.equal(intent.count,1);
  assert.match(intent.notification_id as string,/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
  delete project.folders[1].beforeLock;project.client.usable=true;await project.restart();
  assert.deepEqual(project.store.db.prepare('SELECT * FROM test_notification_intents').get(),intent,'a fresh database connection recovers the pending intent');
  await project.sync();assert.equal(project.notifications.length,0,'unchanged cached mail must not create a duplicate notification');
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM test_notification_intents').get()!.n,1);
},stageIntent));

test('a staging failure rolls back both the arrival cache and intent so recovery can notify once',async()=>{
  let failStage=true;
  await fixture(async project=>{
    project.folders[0].messages=[message(1)];await project.sync();project.folders[0].messages.push(message(2));
    await project.sync();assert.equal(project.notifications.length,0);
    assert.deepEqual(project.store.db.prepare('SELECT uid FROM messages WHERE account_id=? ORDER BY uid').all(project.id).map(row=>row.uid),[1],'a failed queue write must not consume the arriving UID');
    assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM test_notification_intents').get()!.n,0,'the staged insert rolls back with the message');
    assert.equal(project.store.db.prepare('SELECT uid_validity FROM folders WHERE account_id=? AND path=?').get(project.id,'INBOX')!.uid_validity,'1');
    failStage=false;await project.sync();
    assert.equal(project.notifications.length,1);assert.equal(project.notifications[0].count,1);
    const intent=project.store.db.prepare('SELECT * FROM test_notification_intents').get()!;
    assert.equal(intent.notification_id,project.notifications[0].notificationId,'the eventual push and durable intent share the same batch ID');
    await project.sync();assert.equal(project.notifications.length,1);assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM test_notification_intents').get()!.n,1);
    assertNotificationIds(project.events,project.notifications);
  },(...args)=>{stageIntent(...args);if(failStage)throw new Error('Synthetic queue write failure');});
});
