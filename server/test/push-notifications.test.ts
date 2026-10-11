import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
import webPush from 'web-push';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {hashToken} from '../src/security.js';
import type {MailNotificationDetails} from '../src/mail.js';

type Project=Awaited<ReturnType<typeof buildApp>>;
type SendParameters=Parameters<typeof webPush.sendNotification>;
type MailHooks={notify:(userId:string,accountId:string,count:number,notificationId?:string,details?:MailNotificationDetails)=>Promise<void>;stageNotification:(userId:string,accountId:string,count:number,notificationId:string,details?:MailNotificationDetails)=>void;emit:(userId:string,event:string,data:unknown)=>void};
interface Delivery {calls:SendParameters[];error?:unknown;wait?:Promise<void>;onSend?:()=>void}
const origin='http://localhost:5173';
const password='NotificationTest2026!';
const vapid=webPush.generateVAPIDKeys();
const keys={p256dh:'A'.repeat(87),auth:'a'.repeat(22)};
const endpoint=(name:string)=>`https://fcm.googleapis.com/fcm/send/synthetic-${name}`;
async function fixture(run:(project:Project,userId:string,cookie:string,delivery:Delivery)=>Promise<void>,configured=true) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-notifications-'));
  const delivery:Delivery={calls:[]};
  const lookup=mock.method(dnsPromises,'lookup',async()=>{throw new Error('Push endpoints must not receive a DNS/IP precheck');});
  const originalLookup=dns.lookup;
  const callbackLookup=mock.method(dns,'lookup',(...args:unknown[])=>{if(args[0]==='127.0.0.1')return Reflect.apply(originalLookup,dns,args);throw new Error('Push tests must not contact real providers');});
  const send=mock.method(webPush,'sendNotification',async(...args:SendParameters)=>{
    delivery.calls.push(args);delivery.onSend?.();await delivery.wait;
    if(Object.hasOwn(delivery,'error'))throw delivery.error;
    return{statusCode:201,body:'',headers:{}};
  });
  syncBuiltinESMExports();
  let project:Project|undefined;
  try {
    project=await buildApp({...loadConfig({APP_URL:origin,DATA_DIR:directory,ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:password,ENCRYPTION_KEY:'a'.repeat(64),ALLOW_PRIVATE_MAIL_HOSTS:'false',VAPID_PUBLIC_KEY:configured?vapid.publicKey:'',VAPID_PRIVATE_KEY:configured?vapid.privateKey:''}),background:false});
    const login=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'owner@example.com',password}});
    assert.equal(login.statusCode,200);
    await run(project,login.json().user.id,login.headers['set-cookie']!.toString().split(';')[0],delivery);
    assert.equal(lookup.mock.callCount(),0);assert.ok(callbackLookup.mock.calls.every(call=>call.arguments[0]==='127.0.0.1'),'only the isolated loopback SSE listener may invoke callback DNS');
  }finally{await project?.app.close();lookup.mock.restore();callbackLookup.mock.restore();send.mock.restore();syncBuiltinESMExports();await rm(directory,{recursive:true,force:true});}
}
function seedSubscription(project:Project,userId:string,url:string) {
  project.store.db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?)').run(url,userId,JSON.stringify({endpoint:url,keys}));
}
function seedAccount(project:Project,userId:string,unread:number) {
  const id=randomUUID();
  project.store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials,unread) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,'Synthetic account',`${id}@example.com`,'#1677ff','imap','synthetic','synthetic','imap.example.com',993,1,'smtp.example.com',465,1,'not-real-credentials',unread);
  return id;
}
function foreignUser(project:Project) {
  const id=randomUUID();project.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,`${id}@example.com`,'Synthetic foreign owner','not-a-login-hash');return id;
}
function sendTest(project:Project,cookie:string,url:string) {
  return project.app.inject({method:'POST',url:'/api/v1/push/test',headers:{cookie,origin},payload:{endpoint:url}});
}
function payload(call:SendParameters) {return JSON.parse(String(call[1])) as {unreadCount:number;title:string;body:string;url:string;tag:string;notificationId?:string};}
function assertDeliveryOptions(call:SendParameters) {
  const notificationId=payload(call).notificationId;
  assert.match(notificationId||'',/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
  assert.ok(Number.isInteger(call[2]?.TTL)&&call[2]!.TTL!>0&&call[2]!.TTL!<=3600);
  assert.deepEqual(call[2],{TTL:call[2]!.TTL,timeout:10_000,contentEncoding:'aes128gcm',urgency:'high',topic:createHash('sha256').update(notificationId!).digest('base64url').slice(0,32)});
}

test('explicit test sends only to the selected owned device, keeps unread state and excludes duplicate labels and other owners',async()=>fixture(async(project,userId,cookie,delivery)=>{
  const first=seedAccount(project,userId,3);seedAccount(project,userId,4);seedAccount(project,userId,0);seedAccount(project,foreignUser(project),500);
  for(let i=0;i<9;i++)project.store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(`duplicate-${i}`,first,i%2?'INBOX':'[Gmail]/All Mail',i+1,'1','{}',1,0,'2026-01-01');
  const selected=endpoint('selected'),other=endpoint('other');seedSubscription(project,userId,selected);seedSubscription(project,userId,other);
  const before=project.store.db.prepare('SELECT id,unread FROM accounts ORDER BY id').all();
  const response=await sendTest(project,cookie,selected);
  assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{ok:true,accepted:true});assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(delivery.calls.length,1);assert.equal(delivery.calls[0][0].endpoint,selected);assertDeliveryOptions(delivery.calls[0]);
  assert.deepEqual(payload(delivery.calls[0]),{title:'MailNest 测试通知',body:'邮件提醒测试成功。',url:'/',tag:'mailnest-test',notificationId:payload(delivery.calls[0]).notificationId,unreadCount:7});
  assert.deepEqual(project.store.db.prepare('SELECT id,unread FROM accounts ORDER BY id').all(),before);
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n,9);
  assert.equal(response.body.includes(selected),false);assert.equal(response.body.includes(keys.auth),false);
}));

