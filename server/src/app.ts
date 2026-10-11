import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { ServerResponse } from 'node:http';
import webPush from 'web-push';
import type { RequestOptions } from 'web-push';
import { type Config, loadConfig, repoRoot, frontendBuilt } from './config.js';
import { Store, type UserRow, type AccountRow, type MessageRow, accountDto, summaryDto, userDto } from './db.js';
import { ApiError, hashPassword, verifyPassword, hashToken, randomToken, safeMailError } from './security.js';
import { MailService, findFolder, googleToken, googleIdentity } from './mail.js';

interface Auth {user:UserRow;kind:'session'|'token';sessionId?:string;expiresAt?:number}
declare module 'fastify' { interface FastifyRequest { auth:Auth|null } }
const cookieName='mailnest_session';
const portSchema=z.number().int().min(1).max(65535);
const serverSchema=z.object({host:z.string().trim().min(1).max(253),port:portSchema,secure:z.boolean()});
const accountSchema=z.object({name:z.string().trim().min(1).max(80),email:z.email().max(254),color:z.string().regex(/^#[a-f\d]{6}$/i).default('#6d5ce8'),provider:z.enum(['gmail','imap']),username:z.string().trim().min(1).max(254),password:z.string().min(1).max(1024),smtpUsername:z.string().trim().min(1).max(254).optional(),smtpPassword:z.string().min(1).max(1024).optional(),imap:serverSchema,smtp:serverSchema}).strict();
const accountUpdateSchema=z.object({name:z.string().trim().min(1).max(80).optional(),email:z.email().max(254).optional(),color:z.string().regex(/^#[a-f\d]{6}$/i).optional(),username:z.string().trim().min(1).max(254).optional(),password:z.string().max(1024).optional(),smtpUsername:z.string().trim().min(1).max(254).nullable().optional(),smtpPassword:z.string().max(1024).nullable().optional(),imap:serverSchema.strict().optional(),smtp:serverSchema.strict().optional()}).strict().refine(input=>Object.keys(input).length>0,'至少提供一个修改字段');
const headerText=z.string().max(998).refine(value=>!/[\r\n\x00]/.test(value),'邮件头字段不能包含换行');
const sendSchema=z.object({accountId:z.string().max(100),to:headerText.min(3),cc:headerText.optional(),bcc:headerText.optional(),subject:headerText,text:z.string().max(2*1024*1024),inReplyTo:headerText.optional(),references:headerText.optional(),attachments:z.array(z.object({filename:z.string().min(1).max(255).refine(v=>!/[\r\n\x00]/.test(v)),contentType:z.string().max(120).regex(/^[\w.+-]+\/[\w.+-]+$/),content:z.string().max(28*1024*1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict()).max(20).optional()}).strict();
const pushSchema=z.object({endpoint:z.url().max(2048),keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]{87,90}={0,2}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/)}).strict()}).strict();
const trustedPushHosts=['fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com','web.push.apple.com','wns.windows.com'];
function validatePushEndpoint(endpoint:string) {
  const url=new URL(endpoint);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!trustedPushHosts.some(host=>url.hostname===host||url.hostname.endsWith(`.${host}`)))throw new ApiError(400,'INVALID_PUSH_ENDPOINT','仅支持浏览器提供的 HTTPS 推送服务地址。');
}
function pushStatus(error:unknown) {return error&&typeof error==='object'?(error as {statusCode?:number}).statusCode:undefined;}
function pushDeliveryOptions(notificationId:string):RequestOptions {
  // Give an idle device time to reconnect without collapsing separate batches.
  return{TTL:3600,timeout:10_000,contentEncoding:'aes128gcm',urgency:'high',topic:createHash('sha256').update(notificationId).digest('base64url').slice(0,32)};
}
interface EventClient {response:ServerResponse;sessionId:string;userId:string;expiresAt:number}

export async function buildApp(config:Config=loadConfig()) {
  const app=Fastify({logger:{level:config.production?'info':'warn',redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]'],serializers:{req:(req:{method:string;url:string;remoteAddress?:string})=>({method:req.method,url:req.url.split('?')[0],remoteAddress:req.remoteAddress})}},trustProxy:config.trustProxy,bodyLimit:32*1024*1024,requestTimeout:120_000});
  const store=new Store(config);await store.bootstrap(config);
  app.decorateRequest('auth',null);
  await app.register(cookie);
  const clients=new Set<EventClient>();
  const unreadCount=(userId:string)=>(store.db.prepare('SELECT COALESCE(SUM(unread),0) AS n FROM accounts WHERE user_id=?').get(userId) as {n:number}).n;
  const emit=(userId:string,event:string,data:unknown)=>{
    const payload=event==='mail'||event==='sync'?{...(data as Record<string,unknown>),unreadCount:unreadCount(userId)}:data;
    const frame=`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for(const client of clients)if(client.userId===userId){if(client.response.writableLength>128*1024){client.response.end();clients.delete(client);}else client.response.write(frame);}
  };
  const closeUserEvents=(userId:string,sessionId?:string)=>{for(const client of clients)if(client.userId===userId&&(!sessionId||client.sessionId===sessionId)){client.response.end();clients.delete(client);}};
  if(config.vapidPublicKey&&config.vapidPrivateKey)webPush.setVapidDetails(config.vapidSubject,config.vapidPublicKey,config.vapidPrivateKey);
  async function notify(userId:string,accountId:string,count:number,notificationId:string=randomUUID()) {
    if(!config.vapidPublicKey||!config.vapidPrivateKey)return;
    const rows=store.db.prepare('SELECT endpoint,subscription FROM push_subscriptions WHERE user_id=?').all(userId) as {endpoint:string;subscription:string}[];
    const payload=JSON.stringify({title:'MailNest 新邮件',body:`有 ${count} 封新邮件等待查看`,url:`/?account=${encodeURIComponent(accountId)}`,tag:`mail-${accountId}`,notificationId,unreadCount:unreadCount(userId)});
    await Promise.allSettled(rows.map(async row=>{
      const subscriptionId=createHash('sha256').update(row.endpoint).digest('hex').slice(0,12);
      try {
        const response=await webPush.sendNotification(JSON.parse(row.subscription),payload,pushDeliveryOptions(notificationId));
        app.log.info({notificationId,accountId,subscriptionId,statusCode:response.statusCode},'New-mail push accepted');
      } catch(error) {
        const code=pushStatus(error),expired=code===404||code===410;
        if(expired)store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=? AND subscription=?').run(row.endpoint,userId,row.subscription);
        // Provider errors can contain full endpoint URLs and authorization keys.
        app.log.warn({notificationId,accountId,subscriptionId,statusCode:typeof code==='number'?code:undefined,category:expired?'PUSH_SUBSCRIPTION_EXPIRED':'PUSH_DELIVERY_FAILED'},'New-mail push failed');
      }
    }));
  }
  const mail=new MailService(store,config,emit,notify);
  const loginAttempts=new Map<string,{count:number;until:number}>();
  const pushTestAttempts=new Map<string,number>();
  const cookieOptions={httpOnly:true,secure:config.appUrl.startsWith('https:'),sameSite:'lax' as const,path:'/api',maxAge:7*24*60*60};
  const prefix='/api/v1';
  function account(request:FastifyRequest,id:string):AccountRow {const row=store.account(id,request.auth!.user.id);if(!row)throw new ApiError(404,'NOT_FOUND','邮箱不存在。');return row;}
  function message(request:FastifyRequest,id:string):MessageRow {const row=store.message(id,request.auth!.user.id);if(!row)throw new ApiError(404,'NOT_FOUND','邮件不存在。');return row;}
  function sessionOnly(request:FastifyRequest) {if(request.auth?.kind!=='session')throw new ApiError(403,'SESSION_REQUIRED','此操作需要浏览器会话登录。');}
  function csrf(request:FastifyRequest) {if(request.headers.origin!==config.appUrl)throw new ApiError(403,'INVALID_ORIGIN','请求来源无效，请从配置的站点地址登录。');}
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin').header('X-Frame-Options','DENY');
    if(config.appUrl.startsWith('https:'))reply.header('Strict-Transport-Security','max-age=31536000');
    const path=request.url.split('?')[0];
    if(!path.startsWith('/api/'))return;
    reply.header('Cache-Control','no-store');
    if(path===`${prefix}/health`||path===`${prefix}/auth/login`){if(path.endsWith('/auth/login')&&request.method==='POST')csrf(request);return;}
    const authorization=request.headers.authorization;
    if(authorization) {
      const bearer=/^Bearer (\S+)$/.exec(authorization);
      const token=bearer?store.db.prepare('SELECT id,user_id FROM api_tokens WHERE token_hash=?').get(hashToken(bearer[1])) as {id:string;user_id:string}|undefined:undefined;
      const user=token?store.user(token.user_id):undefined;
      if(user&&token){request.auth={user,kind:'token'};store.db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(new Date().toISOString(),token.id);}
    }else {
      const session=request.cookies[cookieName];
      const row=session?store.db.prepare('SELECT user_id,expires_at FROM sessions WHERE id=? AND expires_at>?').get(hashToken(session),Date.now()) as {user_id:string;expires_at:number}|undefined:undefined;
      const user=row?store.user(row.user_id):undefined;
      if(user&&row)request.auth={user,kind:'session',sessionId:hashToken(session!),expiresAt:row.expires_at};
    }
    if(!request.auth)throw new ApiError(401,'UNAUTHENTICATED','请先登录。');
    if(!['GET','HEAD','OPTIONS'].includes(request.method)&&request.auth.kind==='session')csrf(request);
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:`请求参数不正确：${error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).slice(0,3).join('；')}`}});
    if(error instanceof ApiError)return reply.code(error.status).send({error:{code:error.code,message:error.message}});
    const fastifyError=error as {statusCode?:number;code?:string};
    if(fastifyError.statusCode&&fastifyError.statusCode<500)return reply.code(fastifyError.statusCode).send({error:{code:fastifyError.code||'BAD_REQUEST',message:fastifyError.statusCode===413?'请求体过大。':'请求格式不正确。'}});
    // Log only a category; protocol errors can include credentials and complete remote responses.
    request.log.error({category:fastifyError.code||'INTERNAL_ERROR'},'Request failed');
    return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'服务暂时无法完成此操作，请稍后重试。'}});
  });
  app.get(`${prefix}/health`,async()=>({status:'ok'}));
  app.post(`${prefix}/auth/login`,async(request,reply)=>{
    const input=z.object({email:z.email().max(254),password:z.string().max(1024)}).strict().parse(request.body);
    const key=request.ip;const now=Date.now();const attempts=loginAttempts.get(key);
    if(attempts&&attempts.until>now&&attempts.count>=5)throw new ApiError(429,'LOGIN_RATE_LIMIT','登录尝试过多，请 10 分钟后再试。');
    const current=attempts&&attempts.until>now?attempts:{count:0,until:now+600_000};current.count++;loginAttempts.set(key,current);
    if(loginAttempts.size>10_000)for(const [ip,value] of loginAttempts)if(value.until<now)loginAttempts.delete(ip);
    const user=store.db.prepare('SELECT * FROM users WHERE email=?').get(input.email.toLowerCase()) as UserRow|undefined;
    const fallback=store.db.prepare('SELECT password_hash FROM users LIMIT 1').get() as {password_hash:string};
    const valid=await verifyPassword(input.password,user?.password_hash||fallback.password_hash);
    if(!user||!valid)throw new ApiError(401,'LOGIN_FAILED','邮箱或密码不正确。');
    loginAttempts.delete(key);
    const old=request.cookies[cookieName];if(old){const hash=hashToken(old);const oldSession=store.db.prepare('SELECT user_id FROM sessions WHERE id=?').get(hash) as {user_id:string}|undefined;store.db.prepare('DELETE FROM sessions WHERE id=?').run(hash);if(oldSession)closeUserEvents(oldSession.user_id,hash);}
    const token=randomToken();store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token),user.id,now+7*86400_000);
    reply.setCookie(cookieName,token,cookieOptions);
    return {user:userDto(user)};
  });
  app.get(`${prefix}/auth/me`,async request=>({user:userDto(request.auth!.user)}));
  app.post(`${prefix}/auth/logout`,async(request,reply)=>{
    sessionOnly(request);store.db.prepare('DELETE FROM sessions WHERE id=?').run(request.auth!.sessionId!);closeUserEvents(request.auth!.user.id,request.auth!.sessionId);reply.clearCookie(cookieName,{path:'/api'});return{ok:true};
  });
  app.post(`${prefix}/auth/password`,async(request,reply)=>{
    sessionOnly(request);
    const input=z.object({currentPassword:z.string().max(1024),newPassword:z.string().min(12).max(1024)}).strict().parse(request.body);
    if(!await verifyPassword(input.currentPassword,request.auth!.user.password_hash))throw new ApiError(400,'PASSWORD_INVALID','当前密码不正确。');
    const hash=await hashPassword(input.newPassword);const userId=request.auth!.user.id;
    store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,userId);
    store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);store.db.prepare('DELETE FROM api_tokens WHERE user_id=?').run(userId);store.db.prepare('DELETE FROM oauth_states WHERE user_id=?').run(userId);closeUserEvents(userId);reply.clearCookie(cookieName,{path:'/api'});return{ok:true};
  });
  app.get(`${prefix}/config`,async()=>({googleConfigured:!!(config.googleClientId&&config.googleClientSecret),pushPublicKey:config.vapidPublicKey||null,pollingInterval:config.syncIntervalSeconds}));
  app.get(`${prefix}/accounts`,async request=>({accounts:store.accounts(request.auth!.user.id).map(row=>accountDto(row,mail.cachedFolders(row.id),mail.authInfo(row)))}));
  app.post(`${prefix}/accounts`,async(request,reply)=>{
    const input=accountSchema.parse(request.body);
    if(input.provider==='gmail' && (input.imap.host.toLowerCase()!=='imap.gmail.com'||input.smtp.host.toLowerCase()!=='smtp.gmail.com'||input.username.toLowerCase()!==input.email.toLowerCase()||(input.smtpUsername&&input.smtpUsername.toLowerCase()!==input.email.toLowerCase())))throw new ApiError(400,'GMAIL_SETTINGS','Google 邮箱需使用 imap.gmail.com / smtp.gmail.com，且用户名与邮箱地址一致。');
    const created=await mail.create(request.auth!.user.id,input);return reply.code(201).send({account:accountDto(created,mail.cachedFolders(created.id),mail.authInfo(created))});
  });
  app.patch(`${prefix}/accounts/:id`,async request=>{
    const current=account(request,(request.params as {id:string}).id);
    const result=await mail.update(current,accountUpdateSchema.parse(request.body));
    return{account:accountDto(result.account,mail.cachedFolders(current.id),mail.authInfo(result.account)),cacheReset:result.cacheReset};
  });
  app.delete(`${prefix}/accounts/:id`,async request=>{const {id}=request.params as {id:string};await mail.remove(account(request,id));return{ok:true};});
  app.get(`${prefix}/accounts/:id/folders`,async request=>{const {id}=request.params as {id:string};try{return{folders:await mail.listFolders(account(request,id))};}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'MAIL_OPERATION_FAILED',safeMailError(error));}});
  app.post(`${prefix}/accounts/:id/sync`,async request=>{const {id}=request.params as {id:string};mail.schedule(account(request,id).id);return{ok:true};});
  app.post(`${prefix}/sync`,async request=>{
    const input=z.object({accountId:z.string().max(100).optional()}).strict().parse(request.body||{});
    const rows=input.accountId?[account(request,input.accountId)]:store.accounts(request.auth!.user.id);for(const row of rows)mail.schedule(row.id);return{ok:true};
  });
  app.get(`${prefix}/messages`,async request=>{
    const query=z.object({accountId:z.string().max(100).optional(),folder:z.string().min(1).max(200).default('INBOX'),filter:z.enum(['all','unread','starred']).default('all'),q:z.string().max(200).default(''),page:z.coerce.number().int().min(1).max(100_000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)}).strict().parse(request.query);
    const accounts=query.accountId?[account(request,query.accountId)]:store.accounts(request.auth!.user.id);
    const conditions:string[]=[];const values:(string|number)[]=[];
    for(const row of accounts){
      const folders=mail.folderRows(row.id);
      // A specific mailbox supplies actual server paths, including paths that
      // happen to match another folder's logical alias (for example "drafts").
      const exact=query.accountId?folders.find(folder=>folder.path===query.folder):undefined;
      const folder=exact?(exact.selectable===0?undefined:exact.path):findFolder(folders,query.folder);
      if(folder){conditions.push('(m.account_id=? AND m.folder=?)');values.push(row.id,folder);}
    }
    if(!conditions.length)return{messages:[],total:0,page:query.page,pageSize:query.pageSize};
    let where=`(${conditions.join(' OR ')}) AND a.user_id=?`;values.push(request.auth!.user.id);
    if(query.filter==='unread')where+=' AND m.unread=1';if(query.filter==='starred')where+=' AND m.starred=1';
    if(query.q){where+=" AND (json_extract(m.summary,'$.subject') LIKE ? ESCAPE '\\' OR json_extract(m.summary,'$.from.address') LIKE ? ESCAPE '\\' OR json_extract(m.summary,'$.from.name') LIKE ? ESCAPE '\\' OR json_extract(m.detail,'$.text') LIKE ? ESCAPE '\\')";const q=`%${query.q.replace(/[\\%_]/g,'\\$&')}%`;values.push(q,q,q,q);}
    const count=store.db.prepare(`SELECT COUNT(*) AS total FROM messages m JOIN accounts a ON a.id=m.account_id WHERE ${where}`).get(...values) as {total:number};
    const rows=store.db.prepare(`SELECT m.id,m.account_id,m.folder,m.summary,m.unread,m.starred FROM messages m JOIN accounts a ON a.id=m.account_id WHERE ${where} ORDER BY m.date DESC,m.id LIMIT ? OFFSET ?`).all(...values,query.pageSize,(query.page-1)*query.pageSize) as unknown as MessageRow[];
    return{messages:rows.map(summaryDto),total:count.total,page:query.page,pageSize:query.pageSize};
  });
  app.get(`${prefix}/messages/:id`,async request=>{const row=message(request,(request.params as {id:string}).id);try{return{message:await mail.detail(account(request,row.account_id),row)};}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'MAIL_OPERATION_FAILED',safeMailError(error));}});
  app.patch(`${prefix}/messages/:id`,async request=>{
    const input=z.object({unread:z.boolean().optional(),starred:z.boolean().optional()}).strict().refine(v=>v.unread!==undefined||v.starred!==undefined).parse(request.body);const row=message(request,(request.params as {id:string}).id);
    try{return{message:await mail.flags(account(request,row.account_id),row,input)};}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'MAIL_OPERATION_FAILED',safeMailError(error));}
  });
  app.post(`${prefix}/messages/:id/move`,async request=>{
    const input=z.object({destination:z.enum(['trash','archive','INBOX'])}).strict().parse(request.body);const row=message(request,(request.params as {id:string}).id);
    try{await mail.move(account(request,row.account_id),row,input.destination);return{ok:true};}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'MAIL_OPERATION_FAILED',safeMailError(error));}
  });
  app.get(`${prefix}/messages/:id/attachments/:attachmentId`,async(request,reply)=>{
    const params=request.params as {id:string;attachmentId:string};const row=message(request,params.id);
    const query=z.object({inline:z.enum(['true','1','false','0']).optional()}).strict().parse(request.query);
    const inline=query.inline==='true'||query.inline==='1';
    let attachment:Awaited<ReturnType<MailService['attachment']>>;
    try{attachment=await mail.attachment(account(request,row.account_id),row,params.attachmentId,inline);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'MAIL_OPERATION_FAILED',safeMailError(error));}
    const filename=Array.from(attachment.filename.replace(/[\r\n\x00]/g,'')).slice(0,255).join('');
    return reply.header('Content-Disposition',`${inline?'inline':'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16)}`)}`).header('Content-Security-Policy',"default-src 'none'; sandbox").type(inline?attachment.contentType:'application/octet-stream').send(attachment.content);
  });
  app.post(`${prefix}/messages/send`,async request=>{const input=sendSchema.parse(request.body);try{return await mail.send(account(request,input.accountId),input);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'MAIL_SEND_FAILED',safeMailError(error));}});
  app.get(`${prefix}/oauth/google/start`,async request=>{
    sessionOnly(request);if(!config.googleClientId||!config.googleClientSecret)throw new ApiError(503,'GOOGLE_NOT_CONFIGURED','管理员尚未配置 Google OAuth。');
    const state=randomToken(),verifier=randomBytes(48).toString('base64url');
    store.cleanup();store.db.prepare('DELETE FROM oauth_states WHERE user_id=?').run(request.auth!.user.id);
    store.db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?,?)').run(state,request.auth!.user.id,request.auth!.sessionId!,verifier,Date.now()+600_000);
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.search=new URLSearchParams({client_id:config.googleClientId,redirect_uri:config.googleRedirectUri,response_type:'code',scope:'openid email https://mail.google.com/',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();return{url:url.toString()};
  });
  app.get(`${prefix}/oauth/google/callback`,async(request,reply)=>{
    sessionOnly(request);
    try {
      const query=z.object({state:z.string().min(20).max(200),code:z.string().max(4096).optional(),error:z.string().max(200).optional()}).passthrough().parse(request.query);
      const state=store.db.prepare('SELECT * FROM oauth_states WHERE state=? AND user_id=? AND session_id=? AND expires_at>?').get(query.state,request.auth!.user.id,request.auth!.sessionId!,Date.now()) as {verifier:string}|undefined;
      if(!state)throw new ApiError(400,'OAUTH_STATE','授权请求已过期或来源不正确，请重新开始授权。');
      store.db.prepare('DELETE FROM oauth_states WHERE state=?').run(query.state);
      if(query.error||!query.code)throw new ApiError(400,'OAUTH_CANCELLED','Google 授权已取消，请重新连接。');
      const token=await googleToken(config,{grant_type:'authorization_code',code:query.code,redirect_uri:config.googleRedirectUri,code_verifier:state.verifier});
      const identity=await googleIdentity(token.access_token);
      if(!token.refresh_token)throw new ApiError(400,'OAUTH_NO_REFRESH','Google 未提供持续访问授权，请移除旧授权后重新连接。');
      await mail.connectGoogle(request.auth!.user.id,identity.email,identity.name,{accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:Date.now()+token.expires_in*1000});
      return reply.redirect('/?oauth=success');
    }catch(error){return reply.redirect(`/?oauth=error&reason=${encodeURIComponent(error instanceof ApiError?error.message:'Google 邮箱连接失败，请检查授权和邮箱设置。')}`);}
  });
  app.get(`${prefix}/events`,async(request,reply)=>{
    sessionOnly(request);if([...clients].filter(c=>c.userId===request.auth!.user.id).length>=10)throw new ApiError(429,'EVENT_LIMIT','同时打开的通知连接过多。');
    reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({unreadCount:unreadCount(request.auth!.user.id)})}\n\n`);
    const client:EventClient={response:reply.raw,userId:request.auth!.user.id,sessionId:request.auth!.sessionId!,expiresAt:request.auth!.expiresAt!};clients.add(client);
    reply.raw.on('close',()=>clients.delete(client));
  });
  app.post(`${prefix}/push/subscriptions`,async request=>{
    const input=pushSchema.parse(request.body);validatePushEndpoint(input.endpoint);
    if(!config.vapidPublicKey||!config.vapidPrivateKey)throw new ApiError(503,'PUSH_NOT_CONFIGURED','管理员尚未配置推送服务。');
    const userId=request.auth!.user.id;
    const existing=store.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint=?').get(input.endpoint) as {user_id:string}|undefined;
    if(existing&&existing.user_id!==userId)throw new ApiError(409,'PUSH_ENDPOINT_EXISTS','此推送地址已被使用。');
    if(!existing){const count=store.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').get(userId) as {n:number};if(count.n>=20)throw new ApiError(400,'PUSH_LIMIT','每位用户最多 20 个推送设备。');}
    const saved=store.db.prepare('INSERT INTO push_subscriptions(endpoint,user_id,subscription) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription WHERE push_subscriptions.user_id=excluded.user_id').run(input.endpoint,userId,JSON.stringify(input));
    if(!saved.changes)throw new ApiError(409,'PUSH_ENDPOINT_EXISTS','此推送地址已被使用。');
    return{ok:true};
  });
  app.delete(`${prefix}/push/subscriptions`,async request=>{const input=z.object({endpoint:z.string().max(2048)}).strict().parse(request.body);store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(input.endpoint,request.auth!.user.id);return{ok:true};});
  app.post(`${prefix}/push/test`,async(request,reply)=>{
    const input=z.object({endpoint:z.url().max(2048)}).strict().parse(request.body);validatePushEndpoint(input.endpoint);
    const userId=request.auth!.user.id;
    const row=store.db.prepare('SELECT subscription FROM push_subscriptions WHERE endpoint=? AND user_id=?').get(input.endpoint,userId) as {subscription:string}|undefined;
    if(!row)throw new ApiError(404,'PUSH_SUBSCRIPTION_NOT_FOUND','当前设备尚未登记，请重新开启邮件提醒。');
    if(!config.vapidPublicKey||!config.vapidPrivateKey)throw new ApiError(503,'PUSH_NOT_CONFIGURED','管理员尚未配置推送服务。');
    const now=Date.now(),until=pushTestAttempts.get(userId)||0;
    if(until>now){reply.header('Retry-After',Math.ceil((until-now)/1000));throw new ApiError(429,'PUSH_TEST_RATE_LIMIT','测试通知过于频繁，请稍后重试。');}
    for(const [id,expires] of pushTestAttempts)if(expires<=now)pushTestAttempts.delete(id);
    pushTestAttempts.set(userId,now+15_000);
    try {
      const subscription=pushSchema.parse(JSON.parse(row.subscription));
      if(subscription.endpoint!==input.endpoint)throw new Error('Invalid stored push subscription');
      const notificationId=randomUUID();
      await webPush.sendNotification(subscription,JSON.stringify({title:'MailNest 测试通知',body:'邮件提醒测试成功。',url:'/',tag:'mailnest-test',notificationId,unreadCount:unreadCount(userId)}),pushDeliveryOptions(notificationId));
    }catch(error){
      const code=pushStatus(error);
      if(code===404||code===410){store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=? AND subscription=?').run(input.endpoint,userId,row.subscription);throw new ApiError(410,'PUSH_SUBSCRIPTION_EXPIRED','当前设备的提醒订阅已过期，请重新开启邮件提醒。');}
      throw new ApiError(503,'PUSH_DELIVERY_FAILED','推送服务暂时无法接受测试通知，请稍后重试。');
    }
    return{ok:true,accepted:true};
  });
  app.get(`${prefix}/tokens`,async request=>{sessionOnly(request);return{tokens:store.db.prepare('SELECT id,name,created_at AS createdAt,last_used_at AS lastUsedAt FROM api_tokens WHERE user_id=? ORDER BY created_at DESC').all(request.auth!.user.id)};});
  app.post(`${prefix}/tokens`,async(request,reply)=>{sessionOnly(request);const input=z.object({name:z.string().trim().min(1).max(80)}).strict().parse(request.body);const count=store.db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id=?').get(request.auth!.user.id) as {n:number};if(count.n>=20)throw new ApiError(400,'TOKEN_LIMIT','最多可创建 20 个 API 令牌。');const token=`mn_${randomToken()}`,id=randomUUID();store.db.prepare('INSERT INTO api_tokens(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,?)').run(id,request.auth!.user.id,input.name,hashToken(token),new Date().toISOString());return reply.code(201).send({token,id});});
  app.delete(`${prefix}/tokens/:id`,async request=>{sessionOnly(request);store.db.prepare('DELETE FROM api_tokens WHERE id=? AND user_id=?').run((request.params as {id:string}).id,request.auth!.user.id);return{ok:true};});
  app.get(`${prefix}/openapi.json`,async()=>JSON.parse(await readFile(resolve(repoRoot,'docs/openapi.json'),'utf8')));
  const require=createRequire(import.meta.url);const swaggerAssets=resolve(dirname(require.resolve('@fastify/swagger-ui/package.json')),'static');
  app.get(`${prefix}/docs`,async(_request,reply)=>reply.type('text/html').header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MailNest API 文档</title><link rel="stylesheet" href="${prefix}/docs-assets/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="${prefix}/docs-assets/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'${prefix}/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false,withCredentials:true,requestInterceptor: function(request) { if (!['GET','HEAD'].includes(request.method)) request.headers['Origin']=location.origin; return request; }});</script></body></html>`));
  await app.register(fastifyStatic,{root:swaggerAssets,prefix:`${prefix}/docs-assets/`,decorateReply:false,index:false});
  if(frontendBuilt()) {
    app.get('/',async(_request,reply)=>reply.header('Cache-Control','no-cache').sendFile('index.html'));
    await app.register(fastifyStatic,{root:resolve(repoRoot,'web/dist'),prefix:'/',decorateReply:true,index:false,setHeaders:(response,filePath)=>{
      const filename=filePath.split(/[\\/]/).pop()||'';
      if(filename==='sw.js'||filename==='index.html'||filename==='manifest.webmanifest')response.header('Cache-Control','no-cache');
      else if(filePath.includes('/assets/'))response.header('Cache-Control','public, max-age=31536000, immutable');
    }});
    app.setNotFoundHandler((request,reply)=>{
      if(request.url.startsWith('/api/'))return reply.code(404).send({error:{code:'NOT_FOUND',message:'接口不存在。'}});
      if(request.method!=='GET'&&request.method!=='HEAD')return reply.code(404).send({error:{code:'NOT_FOUND',message:'页面不存在。'}});
      return reply.header('Cache-Control','no-cache').sendFile('index.html');
    });
  }else app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'接口不存在。'}}));
  let poll:ReturnType<typeof setInterval>|undefined;
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  app.addHook('onListen',async()=>{
    heartbeat=setInterval(()=>{for(const client of clients){const valid=client.expiresAt>Date.now()&&store.db.prepare('SELECT id FROM sessions WHERE id=?').get(client.sessionId);if(!valid){client.response.end();clients.delete(client);}else client.response.write(': heartbeat\n\n');}},25_000);heartbeat.unref();
    if(config.background){for(const row of store.accounts())mail.schedule(row.id);poll=setInterval(()=>{store.cleanup();for(const row of store.accounts())mail.schedule(row.id);},config.syncIntervalSeconds*1000);poll.unref();}
  });
  app.addHook('preClose',async()=>{if(poll)clearInterval(poll);if(heartbeat)clearInterval(heartbeat);for(const client of clients)client.response.end();clients.clear();mail.stop();});
  app.addHook('onClose',async()=>{await mail.close();store.close();});
  return{app,store,mail};
}
