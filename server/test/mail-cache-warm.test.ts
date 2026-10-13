import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import type {ImapFlow,MessageStructureObject} from 'imapflow';
import {loadConfig,type Config} from '../src/config.js';
import {Store,type AccountRow,type MessageRow} from '../src/db.js';
import {MailService} from '../src/mail.js';
import {SecretBox} from '../src/security.js';

interface RemoteMessage {uid:number;date:string;starred:boolean;seen:boolean;structure?:MessageStructureObject;parts:Record<string,string>}
interface RemoteFolder {validity:bigint;messages:RemoteMessage[]}
interface FetchRecord {accountId:string;folder:string;uid:number;query:unknown}
interface DownloadRecord {accountId:string;folder:string;uid:number;part:string|undefined;maxBytes:number}
interface Fixture {
  store:Store;mail:MailService;config:Config;ownerId:string;remote:Map<string,Map<string,RemoteFolder>>;
  connections:string[];fetches:FetchRecord[];downloads:DownloadRecord[];locks:{folder:string;readOnly:boolean}[];
  searches:{accountId:string;folder:string;query:unknown;uid:boolean}[];
  fetchRanges:{accountId:string;folder:string;range:string;uid:boolean}[];
  notices:number[];order:string[];offline:boolean;mutations:number;
  streams:{record:DownloadRecord;content:Readable}[];
  account:(ownerId?:string)=>AccountRow;
  addRemote:(account:AccountRow,folder:string,uid:number,date:string,starred?:boolean,structure?:MessageStructureObject)=>RemoteMessage;
  seed:(account:AccountRow,folder:string,uid:number,date:string,starred?:boolean,structure?:MessageStructureObject)=>MessageRow;
  onDownload?:(record:DownloadRecord)=>Promise<Readable|void>;
  onSearch?:()=>Promise<void>;
  onUidFetch?:()=>Promise<void>;
  onNotify?:()=>Promise<void>;
}
function deferred() {let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function until(predicate:()=>boolean) {
  for(let attempt=0;attempt<400;attempt++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.ok(predicate(),'expected asynchronous operation did not start');
}
function inUidRange(uid:number,range:string) {
  return range.split(',').some(value=>{const [start,end]=value.split(':');return end===undefined?uid===Number(start):uid>=Number(start)&&uid<=(end==='*'?Infinity:Number(end));});
}
async function fixture(run:(project:Fixture)=>Promise<void>,overrides:Partial<Config>={}) {
  const directory=await mkdtemp(join(tmpdir(),'mailnest-cache-warm-'));
  const config={...loadConfig({APP_URL:'http://localhost:5173',DATA_DIR:directory,ENCRYPTION_KEY:'d'.repeat(64),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:'WarmCacheFixture2026!',MAIL_CACHE_RECENT_COUNT:'2',MAIL_CACHE_MAX_MIB:'4',SYNC_MESSAGE_LIMIT:'20'}),background:false,...overrides};
  const store=new Store(config);await store.bootstrap(config);
  const ownerId=store.db.prepare('SELECT id FROM users').get()!.id as string;
  const remote=new Map<string,Map<string,RemoteFolder>>(),connections:string[]=[],fetches:FetchRecord[]=[],downloads:DownloadRecord[]=[],locks:Fixture['locks']=[],searches:Fixture['searches']=[],fetchRanges:Fixture['fetchRanges']=[],notices:number[]=[],order:string[]=[];
  let project:Fixture;
  const mail=new MailService(store,config,()=>{},async(_owner,_account,count)=>{notices.push(count);order.push('notify-start');await project.onNotify?.();order.push('notify-done');});
  project={store,mail,config,ownerId,remote,connections,fetches,downloads,locks,searches,fetchRanges,notices,order,offline:false,mutations:0,streams:[],
    account:(owner=ownerId)=>{
      const id=randomUUID(),email=`${id}@example.com`;
      store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,owner,id,email,'#377a75','imap',email,email,'imap.example.com',993,1,'smtp.example.com',465,1,new SecretBox(config.encryptionKey).encrypt({password:'test-only-password'}));
      remote.set(id,new Map());return store.account(id)!;
    },
    addRemote:(account,folder,uid,date,starred=false,structure={type:'text/plain',part:'1'})=>{
      const folders=remote.get(account.id)!;if(!folders.has(folder))folders.set(folder,{validity:1n,messages:[]});
      const item={uid,date,starred,seen:false,structure,parts:{'1':`body ${account.id} ${folder} ${uid}`,'2':`<p>HTML ${uid}</p>`}};
      folders.get(folder)!.messages.push(item);return item;
    },
    seed:(account,folder,uid,date,starred=false,structure={type:'text/plain',part:'1'})=>{
      const item=project.addRemote(account,folder,uid,date,starred,structure),id=randomUUID();
      store.db.prepare('INSERT OR IGNORE INTO folders(account_id,path,name,uid_validity) VALUES(?,?,?,?)').run(account.id,folder,folder,'1');
      store.db.prepare('INSERT INTO messages(id,account_id,folder,uid,uid_validity,summary,unread,starred,date) VALUES(?,?,?,?,?,?,?,?,?)').run(id,account.id,folder,uid,'1',JSON.stringify({subject:`subject ${uid}`,from:{name:'Fixture',address:'fixture@example.com'},to:[],cc:[],date:item.date,preview:'',size:100,hasAttachments:false}),1,Number(starred),date);
      return store.message(id,account.user_id)!;
    }};
  (mail as unknown as {withClient:(account:AccountRow,credentials:unknown,work:(client:ImapFlow)=>Promise<unknown>)=>Promise<unknown>}).withClient=async(account,_credentials,work)=>{
    if(project.offline)throw new Error('Synthetic offline transport');connections.push(account.id);
    const folders=remote.get(account.id)!;let path='';
    const item=(uid:number)=>folders.get(path)?.messages.find(message=>message.uid===uid);
    const fetched=(message:RemoteMessage)=>({uid:message.uid,seq:folders.get(path)!.messages.indexOf(message)+1,bodyStructure:message.structure,size:100,envelope:{subject:`subject ${message.uid}`,date:message.date,from:[{name:'Fixture',address:'fixture@example.com'}],messageId:`<${message.uid}@example.com>`},flags:new Set([...message.starred?['\\Flagged']:[],...message.seen?['\\Seen']:[]])});
    const client={usable:true,mailbox:{} as object,list:async()=>[...folders.keys()].map(folder=>({path:folder,name:folder,flags:new Set<string>()})),close(){client.usable=false;},
      getMailboxLock:async(folder:string,options?:{readOnly?:boolean})=>{path=folder;const selected=folders.get(path);if(!selected)throw new Error('Unknown synthetic directory');locks.push({folder,readOnly:!!options?.readOnly});client.mailbox={exists:selected.messages.length,uidValidity:selected.validity,uidNext:Math.max(0,...selected.messages.map(message=>message.uid))+1};return{release(){}};},
      fetchOne:async(uid:number,query:unknown)=>{fetches.push({accountId:account.id,folder:path,uid,query});order.push(`fetch:${uid}`);const message=item(uid);return message?fetched(message):false;},
      fetchAll:async(range:string|number[],_query:unknown,options?:{uid?:boolean})=>{
        const value=Array.isArray(range)?range.join(','):String(range);fetchRanges.push({accountId:account.id,folder:path,range:value,uid:!!options?.uid});if(options?.uid)await project.onUidFetch?.();
        const messages=folders.get(path)!.messages;return(options?.uid?messages.filter(message=>inUidRange(message.uid,value)):messages.slice(Number(value.split(':')[0])-1)).map(fetched);
      },
      search:async(query:unknown,options?:{uid?:boolean})=>{searches.push({accountId:account.id,folder:path,query,uid:!!options?.uid});await project.onSearch?.();return folders.get(path)!.messages.filter(message=>message.starred).map(message=>message.uid);},
      status:async()=>({unseen:folders.get(path)!.messages.filter(message=>!message.seen).length}),
      download:async(uid:number,part:string|undefined,options:{maxBytes:number})=>{
        const record={accountId:account.id,folder:path,uid,part,maxBytes:options.maxBytes};downloads.push(record);const supplied=await project.onDownload?.(record);
        const message=item(uid);if(!message)throw new Error('Synthetic message missing');const content=supplied||Readable.from(Buffer.from(message.parts[part||'RAW']||'synthetic raw MIME should not be downloaded'));project.streams.push({record,content});return{meta:{},content};
      },
      messageFlagsAdd:async()=>{project.mutations++;},messageFlagsRemove:async()=>{project.mutations++;}};
    try{return await work(client as unknown as ImapFlow);}finally{client.close();}
  };
  try{await run(project);}finally{await mail.close();store.close();await rm(directory,{recursive:true,force:true});}
}

test('warm selects newest messages across owner accounts and folders plus old stars, then serves their bodies offline',async()=>fixture(async project=>{
  const {store,mail,ownerId}=project,a=project.account(),b=project.account();
  const oldStar=project.seed(a,'Archive',1,'2025-01-01T00:00:00.000Z',true);
  const oldOtherStar=project.seed(b,'INBOX',1,'2025-02-01T00:00:00.000Z',true);
  const latest=project.seed(a,'INBOX',4,'2026-10-12T00:00:00.000Z');
  const second=project.seed(b,'Archive',2,'2026-10-11T00:00:00.000Z');
  const excluded=project.seed(a,'INBOX',3,'2026-10-10T00:00:00.000Z');
  const otherOwner=randomUUID();store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(otherOwner,'other@example.com','Other','unused synthetic hash');
  const c=project.account(otherOwner),otherLatest=project.seed(c,'INBOX',1,'2026-10-13T00:00:00.000Z'),otherSecond=project.seed(c,'Archive',1,'2026-10-12T00:00:00.000Z'),otherStar=project.seed(c,'Archive',2,'2025-01-01T00:00:00.000Z',true);
  mail.scheduleWarm();await mail.waitForWarm();assert.equal(project.downloads.length,0,'background=false must prevent automatic body traffic');
  mail.scheduleWarm(true);await mail.waitForWarm();
  const expected=[oldStar,oldOtherStar,latest,second,otherLatest,otherSecond,otherStar];
  assert.deepEqual(new Set(store.db.prepare('SELECT id FROM messages WHERE detail IS NOT NULL').all().map(row=>row.id)),new Set(expected.map(row=>row.id)));
  assert.equal(store.message(excluded.id,ownerId)!.detail,null,'recent count applies across account and directory boundaries');
  assert.equal(project.connections.filter(id=>id===a.id).length,1);assert.equal(project.connections.filter(id=>id===b.id).length,1);assert.equal(project.connections.filter(id=>id===c.id).length,1,'one transport serves multiple directories within a small warm batch');
  assert.ok(project.locks.every(lock=>lock.readOnly),'background body reads select every directory read-only');assert.equal(project.mutations,0);
  assert.ok(store.db.prepare('SELECT source,unread FROM messages').all().every(row=>row.source===null&&row.unread===1),'warming must not mark messages read or persist raw MIME');
  project.offline=true;const requests=project.downloads.length;
  for(const row of expected){const detail=await mail.detail(store.account(row.account_id)!,store.message(row.id,store.account(row.account_id)!.user_id)!);assert.match(detail.text,/^body /);}
  assert.equal(project.downloads.length,requests,'all target bodies are available without the remote mailbox');
  project.offline=false;mail.scheduleWarm(true);await mail.waitForWarm();assert.equal(project.downloads.length,requests,'repeated scheduling reuses already warmed targets');
}));

test('warm reads decoded text and HTML parts while preserving attachment metadata without downloading attachments or raw MIME',async()=>fixture(async project=>{
  const account=project.account(),structure:MessageStructureObject={type:'multipart/mixed',childNodes:[{type:'text/plain',part:'1'},{type:'text/html',part:'2'},{type:'image/png',part:'3',id:'<image-1>',disposition:'inline',size:100},{type:'application/zip',part:'4',disposition:'attachment',size:100*1024*1024,dispositionParameters:{filename:'huge.zip'}}]};
  const row=project.seed(account,'INBOX',1,'2026-10-12T00:00:00.000Z',false,structure);
  project.mail.scheduleWarm(true);await project.mail.waitForWarm();
  assert.deepEqual(project.downloads.map(record=>record.part),['1','2']);
  assert.ok(project.downloads.every(record=>record.maxBytes<=2*1024*1024+1),'body reads keep the existing per-part limits');
  const detail=JSON.parse(project.store.message(row.id,account.user_id)!.detail!);assert.equal(detail.cacheVersion,2);assert.match(detail.html,/<p>HTML/);assert.equal(detail.attachments.length,2);assert.equal(detail.attachments[1].filename,'huge.zip');
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get()!.n,0);assert.equal(project.store.message(row.id,account.user_id)!.source,null);assert.equal(project.mutations,0);
}));