test('push test retains authentication, origin, provider URL validation and indistinguishable missing/foreign ownership errors',async()=>fixture(async(project,userId,cookie,delivery)=>{
  const owned=endpoint('owned'),foreign=endpoint('foreign');seedSubscription(project,userId,owned);seedSubscription(project,foreignUser(project),foreign);
  const anonymous=await project.app.inject({method:'POST',url:'/api/v1/push/test',headers:{origin},payload:{endpoint:owned}});assert.equal(anonymous.statusCode,401);
  const invalidOrigin=await project.app.inject({method:'POST',url:'/api/v1/push/test',headers:{cookie,origin:'https://attacker.example'},payload:{endpoint:owned}});assert.equal(invalidOrigin.statusCode,403);
  for(const url of ['http://fcm.googleapis.com/synthetic','https://attacker.example/synthetic','https://fcm.googleapis.com.attacker.example/synthetic','https://fcm.googleapis.com:444/synthetic','https://private:secret@fcm.googleapis.com/synthetic','https://127.0.0.1/synthetic']){
    const response=await sendTest(project,cookie,url);assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'INVALID_PUSH_ENDPOINT');assert.equal(response.body.includes('private:secret'),false);
  }
  const badBody=await project.app.inject({method:'POST',url:'/api/v1/push/test',headers:{cookie,origin},payload:{endpoint:owned,keys}});assert.equal(badBody.statusCode,400);assert.equal(badBody.json().error.code,'VALIDATION_ERROR');
  const unknown=await sendTest(project,cookie,endpoint('unknown')),notOwned=await sendTest(project,cookie,foreign);
  assert.equal(unknown.statusCode,404);assert.deepEqual(notOwned.json(),unknown.json());assert.equal(notOwned.statusCode,404);assert.equal(unknown.json().error.code,'PUSH_SUBSCRIPTION_NOT_FOUND');
  assert.equal(delivery.calls.length,0);assert.ok(project.store.db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(foreign));
  const token='synthetic-notification-token';project.store.db.prepare('INSERT INTO api_tokens VALUES(?,?,?,?,?,?)').run(randomUUID(),userId,'Synthetic API client',hashToken(token),'2026-01-01',null);
  const accepted=await project.app.inject({method:'POST',url:'/api/v1/push/test',headers:{authorization:`Bearer ${token}`},payload:{endpoint:owned}});assert.equal(accepted.statusCode,200);assert.equal(payload(delivery.calls[0]).unreadCount,0);
}));

