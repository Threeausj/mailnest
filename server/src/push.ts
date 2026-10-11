import {createHash,randomUUID} from 'node:crypto';
import type {PushSubscription,RequestOptions,SendResult} from 'web-push';
import type {Store} from './db.js';

const deliveryLifetime=3600_000;
const maximumAttempts=8;
const maximumRetainedRows=4096;
const maximumConcurrency=4;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export function pushDeliveryOptions(notificationId:string,ttl=3600):RequestOptions {
  return{TTL:Math.max(1,Math.min(3600,Math.ceil(ttl))),timeout:10_000,contentEncoding:'aes128gcm',urgency:'high',topic:createHash('sha256').update(notificationId).digest('base64url').slice(0,32)};
}
interface PushLogger {info:(fields:Record<string,unknown>,message:string)=>void;warn:(fields:Record<string,unknown>,message:string)=>void}
interface QueueOptions {
  store:Store;
  send:(subscription:PushSubscription,payload:string,options:RequestOptions)=>Promise<SendResult>;
  logger?:PushLogger;
  now?:()=>number;
  random?:()=>number;
  /** Total operation deadline; socket timeouts alone do not cover stalled DNS/TLS. */
  sendDeadlineMs?:number;
}
interface DeliveryRow {
  id:string;user_id:string;account_id:string;notification_id:string;endpoint_hash:string;subscription_hash:string;payload:string;
  created_at:number;expires_at:number;status:'pending'|'accepted'|'failed'|'cancelled';attempts:number;next_attempt_at:number;
}
export interface PushQueueStats {pending:number;retrying:number;accepted:number;failed:number;nextRetryAt:number|null;lastAcceptedAt:number|null}