test('a fresh service reuses warmed bodies from the database without repeating body downloads',async()=>fixture(async project=>{
  const account=project.account(),rows=[project.seed(account,'INBOX',1,'2026-10-12T00:00:00.000Z'),project.seed(account,'Archive',1,'2025-01-01T00:00:00.000Z',true)];
  project.mail.scheduleWarm(true);await project.mail.waitForWarm();const requests=project.downloads.length,connections=project.connections.length;assert.equal(requests,2);await project.mail.close();
  const reopened=new Store(project.config),fresh=new MailService(reopened,project.config,()=>{},async()=>{});
  (fresh as unknown as {withClient:unknown}).withClient=(project.mail as unknown as {withClient:unknown}).withClient;
  try {
    fresh.scheduleWarm(true);await fresh.waitForWarm();assert.equal(project.connections.length,connections,'planning cached targets after restart needs no IMAP connection');
    project.offline=true;for(const row of rows){const detail=await fresh.detail(reopened.account(account.id)!,reopened.message(row.id,account.user_id)!);assert.match(detail.text,/^body /);}
    assert.equal(project.downloads.length,requests,'persistent target bodies remain available offline after restart');
  }finally{await fresh.close();reopened.close();}
}));

test('warm skips missing BODYSTRUCTURE with a cooldown while an explicit foreground read retains MIME fallback',async()=>fixture(async project=>{
  const account=project.account(),row=project.seed(account,'INBOX',1,'2026-10-12T00:00:00.000Z');
  project.remote.get(account.id)!.get('INBOX')!.messages[0].structure=undefined;
  project.mail.scheduleWarm(true);await project.mail.waitForWarm();
  assert.equal(project.downloads.length,0,'background cache misses must not fetch complete MIME as a compatibility fallback');assert.equal(project.store.message(row.id,account.user_id)!.detail,null);
  const fetches=project.fetches.length;project.mail.scheduleWarm(true);await project.mail.waitForWarm();assert.equal(project.fetches.length,fetches,'unsupported structures must not repeat metadata traffic immediately');
  await project.mail.detail(account,project.store.message(row.id,account.user_id)!);assert.deepEqual(project.downloads.map(record=>record.part),[undefined],'explicit body viewing retains the bounded MIME compatibility path');
}));

