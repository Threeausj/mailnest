import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PushSubscription,RequestOptions} from 'web-push';
import {Store} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {PushDeliveryQueue} from '../src/push.js';

interface Call {subscription:PushSubscription;payload:string;options:RequestOptions}
interface Fixture {
  store:Store;queue:PushDeliveryQueue;userId:string;accountId:string;calls:Call[];logs:Record<string,unknown>[];
  now:number;random:number;error:unknown;onSend?:()=>Promise<void>|void;
  subscribe:(name:string,owner?:string)=>string;
  input:(id?:string)=>{userId:string;accountId:string;notificationId:string;payload:string};
  reopen:()=>Promise<void>;
}
const keys={p256dh:'A'.repeat(87),auth:'a'.repeat(22)};
async function fixture(run:(f:Fixture)=>Promise<void>,sendDeadlineMs?:number) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-outbox-'));
  const config={...loadConfig({APP_URL:'http://localhost:5173',DATA_DIR:directory,ADMIN_EMAIL:'synthetic@example.com',ADMIN_PASSWORD:'Synthetic2026!',ENCRYPTION_KEY:'a'.repeat(64)}),background:false};
  const userId=randomUUID(),accountId=randomUUID();
  const store=new Store(config);
  store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(userId,'synthetic@example.com','Synthetic owner','not-a-real-hash');
  store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(accountId,userId,'Synthetic account','mail@example.com','#1677ff','imap','synthetic','synthetic','imap.example.com',993,1,'smtp.example.com',465,1,'not-real-credentials');
  const f={store,userId,accountId,calls:[],logs:[],now:Date.UTC(2026,9,11),random:0.5,error:undefined} as unknown as Fixture;
  const queue=()=>new PushDeliveryQueue({store:f.store,now:()=>f.now,random:()=>f.random,sendDeadlineMs,logger:{info:fields=>f.logs.push(fields),warn:fields=>f.logs.push(fields)},send:async(subscription,payload,options)=>{
    f.calls.push({subscription,payload,options});await f.onSend?.();if(f.error!==undefined)throw f.error;return{statusCode:201,body:'',headers:{}};
  }});
  f.queue=queue();
  f.subscribe=(name,owner=userId)=>{
    const endpoint=`https://fcm.googleapis.com/fcm/send/synthetic-${name}`;
    f.store.db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?)').run(endpoint,owner,JSON.stringify({endpoint,keys}));return endpoint;
  };
  f.input=(notificationId=randomUUID())=>({userId,accountId,notificationId,payload:JSON.stringify({title:'Synthetic mail',body:'One synthetic batch',tag:`mail-${accountId}`,notificationId,unreadCount:1})});
  f.reopen=async()=>{await f.queue.stop();f.store.close();f.store=new Store(config);f.queue=queue();};
  try{await run(f);}finally{await f.queue.stop();f.store.close();await rm(directory,{recursive:true,force:true});}
}
const deliveries=(f:Fixture)=>f.store.db.prepare('SELECT * FROM push_deliveries ORDER BY created_at,id').all() as unknown as {id:string;status:string;attempts:number;next_attempt_at:number;expires_at:number;last_category:string;payload:string}[];
const retryTime=(f:Fixture)=>deliveries(f).find(row=>row.status==='pending')!.next_attempt_at;

test('transient mail pushes survive a database reopen, retain one-hour expiry and deduplicate accepted batches per owned device',async()=>fixture(async f=>{
  f.subscribe('first');f.subscribe('second');
  const foreign=randomUUID();f.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(foreign,'foreign@example.com','Foreign owner','not-real');f.subscribe('foreign',foreign);
  const input=f.input();f.error=new Error('network unavailable');await f.queue.enqueue(input);
  assert.equal(f.calls.length,2);assert.ok(deliveries(f).every(row=>row.attempts===1&&row.status==='pending'));
  assert.deepEqual(f.queue.stats(f.userId),{pending:2,retrying:2,accepted:0,failed:0,nextRetryAt:f.now+5000,lastAcceptedAt:null});
  const serialized=JSON.stringify(deliveries(f));assert.equal(serialized.includes(keys.p256dh),false);assert.equal(serialized.includes(keys.auth),false);assert.equal(serialized.includes('fcm.googleapis.com'),false);
  f.now+=5000;f.error=undefined;await f.reopen();await f.queue.flush();
  assert.equal(f.calls.length,4);assert.ok(deliveries(f).every(row=>row.status==='accepted'&&row.attempts===2));
  for(const call of f.calls.slice(2)){assert.equal(call.options.TTL,3595);assert.equal(call.options.urgency,'high');assert.equal(call.options.contentEncoding,'aes128gcm');assert.equal(call.options.timeout,10_000);assert.equal(call.payload,input.payload);}
  assert.equal(f.calls[0].options.topic,f.calls[2].options.topic);
  await f.queue.enqueue(input);assert.equal(f.calls.length,4,'accepted notifications are not sent again');
  await f.reopen();await f.queue.enqueue(input);assert.equal(f.calls.length,4,'accepted dedupe survives restart');
  await f.queue.enqueue(f.input());assert.equal(f.calls.length,6);assert.notEqual(f.calls[4].options.topic,f.calls[0].options.topic);
  assert.equal(f.queue.stats(foreign).accepted,0);
}));