/** Durable retries run on the server; no foreground tab or persistent worker is required. */
export class PushDeliveryQueue {
  private readonly now:()=>number;
  private readonly random:()=>number;
  private readonly sendDeadlineMs:number;
  private readonly active=new Set<string>();
  private draining?:Promise<void>;
  private timer?:ReturnType<typeof setTimeout>;
  private started=false;
  private closed=false;
  constructor(private readonly options:QueueOptions) {
    this.now=options.now||Date.now;
    this.random=options.random||Math.random;
    this.sendDeadlineMs=Math.max(1,Math.min(12_000,options.sendDeadlineMs??12_000));
  }
  /** May run inside the caller's mail transaction; never dispatch or begin another transaction here. */
  stage(input:{userId:string;accountId:string;notificationId:string;payload:string}):void {
    if(this.closed)return;
    const db=this.options.store.db,now=this.now();
    this.prune(now);
    if(!this.options.store.account(input.accountId,input.userId))return;
    const subscriptions=db.prepare('SELECT endpoint,subscription FROM push_subscriptions WHERE user_id=?').all(input.userId) as {endpoint:string;subscription:string}[];
    const insert=db.prepare('INSERT OR IGNORE INTO push_deliveries(id,user_id,account_id,notification_id,endpoint_hash,subscription_hash,payload,created_at,expires_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    let retained=(db.prepare('SELECT COUNT(*) AS n FROM push_deliveries').get() as {n:number}).n;
    for(const row of subscriptions) {
      const endpointHash=hash(row.endpoint);
      if(db.prepare('SELECT id FROM push_deliveries WHERE user_id=? AND notification_id=? AND endpoint_hash=?').get(input.userId,input.notificationId,endpointHash))continue;
      if(retained>=maximumRetainedRows) {
        this.options.logger?.warn({notificationId:input.notificationId,accountId:input.accountId,subscriptionId:endpointHash.slice(0,12),category:'PUSH_QUEUE_FULL'},'New-mail push queue capacity reached');
        continue;
      }
      insert.run(randomUUID(),input.userId,input.accountId,input.notificationId,endpointHash,hash(row.subscription),input.payload,now,now+deliveryLifetime,now);
      retained++;
    }
  }
  async enqueue(input:{userId:string;accountId:string;notificationId:string;payload:string}):Promise<void> {
    this.stage(input);
    await this.flush();
    // A caller can enqueue in the microtask after a shared drain finishes, before
    // its owner clears the promise. Recheck so its immediate first attempt is kept.
    if(!this.closed&&this.options.store.db.prepare("SELECT id FROM push_deliveries WHERE user_id=? AND notification_id=? AND status='pending' AND attempts=0 AND next_attempt_at<=?").get(input.userId,input.notificationId,this.now()))await this.flush();
  }
  /** Also useful when background processing is intentionally disabled in tests. */
  async flush():Promise<void> {
    if(this.draining)return this.draining;
    if(this.closed)return;
    this.draining=this.drain();
    try{await this.draining;}finally{this.draining=undefined;this.schedule();}
  }
  start():void {
    if(this.started||this.closed)return;
    this.started=true;
    void this.flush().catch(()=>this.options.logger?.warn({category:'PUSH_QUEUE_UNAVAILABLE'},'Push delivery queue could not be processed'));
  }
  async stop():Promise<void> {
    this.closed=true;
    this.started=false;
    if(this.timer)clearTimeout(this.timer);
    this.timer=undefined;
    await this.draining;
  }
  stats(userId:string):PushQueueStats {
    const row=this.options.store.db.prepare("SELECT COALESCE(SUM(status='pending'),0) AS pending,COALESCE(SUM(status='pending' AND attempts>0),0) AS retrying,COALESCE(SUM(status='accepted'),0) AS accepted,COALESCE(SUM(status='failed'),0) AS failed,MIN(CASE WHEN status='pending' THEN next_attempt_at END) AS nextRetryAt,MAX(last_accepted_at) AS lastAcceptedAt FROM push_deliveries WHERE user_id=? AND expires_at>?").get(userId,this.now()) as unknown as PushQueueStats;
    return{...row};
  }
  private prune(now:number):void {this.options.store.db.prepare('DELETE FROM push_deliveries WHERE expires_at<=?').run(now);}
  private async drain():Promise<void> {
    this.prune(this.now());
    const worker=async()=>{
      while(!this.closed) {
        const now=this.now();
        const due=this.options.store.db.prepare("SELECT * FROM push_deliveries WHERE status='pending' AND next_attempt_at<=? AND expires_at>? ORDER BY next_attempt_at,created_at,id LIMIT ?").all(now,now,maximumConcurrency) as unknown as DeliveryRow[];
        const row=due.find(candidate=>!this.active.has(candidate.id));
        if(!row)return;
        this.active.add(row.id);
        try{await this.deliver(row);}finally{this.active.delete(row.id);}
      }
    };
    // Wait for all senders even when a local database error stops one of them.
    const results=await Promise.allSettled(Array.from({length:maximumConcurrency},worker));
    const rejected=results.find(result=>result.status==='rejected');
    if(rejected?.status==='rejected')throw rejected.reason;
  }
  private currentSubscription(row:DeliveryRow):{endpoint:string;subscription:string}|undefined {
    const rows=this.options.store.db.prepare('SELECT endpoint,subscription FROM push_subscriptions WHERE user_id=?').all(row.user_id) as {endpoint:string;subscription:string}[];
    return rows.find(current=>hash(current.endpoint)===row.endpoint_hash&&hash(current.subscription)===row.subscription_hash);
  }
  private fields(row:DeliveryRow,statusCode?:number,category?:string,retryAt?:number):Record<string,unknown> {
    return{notificationId:row.notification_id,accountId:row.account_id,subscriptionId:row.endpoint_hash.slice(0,12),attempt:row.attempts,...(statusCode===undefined?{}:{statusCode}),...(category?{category}:{}),...(retryAt===undefined?{}:{retryAt})};
  }
  private finish(row:DeliveryRow,status:'failed'|'cancelled',category:string,statusCode?:number):void {
    this.options.store.db.prepare('UPDATE push_deliveries SET status=?,last_status=?,last_category=? WHERE id=?').run(status,statusCode??null,category,row.id);
    this.options.logger?.warn(this.fields(row,statusCode,category),'New-mail push stopped');
  }
  private async deliver(row:DeliveryRow):Promise<void> {
    const db=this.options.store.db,current=this.currentSubscription(row);
    if(!current||!this.options.store.account(row.account_id,row.user_id)){this.finish(row,'cancelled','PUSH_SUBSCRIPTION_CHANGED');return;}
    if(row.attempts>=maximumAttempts){this.finish(row,'failed','PUSH_RETRY_EXHAUSTED');return;}
    if(row.expires_at<=this.now()){this.finish(row,'failed','PUSH_DELIVERY_EXPIRED');return;}
    let subscription:PushSubscription;
    try {
      subscription=JSON.parse(current.subscription) as PushSubscription;
      if(subscription.endpoint!==current.endpoint||!subscription.keys?.p256dh||!subscription.keys.auth)throw new Error('Invalid subscription');
    }catch{this.finish(row,'failed','PUSH_SUBSCRIPTION_INVALID');return;}
    row.attempts++;
    // Commit before dispatch so a restart cannot reset the attempt budget.
    db.prepare('UPDATE push_deliveries SET attempts=? WHERE id=?').run(row.attempts,row.id);
    try {
      const response=await this.boundedSend(subscription,row.payload,pushDeliveryOptions(row.notification_id,(row.expires_at-this.now())/1000));
      if(response.statusCode<200||response.statusCode>=300)throw{statusCode:response.statusCode,headers:response.headers};
      db.prepare("UPDATE push_deliveries SET status='accepted',last_status=?,last_category=NULL,last_accepted_at=? WHERE id=?").run(response.statusCode,this.now(),row.id);
      this.options.logger?.info(this.fields(row,response.statusCode),'New-mail push accepted');
    }catch(error) {
      const provider=error&&typeof error==='object'?error as {statusCode?:unknown;headers?:unknown}:{};
      const statusCode=typeof provider.statusCode==='number'&&Number.isInteger(provider.statusCode)?provider.statusCode:undefined;
      if(statusCode===404||statusCode===410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=? AND subscription=?').run(current.endpoint,row.user_id,current.subscription);
        this.finish(row,'failed','PUSH_SUBSCRIPTION_EXPIRED',statusCode);return;
      }
      if(!this.currentSubscription(row)||!this.options.store.account(row.account_id,row.user_id)){this.finish(row,'cancelled','PUSH_SUBSCRIPTION_CHANGED',statusCode);return;}
      const transient=statusCode===undefined||[408,425,429].includes(statusCode)||(statusCode>=500&&statusCode<=599);
      if(!transient){this.finish(row,'failed','PUSH_DELIVERY_REJECTED',statusCode);return;}
      if(row.attempts>=maximumAttempts){this.finish(row,'failed','PUSH_RETRY_EXHAUSTED',statusCode);return;}
      const backoff=Math.min(600_000,5000*2**(row.attempts-1))*(0.8+Math.max(0,Math.min(1,this.random()))*0.4);
      const now=this.now(),retryAt=Math.ceil(now+Math.max(backoff,this.retryAfter(provider.headers,now)));
      if(retryAt>=row.expires_at){this.finish(row,'failed','PUSH_DELIVERY_EXPIRED',statusCode);return;}
      const category=statusCode===429?'PUSH_RATE_LIMITED':statusCode===undefined?'PUSH_NETWORK_UNAVAILABLE':'PUSH_PROVIDER_UNAVAILABLE';
      db.prepare('UPDATE push_deliveries SET next_attempt_at=?,last_status=?,last_category=? WHERE id=?').run(retryAt,statusCode??null,category,row.id);
      this.options.logger?.warn(this.fields(row,statusCode,category,retryAt),'New-mail push retry scheduled');
    }
  }
  private async boundedSend(subscription:PushSubscription,payload:string,options:RequestOptions):Promise<SendResult> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject({code:'ETIMEDOUT'}),this.sendDeadlineMs);});
    try {
      // The provider promise may still settle after the deadline. Promise.race
      // consumes both outcomes; only the winning result can change delivery state.
      // An already issued request cannot be recalled, so retries retain the same
      // provider topic and notification ID for provider/client deduplication.
      return await Promise.race([this.options.send(subscription,payload,options),deadline]);
    }finally{if(timer)clearTimeout(timer);}
  }
  private retryAfter(headers:unknown,now:number):number {
    if(!headers||typeof headers!=='object')return 0;
    const entry=Object.entries(headers).find(([key])=>key.toLowerCase()==='retry-after')?.[1];
    const value=Array.isArray(entry)?entry[0]:entry;
    if(typeof value!=='string'&&typeof value!=='number')return 0;
    const text=String(value).trim();
    const delay=/^\d+(?:\.\d+)?$/.test(text)?Number(text)*1000:Date.parse(text)-now;
    return Number.isFinite(delay)?Math.max(0,delay):0;
  }
  private schedule():void {
    if(this.timer)clearTimeout(this.timer);
    this.timer=undefined;
    if(!this.started||this.closed)return;
    const row=this.options.store.db.prepare("SELECT MIN(CASE WHEN status='pending' THEN MIN(next_attempt_at,expires_at) ELSE expires_at END) AS due FROM push_deliveries").get() as {due:number|null};
    if(row.due===null)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.flush().catch(()=>this.options.logger?.warn({category:'PUSH_QUEUE_UNAVAILABLE'},'Push delivery queue could not be processed'));},Math.max(1,Math.min(30_000,row.due-this.now())));
    this.timer.unref();
  }
}