test('push tests enforce a shared per-user cooldown before concurrent delivery and allow retry at fifteen seconds',async()=>fixture(async(project,userId,cookie,delivery)=>{
  const selected=endpoint('rate-first'),other=endpoint('rate-second');seedSubscription(project,userId,selected);seedSubscription(project,userId,other);
  let now=Date.now(),release!:()=>void,started!:()=>void;
  const date=mock.method(Date,'now',()=>now);
  delivery.wait=new Promise<void>(resolve=>{release=resolve;});const pending=new Promise<void>(resolve=>{started=resolve;});delivery.onSend=started;
  let first:ReturnType<typeof sendTest>|undefined;
  try {
    first=sendTest(project,cookie,selected);await pending;
    const limited=await sendTest(project,cookie,other);assert.equal(limited.statusCode,429);assert.equal(limited.json().error.code,'PUSH_TEST_RATE_LIMIT');assert.equal(limited.headers['retry-after'],'15');assert.equal(delivery.calls.length,1);
    now+=14_999;const nearly=await sendTest(project,cookie,other);assert.equal(nearly.statusCode,429);assert.equal(nearly.headers['retry-after'],'1');
    release();assert.equal((await first).statusCode,200);now+=1;delete delivery.wait;
    assert.equal((await sendTest(project,cookie,other)).statusCode,200);assert.equal(delivery.calls.length,2);
    for(const call of delivery.calls){assertDeliveryOptions(call);assert.equal(payload(call).tag,'mailnest-test');}
    assert.notEqual(payload(delivery.calls[0]).notificationId,payload(delivery.calls[1]).notificationId);assert.notEqual(delivery.calls[0][2]!.topic,delivery.calls[1][2]!.topic);
  }finally{release();await first;date.mock.restore();}
}));

test('expired provider subscriptions are removed only for the selected device; temporary errors stay private and can be retried',async()=>{
  for(const statusCode of [404,410,429,500,503,undefined])await fixture(async(project,userId,cookie,delivery)=>{
    const selected=endpoint(`failure-${statusCode}`),other=endpoint('retained');seedSubscription(project,userId,selected);seedSubscription(project,userId,other);
    delivery.error=Object.assign(new Error(`provider secret ${selected} ${keys.auth}`),{statusCode,body:'sensitive provider response'});
    const response=await sendTest(project,cookie,selected),expired=statusCode===404||statusCode===410;
    assert.equal(response.statusCode,expired?410:503);assert.equal(response.json().error.code,expired?'PUSH_SUBSCRIPTION_EXPIRED':'PUSH_DELIVERY_FAILED');
    for(const secret of [selected,keys.auth,'sensitive provider response','provider secret'])assert.equal(response.body.includes(secret),false);
    assert.equal(!!project.store.db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(selected),!expired);assert.ok(project.store.db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(other));
    assert.equal(delivery.calls.length,1);
    if(!expired){const now=Date.now();const date=mock.method(Date,'now',()=>now+15_000);try{delete delivery.error;assert.equal((await sendTest(project,cookie,selected)).statusCode,200);assert.equal(delivery.calls.length,2);}finally{date.mock.restore();}}
  });
});

test('test notification requires VAPID configuration and protects a re-registered subscription while its old request expires',async()=>{
  await fixture(async(project,userId,cookie,delivery)=>{const selected=endpoint('unconfigured');seedSubscription(project,userId,selected);const response=await sendTest(project,cookie,selected);assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'PUSH_NOT_CONFIGURED');assert.equal(delivery.calls.length,0);},false);
  await fixture(async(project,userId,cookie,delivery)=>{
    const selected=endpoint('refreshed');seedSubscription(project,userId,selected);
    delivery.onSend=()=>{project.store.db.prepare('UPDATE push_subscriptions SET subscription=? WHERE endpoint=?').run(JSON.stringify({endpoint:selected,keys:{p256dh:'B'.repeat(87),auth:'b'.repeat(22)}}),selected);};
    delivery.error={statusCode:410};const response=await sendTest(project,cookie,selected);assert.equal(response.statusCode,410);assert.ok(project.store.db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(selected),'expiration of the old keys must not erase a newly registered subscription');
  });
});

