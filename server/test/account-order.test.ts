import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import dns from 'node:dns/promises';
import type {ImapFlow} from 'imapflow';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {SecretBox} from '../src/security.js';
import type {AccountRow} from '../src/db.js';
import type {Credentials} from '../src/mail.js';

type Project=Awaited<ReturnType<typeof buildApp>>;
type MailHooks={withClient:(account:AccountRow,credentials:Credentials,work:(client:ImapFlow)=>Promise<unknown>)=>Promise<unknown>;smtp:(account:AccountRow,credentials:Credentials)=>Promise<object>};
interface Fixture {project:Project;userId:string;cookie:string;reopen:()=>Promise<void>}
const origin='http://localhost:5173',secretBox=new SecretBox('d'.repeat(64));
async function fixture(run:(f:Fixture)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-account-order-'));
  const config={...loadConfig({APP_URL:origin,DATA_DIR:directory,ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'SyntheticOrderTest2026!',ENCRYPTION_KEY:'d'.repeat(64)}),background:false};
  const lookup=mock.method(dns,'lookup',async()=>{throw new Error('Account order tests must not contact external services');});
  let project:Project|undefined;
  const offline=(p:Project)=>{
    const hooks=p.mail as unknown as MailHooks;
    hooks.withClient=async()=>{throw new Error('Unexpected IMAP access');};hooks.smtp=async()=>{throw new Error('Unexpected SMTP access');};p.mail.schedule=()=>{};
  };
  try {
    project=await buildApp(config);offline(project);
    const login=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:config.adminEmail,password:config.adminPassword}});assert.equal(login.statusCode,200);
    const f={project,userId:login.json().user.id,cookie:login.headers['set-cookie']!.toString().split(';')[0]} as Fixture;
    f.reopen=async()=>{await f.project.app.close();project=await buildApp(config);offline(project);f.project=project;};
    await run(f);assert.equal(lookup.mock.callCount(),0,'sorting and mocked connection checks stay completely offline');
  }finally{await project?.app.close();lookup.mock.restore();await rm(directory,{recursive:true,force:true});}
}
function seedAccount(f:Fixture,name:string,owner=f.userId,sortOrder=0) {
  const id=randomUUID();
  f.project.store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,owner,name,`${id}@example.com`,'#1677ff','imap','synthetic','synthetic','imap.example.com',993,1,'smtp.example.com',465,1,secretBox.encrypt({password:'secret-account-password'}),sortOrder);
  return id;
}
function foreignUser(f:Fixture) {const id=randomUUID();f.project.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,'foreign@example.com','Foreign owner','not-a-real-hash');return id;}
function order(f:Fixture,accountIds:string[],extra:object={}) {return f.project.app.inject({method:'PATCH',url:'/api/v1/accounts/order',headers:{cookie:f.cookie,origin},payload:{accountIds,...extra}});}
async function listedIds(f:Fixture) {const response=await f.project.app.inject({url:'/api/v1/accounts',headers:{cookie:f.cookie}});assert.equal(response.statusCode,200,response.body);return response.json().accounts.map((account:{id:string})=>account.id) as string[];}
const snapshot=(f:Fixture)=>f.project.store.db.prepare('SELECT id,user_id,name,sort_order,credentials FROM accounts ORDER BY id').all();
function assertSafeAccountDto(response:{body:string;json:()=>{accounts:Record<string,unknown>[]}},f:Fixture) {
  const fields=['credentials','password_hash','sort_order','user_id'];
  for(const account of response.json().accounts)for(const field of fields)assert.equal(Object.hasOwn(account,field),false,`internal ${field} must not leak into account DTO`);
  assert.equal(response.body.includes('secret-account-password'),false);
  for(const row of f.project.store.accounts(f.userId))assert.equal(response.body.includes(row.credentials),false);
}

test('account order persists through renaming and application/database reopen without exposing internal fields',async()=>fixture(async f=>{
  const a=seedAccount(f,'Alpha'),b=seedAccount(f,'Bravo'),c=seedAccount(f,'Charlie');seedAccount(f,'Foreign',foreignUser(f));
  assert.deepEqual(await listedIds(f),[a,b,c]);
  const response=await order(f,[c,a,b]);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().accounts.map((account:{id:string})=>account.id),[c,a,b]);assertSafeAccountDto(response,f);
  assert.deepEqual(await listedIds(f),[c,a,b]);assert.deepEqual(f.project.store.accounts(f.userId).map(account=>account.sort_order),[0,1,2]);
  const rename=await f.project.app.inject({method:'PATCH',url:`/api/v1/accounts/${a}`,headers:{cookie:f.cookie,origin},payload:{name:'Zulu'}});assert.equal(rename.statusCode,200,rename.body);
  assert.deepEqual(await listedIds(f),[c,a,b],'a display-name edit must not reorder accounts');
  await f.reopen();assert.deepEqual(await listedIds(f),[c,a,b]);assert.equal(f.project.store.account(a)!.name,'Zulu');
  const repeated=await order(f,[c,a,b]);assert.equal(repeated.statusCode,200);assert.deepEqual(await listedIds(f),[c,a,b]);
}));