test('stage is synchronous and shares the mail transaction so rollback cannot leak notifications',async()=>fixture(async f=>{
  f.subscribe('transaction');const input=f.input();
  f.store.db.exec('BEGIN IMMEDIATE');f.queue.stage(input);assert.equal(deliveries(f).length,1);assert.equal(f.calls.length,0);f.store.db.exec('ROLLBACK');
  await f.queue.flush();assert.equal(deliveries(f).length,0);assert.equal(f.calls.length,0);
  f.store.db.exec('BEGIN IMMEDIATE');f.queue.stage(input);f.store.db.exec('COMMIT');assert.equal(f.calls.length,0);
  await f.reopen();await f.queue.flush();assert.equal(f.calls.length,1);assert.equal(deliveries(f)[0].status,'accepted');
}));

test('network, timeout, rate-limit and temporary provider statuses retry with backoff, provider Retry-After and shrinking TTL',async()=>{
  for(const statusCode of [undefined,408,425,429,500,503,599])await fixture(async f=>{
    f.subscribe(`transient-${statusCode}`);f.error={statusCode,headers:{'Retry-After':'30'},message:'private provider error'};
    await f.queue.enqueue(f.input());assert.equal(f.calls.length,1);assert.equal(retryTime(f),f.now+30_000);
    f.now+=29_999;await f.queue.flush();assert.equal(f.calls.length,1);
    f.now++;f.error={statusCode,headers:{'retry-after':new Date(f.now+60_000).toUTCString()}};await f.queue.flush();
    assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.TTL,3570);assert.equal(retryTime(f),f.now+60_000);
    f.now+=60_000;f.error={statusCode,headers:{'retry-after':'not-a-date'}};await f.queue.flush();assert.equal(retryTime(f),f.now+20_000);
    f.now+=20_000;f.error=undefined;await f.queue.flush();assert.equal(deliveries(f)[0].status,'accepted');assert.equal(f.calls[3].options.TTL,3490);
    const logs=JSON.stringify(f.logs);assert.equal(logs.includes('private provider error'),false);assert.equal(logs.includes(keys.auth),false);assert.equal(logs.includes('fcm.googleapis.com'),false);
  });
});

test('retry attempts stop at eight and permanent errors never enter a retry loop',async()=>{
  await fixture(async f=>{
    f.subscribe('budget');f.error={statusCode:503};await f.queue.enqueue(f.input());
    for(let attempt=2;attempt<=8;attempt++){f.now=retryTime(f);await f.queue.flush();assert.equal(f.calls.length,attempt);}
    assert.equal(deliveries(f)[0].status,'failed');assert.equal(deliveries(f)[0].last_category,'PUSH_RETRY_EXHAUSTED');
    f.now+=1;await f.reopen();await f.queue.flush();assert.equal(f.calls.length,8);
  });
  for(const statusCode of [301,400,401,403,409,422,5010])await fixture(async f=>{
    f.subscribe(`rejected-${statusCode}`);f.error={statusCode};await f.queue.enqueue(f.input());
    f.now+=100_000;await f.queue.flush();assert.equal(f.calls.length,1);assert.equal(deliveries(f)[0].status,'failed');assert.equal(deliveries(f)[0].last_category,'PUSH_DELIVERY_REJECTED');
  });
});

test('retry jitter spans twenty percent without weakening a provider Retry-After deadline',async()=>{
  for(const random of [0,1])await fixture(async f=>{
    f.subscribe(`jitter-${random}`);f.random=random;f.error={statusCode:503};await f.queue.enqueue(f.input());assert.equal(retryTime(f),f.now+(random?6000:4000));
    f.now=retryTime(f);f.error={statusCode:429,headers:{'retry-after':['30']}};await f.queue.flush();assert.equal(retryTime(f),f.now+30_000);
  });
});