test('normal mail notifications include the total inbox unread count and keep expiration cleanup owner-scoped',async()=>fixture(async(project,userId,_cookie,delivery)=>{
  const account=seedAccount(project,userId,12);seedAccount(project,userId,8);const foreign=foreignUser(project);seedAccount(project,foreign,1000);
  const first=endpoint('normal-first'),second=endpoint('normal-second'),outside=endpoint('outside');seedSubscription(project,userId,first);seedSubscription(project,userId,second);seedSubscription(project,foreign,outside);
  const hooks=project.mail as unknown as MailHooks;
  const notificationId=randomUUID();
  await hooks.notify(userId,account,2,notificationId);assert.deepEqual(delivery.calls.map(call=>call[0].endpoint).sort(),[first,second].sort());
  for(const call of delivery.calls){assertDeliveryOptions(call);assert.equal(payload(call).unreadCount,20);assert.equal(payload(call).body,'有 2 封新邮件等待查看');assert.equal(payload(call).notificationId,notificationId);assert.equal(payload(call).tag,`mail-${account}`);}
  delivery.error={statusCode:410};await hooks.notify(userId,account,1);
  assert.notEqual(payload(delivery.calls[2]).notificationId,notificationId);assert.equal(payload(delivery.calls[2]).notificationId,payload(delivery.calls[3]).notificationId);
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').get(userId)!.n,0);assert.ok(project.store.db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(outside));
}));

test('normal mail notifications show the latest subject, sender and plain-text preview with a multi-mail count',async()=>fixture(async(project,userId,_cookie,delivery)=>{
  const account=seedAccount(project,userId,5),selected=endpoint('content-preview');seedSubscription(project,userId,selected);
  const hooks=project.mail as unknown as MailHooks,notificationId=randomUUID();
  const details:MailNotificationDetails={subject:' 本周项目进度\r\n汇总 ',preview:' 设计已完成。\n请查收附件，明天一起确认。 ',from:{name:' 林同学\t ',address:'sender@example.com'}};
  await hooks.notify(userId,account,3,notificationId,details);
  assert.equal(delivery.calls.length,1);assertDeliveryOptions(delivery.calls[0]);
  assert.deepEqual(payload(delivery.calls[0]),{title:'本周项目进度 汇总',body:'林同学：设计已完成。 请查收附件，明天一起确认。 · 另有 2 封新邮件',url:`/?account=${account}`,tag:`mail-${account}`,notificationId,unreadCount:5});
  assert.equal(String(delivery.calls[0][1]).includes('sender@example.com'),false,'prefer the friendly sender name');
  await hooks.notify(userId,account,1,randomUUID(),{subject:'直接回复',preview:'邮件内容',from:{name:'',address:'sender@example.com'}});
  assert.equal(payload(delivery.calls[1]).body,'sender@example.com：邮件内容');
}));

test('empty subject, sender and preview retain useful fallback text while explicit tests keep their semantics',async()=>fixture(async(project,userId,cookie,delivery)=>{
  const account=seedAccount(project,userId,1),selected=endpoint('empty-preview');seedSubscription(project,userId,selected);
  const hooks=project.mail as unknown as MailHooks;
  await hooks.notify(userId,account,1,randomUUID(),{subject:' \r\n',preview:'\u0000\t',from:{name:' ',address:''}});
  assert.equal(payload(delivery.calls[0]).title,'无主题');assert.equal(payload(delivery.calls[0]).body,'未知发件人：（无正文摘要）');
  await hooks.notify(userId,account,2);assert.equal(payload(delivery.calls[1]).title,'MailNest 新邮件');assert.equal(payload(delivery.calls[1]).body,'有 2 封新邮件等待查看');
  const response=await sendTest(project,cookie,selected);assert.equal(response.statusCode,200);assert.equal(payload(delivery.calls[2]).title,'MailNest 测试通知');assert.equal(payload(delivery.calls[2]).body,'邮件提醒测试成功。');
}));