test('invalid duplicate, missing, foreign, stale and unexpected sort input leaves every account unchanged',async()=>fixture(async f=>{
  const a=seedAccount(f,'Alpha'),b=seedAccount(f,'Bravo'),c=seedAccount(f,'Charlie'),foreign=seedAccount(f,'Foreign',foreignUser(f),99);
  assert.equal((await order(f,[c,b,a])).statusCode,200);const before=snapshot(f);
  for(const ids of [[a,a,c],[a,b],[a,b,foreign],[a,b,randomUUID()],[a,b,c,foreign],[]]) {
    const response=await order(f,ids);assert.equal(response.statusCode,400,response.body);assert.equal(response.json().error.code,'ACCOUNT_ORDER_INVALID');assert.deepEqual(snapshot(f),before,'an invalid permutation cannot partially rewrite sort positions');
  }
  for(const payload of [{accountIds:[a,b,c],sort_order:123},{accountIds:[a,b,c],userId:foreign},{accountIds:Array.from({length:21},()=>randomUUID())},{accountIds:['',b,c]},{accountIds:'invalid'},{}]) {
    const response=await f.project.app.inject({method:'PATCH',url:'/api/v1/accounts/order',headers:{cookie:f.cookie,origin},payload});assert.equal(response.statusCode,400,response.body);assert.equal(response.json().error.code,'VALIDATION_ERROR');assert.deepEqual(snapshot(f),before);
  }
  f.project.store.db.prepare('DELETE FROM accounts WHERE id=?').run(b);const afterDeletion=snapshot(f);
  const stale=await order(f,[c,b,a]);assert.equal(stale.statusCode,400);assert.equal(stale.json().error.code,'ACCOUNT_ORDER_INVALID');assert.deepEqual(snapshot(f),afterDeletion,'a client with a deleted account cannot partially update survivors');
  const current=await order(f,[a,c]);assert.equal(current.statusCode,200,current.body);assert.deepEqual(await listedIds(f),[a,c]);assert.equal(f.project.store.account(foreign)!.sort_order,99);
}));

test('account order requires authentication and the configured request origin',async()=>fixture(async f=>{
  const a=seedAccount(f,'Alpha'),b=seedAccount(f,'Bravo'),before=snapshot(f);
  const anonymous=await f.project.app.inject({method:'PATCH',url:'/api/v1/accounts/order',headers:{origin},payload:{accountIds:[b,a]}});assert.equal(anonymous.statusCode,401);assert.deepEqual(snapshot(f),before);
  const wrongOrigin=await f.project.app.inject({method:'PATCH',url:'/api/v1/accounts/order',headers:{cookie:f.cookie,origin:'https://attacker.example'},payload:{accountIds:[b,a]}});assert.equal(wrongOrigin.statusCode,403);assert.equal(wrongOrigin.json().error.code,'INVALID_ORIGIN');assert.deepEqual(snapshot(f),before);
  const noOrigin=await f.project.app.inject({method:'PATCH',url:'/api/v1/accounts/order',headers:{cookie:f.cookie},payload:{accountIds:[b,a]}});assert.equal(noOrigin.statusCode,403);assert.deepEqual(snapshot(f),before);
}));

test('an empty own account list can be reordered even when another owner has accounts',async()=>fixture(async f=>{
  const foreign=seedAccount(f,'Foreign',foreignUser(f),17),before=snapshot(f);
  const response=await order(f,[]);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{accounts:[]});assert.deepEqual(await listedIds(f),[]);assert.deepEqual(snapshot(f),before);assert.equal(f.project.store.account(foreign)!.sort_order,17);
}));

test('newly connected accounts append after the saved owner order with only mocked transport checks',async()=>fixture(async f=>{
  const a=seedAccount(f,'Zulu'),b=seedAccount(f,'Bravo');seedAccount(f,'Foreign',foreignUser(f),999);
  assert.equal((await order(f,[a,b])).statusCode,200);
  const calls:string[]=[];
  const hooks=f.project.mail as unknown as MailHooks;
  hooks.withClient=async(_account,_credentials,work)=>{calls.push('imap');return work({list:async()=>[{path:'INBOX',name:'INBOX',flags:new Set()}]} as unknown as ImapFlow);};
  hooks.smtp=async()=>{calls.push('smtp');return{verify:async()=>{calls.push('verify');return true;},close(){calls.push('close');}};};
  const payload={name:'AAA new account',email:'newly-connected@example.com',provider:'imap',username:'synthetic',password:'new-account-secret',imap:{host:'imap.example.com',port:993,secure:true},smtp:{host:'smtp.example.com',port:465,secure:true}};
  const created=await f.project.app.inject({method:'POST',url:'/api/v1/accounts',headers:{cookie:f.cookie,origin},payload});assert.equal(created.statusCode,201,created.body);
  const id=created.json().account.id;assert.deepEqual(calls,['imap','smtp','verify','close']);assert.deepEqual(await listedIds(f),[a,b,id]);assert.equal(f.project.store.account(id,f.userId)!.sort_order,2,'only this owner controls the append position');
  assert.equal(created.body.includes(payload.password),false);assert.equal(Object.hasOwn(created.json().account,'sort_order'),false);assert.equal(Object.hasOwn(created.json().account,'credentials'),false);
  await f.reopen();assert.deepEqual(await listedIds(f),[a,b,id]);
}));
