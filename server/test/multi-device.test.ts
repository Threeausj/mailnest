import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
import type {ImapFlow} from 'imapflow';
import webPush from 'web-push';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {SecretBox} from '../src/security.js';
import type {AccountRow} from '../src/db.js';
import type {Credentials,MailNotificationDetails} from '../src/mail.js';

type Project=Awaited<ReturnType<typeof buildApp>>;
type PushCall=Parameters<typeof webPush.sendNotification>;
interface Event {name:string;data:Record<string,unknown>}
interface Capture {events:Event[];wait:(name:string,predicate?:(data:Record<string,unknown>)=>boolean)=>Promise<Event>;close:()=>Promise<void>}
interface Fixture {project:Project;userId:string;foreignId:string;accountId:string;cookie:string;secondCookie:string;first:Capture;second:Capture;foreign:Capture;calls:PushCall[];pushFailures:Map<string,unknown>;transport:{unread:number;flagsError?:Error;smtpError?:Error};flags:Map<number,Set<string>>}
const origin='http://localhost:5173',password='SyntheticMultiDevice2026!',secretBox=new SecretBox('c'.repeat(64));
const keys={p256dh:'A'.repeat(87),auth:'a'.repeat(22)},vapid=webPush.generateVAPIDKeys();
async function capture(address:string,cookie:string):Promise<Capture> {
  const controller=new AbortController(),response=await fetch(`${address}/api/v1/events`,{headers:{cookie},signal:controller.signal});assert.equal(response.status,200);
  const reader=response.body!.getReader(),decoder=new TextDecoder(),events:Event[]=[];
  const listeners=new Set<()=>void>();let buffer='';
  const pumping=(async()=>{
    try{while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let end:number;
      while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const match=/event: (\w+)\ndata: (.+)/.exec(frame);if(match){events.push({name:match[1],data:JSON.parse(match[2])});for(const listener of listeners)listener();}}
    }}catch(error){if(!controller.signal.aborted)throw error;}
  })();
  const result:Capture={events,wait:(name,predicate=()=>true)=>{
    const existing=events.find(event=>event.name===name&&predicate(event.data));if(existing)return Promise.resolve(existing);
    return new Promise<Event>((resolve,reject)=>{
      const check=()=>{const found=events.find(event=>event.name===name&&predicate(event.data));if(found){clearTimeout(timer);listeners.delete(check);resolve(found);}};
      const timer=setTimeout(()=>{listeners.delete(check);reject(new Error(`Missing synthetic ${name} event`));},2000);listeners.add(check);
    });
  },close:async()=>{controller.abort();await reader.cancel().catch(()=>{});await pumping;}};
  await result.wait('ready');return result;
}
async function fixture(run:(f:Fixture)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-multi-device-')),calls:PushCall[]=[],pushFailures=new Map<string,unknown>();
  const lookup=mock.method(dnsPromises,'lookup',async()=>{throw new Error('Multi-device tests must not contact external services');});
  const originalLookup=dns.lookup,callbackLookup=mock.method(dns,'lookup',(...args:unknown[])=>{if(args[0]==='127.0.0.1')return Reflect.apply(originalLookup,dns,args);throw new Error('Only the isolated SSE listener may use DNS');});
  const send=mock.method(webPush,'sendNotification',async(...args:PushCall)=>{calls.push(args);if(pushFailures.has(args[0].endpoint))throw pushFailures.get(args[0].endpoint);return{statusCode:201,body:'',headers:{}};});syncBuiltinESMExports();
  let project:Project|undefined;const captures:Capture[]=[];
  try {
    project=await buildApp({...loadConfig({APP_URL:origin,DATA_DIR:directory,ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:password,ENCRYPTION_KEY:'c'.repeat(64),VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey}),background:false});
    const login=async(email:string)=>{const response=await project!.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email,password}});assert.equal(response.statusCode,200,response.body);return{userId:response.json().user.id,cookie:response.headers['set-cookie']!.toString().split(';')[0]};};
    const firstLogin=await login('owner@example.com'),secondLogin=await login('owner@example.com'),foreignId=randomUUID();
    project.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(foreignId,'foreign@example.com','Foreign owner',project.store.user(firstLogin.userId)!.password_hash);
    const foreignLogin=await login('foreign@example.com'),accountId=seedAccount(project,firstLogin.userId,'Owner',3);seedAccount(project,foreignId,'Foreign',100);
    const transport:Fixture['transport']={unread:3},flags=new Map<number,Set<string>>([[1,new Set()],[2,new Set()]]);
    let selected='INBOX';
    const client={usable:true,mailbox:{uidValidity:1n,exists:2},list:async()=>[{path:'INBOX',name:'INBOX',flags:new Set()},{path:'Trash',name:'Trash',flags:new Set()},{path:'Sent',name:'Sent',flags:new Set()}],getMailboxLock:async(folder:string)=>{selected=folder;return{release(){}};},fetchOne:async(uid:number)=>({uid,flags:flags.get(uid)||new Set()}),messageFlagsAdd:async(uid:number,values:string[])=>{
      if(transport.flagsError)throw transport.flagsError;const current=flags.get(uid)!;for(const value of values){if(value==='\\Seen'&&!current.has(value))transport.unread--;current.add(value);}return true;
    },messageFlagsRemove:async(uid:number,values:string[])=>{if(transport.flagsError)throw transport.flagsError;const current=flags.get(uid)!;for(const value of values){if(value==='\\Seen'&&current.has(value))transport.unread++;current.delete(value);}return true;},status:async()=>({unseen:transport.unread}),messageMove:async(uid:number,destination:string)=>{if(selected==='INBOX'&&destination!=='INBOX'&&!flags.get(uid)!.has('\\Seen'))transport.unread--;return{uidValidity:1n,uidMap:new Map([[uid,uid]])};},append:async()=>({uidValidity:1n,uid:1}),close(){}};
    const mail=project.mail as unknown as {withClient:(account:AccountRow,credentials:Credentials,work:(client:ImapFlow)=>Promise<unknown>)=>Promise<unknown>;smtp:(account:AccountRow,credentials:Credentials)=>Promise<object>};
    mail.withClient=async(_account,_credentials,work)=>work(client as unknown as ImapFlow);
    mail.smtp=async()=>({sendMail:async()=>{if(transport.smtpError)throw transport.smtpError;return{accepted:['recipient@example.com'],messageId:'<synthetic-sent@example.com>'};},close(){}});project.mail.schedule=()=>{};
    const address=await project.app.listen({host:'127.0.0.1',port:0});
    const first=await capture(address,firstLogin.cookie);captures.push(first);const second=await capture(address,secondLogin.cookie);captures.push(second);const foreign=await capture(address,foreignLogin.cookie);captures.push(foreign);
    await run({project,userId:firstLogin.userId,foreignId,accountId,cookie:firstLogin.cookie,secondCookie:secondLogin.cookie,first,second,foreign,calls,pushFailures,transport,flags});
    assert.equal(lookup.mock.callCount(),0);assert.ok(callbackLookup.mock.calls.every(call=>call.arguments[0]==='127.0.0.1'));
  }finally{for(const item of captures)await item.close();await project?.app.close();send.mock.restore();lookup.mock.restore();callbackLookup.mock.restore();syncBuiltinESMExports();await rm(directory,{recursive:true,force:true});}
}
function seedAccount(project:Project,userId:string,name:string,unread:number) {
  const id=randomUUID();project.store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials,unread) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,name,`${id}@example.com`,'#1677ff','imap','synthetic','synthetic','imap.example.com',993,1,'smtp.example.com',465,1,secretBox.encrypt({password:'synthetic-mail-secret'}),unread);return id;
}
function seedMessage(f:Fixture,uid:number) {const id=randomUUID();f.project.store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(id,f.accountId,'INBOX',uid,'1',JSON.stringify({from:{name:'Synthetic sender',address:'sender@example.com'},to:[],cc:[],subject:'Synthetic state',preview:'Synthetic content',date:'2026-01-01',hasAttachments:false,size:100}),1,0,'2026-01-01');return id;}
function mutate(f:Fixture,method:'PATCH'|'POST'|'DELETE',url:string,payload?:object) {return f.project.app.inject({method,url,headers:{cookie:f.cookie,origin},payload});}
async function changeOnBoth(f:Fixture,action:string,messageId?:string) {const predicate=(data:Record<string,unknown>)=>data.action===action&&(!messageId||data.messageId===messageId);const [first,second]=await Promise.all([f.first.wait('change',predicate),f.second.wait('change',predicate)]);assert.deepEqual(first,second);return first.data;}