test('long Unicode previews fit the Web Push payload budget and never cut an emoji surrogate pair',async()=>fixture(async(project,userId,_cookie,delivery)=>{
  const account=seedAccount(project,userId,1);seedSubscription(project,userId,endpoint('unicode-budget'));
  const hooks=project.mail as unknown as MailHooks;
  await hooks.notify(userId,account,200,randomUUID(),{subject:'主题🚀'.repeat(1000),preview:'正文😀\\"'.repeat(1000),from:{name:'寄件人🎈'.repeat(1000),address:'synthetic@example.com'}});
  const notice=payload(delivery.calls[0]);assert.equal(Array.from(notice.title).length,120);assert.ok(notice.title.endsWith('…'));assert.ok(notice.body.includes(' · 另有 199 封新邮件'));
  assert.ok(Buffer.byteLength(String(delivery.calls[0][1]),'utf8')<3000,'leave space for Web Push encryption overhead below 4 KB');
  for(const value of [notice.title,notice.body])assert.equal(value.isWellFormed(),true);
  assert.equal(notice.body.includes('\n'),false);assert.equal(notice.body.includes('\u0000'),false);
}));

test('transactionally staged previews survive retries unchanged while IDs deduplicate and current unread badges refresh',async()=>fixture(async(project,userId,_cookie,delivery)=>{
  const account=seedAccount(project,userId,4);seedSubscription(project,userId,endpoint('durable-preview'));
  const hooks=project.mail as unknown as MailHooks,notificationId=randomUUID();
  const details:MailNotificationDetails={subject:'已持久化的主题',preview:'这段摘要只生成一次。',from:{name:'联系人',address:'synthetic@example.com'}};
  project.store.db.exec('BEGIN IMMEDIATE');hooks.stageNotification(userId,account,1,notificationId,details);project.store.db.exec('COMMIT');assert.equal(delivery.calls.length,0);
  const staged=project.store.db.prepare('SELECT payload FROM push_deliveries WHERE notification_id=?').get(notificationId) as {payload:string};assert.equal(JSON.parse(staged.payload).title,details.subject);
  delivery.error={statusCode:503};await hooks.notify(userId,account,1,notificationId,{...details,subject:'不会覆盖入队的内容'});assert.equal(payload(delivery.calls[0]).title,details.subject);
  project.store.db.prepare('UPDATE accounts SET unread=1 WHERE id=?').run(account);project.store.db.prepare('UPDATE push_deliveries SET next_attempt_at=0').run();delete delivery.error;await project.pushQueue.flush();
  assert.equal(delivery.calls.length,2);assert.equal(payload(delivery.calls[1]).title,details.subject);assert.equal(payload(delivery.calls[1]).body,'联系人：这段摘要只生成一次。');assert.equal(payload(delivery.calls[1]).unreadCount,1);assert.equal(payload(delivery.calls[1]).notificationId,notificationId);
  await hooks.notify(userId,account,1,notificationId,details);assert.equal(delivery.calls.length,2);
}));

test('provider topics are stable for one notification batch and distinct for later mail and explicit tests',async()=>fixture(async(project,userId,cookie,delivery)=>{
  const account=seedAccount(project,userId,2),selected=endpoint('batch-topics');seedSubscription(project,userId,selected);
  const hooks=project.mail as unknown as MailHooks,firstId=randomUUID(),nextId=randomUUID();
  await hooks.notify(userId,account,1,firstId);await hooks.notify(userId,account,1,firstId);await hooks.notify(userId,account,1,nextId);
  assert.equal((await sendTest(project,cookie,selected)).statusCode,200);assert.equal(delivery.calls.length,3);
  for(const call of delivery.calls)assertDeliveryOptions(call);
  assert.notEqual(delivery.calls[0][2]!.topic,delivery.calls[1][2]!.topic);assert.notEqual(delivery.calls[1][2]!.topic,delivery.calls[2][2]!.topic);
  assert.equal(payload(delivery.calls[0]).tag,`mail-${account}`);assert.equal(payload(delivery.calls[1]).tag,`mail-${account}`);assert.equal(payload(delivery.calls[2]).tag,'mailnest-test');
  assert.notEqual(payload(delivery.calls[2]).notificationId,firstId);assert.notEqual(payload(delivery.calls[2]).notificationId,nextId);
  assert.equal(payload(delivery.calls[2]).unreadCount,2);
}));