test('target bodies survive TTL, eviction removes non-targets before recent bodies and stars, and the byte budget remains hard',async()=>fixture(async project=>{
  const account=project.account(),star=project.seed(account,'Archive',1,'2025-01-01T00:00:00.000Z',true),latest=project.seed(account,'INBOX',4,'2026-10-12T00:00:00.000Z'),second=project.seed(account,'Archive',3,'2026-10-11T00:00:00.000Z'),other=project.seed(account,'INBOX',2,'2026-05-01T00:00:00.000Z');
  const detail=(size:number)=>JSON.stringify({cacheVersion:2,text:'a'.repeat(size),html:null,messageId:null,attachments:[],bodyTruncated:false});
  const old=Date.now()-20*86400_000;
  for(const row of [star,latest,second,other])project.store.db.prepare('UPDATE messages SET detail=?,detail_cached_at=? WHERE id=?').run(detail(100),old,row.id);
  project.store.pruneMailCache();
  assert.ok([star,latest,second].every(row=>project.store.message(row.id,account.user_id)!.detail),'all star and recent targets are exempt from body cache TTL');assert.equal(project.store.message(other.id,account.user_id)!.detail,null,'unprotected expired body is evicted');
  project.offline=true;const cached=await project.mail.detail(account,project.store.message(star.id,account.user_id)!);assert.equal(cached.text.length,100,'a protected expired body remains an offline cache hit');project.offline=false;
  for(const [index,row] of [star,second,latest,other].entries()){const body=detail(1536*1024);project.store.db.prepare('UPDATE messages SET detail=?,detail_cached_at=?,detail_size_bytes=? WHERE id=?').run(body,old+index*5*86400_000,Buffer.byteLength(body),row.id);}
  project.store.pruneMailCache();
  const retained=new Set(project.store.db.prepare('SELECT id FROM messages WHERE detail IS NOT NULL').all().map(row=>row.id));assert.deepEqual(retained,new Set([star.id,latest.id]),'stars outrank recent bodies, which outrank a hot non-target');
  assert.ok(Number(project.store.db.prepare('SELECT COALESCE(SUM(length(CAST(detail AS BLOB))),0) AS bytes FROM messages').get()!.bytes)<=project.config.mailCacheMaxBytes,'target protection cannot exceed the configured byte ceiling');
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n,4,'body eviction keeps every summary');
  project.store.db.prepare('UPDATE messages SET detail_retry_at=0 WHERE id=?').run(second.id);
  project.mail.scheduleWarm(true);await project.mail.waitForWarm();project.mail.scheduleWarm(true);await project.mail.waitForWarm();
  assert.equal(project.downloads.length,0,'a known body that cannot fit the priority budget must not be downloaded and evicted repeatedly');
}));

