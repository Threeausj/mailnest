import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import nodemailer from 'nodemailer';
import {simpleParser} from 'mailparser';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {Store,type AccountRow} from '../src/db.js';
import {MailService,type SendInput} from '../src/mail.js';
import {SecretBox} from '../src/security.js';

test('outgoing MIME uses the selected account name by default and a per-message custom name without changing its address',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mailnest-sender-name-'));
  const config={...loadConfig({APP_URL:'http://localhost:5173',DATA_DIR:directory,ENCRYPTION_KEY:'d'.repeat(64),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:'SyntheticSenderName2026!',ALLOW_PRIVATE_MAIL_HOSTS:'true'}),background:false};
  const store=new Store(config);await store.bootstrap(config);
  const userId=store.db.prepare('SELECT id FROM users').get()!.id as string;
  const captured:{raw:Buffer;envelope:{from:string;to:string[]}}[]=[];
  let closed=0;
  const transport=mock.method(nodemailer,'createTransport',()=>({
    sendMail:async(options:typeof captured[number])=>{captured.push(options);return{accepted:['recipient@example.com'],messageId:'<synthetic-sent@example.com>'};},
    close:()=>{closed++;},
  }) as unknown as ReturnType<typeof nodemailer.createTransport>);
  const mail=new MailService(store,config,()=>{},async()=>{});
  const schedule=mock.method(mail,'schedule',()=>{});
  try{
    const accounts=['工作邮箱','私人邮箱'].map((name,index)=>{
      const id=randomUUID(),email=`sender-${index}@example.com`;
      store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,name,email,'#377a75','gmail',email,email,'127.0.0.1',993,1,'127.0.0.1',465,1,new SecretBox(config.encryptionKey).encrypt({password:'synthetic-only-password'}));
      return store.account(id)!;
    });
    const cases:{account:AccountRow;senderName?:string;expected:string}[]=[
      {account:accounts[0],expected:'工作邮箱'},
      {account:accounts[1],expected:'私人邮箱'},
      {account:accounts[1],senderName:'  自定义发件人  ',expected:'自定义发件人'},
      {account:accounts[0],senderName:'Au "Three"',expected:'Au "Three"'},
      {account:accounts[1],senderName:'   ',expected:'私人邮箱'},
    ];
    for(const item of cases){
      await mail.send(item.account,{accountId:item.account.id,senderName:item.senderName,to:'recipient@example.com',subject:'Synthetic sender test',text:'Synthetic body'});
      const outgoing=captured.at(-1)!;
      const parsed=await simpleParser(outgoing.raw);
      assert.deepEqual(parsed.from?.value,[{name:item.expected,address:item.account.email}]);
      assert.equal(outgoing.envelope.from,item.account.email);
      assert.deepEqual(outgoing.envelope.to,['recipient@example.com']);
      assert.equal(store.account(item.account.id)!.name,item.account.name,'per-message customization must not rename the account');
    }
    assert.equal(closed,cases.length);assert.equal(schedule.mock.callCount(),cases.length);
  }finally{await mail.close();store.close();schedule.mock.restore();transport.mock.restore();await rm(directory,{recursive:true,force:true});}
});

test('send API validates custom names before SMTP and never accepts a caller-controlled sender address',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mailnest-sender-name-api-'));
  const origin='http://localhost:5173',password='SyntheticSenderName2026!';
  const project=await buildApp({...loadConfig({APP_URL:origin,DATA_DIR:directory,ENCRYPTION_KEY:'d'.repeat(64),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:password}),background:false});
  const send=mock.method(project.mail,'send',async(_account:AccountRow,_input:SendInput)=>({ok:true as const,messageId:'<synthetic-api-sent@example.com>'}));
  const smtp=mock.method(nodemailer,'createTransport',()=>{throw new Error('Sender API tests must not contact SMTP');});
  try{
    const login=await project.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'test@example.com',password}});
    assert.equal(login.statusCode,200);const userId=login.json().user.id as string,cookie=login.headers['set-cookie']!.toString().split(';')[0];
    const accountId=randomUUID(),email='selected-account@example.com';
    project.store.db.prepare('INSERT INTO accounts(id,user_id,name,email,color,provider,username,smtp_username,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(accountId,userId,'所选账号名称',email,'#377a75','imap',email,email,'127.0.0.1',993,1,'127.0.0.1',465,1,new SecretBox('d'.repeat(64)).encrypt({password:'synthetic-only-password'}));
    const base={accountId,to:'recipient@example.com',subject:'Synthetic API sender test',text:'Synthetic body'};
    const request=(extra:Record<string,unknown>)=>project.app.inject({method:'POST',url:'/api/v1/messages/send',headers:{origin,cookie},payload:{...base,...extra}});
    for(const senderName of ['Unsafe\rBcc: injected@example.com','Unsafe\nBcc: injected@example.com','Unsafe\0Name','a'.repeat(81)]){
      const response=await request({senderName});assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'VALIDATION_ERROR');
      assert.equal(send.mock.callCount(),0,'invalid names must be rejected before the mail service runs');
    }
    for(const extra of [{from:{name:'Pretend sender',address:'attacker@example.com'}},{fromAddress:'attacker@example.com'}]){
      const response=await request({senderName:'合法名称',...extra});assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'VALIDATION_ERROR');
      assert.equal(send.mock.callCount(),0,'address override fields must be rejected before the mail service runs');
    }
    const cases=[{input:{senderName:'  自定义名称  '},expected:'自定义名称'},{input:{senderName:'   '},expected:''},{input:{senderName:'a'.repeat(80)},expected:'a'.repeat(80)},{input:{},expected:undefined}];
    for(const item of cases){
      const response=await request(item.input);assert.equal(response.statusCode,200,response.body);
      const [account,input]=send.mock.calls.at(-1)!.arguments;
      assert.equal(account.id,accountId);assert.equal(account.email,email);assert.equal(account.name,'所选账号名称');assert.equal(input.senderName,item.expected);
      assert.equal(Object.hasOwn(input,'from'),false);assert.equal(Object.hasOwn(input,'fromAddress'),false);
    }
    assert.equal(send.mock.callCount(),cases.length);assert.equal(smtp.mock.callCount(),0);
  }finally{await project.app.close();send.mock.restore();smtp.mock.restore();await rm(directory,{recursive:true,force:true});}
});
