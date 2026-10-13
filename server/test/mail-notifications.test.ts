import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {ImapFlow,type MessageStructureObject,type FetchQueryObject} from 'imapflow';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/db.js';
import {MailService,type MailNotificationDetails} from '../src/mail.js';
import {SecretBox} from '../src/security.js';

interface SyntheticMessage {uid:number;flags:Set<string>;envelope:{date:string;subject:string;from?:{name:string;address:string}[]};size:number;bodyStructure?:MessageStructureObject;body?:Buffer;mimeHeaders?:Buffer;beforeDownload?:()=>void;downloadError?:Error;downloadWait?:Promise<void>;stream?:Readable}
interface Folder {path:string;validity?:bigint;messages:SyntheticMessage[];exists?:number;error?:Error;disconnect?:boolean;statusError?:Error;beforeLock?:()=>void}
interface Event {name:string;data:{accountId:string;status?:string;count?:number;notificationId?:string;notification?:MailNotificationDetails}}
interface Fixture {store:Store;mail:MailService;id:string;events:Event[];notifications:{userId:string;accountId:string;count:number;notificationId?:string;details?:MailNotificationDetails}[];folders:Folder[];client:{usable:boolean;close:()=>void};downloads:{uid:number;part:string;options:{uid:boolean;maxBytes:number;chunkSize:number}}[];fetches:{uid:number;query:FetchQueryObject;options:{uid:boolean}}[];sync:()=>Promise<void>;restart:()=>Promise<void>}
type StageNotification=(store:Store,userId:string,accountId:string,count:number,notificationId:string,details?:MailNotificationDetails)=>void;
function assertNotificationIds(events:Event[],notifications:Fixture['notifications']) {
  const mailEvents=events.filter(event=>event.name==='mail');assert.equal(mailEvents.length,notifications.length);
  for(const [index,notification] of notifications.entries()){
    assert.match(notification.notificationId||'',/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
    assert.equal(mailEvents[index].data.notificationId,notification.notificationId);
  }
}
function message(uid:number,seen=false):SyntheticMessage {return{uid,flags:new Set(seen?['\\Seen']:[]),envelope:{date:'2026-01-01T00:00:00Z',subject:'Synthetic message'},size:100,bodyStructure:{type:'text/plain',part:'1'}};}
async function fixture(run:(project:Fixture)=>Promise<void>,stage?:StageNotification) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-mail-notifications-'));
  const config={...loadConfig({APP_URL:'http://localhost:5173',DATA_DIR:directory,ENCRYPTION_KEY:'d'.repeat(64),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:'SyntheticNotifications2026!',VAPID_PUBLIC_KEY:'',VAPID_PRIVATE_KEY:'',ALLOW_PRIVATE_MAIL_HOSTS:'true'}),background:false};
  let store=new Store(config);await store.bootstrap(config);
  store.db.exec('CREATE TABLE test_notification_intents(notification_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_id TEXT NOT NULL,count INTEGER NOT NULL,details TEXT)');
  const userId=store.db.prepare('SELECT id FROM users').get()!.id as string,id=randomUUID();
  store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,'Synthetic','synthetic@example.com','#377a75','imap','synthetic','synthetic','imap.example.com',993,1,'smtp.example.com',465,1,new SecretBox(config.encryptionKey).encrypt({password:'test-only-password'}));
  const events:Event[]=[],notifications:Fixture['notifications']=[],folders:Folder[]=[{path:'INBOX',validity:1n,messages:[]}];
  const downloads:Fixture['downloads']=[],fetches:Fixture['fetches']=[];
  let current=folders[0];
  const client={usable:true,mailbox:{} as object,close(){client.usable=false;},list:async()=>folders.map(folder=>({path:folder.path,name:folder.path,flags:new Set<string>()})),getMailboxLock:async(path:string)=>{
    current=folders.find(folder=>folder.path===path)!;
    if(!current)throw new Error('Unknown synthetic folder');
    current.beforeLock?.();
    client.mailbox={exists:current.exists??current.messages.length,uidValidity:current.validity,uidNext:Math.max(0,...current.messages.map(item=>item.uid))+1};
    return{release(){}};
  },search:async()=>current.messages.filter(item=>item.flags.has('\\Flagged')).map(item=>item.uid),fetchAll:async(range:string)=>{if(current.error){if(current.disconnect)client.usable=false;throw current.error;}return current.messages.slice(Number(range.split(':')[0])-1);},status:async()=>{if(current.statusError)throw current.statusError;return{unseen:current.messages.filter(item=>!item.flags.has('\\Seen')).length};},download:async(uid:number,part:string,options:Fixture['downloads'][number]['options'])=>{
    downloads.push({uid,part,options});const item=current.messages.find(message=>message.uid===uid)!;item.beforeDownload?.();await item.downloadWait;if(item.downloadError)throw item.downloadError;
    return{meta:{},content:item.stream||Readable.from(item.body||Buffer.from(''))};
  },fetchOne:async(uid:number,query:FetchQueryObject,options:{uid:boolean})=>{
    fetches.push({uid,query,options});const item=current.messages.find(message=>message.uid===uid)!;
    return query.headers?{uid,headers:item.mimeHeaders||Buffer.from('Content-Type: multipart/mixed\r\n')}:{uid,bodyParts:new Map([['text',item.body||Buffer.from('')]])};
  }};
  const createService=()=>{
    const service=new MailService(store,config,(_userId,name,data)=>events.push({name,data:data as Event['data']}),async(userId,accountId,count,notificationId,details)=>{notifications.push({userId,accountId,count,notificationId,details});},stage?(...args)=>stage(store,...args):undefined);
    (service as unknown as {withClient:(account:unknown,credentials:unknown,work:(client:ImapFlow)=>Promise<unknown>)=>Promise<unknown>}).withClient=async(_account,_credentials,work)=>work(client as unknown as ImapFlow);
    return service;
  };
  let mail=createService();
  try{await run({get store(){return store;},get mail(){return mail;},id,events,notifications,folders,client,downloads,fetches,sync:async()=>{mail.schedule(id);await mail.waitForSync();},restart:async()=>{await mail.close();store.close();store=new Store(config);await store.bootstrap(config);mail=createService();}});}finally{mail.stop();await mail.close();store.close();await rm(directory,{recursive:true,force:true});}
}