test('new-mail retries keep the original ID but refresh the inbox badge from current account state',async()=>fixture(async(project,userId,_cookie,delivery)=>{
  const account=seedAccount(project,userId,7),selected=endpoint('retry-current-badge');seedSubscription(project,userId,selected);
  const hooks=project.mail as unknown as MailHooks,notificationId=randomUUID();
  delivery.error={statusCode:503,headers:{'retry-after':'15'}};
  await hooks.notify(userId,account,1,notificationId);
  assert.equal(delivery.calls.length,1);assert.equal(payload(delivery.calls[0]).unreadCount,7);
  assert.equal(project.pushQueue.stats(userId).retrying,1);
  project.store.db.prepare('UPDATE accounts SET unread=0 WHERE id=?').run(account);
  project.store.db.prepare("UPDATE push_deliveries SET next_attempt_at=0 WHERE status='pending'").run();
  delete delivery.error;await project.pushQueue.flush();
  assert.equal(delivery.calls.length,2);assert.equal(payload(delivery.calls[1]).unreadCount,0);
  assert.equal(payload(delivery.calls[1]).notificationId,notificationId);assert.equal(delivery.calls[1][2]!.topic,delivery.calls[0][2]!.topic);
  assert.equal(project.pushQueue.stats(userId).accepted,1);assert.equal(project.pushQueue.stats(userId).pending,0);
  await hooks.notify(userId,account,1,notificationId);assert.equal(delivery.calls.length,2);
}));

test('SSE ready and account updates include the current scoped unread total without remote mail access',async()=>fixture(async(project,userId,cookie)=>{
  const first=seedAccount(project,userId,3),second=seedAccount(project,userId,4);seedAccount(project,foreignUser(project),1000);
  const address=await project.app.listen({host:'127.0.0.1',port:0});
  const response=await fetch(`${address}/api/v1/events`,{headers:{cookie},signal:AbortSignal.timeout(5_000)});assert.equal(response.status,200);
  const reader=response.body!.getReader(),decoder=new TextDecoder();
  async function nextEvent(){const chunk=await reader.read();assert.equal(chunk.done,false);const frame=decoder.decode(chunk.value);const match=/event: (\w+)\ndata: (.+)\n\n/.exec(frame);assert.ok(match,frame);return{event:match[1],data:JSON.parse(match[2])};}
  try {
    assert.deepEqual(await nextEvent(),{event:'ready',data:{unreadCount:7}});
    const hooks=project.mail as unknown as MailHooks;
    project.store.db.prepare('UPDATE accounts SET unread=? WHERE id=?').run(1,first);
    hooks.emit(userId,'sync',{accountId:first,status:'connected'});assert.deepEqual(await nextEvent(),{event:'sync',data:{accountId:first,status:'connected',unreadCount:5}});
    const notificationId=randomUUID();hooks.emit(userId,'mail',{accountId:second,count:2,notificationId});assert.deepEqual(await nextEvent(),{event:'mail',data:{accountId:second,count:2,notificationId,unreadCount:5}});
    const notification:MailNotificationDetails={subject:'统一邮件主题',preview:'统一正文摘要',from:{name:'SSE 联系人',address:'synthetic@example.com'}};
    hooks.emit(userId,'mail',{accountId:second,count:1,notificationId,notification});assert.deepEqual(await nextEvent(),{event:'mail',data:{accountId:second,count:1,notificationId,notification,unreadCount:5}});
    project.store.db.prepare('DELETE FROM accounts WHERE user_id=?').run(userId);hooks.emit(userId,'sync',{accountId:second,status:'connected'});assert.equal((await nextEvent()).data.unreadCount,0);
  }finally{await reader.cancel();}
}));