test('expired deliveries do not send and Retry-After cannot extend the fixed lifetime',async()=>fixture(async f=>{
  f.subscribe('expiry');const input=f.input();f.queue.stage(input);f.now+=3600_000;await f.queue.flush();assert.equal(f.calls.length,0);assert.equal(deliveries(f).length,0);
  f.error={statusCode:429,headers:{'retry-after':'7200'}};await f.queue.enqueue(f.input());assert.equal(f.calls.length,1);assert.equal(deliveries(f)[0].status,'failed');assert.equal(deliveries(f)[0].last_category,'PUSH_DELIVERY_EXPIRED');
  f.now+=3600_000;await f.queue.flush();assert.equal(deliveries(f).length,0);
}));

test('retries cancel when keys, ownership or subscriptions change, and deleted accounts remove their queue',async()=>{
  for(const change of ['keys','owner','unsubscribe','account'] as const)await fixture(async f=>{
    const endpoint=f.subscribe(change);f.error={statusCode:503};await f.queue.enqueue(f.input());
    if(change==='keys')f.store.db.prepare('UPDATE push_subscriptions SET subscription=? WHERE endpoint=?').run(JSON.stringify({endpoint,keys:{p256dh:'B'.repeat(87),auth:'b'.repeat(22)}}),endpoint);
    if(change==='owner'){const other=randomUUID();f.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(other,'other@example.com','Other owner','not-real');f.store.db.prepare('UPDATE push_subscriptions SET user_id=? WHERE endpoint=?').run(other,endpoint);}
    if(change==='unsubscribe')f.store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
    if(change==='account')f.store.db.prepare('DELETE FROM accounts WHERE id=?').run(f.accountId);
    f.now+=5000;await f.queue.flush();assert.equal(f.calls.length,1);
    if(change==='account')assert.equal(deliveries(f).length,0);else assert.equal(deliveries(f)[0].status,'cancelled');
  });
});

test('expired cleanup is conditional on the exact subscription sent and leaves other owners/devices intact',async()=>{
  for(const statusCode of [404,410])await fixture(async f=>{
    const selected=f.subscribe('expired'),retained=f.subscribe('retained');
    f.onSend=()=>{if(f.calls.at(-1)!.subscription.endpoint===selected){f.store.db.prepare('UPDATE push_subscriptions SET subscription=? WHERE endpoint=?').run(JSON.stringify({endpoint:selected,keys:{p256dh:'B'.repeat(87),auth:'b'.repeat(22)}}),selected);throw{statusCode};}};
    await f.queue.enqueue(f.input());
    assert.ok(f.store.db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(selected));assert.ok(f.store.db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(retained));
    assert.deepEqual(deliveries(f).map(row=>row.status).sort(),['accepted','failed']);
    assert.equal(f.calls.length,2);
  });
  await fixture(async f=>{const endpoint=f.subscribe('actually-expired');f.error={statusCode:410};await f.queue.enqueue(f.input());assert.equal(f.store.db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(endpoint),undefined);});
});

test('parallel batches use at most four senders and shutdown waits for in-flight attempts without losing staged work',async()=>fixture(async f=>{
  for(let device=0;device<10;device++)f.subscribe(`concurrent-${device}`);
  let release!:()=>void,reached!:()=>void,active=0,peak=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reached=resolve;});
  f.onSend=async()=>{active++;peak=Math.max(peak,active);if(active===4)reached();await gate;active--;};
  const first=f.queue.enqueue(f.input());await started;assert.equal(f.calls.length,4);assert.equal(peak,4);
  const second=f.queue.enqueue(f.input());let stopped=false;const stop=f.queue.stop().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);assert.equal(f.calls.length,4);
  release();await Promise.all([first,second,stop]);assert.equal(stopped,true);assert.equal(f.calls.length,4);assert.equal(deliveries(f).length,20);
  f.onSend=undefined;await f.reopen();await f.queue.flush();assert.equal(f.calls.length,20);assert.equal(deliveries(f).filter(row=>row.status==='accepted').length,20);assert.equal(peak,4);
}));

test('overlapping enqueues wait for their own immediate attempts while sharing the four-sender limit',async()=>fixture(async f=>{
  for(let device=0;device<6;device++)f.subscribe(`overlap-${device}`);
  let release!:()=>void,reached!:()=>void,active=0,peak=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reached=resolve;});
  f.onSend=async()=>{active++;peak=Math.max(peak,active);if(active===4)reached();await gate;active--;};
  const first=f.queue.enqueue(f.input());await started;
  const second=f.queue.enqueue(f.input());release();await Promise.all([first,second]);
  assert.equal(f.calls.length,12);assert.equal(peak,4);assert.ok(deliveries(f).every(row=>row.status==='accepted'));
}));

