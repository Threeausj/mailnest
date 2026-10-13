// Runs against an isolated GreenMail sandbox. No messages reach external mailboxes.
// See docs/testing.md for the TLS fixture setup; certificate validation stays enabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { buildApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import type { MailNotificationDetails } from '../server/src/mail.js';

const enabled = process.env.MAIL_TEST_ENABLED === 'true';
test('TLS IMAP: prewarm merged recent bodies and old starred mail, then read without a connection', { skip: !enabled, timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mailnest-cache-wire-'));
  const config = { ...loadConfig({
    APP_URL: 'http://localhost:5173', DATA_DIR: dataDir,
    ENCRYPTION_KEY: 'd'.repeat(64), ADMIN_EMAIL: 'cache@test.example', ADMIN_PASSWORD: 'MailnestCacheAdmin2026!',
    ALLOW_PRIVATE_MAIL_HOSTS: 'true', SYNC_MESSAGE_LIMIT: '20', MAIL_CACHE_RECENT_COUNT: '3',
  }), background: false };
  const { app, mail, store } = await buildApp(config);
  const notices: unknown[] = [];
  Object.defineProperty(mail, 'notify', { value: async (...args: unknown[]) => { notices.push(args); } });
  const host = process.env.MAIL_TEST_HOST || 'localhost';
  const imapPort = Number(process.env.MAIL_TEST_IMAP_PORT || '33993');
  const smtpPort = Number(process.env.MAIL_TEST_SMTP_PORT || '33465');
  const suffix = process.env.MAIL_TEST_DOMAIN || 'mailnest.test';
  const password = process.env.MAIL_TEST_PASSWORD || 'MailnestWirePassword2026';
  const folder = `CacheWarm-${Date.now()}`;
  const baseDate = Date.now() + 60_000;
  try {
    for (const [accountIndex, local] of ['alpha', 'beta'].entries()) {
      const email = `${local}@${suffix}`;
      const remote = new ImapFlow({ host, port: imapPort, secure: true, auth: { user: email, pass: password }, logger: false });
      await remote.connect();
      try {
        await remote.mailboxCreate(folder);
        for (let index = 0; index < (accountIndex === 0 ? 30 : 1); index++) {
          const date = new Date(baseDate + (accountIndex === 0 ? index : 31) * 1000);
          const raw = Buffer.from(`From: cache-sender@example.test\r\nTo: ${email}\r\nDate: ${date.toUTCString()}\r\nSubject: Cache warm ${local} ${index}\r\nMessage-ID: <cache-${local}-${index}-${baseDate}@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n预缓存正文 ${local} ${index}`);
          await remote.append(folder, raw, accountIndex === 0 && index === 0 ? ['\\Flagged'] : [], date);
        }
      } finally { await remote.logout(); }
    }
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.appUrl }, payload: { email: config.adminEmail, password: config.adminPassword } });
    assert.equal(login.statusCode, 200);
    const headers = { cookie: login.cookies.map(item => `${item.name}=${item.value}`).join('; '), origin: config.appUrl };
    for (const local of ['alpha', 'beta']) {
      const email = `${local}@${suffix}`;
      const response = await app.inject({ method: 'POST', url: '/api/v1/accounts', headers, payload: {
        name: `缓存 ${local}`, email, username: email, password, color: '#2563eb', provider: 'imap',
        imap: { host, port: imapPort, secure: true }, smtp: { host, port: smtpPort, secure: true },
      } });
      assert.equal(response.statusCode, 201, response.body);
      await mail.waitForSync();
    }
    const accounts = store.accounts();
    assert.ok(accounts.every(account => account.status === 'connected'));
    const alpha = accounts.find(account => account.email === `alpha@${suffix}`)!;
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id=? AND folder=?').get(alpha.id, folder)!.n, 21, 'Old flagged UID remains outside the recent 20-message window');
    const starred = store.db.prepare('SELECT id FROM messages WHERE account_id=? AND folder=? AND starred=1').get(alpha.id, folder) as { id: string };
    assert.ok(starred);
    const targets = store.db.prepare('SELECT id FROM messages WHERE starred=1 UNION SELECT id FROM (SELECT id FROM messages ORDER BY date DESC,id LIMIT 3)').all() as { id: string }[];
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE detail IS NOT NULL').get()!.n, 0, 'No automatic prewarm when background is disabled');
    mail.scheduleWarm(true); await mail.waitForWarm();
    assert.equal(notices.length, 0, 'Initial synchronization and warming do not notify old mail');
    for (const target of targets) {
      const row = store.message(target.id, alpha.user_id)!;
      assert.ok(row.detail, 'Every starred/recent target has a locally cached body');
      assert.equal(row.source, null);
    }
    const remote = new ImapFlow({ host, port: imapPort, secure: true, auth: { user: alpha.email, pass: password }, logger: false });
    await remote.connect();
    try {
      await remote.mailboxOpen(folder);
      const row = store.message(starred.id, alpha.user_id)!;
      const message = await remote.fetchOne(row.uid, { flags: true }, { uid: true });
      assert.ok(message && message.flags?.has('\\Flagged'));
      assert.ok(message && !message.flags?.has('\\Seen'), 'Warming uses BODY.PEEK and never marks read');
    } finally { await remote.logout(); }
    let attempts = 0;
    Object.defineProperty(mail, 'withClient', { value: async () => { attempts++; throw new Error('Remote unavailable'); } });
    for (const target of targets) {
      const response = await app.inject({ url: `/api/v1/messages/${target.id}`, headers });
      assert.equal(response.statusCode, 200, 'A warmed body is readable with IMAP offline');
      assert.ok(response.json().message.text);
    }
    assert.equal(attempts, 0, 'Cache hits bypass remote connections entirely');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get()!.n, 0);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('TLS IMAP/SMTP: multi-account send, sync, MIME attachment, flags, move, configuration edits, and disconnect', { skip: !enabled, timeout: 90_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mailnest-wire-'));
  const config = { ...loadConfig({
    APP_URL: 'http://localhost:5173', DATA_DIR: dataDir,
    ENCRYPTION_KEY: 'c'.repeat(64), ADMIN_EMAIL: 'wire@test.example',
    ADMIN_PASSWORD: 'MailnestTestAdmin2026!',
    ALLOW_PRIVATE_MAIL_HOSTS: 'true',
  }), background: false };
  const { app, mail, store } = await buildApp(config);
  const notices: {accountId:string;count:number;details?:MailNotificationDetails}[] = [];
  // Capture the real IMAP synchronization result without delivering external Push.
  Object.defineProperty(mail,'notify',{value:async (_owner:string,accountId:string,count:number,_id:string,details?:MailNotificationDetails) => {
    notices.push({accountId,count,details});
  }});
  const host = process.env.MAIL_TEST_HOST || 'localhost';
  const imapPort = Number(process.env.MAIL_TEST_IMAP_PORT || '33993');
  const smtpPort = Number(process.env.MAIL_TEST_SMTP_PORT || '33465');
  const suffix = process.env.MAIL_TEST_DOMAIN || 'mailnest.test';
  const remotePassword = process.env.MAIL_TEST_PASSWORD || 'MailnestWirePassword2026';
  const firstEmail = `alpha@${suffix}`, secondEmail = `beta@${suffix}`;
  const remote = (email: string) => new ImapFlow({host,port:imapPort,secure:true,auth:{user:email,pass:remotePassword},logger:false});
  try {
    // Create ordinary remote folders so providers without SPECIAL-USE flags are covered.
    for (const email of [firstEmail, secondEmail]) {
      const client = remote(email);
      await client.connect();
      const paths = (await client.list()).map(folder => folder.path);
      for (const folder of ['Sent', 'Trash', 'Archive']) if (!paths.includes(folder)) await client.mailboxCreate(folder);
      await client.logout();
    }
    const login = await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:config.appUrl},payload:{email:config.adminEmail,password:config.adminPassword}});
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    const headers = { cookie, origin: config.appUrl };
    const create = async (email: string, name: string) => {
      const response = await app.inject({method:'POST',url:'/api/v1/accounts',headers,payload:{
        name,email,username:email,password:remotePassword,color:'#377a75',provider:'imap',
        imap:{host,port:imapPort,secure:true},smtp:{host,port:smtpPort,secure:true},
      }});
      assert.equal(response.statusCode, 201, response.body);
      assert.ok(!response.body.includes(remotePassword));
      await mail.waitForSync();
      return response.json().account;
    };
    const alpha = await create(firstEmail, '测试邮箱 A');
    const beta = await create(secondEmail, '测试邮箱 B');
    const accounts = (await app.inject({url:'/api/v1/accounts',headers})).json().accounts;
    assert.equal(accounts.length, 2);
    assert.ok(accounts.every((account: {status:string}) => account.status === 'connected'));
    assert.ok(!store.db.prepare('SELECT credentials FROM accounts').get()!.credentials!.toString().includes(remotePassword));
    const subject = `MailNest TLS protocol ${Date.now()}`;
    const content = '附件测试 / wire-level MIME attachment';
    const sent = await app.inject({method:'POST',url:'/api/v1/messages/send',headers,payload:{
      accountId:alpha.id,to:secondEmail,bcc:firstEmail,subject,text:'这封邮件通过真正的 TLS SMTP 发送并由 TLS IMAP 收取。',
      attachments:[{filename:'测试.txt',contentType:'text/plain',content:Buffer.from(content).toString('base64')}],
    }});
    assert.equal(sent.statusCode, 200, sent.body);
    assert.ok(sent.json().messageId);
    assert.equal(sent.json().warning, undefined, 'Sent-folder copy should be saved');
    await mail.waitForSync();
    await app.inject({method:'POST',url:'/api/v1/sync',headers,payload:{}});
    await mail.waitForSync();
    const unified = (await app.inject({url:`/api/v1/messages?folder=INBOX&q=${encodeURIComponent(subject)}`,headers})).json();
    assert.equal(unified.total, 2, 'BCC arrives in alpha inbox and TO arrives in beta inbox');
    const own = (await app.inject({url:`/api/v1/messages?folder=INBOX&accountId=${beta.id}&q=${encodeURIComponent(subject)}`,headers})).json();
    assert.equal(own.total, 1);
    assert.match(own.messages[0].preview,/真正的 TLS SMTP/,'New mail obtains a bounded preview before opening its body');
    const firstNotice = notices.find(notice => notice.accountId === beta.id && notice.details?.subject === subject);
    assert.ok(firstNotice,'New INBOX arrivals include notification details');
    assert.match(firstNotice.details!.preview,/真正的 TLS SMTP/);
    assert.equal(firstNotice.details!.from.address,firstEmail);
    const id = own.messages[0].id;
    assert.equal(own.messages[0].hasAttachments, true);
    const detail = await app.inject({url:`/api/v1/messages/${id}`,headers});
    assert.equal(detail.statusCode, 200, detail.body);
    const message = detail.json().message;
    assert.ok(message.text.includes('真正的 TLS SMTP'));
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].filename, '测试.txt');
    const attachment = await app.inject({url:`/api/v1/messages/${id}/attachments/${message.attachments[0].id}`,headers});
    assert.equal(attachment.statusCode, 200);
    assert.equal(attachment.rawPayload.toString('utf8'), content);
    const patched = await app.inject({method:'PATCH',url:`/api/v1/messages/${id}`,headers,payload:{unread:false,starred:true}});
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().message.unread, false);
    assert.equal(patched.json().message.starred, true);
    const client = remote(secondEmail);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({header:{subject}}, {uid:true});
      assert.ok(uids && uids.length);
      const remoteMessage = await client.fetchOne(uids[0],{flags:true},{uid:true});
      assert.ok(remoteMessage && remoteMessage.flags?.has('\\Seen'));
      assert.ok(remoteMessage && remoteMessage.flags?.has('\\Flagged'));
    } finally { lock.release(); await client.logout(); }
    const moved = await app.inject({method:'POST',url:`/api/v1/messages/${id}/move`,headers,payload:{destination:'trash'}});
    assert.equal(moved.statusCode, 200, moved.body);
    await mail.waitForSync();
    const trash = (await app.inject({url:`/api/v1/messages?folder=trash&accountId=${beta.id}&q=${encodeURIComponent(subject)}`,headers})).json();
    assert.equal(trash.total, 1);
    const sentFolder = (await app.inject({url:`/api/v1/messages?folder=sent&accountId=${alpha.id}&q=${encodeURIComponent(subject)}`,headers})).json();
    assert.equal(sentFolder.total, 1);
    const sentDetail = (await app.inject({url:`/api/v1/messages/${sentFolder.messages[0].id}`,headers})).json().message;
    assert.equal(store.db.prepare('SELECT source FROM messages WHERE id=?').get(sentDetail.id)!.source,null,'Complete MIME is no longer duplicated in the body cache');
    const sentRemote=remote(firstEmail);await sentRemote.connect();
    try {
      await sentRemote.mailboxOpen('Sent');
      const row=store.db.prepare('SELECT uid FROM messages WHERE id=?').get(sentDetail.id) as {uid:number};
      const original=await sentRemote.fetchOne(row.uid,{source:true},{uid:true});
      assert.ok(original&&original.source&&!original.source.toString().match(/^bcc:/im),'BCC address must not be included in the delivered MIME');
    }finally{await sentRemote.logout();}
    // Exercise real MIME-part downloads, including a root with no part number,
    // charset conversion, and a CID image fetched separately from the body.
    const mimeRemote=remote(secondEmail);await mimeRemote.connect();
    const cidSubject=`MailNest CID ${Date.now()}`,plainSubject=`MailNest single-part ${Date.now()}`;
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
    try {
      await mimeRemote.append('INBOX',Buffer.from(`From: alpha@${suffix}\r\nTo: beta@${suffix}\r\nSubject: ${cidSubject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=fixture-cid\r\n\r\n--fixture-cid\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>CID image</p><img src="cid:fixture-image">\r\n--fixture-cid\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <fixture-image>\r\nContent-Disposition: inline; filename="inline.png"\r\n\r\n${png.toString('base64')}\r\n--fixture-cid--\r\n`));
      await mimeRemote.append('INBOX',Buffer.from(`From: alpha@${suffix}\r\nTo: beta@${suffix}\r\nSubject: ${plainSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=gb2312\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=C4=E3=BA=C3 single-part body\r\n`));
    }finally{await mimeRemote.logout();}
    await app.inject({method:'POST',url:`/api/v1/accounts/${beta.id}/sync`,headers});await mail.waitForSync();
    const plainNotice = notices.at(-1)!;
    assert.equal(plainNotice.accountId,beta.id);
    assert.equal(plainNotice.count,2);
    assert.equal(plainNotice.details?.subject,plainSubject,'The latest arriving UID wins within a multi-message batch');
    assert.match(plainNotice.details!.preview,/你好 single-part body/,'Notification MIME decoding preserves GB2312 and quoted-printable text');
    for(const [query,verify] of [[plainSubject,async(message:{text:string})=>assert.match(message.text,/你好 single-part body/)],[cidSubject,async(message:{text:string;attachments:{id:string;contentId:string;inline:boolean}[]})=>{
      assert.match(message.text,/CID image/);assert.equal(message.attachments[0].contentId,'fixture-image');assert.equal(message.attachments[0].inline,true);
      const image=await app.inject({url:`/api/v1/messages/${(message as {id?:string}).id}/attachments/${message.attachments[0].id}?inline=true`,headers});assert.equal(image.statusCode,200,image.body);assert.equal(image.headers['content-type'],'image/png');assert.deepEqual(image.rawPayload,png);
    }]] as const) {
      const result=(await app.inject({url:`/api/v1/messages?accountId=${beta.id}&q=${encodeURIComponent(query)}`,headers})).json();assert.equal(result.total,1);
      const response=await app.inject({url:`/api/v1/messages/${result.messages[0].id}`,headers});assert.equal(response.statusCode,200,response.body);await verify(response.json().message);
    }
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as {n:number}).n,0,'Inline images and downloads are not retained as binary database payloads');

    // Attachment-first multipart mail must download only the HTML body part.
    // Its old Date header must not make an earlier notification win.
    const htmlSubject = `MailNest HTML preview ${Date.now()}`;
    const htmlRemote = remote(secondEmail);await htmlRemote.connect();
    try {
      await htmlRemote.append('INBOX',Buffer.from(`From: Preview Team <alpha@${suffix}>\r\nTo: beta@${suffix}\r\nDate: Sat, 01 Jan 2000 00:00:00 +0000\r\nSubject: ${htmlSubject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=fixture-preview\r\n\r\n--fixture-preview\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="unneeded.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.alloc(64*1024,65).toString('base64')}\r\n--fixture-preview\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('<html><body><style>.x{color:red}</style><h1>项目更新</h1><p>正文摘要 &amp; 已完成。</p></body></html>').toString('base64')}\r\n--fixture-preview--\r\n`));
    } finally {await htmlRemote.logout();}
    await app.inject({method:'POST',url:`/api/v1/accounts/${beta.id}/sync`,headers});await mail.waitForSync();
    const htmlNotice = notices.at(-1)!;
    assert.equal(htmlNotice.details?.subject,htmlSubject);
    assert.match(htmlNotice.details!.preview,/项目更新/);
    assert.match(htmlNotice.details!.preview,/正文摘要 & 已完成/);
    assert.ok(!htmlNotice.details!.preview.includes('<') && !htmlNotice.details!.preview.includes('color:red'));
    const htmlRow = (await app.inject({url:`/api/v1/messages?accountId=${beta.id}&q=${encodeURIComponent(htmlSubject)}`,headers})).json().messages[0];
    const htmlCache = store.db.prepare('SELECT source,detail FROM messages WHERE id=?').get(htmlRow.id)!;
    assert.equal(htmlCache.source,null);assert.equal(htmlCache.detail,null,'Notification preview does not eagerly cache the full HTML body or attachments');
    const htmlCheck = remote(secondEmail);await htmlCheck.connect();
    try {
      await htmlCheck.mailboxOpen('INBOX',{readOnly:true});
      const uids = await htmlCheck.search({header:{subject:htmlSubject}},{uid:true});
      assert.ok(uids && uids.length);
      const fetched = await htmlCheck.fetchOne(uids[0],{flags:true},{uid:true});
      assert.ok(fetched && !fetched.flags?.has('\\Seen'),'Fetching a notification preview does not mark the message read');
    }finally{await htmlCheck.logout();}

    const cachedAlphaIds = () => (store.db.prepare('SELECT id FROM messages WHERE account_id=? ORDER BY id').all(alpha.id) as {id:string}[]).map(row => row.id);
    const originalAlphaIds = cachedAlphaIds();
    assert.ok(originalAlphaIds.length >= 2, 'Configuration edits start with populated Inbox and Sent caches');
    const originalEpoch = store.account(alpha.id)!.mail_cache_epoch;
    const metadataEdit = await app.inject({method:'PATCH',url:`/api/v1/accounts/${alpha.id}`,headers,payload:{name:'已编辑测试邮箱 A',color:'#627dcc'}});
    assert.equal(metadataEdit.statusCode,200,metadataEdit.body);
    assert.equal(metadataEdit.json().account.id,alpha.id);
    assert.equal(metadataEdit.json().account.name,'已编辑测试邮箱 A');
    assert.equal(metadataEdit.json().account.color,'#627dcc');
    assert.equal(metadataEdit.json().account.authType,'password');
    assert.equal(metadataEdit.json().cacheReset,false);
    assert.deepEqual(cachedAlphaIds(),originalAlphaIds,'Name and color changes retain cached messages');
    assert.equal(store.account(alpha.id)!.mail_cache_epoch,originalEpoch);

    // Matching SMTP values still opt into independent credentials, and both
    // real TLS connections must validate before the encrypted change is saved.
    const separateEdit = await app.inject({method:'PATCH',url:`/api/v1/accounts/${alpha.id}`,headers,payload:{smtpUsername:firstEmail,smtpPassword:remotePassword}});
    assert.equal(separateEdit.statusCode,200,separateEdit.body);
    assert.equal(separateEdit.json().account.id,alpha.id);
    assert.equal(separateEdit.json().account.hasSeparateSmtpCredentials,true);
    assert.equal(separateEdit.json().cacheReset,false);
    assert.ok(!separateEdit.body.includes(remotePassword));
    await mail.waitForSync();
    assert.deepEqual(cachedAlphaIds(),originalAlphaIds,'SMTP credential edits preserve mailbox identity and cached IDs');
    const validAlpha = store.account(alpha.id)!;
    for (const invalid of [
      {password:'Wrong-IMAP-fixture-password-2026!'},
      {smtpPassword:'Wrong-SMTP-fixture-password-2026!'},
    ]) {
      const failedEdit = await app.inject({method:'PATCH',url:`/api/v1/accounts/${alpha.id}`,headers,payload:{name:'失败修改不得保存',...invalid}});
      assert.equal(failedEdit.statusCode,400,failedEdit.body);
      assert.equal(failedEdit.json().error.code,'MAIL_CONNECTION_FAILED');
      for (const secret of Object.values(invalid)) assert.ok(!failedEdit.body.includes(secret),'Connection errors must not expose supplied passwords');
      const retainedAccount = store.account(alpha.id)!;
      assert.equal(retainedAccount.name,validAlpha.name,'A failed validation leaves the previous account name intact');
      assert.equal(retainedAccount.credentials,validAlpha.credentials,'A failed validation does not replace encrypted credentials');
      assert.equal(retainedAccount.mail_cache_epoch,originalEpoch);
      assert.deepEqual(cachedAlphaIds(),originalAlphaIds,'A failed validation retains the populated mail cache');
      assert.equal((await app.inject({url:`/api/v1/messages/${sentDetail.id}`,headers})).statusCode,200,'Existing messages remain readable after failed validation');
    }
    const sharedEdit = await app.inject({method:'PATCH',url:`/api/v1/accounts/${alpha.id}`,headers,payload:{smtpUsername:null,smtpPassword:null}});
    assert.equal(sharedEdit.statusCode,200,sharedEdit.body);
    assert.equal(sharedEdit.json().account.hasSeparateSmtpCredentials,false);
    assert.equal(sharedEdit.json().account.smtpUsername,firstEmail);
    assert.equal(sharedEdit.json().cacheReset,false);
    await mail.waitForSync();
    assert.deepEqual(cachedAlphaIds(),originalAlphaIds,'Restoring shared credentials retains the existing mailbox cache');

    // Rebind the local account to the other real fixture login. The displayed
    // email stays unchanged, while remote mailbox identity and local IDs change.
    const rebound = await app.inject({method:'PATCH',url:`/api/v1/accounts/${alpha.id}`,headers,payload:{username:secondEmail}});
    assert.equal(rebound.statusCode,200,rebound.body);
    assert.equal(rebound.json().account.id,alpha.id);
    assert.equal(rebound.json().account.email,firstEmail);
    assert.equal(rebound.json().account.username,secondEmail);
    assert.equal(rebound.json().cacheReset,true);
    assert.notEqual(store.account(alpha.id)!.mail_cache_epoch,originalEpoch,'A changed remote login uses a new cache epoch');
    for (const previousId of originalAlphaIds) assert.equal((await app.inject({url:`/api/v1/messages/${previousId}`,headers})).statusCode,404,'Old cached IDs cannot be reused after changing mailbox identity');
    await mail.waitForSync();
    assert.equal(store.account(alpha.id)!.status,'connected','The new remote login synchronizes successfully');
    const reboundInbox = (await app.inject({url:`/api/v1/messages?folder=INBOX&accountId=${alpha.id}&q=${encodeURIComponent(cidSubject)}`,headers})).json();
    assert.equal(reboundInbox.total,1,'The rebound account reads messages from the newly selected remote mailbox');
    assert.ok(!originalAlphaIds.includes(reboundInbox.messages[0].id));
    assert.equal((await app.inject({url:`/api/v1/messages/${reboundInbox.messages[0].id}`,headers})).statusCode,200);
    for (const previousId of originalAlphaIds) assert.equal((await app.inject({url:`/api/v1/messages/${previousId}`,headers})).statusCode,404,'Resynchronization does not revive old cached IDs');
    for (const [email,folders] of [
      [firstEmail,[['INBOX',subject],['Sent',subject]]],
      [secondEmail,[['INBOX',cidSubject],['INBOX',plainSubject],['Trash',subject]]],
    ] as const) {
      const untouched = remote(email);
      await untouched.connect();
      try {
        for (const [folder,remoteSubject] of folders) {
          await untouched.mailboxOpen(folder,{readOnly:true});
          const uids = await untouched.search({header:{subject:remoteSubject}},{uid:true});
          assert.ok(uids && uids.length,`Account edits preserve remote ${folder} messages`);
        }
      } finally { await untouched.logout(); }
    }
    const removed = await app.inject({method:'DELETE',url:`/api/v1/accounts/${beta.id}`,headers});
    assert.equal(removed.statusCode, 200);
    const retained = remote(secondEmail);
    await retained.connect();
    await retained.mailboxOpen('Trash');
    assert.ok((await retained.search({header:{subject}}, {uid:true}))!.length, 'Disconnect leaves remote messages untouched');
    await retained.logout();
  } finally {
    await app.close();
    await rm(dataDir, {recursive:true,force:true});
  }
});
