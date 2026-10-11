import {test,expect,type Page} from '@playwright/test';
import type {Account,Message} from '../web/src/types';

async function mailbox(page:Page,beforeSend?:()=>Promise<void>) {
  const accounts:Account[]=[
    {id:'sender-work',name:'工作邮箱',email:'work@example.com',color:'#377a75',provider:'imap',username:'work@example.com',imap:{host:'imap.example.com',port:993,secure:true},smtp:{host:'smtp.example.com',port:465,secure:true},status:'connected',lastSyncedAt:new Date().toISOString(),error:null,unread:0},
    {id:'sender-private',name:'私人邮箱',email:'private@example.com',color:'#627dcc',provider:'gmail',username:'private@example.com',imap:{host:'imap.gmail.com',port:993,secure:true},smtp:{host:'smtp.gmail.com',port:465,secure:true},status:'connected',lastSyncedAt:new Date().toISOString(),error:null,unread:0},
  ];
  const message:Message={id:'sender-original',accountId:'sender-private',folder:'INBOX',from:{name:'项目团队',address:'team@example.com'},to:[{name:'私人邮箱',address:'private@example.com'}],cc:[],subject:'发件人名称回归',preview:'这是一封原邮件。',date:new Date().toISOString(),unread:false,starred:false,hasAttachments:false,text:'这是一封原邮件。',html:null,messageId:'<sender-original@example.com>',attachments:[]};
  const sends:Record<string,unknown>[]=[];
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length);
    const respond=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/auth/me')return respond({user:{id:'sender-owner',email:'owner@example.com',name:'测试管理员'}});
    if(path==='/config')return respond({googleConfigured:false,pushPublicKey:null,pollingInterval:3600});
    if(path==='/accounts')return respond({accounts});
    if(path==='/events')return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
    if(path==='/messages')return respond({messages:[message],total:1,page:1,pageSize:30});
    if(path===`/messages/${message.id}`)return respond({message});
    if(path==='/messages/send'){sends.push(request.postDataJSON());await beforeSend?.();return respond({ok:true,messageId:'<sender-sent@example.com>'});}
    if(path==='/sync')return respond({ok:true});
    return respond({error:{code:'NOT_FOUND',message:`Unhandled sender fixture ${request.method()} ${path}`}},404);
  });
  await page.goto('/');await expect(page.getByRole('button',{name:`打开邮件：${message.subject}`,exact:true})).toBeVisible();
  return{sends,message};
}

async function openCompose(page:Page) {
  const mobile=page.getByRole('navigation',{name:'快捷导航',exact:true}).getByRole('button',{name:'写邮件',exact:true});
  if(await mobile.isVisible())await mobile.click();
  else await page.getByRole('complementary',{name:'邮箱导航',exact:true}).getByRole('button',{name:/^写邮件/}).click();
  const dialog=page.getByRole('dialog',{name:'写一封新邮件',exact:true});await expect(dialog).toBeVisible();return dialog;
}

test('new mail uses the selected account name, accepts a custom name, disables it while sending and falls back when empty',async({page})=>{
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const{sends}=await mailbox(page,()=>pending);
  try{
    const compose=await openCompose(page);
    const sender=compose.getByLabel('发件人',{exact:true}),name=compose.getByLabel('发件人名称',{exact:true});
    await expect(sender).toHaveValue('sender-work');await expect(name).toHaveValue('工作邮箱');await expect(name).toHaveAttribute('maxlength','80');
    await name.fill('临时名称');await sender.selectOption('sender-private');await expect(name).toHaveValue('私人邮箱');
    await name.fill('  自定义发件人  ');await compose.getByLabel(/^收件人/).fill('recipient@example.com');await compose.getByLabel('主题',{exact:true}).fill('自定义名称');await compose.getByRole('textbox',{name:'邮件正文',exact:true}).fill('正文。');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await compose.getByRole('button',{name:'发送邮件',exact:true}).click();await expect.poll(()=>sends.length).toBe(1);
    await expect(sender).toBeDisabled();await expect(name).toBeDisabled();expect(sends[0]).toMatchObject({accountId:'sender-private',senderName:'自定义发件人',to:'recipient@example.com'});expect(sends[0]).not.toHaveProperty('from');
    release();await expect(compose).toHaveCount(0);
    const second=await openCompose(page);await expect(second.getByLabel('发件人名称',{exact:true})).toHaveValue('工作邮箱');
    await second.getByLabel('发件人名称',{exact:true}).fill('');await second.getByLabel(/^收件人/).fill('recipient@example.com');await second.getByLabel('主题',{exact:true}).fill('默认名称');await second.getByRole('textbox',{name:'邮件正文',exact:true}).fill('正文。');await second.getByRole('button',{name:'发送邮件',exact:true}).click();await expect(second).toHaveCount(0);
    expect(sends[1]).toMatchObject({accountId:'sender-work',senderName:'工作邮箱'});
  }finally{release();}
});

test('editing only the sender name protects the unsent draft and does not persist the name into another message',async({page})=>{
  await mailbox(page);const compose=await openCompose(page);await compose.getByLabel('发件人名称',{exact:true}).fill('未发送的自定义名称');
  page.once('dialog',dialog=>dialog.dismiss());await compose.getByRole('button',{name:'关闭弹窗',exact:true}).click();await expect(compose).toBeVisible();await expect(compose.getByLabel('发件人名称',{exact:true})).toHaveValue('未发送的自定义名称');
  page.once('dialog',dialog=>dialog.accept());await compose.getByRole('button',{name:'关闭弹窗',exact:true}).click();await expect(compose).toHaveCount(0);
  const next=await openCompose(page);await expect(next.getByLabel('发件人名称',{exact:true})).toHaveValue('工作邮箱');await next.getByRole('button',{name:'关闭弹窗',exact:true}).click();await expect(next).toHaveCount(0);
});

test('reply and forward default to the original receiving account name and send their custom names independently',async({page})=>{
  const{sends,message}=await mailbox(page);await page.getByRole('button',{name:`打开邮件：${message.subject}`,exact:true}).click();
  const toolbar=page.getByRole('toolbar',{name:'邮件操作',exact:true});await toolbar.getByRole('button',{name:'回复邮件',exact:true}).click();
  const reply=page.getByRole('dialog',{name:'回复邮件',exact:true});await expect(reply.getByLabel('发件人',{exact:true})).toHaveValue('sender-private');await expect(reply.getByLabel('发件人名称',{exact:true})).toHaveValue('私人邮箱');
  await reply.getByLabel('发件人名称',{exact:true}).fill('回复署名');await reply.getByRole('textbox',{name:'邮件正文',exact:true}).fill('回复正文。');await reply.getByRole('button',{name:'发送邮件',exact:true}).click();await expect(reply).toHaveCount(0);
  expect(sends[0]).toMatchObject({accountId:'sender-private',senderName:'回复署名',inReplyTo:message.messageId,references:message.messageId});
  await toolbar.getByRole('button',{name:'转发邮件',exact:true}).click();const forward=page.getByRole('dialog',{name:'转发邮件',exact:true});await expect(forward.getByLabel('发件人名称',{exact:true})).toHaveValue('私人邮箱');
  await forward.getByLabel('发件人名称',{exact:true}).fill('转发署名');await forward.getByLabel(/^收件人/).fill('recipient@example.com');await forward.getByRole('button',{name:'发送邮件',exact:true}).click();await expect(forward).toHaveCount(0);
  expect(sends[1]).toMatchObject({accountId:'sender-private',senderName:'转发署名',to:'recipient@example.com'});expect(sends[1]).not.toHaveProperty('inReplyTo');
});