test('invalid stored keys stop safely and foreign or nonexistent accounts cannot stage deliveries',async()=>fixture(async f=>{
  const endpoint=f.subscribe('invalid');f.store.db.prepare('UPDATE push_subscriptions SET subscription=? WHERE endpoint=?').run('{invalid json',endpoint);
  await f.queue.enqueue(f.input());assert.equal(f.calls.length,0);assert.equal(deliveries(f)[0].last_category,'PUSH_SUBSCRIPTION_INVALID');
  f.queue.stage({...f.input(),accountId:randomUUID()});f.queue.stage({...f.input(),userId:randomUUID()});assert.equal(deliveries(f).length,1);
}));

test('manual mode has no implicit timer and start restores due staged notifications',async()=>fixture(async f=>{
  f.subscribe('manual');f.error={statusCode:503};await f.queue.enqueue(f.input());f.now+=5000;f.error=undefined;
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.calls.length,1,'enqueue does not start retry timers');
  f.queue.start();await f.queue.flush();assert.equal(f.calls.length,2);assert.equal(deliveries(f)[0].status,'accepted');
}));

test('a stalled provider has a total deadline so shutdown completes and a restart can retry', {timeout:3000},async()=>fixture(async f=>{
  f.subscribe('stalled');f.onSend=()=>new Promise<void>(()=>{});
  const pending=f.queue.enqueue(f.input());assert.equal(f.calls.length,1);
  await Promise.all([pending,f.queue.stop()]);
  assert.equal(deliveries(f)[0].status,'pending');assert.equal(deliveries(f)[0].attempts,1);assert.equal(deliveries(f)[0].last_category,'PUSH_NETWORK_UNAVAILABLE');
  assert.equal(retryTime(f),f.now+5000);assert.equal(f.calls[0].options.timeout,10_000,'retain the provider socket timeout as well');
  f.onSend=undefined;f.now+=5000;await f.reopen();await f.queue.flush();assert.equal(f.calls.length,2);assert.equal(deliveries(f)[0].status,'accepted');assert.equal(deliveries(f)[0].attempts,2);
},10));

test('late provider outcomes cannot mutate timed-out state and a later flush retains the notification identity', {timeout:3000},async()=>fixture(async f=>{
  f.subscribe('late-success');let resolve!:()=>void;
  f.onSend=()=>new Promise<void>(done=>{resolve=done;});const input=f.input();await f.queue.enqueue(input);
  const timedOut=deliveries(f);assert.equal(timedOut[0].status,'pending');assert.equal(timedOut[0].last_category,'PUSH_NETWORK_UNAVAILABLE');
  resolve();await Promise.resolve();await Promise.resolve();assert.deepEqual(deliveries(f),timedOut,'a late 201 cannot mark a timed-out row accepted');assert.equal(f.logs.filter(row=>row.statusCode===201).length,0);
  f.onSend=undefined;f.now=retryTime(f);await f.queue.flush();assert.equal(f.calls.length,2);assert.equal(deliveries(f)[0].status,'accepted');assert.equal(f.calls[0].options.topic,f.calls[1].options.topic);assert.equal(JSON.parse(f.calls[0].payload).notificationId,JSON.parse(f.calls[1].payload).notificationId);
},10));

test('late provider rejection is consumed safely after the store closes', {timeout:3000},async()=>fixture(async f=>{
  f.subscribe('late-rejection');let reject!:(error:unknown)=>void;
  f.onSend=()=>new Promise<void>((_resolve,fail)=>{reject=fail;});await f.queue.enqueue(f.input());assert.equal(deliveries(f)[0].status,'pending');
  await f.reopen();const retained=deliveries(f);reject(new Error('synthetic late provider failure'));await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(deliveries(f),retained,'late callback must not touch a closed SQLite handle or new queue state');
  f.onSend=undefined;f.now=retryTime(f);await f.queue.flush();assert.equal(deliveries(f)[0].status,'accepted');
},10));

test('retained queue storage is bounded and expired records are pruned before accepting another batch',async()=>fixture(async f=>{
  f.subscribe('capacity');
  f.store.db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4096) INSERT INTO push_deliveries(id,user_id,account_id,notification_id,endpoint_hash,subscription_hash,payload,created_at,expires_at,status,attempts,next_attempt_at) SELECT 'capacity-'||x,?,?,'capacity-'||x,'endpoint-'||x,'hash','{}',?,?,'accepted',1,? FROM n").run(f.userId,f.accountId,f.now,f.now+3600_000,f.now);
  await f.queue.enqueue(f.input());assert.equal(f.calls.length,0);assert.equal(deliveries(f).length,4096);assert.equal(f.logs.at(-1)!.category,'PUSH_QUEUE_FULL');
  f.now+=3600_000;await f.queue.enqueue(f.input());assert.equal(f.calls.length,1);assert.equal(deliveries(f).length,1);
}));
