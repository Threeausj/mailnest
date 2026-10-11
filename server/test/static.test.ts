import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import {loadConfig,frontendBuilt} from '../src/config.js';

test('production serves homepage, HEAD and SPA fallback while revalidating service worker updates', {skip:!frontendBuilt()},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mailnest-static-'));
  const config={...loadConfig({NODE_ENV:'production',ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD:'test static password 123',ENCRYPTION_KEY:'c'.repeat(64),DATA_DIR:directory,APP_URL:'http://localhost:3001'}),background:false};
  const {app}=await buildApp(config);
  try {
    const homepage=await app.inject({url:'/'});assert.equal(homepage.statusCode,200);assert.match(homepage.headers['content-type']||'',/^text\/html/);assert.equal(homepage.headers['cache-control'],'no-cache');assert.match(homepage.body,/<html/);
    const head=await app.inject({method:'HEAD',url:'/'});assert.equal(head.statusCode,200);assert.equal(head.body,'');assert.equal(head.headers['cache-control'],'no-cache');
    const fallback=await app.inject({url:'/inbox/deep-link'});assert.equal(fallback.statusCode,200);assert.equal(fallback.body,homepage.body);assert.equal(fallback.headers['cache-control'],'no-cache');
    for(const path of ['/index.html','/sw.js','/manifest.webmanifest']){const response=await app.inject({url:path});assert.equal(response.statusCode,200,path);assert.equal(response.headers['cache-control'],'no-cache',path);}
    const script=homepage.body.match(/src="(\/assets\/[^\"]+\.js)"/);assert.ok(script,'build has hashed JavaScript entry');const asset=await app.inject({url:script[1]});assert.equal(asset.statusCode,200);assert.equal(asset.headers['cache-control'],'public, max-age=31536000, immutable');
    const protectedApi=await app.inject({url:'/api/v1/accounts'});assert.equal(protectedApi.statusCode,401);assert.equal(protectedApi.headers['cache-control'],'no-store');
    const apiUnknown=await app.inject({url:'/api/v1/no-such-endpoint'});assert.equal(apiUnknown.statusCode,401);assert.match(apiUnknown.headers['content-type']||'',/^application\/json/);
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});
