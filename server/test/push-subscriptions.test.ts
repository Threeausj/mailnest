import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
import webPush from 'web-push';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';

type Project=Awaited<ReturnType<typeof buildApp>>;
const origin='http://localhost:5173';
const password='PushSubscriptionTest2026!';
const vapid=webPush.generateVAPIDKeys();
const keys={p256dh:'A'.repeat(87),auth:'a'.repeat(22)};
function subscription(endpoint:string,rotated=false) {
  return{endpoint,keys:rotated?{p256dh:'B'.repeat(87),auth:'b'.repeat(22)}:keys};
}
async function fixture(run:(project:Project,userId:string,cookie:string,answer:{value:unknown})=>Promise<void>,allowPrivate=false,configured=true) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-push-'));
  const answer:{value:unknown}={value:new Error('Synthetic DNS failure; registration must not resolve push endpoints')};
  const lookup=mock.method(dnsPromises,'lookup',async()=>{if(answer.value instanceof Error)throw answer.value;return answer.value;});
  const callbackLookup=mock.method(dns,'lookup',()=>{throw new Error('Unexpected callback DNS lookup during subscription registration');});
  const send=mock.method(webPush,'sendNotification',async()=>{throw new Error('Registration must not deliver a real push message');});
  // Keep built-in named imports in security.ts connected to the mocked DNS
  // method so reintroducing its old lookup precheck makes these tests fail.
  syncBuiltinESMExports();
  let project:Project|undefined;
  try {
    project=await buildApp({...loadConfig({APP_URL:origin,DATA_DIR:directory,ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:password,ENCRYPTION_KEY:'a'.repeat(64),ALLOW_PRIVATE_MAIL_HOSTS:String(allowPrivate),VAPID_PUBLIC_KEY:configured?vapid.publicKey:'',VAPID_PRIVATE_KEY:configured?vapid.privateKey:''}),background:false});
    const login=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'owner@example.com',password}});
    assert.equal(login.statusCode,200);
    await run(project,login.json().user.id,login.headers['set-cookie']!.toString().split(';')[0],answer);
    assert.equal(lookup.mock.callCount(),0,'subscription registration delegates DNS and routing to the active network/proxy');
    assert.equal(callbackLookup.mock.callCount(),0);assert.equal(send.mock.callCount(),0);
  }finally{
    await project?.app.close();lookup.mock.restore();callbackLookup.mock.restore();send.mock.restore();syncBuiltinESMExports();await rm(directory,{recursive:true,force:true});
  }
}
function register(project:Project,cookie:string,endpoint:string,rotated=false) {
  return project.app.inject({method:'POST',url:'/api/v1/push/subscriptions',headers:{cookie,origin},payload:subscription(endpoint,rotated)});
}

test('browser-provider HTTPS subscriptions register without DNS prechecks or a private-mail flag',async()=>fixture(async(project,userId,cookie)=>{
  const endpoints=[
    'https://fcm.googleapis.com/fcm/send/synthetic-google',
    'https://fcm.googleapis.com:443/fcm/send/synthetic-default-port',
    'https://updates.push.services.mozilla.com/wpush/v2/synthetic-mozilla',
    'https://push.services.mozilla.com/wpush/v2/synthetic-mozilla-root',
    'https://web.push.apple.com/synthetic-apple',
    'https://wns.windows.com/synthetic-windows',
    'https://channel.wns.windows.com/synthetic-windows-subdomain',
  ];
  for(const endpoint of endpoints){const response=await register(project,cookie,endpoint);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{ok:true});assert.equal(response.headers['cache-control'],'no-store');}
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').get(userId)!.n,endpoints.length);
}));

test('push registration ignores public, Fake-IP, private, mixed and failed DNS in either mail-host mode',async()=>{
  for(const allowPrivate of [false,true])await fixture(async(project,_userId,cookie,answer)=>{
    const replies=[
      [{address:'142.250.1.1',family:4}],
      [{address:'198.18.0.2',family:4}],
      [{address:'198.19.255.254',family:4}],
      [{address:'127.0.0.1',family:4}],
      [{address:'192.168.1.2',family:4}],
      [{address:'142.250.1.1',family:4},{address:'fe80::1',family:6}],
      new Error('Synthetic DNS error containing no real network data'),
    ];
    for(const [index,reply] of replies.entries()){
      answer.value=reply;
      const response=await register(project,cookie,`https://fcm.googleapis.com/fcm/send/synthetic-${allowPrivate}-${index}`);
      assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{ok:true});assert.equal(response.body.includes('ALLOW_PRIVATE_MAIL_HOSTS'),false);
    }
  },allowPrivate);
});