function stageIntent(store:Store,userId:string,accountId:string,count:number,notificationId:string,details?:MailNotificationDetails) {
  store.db.prepare('INSERT INTO test_notification_intents(notification_id,user_id,account_id,count,details) VALUES(?,?,?,?,?)').run(notificationId,userId,accountId,count,details?JSON.stringify(details):null);
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

test('one bounded body read prepares the latest new UID for stage, push and SSE without downloading history or attachments',async()=>fixture(async project=>{
  project.folders[0].messages=[message(1)];project.folders.push({path:'Archive',validity:1n,messages:[message(1)]});await project.sync();
  assert.equal(project.downloads.length,0);assert.equal(project.fetches.length,0,'historical synchronization must not read any message body');
  const arrivals=Array.from({length:200},(_,index)=>message(index+2));
  const latest=arrivals.at(-1)!;latest.envelope={date:'2020-01-01',subject:`  新主题\n${'📨'.repeat(200)}`,from:[{name:`  新发件人\0${'🙂'.repeat(100)}`,address:'latest@example.com'}]};
  arrivals.at(-2)!.envelope.date='2099-01-01';
  latest.bodyStructure={type:'multipart/mixed',childNodes:[{type:'text/html',part:'1'},{type:'text/plain',part:'2.1'},{type:'text/plain',part:'3',disposition:'attachment',dispositionParameters:{filename:'secret.txt'}},{type:'application/zip',part:'4',size:200*1024*1024,disposition:'attachment'}]};
  latest.body=Buffer.from(`  最新正文\n\t${'🙂'.repeat(10_000)}`);
  latest.beforeDownload=()=>{project.store.db.exec('BEGIN');project.store.db.exec('ROLLBACK');};
  project.folders[0].messages.push(...arrivals);await project.sync();
  assert.deepEqual(project.downloads,[{uid:201,part:'2.1',options:{uid:true,maxBytes:16*1024,chunkSize:8*1024}}]);
  assert.equal(project.fetches.length,0);assert.equal(project.notifications.length,1);assert.equal(project.notifications[0].count,200);
  const details=project.notifications[0].details!;
  assert.equal(details.subject,Array.from(`新主题 ${'📨'.repeat(200)}`).slice(0,120).join(''));
  assert.equal(details.preview,Array.from(`最新正文 ${'🙂'.repeat(10_000)}`).slice(0,200).join(''));
  assert.equal(details.from.name,Array.from(`新发件人 ${'🙂'.repeat(100)}`).slice(0,80).join(''));assert.equal(details.from.address,'latest@example.com');
  const intent=project.store.db.prepare('SELECT * FROM test_notification_intents').get()!;
  assert.equal(intent.notification_id,project.notifications[0].notificationId);assert.deepEqual(JSON.parse(intent.details as string),details);
  assert.deepEqual(project.events.find(event=>event.name==='mail')!.data.notification,details);assertNotificationIds(project.events,project.notifications);
  const cached=project.store.db.prepare('SELECT uid,summary,source,detail FROM messages WHERE account_id=? AND folder=? ORDER BY uid').all(project.id,'INBOX');
  assert.ok(cached.every(row=>row.source===null&&row.detail===null));
  assert.equal(JSON.parse(cached.at(-1)!.summary as string).preview,details.preview);assert.equal(JSON.parse(cached[0].summary as string).preview,'');
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get()!.n,0);
  await project.sync();assert.equal(project.downloads.length,1,'unchanged polls reuse the bounded preview without downloading bodies');assert.equal(project.notifications.length,1);
},stageIntent));