test('one new-mail batch fans out to every registered owner device with the same ID and badge, independently of login sessions',async()=>fixture(async f=>{
  const register=async(cookie:string,name:string)=>{const endpoint=`https://fcm.googleapis.com/fcm/send/synthetic-${name}`;const response=await f.project.app.inject({method:'POST',url:'/api/v1/push/subscriptions',headers:{cookie,origin},payload:{endpoint,keys}});assert.equal(response.statusCode,200,response.body);return endpoint;};
  const first=await register(f.cookie,'one'),second=await register(f.secondCookie,'two');await register(f.cookie,'one');
  const foreignEndpoint='https://fcm.googleapis.com/fcm/send/synthetic-foreign';f.project.store.db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?)').run(foreignEndpoint,f.foreignId,JSON.stringify({endpoint:foreignEndpoint,keys}));
  assert.equal(f.project.store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').get(f.userId)!.n,2);
  const thirdLogin=await f.project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'owner@example.com',password}});assert.equal(thirdLogin.statusCode,200);assert.equal(f.project.store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').get(f.userId)!.n,2,'logging in does not create a push permission or subscription');
  const notificationId=randomUUID(),notification:MailNotificationDetails={subject:'跨设备邮件提醒',preview:'所有已开启提醒的设备收到相同批次。',from:{name:'Synthetic sender',address:'sender@example.com'}};
  const hooks=f.project.mail as unknown as {notify:(userId:string,accountId:string,count:number,id:string,details:MailNotificationDetails)=>Promise<void>;emit:(userId:string,event:string,data:unknown)=>void};
  hooks.emit(f.userId,'mail',{accountId:f.accountId,count:2,notificationId,notification});await hooks.notify(f.userId,f.accountId,2,notificationId,notification);
  const events=await Promise.all([f.first.wait('mail'),f.second.wait('mail')]);assert.deepEqual(events[0],events[1]);assert.equal(events[0].data.unreadCount,3);
  assert.deepEqual(f.calls.map(call=>call[0].endpoint).sort(),[first,second].sort());
  for(const call of f.calls){const notice=JSON.parse(String(call[1]));assert.equal(notice.notificationId,notificationId);assert.equal(notice.unreadCount,3);assert.equal(notice.title,notification.subject);}
  assert.equal(f.calls[0][2]!.topic,f.calls[1][2]!.topic);await hooks.notify(f.userId,f.accountId,2,notificationId,notification);assert.equal(f.calls.length,2,'repeated batches cannot duplicate a device delivery');
  await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(f.foreign.events.map(event=>event.name),['ready']);
}));