test('subscription request validation still rejects untrusted hosts, non-HTTPS ports and invalid keys',async()=>fixture(async(project,_userId,cookie)=>{
  const rejected=[
    'http://fcm.googleapis.com/fcm/send/synthetic',
    'https://attacker.example/fcm.googleapis.com/synthetic',
    'https://fcm.googleapis.com.attacker.example/synthetic',
    'https://127.0.0.1/synthetic',
    'https://user:synthetic-password@fcm.googleapis.com/synthetic',
    'https://fcm.googleapis.com:444/synthetic',
    'https://fcm.googleapis.com:80/synthetic',
  ];
  for(const endpoint of rejected){const response=await register(project,cookie,endpoint);assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'INVALID_PUSH_ENDPOINT');assert.equal(response.body.includes('synthetic-password'),false);}
  const badKeys=await project.app.inject({method:'POST',url:'/api/v1/push/subscriptions',headers:{cookie,origin},payload:{endpoint:'https://fcm.googleapis.com/synthetic',keys:{p256dh:'invalid',auth:'invalid'}}});
  assert.equal(badKeys.statusCode,400);assert.equal(badKeys.json().error.code,'VALIDATION_ERROR');
  const anonymous=await project.app.inject({method:'POST',url:'/api/v1/push/subscriptions',headers:{origin},payload:subscription('https://fcm.googleapis.com/synthetic')});assert.equal(anonymous.statusCode,401);
  const badOrigin=await project.app.inject({method:'POST',url:'/api/v1/push/subscriptions',headers:{cookie,origin:'https://attacker.example'},payload:subscription('https://fcm.googleapis.com/synthetic')});assert.equal(badOrigin.statusCode,403);
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()!.n,0);
}));

test('twenty-device limit permits same-owner re-registration and protects foreign endpoints',async()=>fixture(async(project,userId,cookie)=>{
  const endpoints=Array.from({length:20},(_,index)=>`https://fcm.googleapis.com/fcm/send/device-${index}`);
  for(const endpoint of endpoints)project.store.db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?)').run(endpoint,userId,JSON.stringify(subscription(endpoint)));
  const rotated=subscription(endpoints[0],true);
  for(let repeat=0;repeat<2;repeat++){const updated=await register(project,cookie,endpoints[0],true);assert.equal(updated.statusCode,200,updated.body);assert.deepEqual(updated.json(),{ok:true});}
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').get(userId)!.n,20);
  assert.deepEqual(JSON.parse(project.store.db.prepare('SELECT subscription FROM push_subscriptions WHERE endpoint=?').get(endpoints[0])!.subscription as string),rotated,'re-registration refreshes this device keys instead of rejecting at capacity');
  const full=await register(project,cookie,'https://fcm.googleapis.com/fcm/send/new-device');assert.equal(full.statusCode,400);assert.equal(full.json().error.code,'PUSH_LIMIT');
  const foreignUser=randomUUID(),foreignEndpoint='https://fcm.googleapis.com/fcm/send/foreign-device';
  project.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(foreignUser,'private-owner@example.com','Private fixture owner','not-a-login-hash');
  project.store.db.prepare('INSERT INTO push_subscriptions VALUES(?,?,?)').run(foreignEndpoint,foreignUser,JSON.stringify(subscription(foreignEndpoint)));
  const foreignBefore={...project.store.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint=?').get(foreignEndpoint)};
  const conflict=await register(project,cookie,foreignEndpoint,true);
  assert.equal(conflict.statusCode,409);assert.equal(conflict.json().error.code,'PUSH_ENDPOINT_EXISTS');assert.equal(conflict.body.includes(foreignUser),false);assert.equal(conflict.body.includes('private-owner@example.com'),false);assert.equal(conflict.body.includes(keys.auth),false);
  const ignoredDelete=await project.app.inject({method:'DELETE',url:'/api/v1/push/subscriptions',headers:{cookie,origin},payload:{endpoint:foreignEndpoint}});assert.equal(ignoredDelete.statusCode,200);
  assert.deepEqual({...project.store.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint=?').get(foreignEndpoint)},foreignBefore);
  assert.equal((await project.app.inject({method:'DELETE',url:'/api/v1/push/subscriptions',headers:{cookie,origin},payload:{endpoint:endpoints[1]}})).statusCode,200);
  assert.equal((await register(project,cookie,'https://fcm.googleapis.com/fcm/send/new-device')).statusCode,200);
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').get(userId)!.n,20);
}));

test('unconfigured push responds with its own configuration error without resolving mail hosts',async()=>fixture(async(project,_userId,cookie)=>{
  const response=await register(project,cookie,'https://fcm.googleapis.com/fcm/send/synthetic');
  assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'PUSH_NOT_CONFIGURED');assert.equal(response.body.includes('ALLOW_PRIVATE_MAIL_HOSTS'),false);
},false,false));
