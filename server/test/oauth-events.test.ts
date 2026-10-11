import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';

const origin='http://localhost:5173';
const password='initial password 123';
async function fixture(google=false) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-events-'));
  const config={...loadConfig({ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD:password,ENCRYPTION_KEY:'b'.repeat(64),DATA_DIR:directory,APP_URL:origin,GOOGLE_CLIENT_ID:google?'fake-test-client':'',GOOGLE_CLIENT_SECRET:google?'fake-test-secret':''}),background:false};
  const project=await buildApp(config);
  const login=async()=>{
    const response=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'admin@example.com',password}});
    assert.equal(response.statusCode,200);return response.headers['set-cookie']!.toString().split(';')[0];
  };
  return{...project,login,close:async()=>{await project.app.close();await rm(directory,{recursive:true,force:true});}};
}

test('Google authorization uses PKCE; state is session bound, expires and cannot be replayed',async()=>{
  const project=await fixture(true);
  const originalFetch=globalThis.fetch;
  let networkCalls=0;
  globalThis.fetch=async()=>{networkCalls++;throw new Error('Unexpected external network request during OAuth guard test');};
  try {
    const first=await project.login(),second=await project.login();
    const start=await project.app.inject({url:'/api/v1/oauth/google/start',headers:{cookie:first}});assert.equal(start.statusCode,200);
    const authorization=new URL(start.json().url);
    assert.equal(authorization.origin,'https://accounts.google.com');
    assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
    assert.equal(authorization.searchParams.get('client_id'),'fake-test-client');
    assert.equal(authorization.searchParams.get('redirect_uri'),`${origin}/api/v1/oauth/google/callback`);
    assert.equal(authorization.searchParams.get('access_type'),'offline');
    assert.equal(authorization.searchParams.get('prompt'),'consent');
    assert.equal(authorization.searchParams.get('scope'),'openid email https://mail.google.com/');
    const state=authorization.searchParams.get('state')!;
    assert.ok(state.length>=40);
    const row=project.store.db.prepare('SELECT verifier,session_id,expires_at FROM oauth_states WHERE state=?').get(state) as {verifier:string;session_id:string;expires_at:number};
    assert.ok(row);assert.ok(row.verifier.length>=43);assert.ok(row.expires_at>Date.now()&&row.expires_at<=Date.now()+600_000);
    assert.equal(authorization.searchParams.get('code_challenge'),createHash('sha256').update(row.verifier).digest('base64url'));
    const callback=async(cookie:string,query:Record<string,string>)=>project.app.inject({url:`/api/v1/oauth/google/callback?${new URLSearchParams(query)}`,headers:{cookie}});
    const wrongSession=await callback(second,{state,code:'fake-code'});assert.equal(wrongSession.statusCode,302);assert.ok(wrongSession.headers.location?.startsWith('/?oauth=error&reason='));
    assert.ok(project.store.db.prepare('SELECT state FROM oauth_states WHERE state=?').get(state),'mismatching session must not consume valid state');
    const invalid=await callback(first,{state:'invalid-state-1234567890123456',code:'fake-code'});assert.equal(invalid.statusCode,302);assert.ok(invalid.headers.location?.startsWith('/?oauth=error&reason='));
    const cancelled=await callback(first,{state,error:'access_denied'});assert.equal(cancelled.statusCode,302);assert.ok(cancelled.headers.location?.includes('oauth=error'));assert.equal(project.store.db.prepare('SELECT state FROM oauth_states WHERE state=?').get(state),undefined);
    const replay=await callback(first,{state,code:'fake-code'});assert.equal(replay.statusCode,302);assert.ok(replay.headers.location?.includes('oauth=error'));
    const next=await project.app.inject({url:'/api/v1/oauth/google/start',headers:{cookie:first}});const expiredState=new URL(next.json().url).searchParams.get('state')!;
    project.store.db.prepare('UPDATE oauth_states SET expires_at=? WHERE state=?').run(Date.now()-1,expiredState);
    const expired=await callback(first,{state:expiredState,code:'fake-code'});assert.equal(expired.statusCode,302);assert.ok(expired.headers.location?.includes('oauth=error'));
    const anonymous=await project.app.inject({url:`/api/v1/oauth/google/callback?state=${state}&code=fake-code`});assert.equal(anonymous.statusCode,401);
    assert.equal(networkCalls,0,'all rejected callbacks must validate state before calling Google');
  }finally{globalThis.fetch=originalFetch;await project.close();}
});

test('SSE sends ready, logout closes only the revoked session and shutdown closes remaining streams',async()=>{
  const project=await fixture();
  let firstReader:ReadableStreamDefaultReader<Uint8Array>|undefined,secondReader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    const first=await project.login(),second=await project.login();
    const address=await project.app.listen({host:'127.0.0.1',port:0});
    const event=async(cookie:string)=>{
      const response=await fetch(`${address}/api/v1/events`,{headers:{cookie},signal:AbortSignal.timeout(5_000)});
      assert.equal(response.status,200);assert.match(response.headers.get('content-type')||'',/^text\/event-stream/);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-accel-buffering'),'no');
      const reader=response.body!.getReader();const chunk=await reader.read();assert.equal(chunk.done,false);assert.match(new TextDecoder().decode(chunk.value),/event: ready\ndata: \{"unreadCount":0\}/);return reader;
    };
    firstReader=await event(first);secondReader=await event(second);
    const logout=await project.app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{cookie:first,origin},payload:{}});assert.equal(logout.statusCode,200);
    const ended=await firstReader.read();assert.equal(ended.done,true,'logout must close its SSE stream immediately');
    assert.equal((await project.app.inject({url:'/api/v1/auth/me',headers:{cookie:second}})).statusCode,200,'independent session remains authenticated');
    let timer:ReturnType<typeof setTimeout>;
    try{await Promise.race([project.app.close(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Server close stalled with active SSE')),2_000);})]);}finally{clearTimeout(timer!);}
    const remaining=await secondReader.read();assert.equal(remaining.done,true,'preClose must end remaining SSE streams');
  }finally{await firstReader?.cancel().catch(()=>{});await secondReader?.cancel().catch(()=>{});await project.close();}
});