test('foreground requests interrupt an indefinitely stalled warm stream and merge identical misses without waiting for it',async()=>fixture(async project=>{
  const account=project.account(),first=project.seed(account,'INBOX',1,'2026-10-12T00:00:00.000Z',true),second=project.seed(account,'INBOX',2,'2026-10-11T00:00:00.000Z',true),foreground=project.seed(account,'INBOX',3,'2025-01-01T00:00:00.000Z');
  const stalled=new Readable({read(){}});let heldUid=0;
  project.onDownload=async record=>{if(!heldUid){heldUid=record.uid;return stalled;}};
  project.mail.scheduleWarm(true);
  try {
    await until(()=>heldUid!==0);assert.ok([first.uid,second.uid].includes(heldUid));
    let completed=false;const requests=Promise.all([project.mail.detail(account,foreground),project.mail.detail(account,foreground)]).then(details=>{completed=true;return details;});
    await until(()=>completed);const details=await requests;
    assert.equal(stalled.destroyed,true,'interactive work cancels and destroys the stalled background stream');
    assert.equal(project.store.db.prepare('SELECT detail FROM messages WHERE account_id=? AND uid=?').get(account.id,heldUid)!.detail,null,'the cancelled warm unit must not persist a body');
    await project.mail.waitForWarm();
    assert.equal(details[0].text,details[1].text);assert.equal(project.downloads.filter(record=>record.uid===foreground.uid).length,1,'two foreground misses share the persisted decoded body');
    const order=project.fetches.map(record=>record.uid),otherWarmUid=heldUid===first.uid?second.uid:first.uid;
    assert.ok(order.indexOf(foreground.uid)<order.indexOf(otherWarmUid),'the current body read finishes, then pending interactive work takes priority');
  }finally{stalled.destroy();await project.mail.waitForWarm();}
}));