test('HTML notification bodies become readable text while scripts, styles and markup are omitted',async()=>fixture(async project=>{
  await project.sync();const latest=message(1);latest.bodyStructure={type:'text/html',part:'1'};
  latest.body=Buffer.from('<html><head><style>.secret { color:red }</style></head><body><img src="https://invalid.example/tracking?token=synthetic" alt="远程 > 图片"><script>dangerous()</script><h1>正文标题 &amp; 提醒</h1><p>第一段<br>第二段</p><img src="https://invalid.example/image" alt="远程图片"></body></html>');
  project.folders[0].messages.push(latest);await project.sync();
  const preview=project.notifications[0].details!.preview;
  assert.match(preview,/正文标题 & 提醒/);assert.match(preview,/第一段 第二段/);assert.doesNotMatch(preview,/[<>]|dangerous|\.secret|invalid\.example/);
  assert.equal(project.downloads.length,1);
}));

test('missing BODYSTRUCTURE supports bounded standalone MIME decoding and skips multipart or attachment bodies',async()=>{
  for(const variant of ['quoted-printable','base64-html','multipart','attachment'])await fixture(async project=>{
    await project.sync();const latest=message(1);delete latest.bodyStructure;
    latest.mimeHeaders=Buffer.from(variant==='quoted-printable'?'Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n':variant==='base64-html'?'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n':variant==='multipart'?'Content-Type: multipart/mixed; boundary=synthetic\r\n':'Content-Type: text/plain\r\nContent-Disposition: attachment; filename=secret.txt\r\n');
    latest.body=Buffer.from(variant==='quoted-printable'?'R=E9sum=E9 body':Buffer.from('<img src="https://invalid.example/tracking"><p>中文 &amp; 正文</p>').toString('base64'));
    project.folders[0].messages.push(latest);await project.sync();
    assert.equal(project.downloads.length,0);
    assert.deepEqual(project.fetches[0],{uid:1,query:{headers:['Content-Type','Content-Transfer-Encoding','Content-Disposition']},options:{uid:true}});
    if(variant==='multipart'||variant==='attachment'){
      assert.equal(project.fetches.length,1,'a container or attachment must not trigger a TEXT body read');assert.equal(project.notifications[0].details!.preview,'');
    }else{
      assert.deepEqual(project.fetches[1],{uid:1,query:{bodyParts:[{key:'TEXT',start:0,maxLength:16*1024}]},options:{uid:true}});
      assert.equal(project.notifications[0].details!.preview,variant==='quoted-printable'?'Résumé body':'中文 & 正文');
    }
  });
});

test('body read failure preserves the committed arrival and uses its subject and sender for notification',async()=>fixture(async project=>{
  await project.sync();const latest=message(1);latest.envelope.subject='正文暂不可读取';latest.envelope.from=[{name:'发件人',address:'sender@example.com'}];latest.downloadError=new Error('Synthetic download failure');project.folders[0].messages.push(latest);
  await project.sync();assert.equal(project.notifications.length,1);assert.deepEqual(project.notifications[0].details,{subject:'正文暂不可读取',preview:'',from:{name:'发件人',address:'sender@example.com'}});
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=?').get(project.id)!.n,1);assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM test_notification_intents').get()!.n,1);
},stageIntent));