test('read, star and move actions promptly update both sessions and the full remote inbox count without sending a new-mail push',async()=>fixture(async f=>{
  const firstId=seedMessage(f,1),secondId=seedMessage(f,2);
  const read=await mutate(f,'PATCH',`/api/v1/messages/${firstId}`,{unread:false});assert.equal(read.statusCode,200,read.body);
  const changed=await changeOnBoth(f,'message-updated',firstId);assert.equal((changed.message as {unread:boolean}).unread,false);assert.equal(changed.unreadCount,2);assert.equal(f.project.store.account(f.accountId)!.unread,2,'retain the uncached remote unread message');
  const star=await mutate(f,'PATCH',`/api/v1/messages/${firstId}`,{starred:true});assert.equal(star.statusCode,200,star.body);
  await Promise.all([f.first.wait('change',data=>(data.message as {starred?:boolean})?.starred===true),f.second.wait('change',data=>(data.message as {starred?:boolean})?.starred===true)]);
  const moved=await mutate(f,'POST',`/api/v1/messages/${secondId}/move`,{destination:'trash'});assert.equal(moved.statusCode,200,moved.body);
  const removed=await changeOnBoth(f,'message-moved',secondId);assert.equal(removed.unreadCount,1);assert.equal(f.project.store.account(f.accountId)!.unread,1);assert.equal(f.project.store.message(secondId,f.userId),undefined);
  assert.equal(f.calls.length,0,'state changes must not generate new-mail system notifications');
  await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(f.foreign.events.map(event=>event.name),['ready']);
}));