test('sync discovers stars outside the recent sequence window without announcing them as arrivals, then drops removed stars',async()=>fixture(async project=>{
  const account=project.account();for(let uid=1;uid<=22;uid++)project.addRemote(account,'INBOX',uid,`2026-10-${String(Math.min(uid,12)).padStart(2,'0')}T00:00:00.000Z`,uid===1);
  const sync=async()=>{project.mail.schedule(account.id);await project.mail.waitForSync();};
  await sync();assert.deepEqual(project.notices,[]);assert.ok(project.store.db.prepare('SELECT uid FROM messages WHERE account_id=? AND uid=1 AND starred=1').get(account.id),'old remote star is retained outside the last 20 sequence numbers');
  assert.equal(project.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=?').get(account.id)!.n,21);
  assert.ok(project.searches.some(record=>(record.query as {flagged?:boolean}).flagged===true&&record.uid));assert.ok(project.fetchRanges.some(record=>record.uid&&inUidRange(1,record.range)),'extra stars are fetched by UID, not sequence');
  const messages=project.remote.get(account.id)!.get('INBOX')!.messages;messages[0].starred=false;messages[1].starred=true;project.addRemote(account,'INBOX',23,'2026-10-13T00:00:00.000Z');await sync();
  assert.deepEqual(project.notices,[1],'an old star first discovered by UID never contributes to the new-arrival count');assert.equal(project.store.db.prepare('SELECT uid FROM messages WHERE account_id=? AND uid=1').get(account.id),undefined,'a remotely unstarred message outside the current window is removed');assert.ok(project.store.db.prepare('SELECT uid FROM messages WHERE account_id=? AND uid=2 AND starred=1').get(account.id),'a newly flagged old UID is discovered on the next sync');
}));

test('failed star discovery preserves already cached stars while new-arrival delivery remains exactly once after recovery',async()=>{
  for(const failure of ['search','uid-fetch'] as const)await fixture(async project=>{
    const account=project.account();for(let uid=1;uid<=22;uid++)project.addRemote(account,'INBOX',uid,`2026-10-${String(Math.min(uid,12)).padStart(2,'0')}T00:00:00.000Z`,uid===1);
    const sync=async()=>{project.mail.schedule(account.id);await project.mail.waitForSync();};
    await sync();project.mail.scheduleWarm(true);await project.mail.waitForWarm();
    const star=project.store.db.prepare('SELECT id,detail FROM messages WHERE account_id=? AND uid=1').get(account.id)!;assert.ok(star.detail);
    const fail=async()=>{throw new Error(`Synthetic ${failure} failure`);};if(failure==='search')project.onSearch=fail;else project.onUidFetch=fail;
    project.addRemote(account,'INBOX',23,'2026-10-13T00:00:00.000Z');await sync();
    assert.equal(project.store.db.prepare('SELECT detail FROM messages WHERE id=?').get(star.id)!.detail,star.detail,'a failed UID star query cannot delete its cached body');
    delete project.onSearch;delete project.onUidFetch;await sync();
    assert.deepEqual(project.notices,[1],'the failed auxiliary star query must not lose or duplicate the one new arrival');
    assert.ok(project.store.db.prepare('SELECT uid FROM messages WHERE account_id=? AND uid=1 AND starred=1').get(account.id));
  });
});

test('a stopped service or changed account cannot persist a late warm body',async()=>{
  for(const change of ['stop','account-epoch','message-namespace'] as const)await fixture(async project=>{
    const account=project.account(),row=project.seed(account,'INBOX',1,'2026-10-12T00:00:00.000Z'),blocked=deferred();let started=false;
    project.onDownload=async()=>{started=true;await blocked.promise;};project.mail.scheduleWarm(true);
    try {
      await until(()=>started);
      if(change==='stop')project.mail.stop();
      else if(change==='account-epoch')project.store.db.prepare('UPDATE accounts SET mail_cache_epoch=? WHERE id=?').run(randomUUID(),account.id);
      else project.store.db.prepare('UPDATE messages SET uid_validity=? WHERE id=?').run('2',row.id);
      blocked.resolve();await project.mail.waitForWarm();
      assert.equal(project.store.message(row.id,account.user_id)!.detail,null,`${change} invalidates the in-flight warm snapshot`);
    }finally{blocked.resolve();await project.mail.waitForWarm();}
  });
});

test('automatic warming begins after the new-mail notification callback finishes',async()=>fixture(async project=>{
  const account=project.account();project.addRemote(account,'INBOX',1,'2026-10-11T00:00:00.000Z');
  const sync=async()=>{project.mail.schedule(account.id);await project.mail.waitForSync();};
  await sync();project.addRemote(account,'INBOX',2,'2026-10-12T00:00:00.000Z');project.config.background=true;
  const notified=deferred();project.onNotify=()=>notified.promise;project.mail.schedule(account.id);
  try {
    await until(()=>project.order.includes('notify-start'));
    assert.equal(project.fetches.length,0,'the bounded notification preview is separate from full-body warm metadata reads');
    assert.equal(project.downloads.length,1,'only the newest notification preview is read before the notifier finishes');
    notified.resolve();await project.mail.waitForSync();await project.mail.waitForWarm();
    const notifyDone=project.order.indexOf('notify-done'),firstWarm=project.order.findIndex(value=>value.startsWith('fetch:'));
    assert.ok(firstWarm>notifyDone,'background body warming must yield to delivery of the arrival notification');assert.ok(project.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE detail IS NOT NULL').get()!.n>0);
  }finally{notified.resolve();await project.mail.waitForSync();await project.mail.waitForWarm();}
}));
