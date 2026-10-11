import test, {after,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {hashPassword,hashToken,isPublicAddress,resolveMailHost,SecretBox} from '../src/security.js';

const origin='http://localhost:5173';
const password='initial password 123';
let project:Awaited<ReturnType<typeof buildApp>>;
let folder:string;
let session:string;
before(async()=>{
  folder=await mkdtemp(join(tmpdir(),'mailnest-security-'));
  const config={...loadConfig({ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD:password,ENCRYPTION_KEY:'a'.repeat(64),DATA_DIR:folder,APP_URL:origin}),background:false};
  project=await buildApp(config);
  const login=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'admin@example.com',password}});
  assert.equal(login.statusCode,200);session=login.headers['set-cookie']!.toString().split(';')[0];
});
after(async()=>{await project?.app.close();if(folder)await rm(folder,{recursive:true,force:true});});

function request(method:'GET'|'POST'|'DELETE'|'PATCH',url:string,payload?:unknown,extra:Record<string,string>={}) {return project.app.inject({method,url,headers:{cookie:session,origin,...extra},...(payload===undefined?{}:{payload})});}

test('API, specification, docs and local docs assets require authentication',async()=>{
  for(const url of ['/api/v1/accounts','/api/v1/config','/api/v1/openapi.json','/api/v1/docs','/api/v1/docs-assets/swagger-ui.css']) {
    const response=await project.app.inject({url});assert.equal(response.statusCode,401,url);assert.equal(response.headers['cache-control'],'no-store');
  }
  assert.equal((await project.app.inject({url:'/api/v1/health'})).statusCode,200);
});
test('cookie mutations including login reject absent or mismatching Origin',async()=>{
  assert.equal((await project.app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'admin@example.com',password}})).statusCode,403);
  assert.equal((await request('POST','/api/v1/sync',{}, {origin:'https://attacker.example'})).statusCode,403);
  assert.equal((await project.app.inject({method:'POST',url:'/api/v1/sync',headers:{cookie:session},payload:{}})).statusCode,403);
  assert.equal((await request('POST','/api/v1/sync',{})).statusCode,200);
});
test('API tokens are stored hashed, owner scoped and cannot manage credentials or OAuth',async()=>{
  const created=await request('POST','/api/v1/tokens',{name:'integration'});assert.equal(created.statusCode,201);
  const {token,id}=created.json();
  const row=project.store.db.prepare('SELECT token_hash FROM api_tokens WHERE id=?').get(id) as {token_hash:string};assert.notEqual(row.token_hash,token);assert.equal(row.token_hash,hashToken(token));
  const bearer={authorization:`Bearer ${token}`};
  assert.equal((await project.app.inject({url:'/api/v1/accounts',headers:bearer})).statusCode,200);
  assert.equal((await project.app.inject({method:'POST',url:'/api/v1/sync',headers:bearer,payload:{}})).statusCode,200);
  for(const [method,url,payload] of [['GET','/api/v1/tokens',undefined],['POST','/api/v1/tokens',{name:'forbidden'}],['POST','/api/v1/auth/password',{currentPassword:password,newPassword:'changed password 123'}],['GET','/api/v1/oauth/google/start',undefined],['GET','/api/v1/events',undefined]] as const) {
    const response=await project.app.inject({method,url,headers:bearer,...(payload?{payload}:{})});assert.equal(response.statusCode,403,url);
  }
  assert.equal((await request('GET','/api/v1/accounts',undefined,{authorization:'Bearer wrong'})).statusCode,401,'invalid bearer cannot fallback to valid session');
  await request('DELETE',`/api/v1/tokens/${id}`);assert.equal((await project.app.inject({url:'/api/v1/accounts',headers:bearer})).statusCode,401);
});
test('accounts, mail, flags, move and attachments enforce ownership before network access',async()=>{
  const userId=randomUUID(),accountId=randomUUID(),messageId=randomUUID();
  project.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(userId,'other@example.com','other',await hashPassword('other password 123'));
  project.store.db.prepare("INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(accountId,userId,'other','other@example.com','#abcdef','imap','other','other','127.0.0.1',993,1,'127.0.0.1',465,1,'never decrypt');
  project.store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(messageId,accountId,'INBOX',1,'1','{}',1,0,new Date().toISOString());
  const checks=[['GET',`/api/v1/accounts/${accountId}/folders`,undefined],['DELETE',`/api/v1/accounts/${accountId}`,undefined],['POST',`/api/v1/accounts/${accountId}/sync`,{}],['GET',`/api/v1/messages?accountId=${accountId}`,undefined],['GET',`/api/v1/messages/${messageId}`,undefined],['PATCH',`/api/v1/messages/${messageId}`,{unread:false}],['POST',`/api/v1/messages/${messageId}/move`,{destination:'trash'}],['GET',`/api/v1/messages/${messageId}/attachments/anything`,undefined],['POST','/api/v1/messages/send',{accountId,to:'recipient@example.com',subject:'test',text:'text'}]] as const;
  for(const [method,url,payload] of checks)assert.equal((await request(method,url,payload)).statusCode,404,url);
  const listed=await request('GET','/api/v1/accounts');assert.equal(listed.json().accounts.length,0);
});
test('mail connection prevents internal target SSRF and never stores failed credentials',async()=>{
  const payload={name:'invalid',email:'invalid@example.com',color:'#123456',provider:'imap',username:'invalid',password:'secret-password-123',imap:{host:'127.0.0.1',port:993,secure:true},smtp:{host:'127.0.0.1',port:465,secure:true}};
  const response=await request('POST','/api/v1/accounts',payload);assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'PRIVATE_HOST');assert.ok(!response.body.includes(payload.password));
  assert.equal((await request('GET','/api/v1/accounts')).json().accounts.length,0);
});
test('encryption authenticates ciphertext and private host classification handles IPv4/IPv6',async()=>{
  const box=new SecretBox('a'.repeat(64));const encrypted=box.encrypt({password:'secret',refreshToken:'token'});assert.ok(!encrypted.includes('secret'));assert.deepEqual(box.decrypt(encrypted),{password:'secret',refreshToken:'token'});
  const parts=encrypted.split('.');parts[2]=Buffer.from('tampered').toString('base64');assert.throws(()=>box.decrypt(parts.join('.')));
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.2','169.254.169.254','100.64.1.2','::1','fe80::1','fc00::1','::ffff:127.0.0.1'])assert.equal(isPublicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','142.250.1.1','2606:4700:4700::1111'])assert.equal(isPublicAddress(ip),true,ip);
  await assert.rejects(resolveMailHost('localhost'),/内部或保留/);
});
test('logout revokes session server side, then login rate limiting blocks repeated guesses',async()=>{
  const result=await request('POST','/api/v1/auth/logout',{});assert.equal(result.statusCode,200);
  assert.equal((await request('GET','/api/v1/auth/me')).statusCode,401);
  for(let i=0;i<5;i++)assert.equal((await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'admin@example.com',password:'wrong'}})).statusCode,401);
  assert.equal((await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'admin@example.com',password}})).statusCode,429);
});

test('password rotation revokes every session and API token',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mailnest-password-'));
  const p=await buildApp({...loadConfig({ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD:password,ENCRYPTION_KEY:'a'.repeat(64),DATA_DIR:directory,APP_URL:origin}),background:false});
  try {
    const login=async()=>{const r=await p.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'admin@example.com',password}});assert.equal(r.statusCode,200);return r.headers['set-cookie']!.toString().split(';')[0];};
    const first=await login(),second=await login();
    const token=(await p.app.inject({method:'POST',url:'/api/v1/tokens',headers:{cookie:first,origin},payload:{name:'test'}})).json().token;
    const changed=await p.app.inject({method:'POST',url:'/api/v1/auth/password',headers:{cookie:first,origin},payload:{currentPassword:password,newPassword:'replacement password 123'}});assert.equal(changed.statusCode,200);
    for(const headers of [{cookie:first},{cookie:second},{authorization:`Bearer ${token}`}])assert.equal((await p.app.inject({url:'/api/v1/auth/me',headers})).statusCode,401);
    assert.equal((await p.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'admin@example.com',password:'replacement password 123'}})).statusCode,200);
  }finally{await p.app.close();await rm(directory,{recursive:true,force:true});}
});