test('one unavailable device retries independently without resending the accepted device notification',async()=>fixture(async f=>{
  const accepted='https://fcm.googleapis.com/fcm/send/synthetic-accepted',retry='https://fcm.googleapis.com/fcm/send/synthetic-retry';
  for(const endpoint of [accepted,retry])f.project.store.db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?)').run(endpoint,f.userId,JSON.stringify({endpoint,keys}));
  const notificationId=randomUUID();f.pushFailures.set(retry,{statusCode:503});
  const hooks=f.project.mail as unknown as {notify:(userId:string,accountId:string,count:number,id:string)=>Promise<void>};
  await hooks.notify(f.userId,f.accountId,1,notificationId);assert.equal(f.calls.length,2);assert.equal(f.project.pushQueue.stats(f.userId).accepted,1);assert.equal(f.project.pushQueue.stats(f.userId).pending,1);
  f.pushFailures.clear();f.project.store.db.prepare('UPDATE push_deliveries SET next_attempt_at=0').run();await f.project.pushQueue.flush();
  assert.equal(f.calls.length,3);assert.equal(f.calls[2][0].endpoint,retry);assert.equal(JSON.parse(String(f.calls[2][1])).notificationId,notificationId);assert.equal(f.project.pushQueue.stats(f.userId).accepted,2);assert.equal(f.project.pushQueue.stats(f.userId).pending,0);
}));

test('sending and account configuration changes refresh all owner sessions while failed mutations stay silent',async()=>fixture(async f=>{
  const id=seedMessage(f,1),before=f.first.events.length;
  f.transport.flagsError=Object.assign(new Error('synthetic rejected flags'),{code:'EAUTH'});const failed=await mutate(f,'PATCH',`/api/v1/messages/${id}`,{unread:false});assert.equal(failed.statusCode,400);assert.equal(f.first.events.length,before);delete f.transport.flagsError;
  const renamed=await mutate(f,'PATCH',`/api/v1/accounts/${f.accountId}`,{name:'Updated across devices'});assert.equal(renamed.statusCode,200,renamed.body);await changeOnBoth(f,'accounts-updated');
  const sent=await mutate(f,'POST','/api/v1/messages/send',{accountId:f.accountId,to:'recipient@example.com',subject:'Synthetic sent state',text:'No real remote SMTP is used.'});assert.equal(sent.statusCode,200,sent.body);const event=await changeOnBoth(f,'message-sent');assert.equal(event.unreadCount,3);
  f.transport.smtpError=Object.assign(new Error('synthetic rejected SMTP'),{code:'EAUTH'});const count=f.first.events.filter(event=>event.name==='change'&&event.data.action==='message-sent').length;
  const failedSend=await mutate(f,'POST','/api/v1/messages/send',{accountId:f.accountId,to:'recipient@example.com',subject:'Synthetic failure',text:'No real remote SMTP is used.'});assert.equal(failedSend.statusCode,400);
  assert.equal(f.first.events.filter(event=>event.name==='change'&&event.data.action==='message-sent').length,count);assert.equal(f.calls.length,0);
  const removed=await mutate(f,'DELETE',`/api/v1/accounts/${f.accountId}`);assert.equal(removed.statusCode,200);await f.second.wait('change',data=>data.action==='accounts-updated'&&data.unreadCount===0);
  await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(f.foreign.events.map(event=>event.name),['ready']);
}));