test('body preview deadlines close stalled streams or late downloads and never block the arrival notification',async()=>{
  for(const variant of ['stream','download'])await fixture(async project=>{
    await project.sync();const latest=message(1);latest.stream=new Readable({read(){}});let release=()=>{};
    if(variant==='download')latest.downloadWait=new Promise<void>(resolve=>{release=resolve;});
    project.folders[0].messages.push(latest);mock.timers.enable({apis:['setTimeout']});
    let syncing:Promise<void>|undefined;
    try{
      syncing=project.sync();for(let i=0;i<40&&!project.downloads.length;i++)await Promise.resolve();
      assert.equal(project.downloads.length,1);for(let i=0;i<5;i++)await Promise.resolve();
      mock.timers.tick(8_000);await syncing;
      assert.equal(project.notifications.length,1);assert.equal(project.notifications[0].details!.preview,'');assert.equal(project.client.usable,false);
      release();for(let i=0;i<10;i++)await Promise.resolve();assert.equal(latest.stream.destroyed,true,'late or stalled streams must be destroyed');
      assert.equal(project.notifications.length,1);
    }finally{release();mock.timers.reset();await syncing;latest.stream.destroy();}
  });
});

test('shutdown during preview preparation leaves the INBOX baseline unchanged so recovery can retry the arrival',async()=>fixture(async project=>{
  project.folders[0].messages=[message(1)];await project.sync();const latest=message(2);latest.body=Buffer.from('停机恢复后的正文');latest.beforeDownload=()=>project.mail.stop();project.folders[0].messages.push(latest);
  await project.sync();assert.equal(project.notifications.length,0);assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM test_notification_intents').get()!.n,0);assert.deepEqual(project.store.db.prepare('SELECT uid FROM messages WHERE account_id=? ORDER BY uid').all(project.id).map(row=>row.uid),[1]);
  delete latest.beforeDownload;await project.restart();await project.sync();assert.equal(project.notifications.length,1);assert.equal(project.notifications[0].details!.preview,'停机恢复后的正文');assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM test_notification_intents').get()!.n,1);
},stageIntent));

test('a late body preview cannot commit after the enclosing IMAP operation has already timed out',async()=>fixture(async project=>{
  project.folders[0].messages=[message(1)];await project.sync();project.folders[0].messages.push(message(2));
  project.store.db.prepare("UPDATE accounts SET imap_host='127.0.0.1' WHERE id=?").run(project.id);
  const synthetic=project.client as unknown as ImapFlow;
  let started=false,release!:(value:{meta:object;content:Readable})=>void;
  const pending=new Promise<{meta:object;content:Readable}>(resolve=>{release=resolve;});
  const mocks=[
    mock.method(ImapFlow.prototype,'connect',async()=>{}),mock.method(ImapFlow.prototype,'close',()=>{}),
    mock.method(ImapFlow.prototype,'list',async()=>synthetic.list()),
    mock.method(ImapFlow.prototype,'getMailboxLock',async function(this:ImapFlow,path:string){const lock=await synthetic.getMailboxLock(path);this.mailbox=synthetic.mailbox;return lock;}),
    mock.method(ImapFlow.prototype,'fetchAll',async(range:string)=>{mock.timers.tick(85_000);return synthetic.fetchAll(range,{uid:true});}),
    mock.method(ImapFlow.prototype,'download',async()=>{started=true;return pending;}),
    mock.method(ImapFlow.prototype,'search',async()=>[]),
    mock.method(ImapFlow.prototype,'status',async(path:string)=>synthetic.status(path,{unseen:true})),
  ];
  (project.mail as unknown as {withClient:unknown}).withClient=(MailService.prototype as unknown as {withClient:unknown}).withClient;
  mock.timers.enable({apis:['setTimeout']});const lateStream=Readable.from(Buffer.from('Late body'));let syncing:Promise<void>|undefined;
  try{
    syncing=project.sync();for(let i=0;i<80&&!started;i++)await Promise.resolve();assert.equal(started,true);
    mock.timers.tick(5_000);await syncing;
    mock.timers.tick(3_000);for(let i=0;i<30;i++)await Promise.resolve();
    assert.deepEqual(project.store.db.prepare('SELECT uid FROM messages WHERE account_id=? ORDER BY uid').all(project.id).map(row=>row.uid),[1],'completion after the 90-second owner timeout must not advance the cache');
    assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM test_notification_intents').get()!.n,0);assert.equal(project.notifications.length,0);
    release({meta:{},content:lateStream});for(let i=0;i<10;i++)await Promise.resolve();assert.equal(lateStream.destroyed,true);
  }finally{release({meta:{},content:lateStream});mock.timers.reset();await syncing;lateStream.destroy();for(const method of mocks)method.mock.restore();}
},stageIntent));
