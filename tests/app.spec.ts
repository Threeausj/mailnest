import { test, expect, type Page } from '@playwright/test';
import type { Account, Message } from '../web/src/types';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('登录邮箱').fill('e2e@mailnest.test');
  await page.getByLabel('登录密码').fill('Mailnest-E2E-only-password!2026');
  await page.getByRole('button', { name: '登录工作空间' }).click();
  await expect(page.getByRole('heading', { name: '收件箱', exact: false }).first()).toBeVisible();
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
async function headerUtility(page: Page, name: string) {
  await expect(page.getByRole('toolbar',{name:'邮件操作',exact:true})).toBeVisible();
  const button = page.getByRole('button',{name,exact:true});
  if (await button.isVisible()) return button;
  const more = page.getByRole('button',{name:'更多邮件操作',exact:true});
  if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
  const item = page.getByRole('menuitem',{name,exact:true});
  await expect(item).toBeVisible();
  return item;
}

function mailboxMessages(count = 18): Message[] {
  return Array.from({length:count}, (_, index) => ({
    id:`density-${index}`,accountId:'density-account',folder:'INBOX',
    from:{name:`项目团队 ${index + 1}`,address:'team@example.com'},to:[{name:'',address:'ui@example.com'}],cc:[],
    subject:`${index + 1} · 长主题回归：${'邮件列表应保持紧凑且不被长文本撑高'.repeat(8)}`,
    preview:'需要同时看清发件人、主题、摘要和所属邮箱。'.repeat(12),
    date:new Date(Date.now() - index * 60_000).toISOString(),unread:index % 3 === 0,starred:false,hasAttachments:index % 2 === 0,
    text:'邮件正文内容。',html:null,messageId:`<density-${index}@example.com>`,attachments:[],
  }));
}

async function mockMailbox(page: Page, messages: Message[] = []) {
  const accounts: Account[] = [{
    id:'density-account',name:'测试邮箱',email:'ui@example.com',color:'#377a75',provider:'imap',username:'ui@example.com',
    imap:{host:'imap.example.com',port:993,secure:true},smtp:{host:'smtp.example.com',port:465,secure:true},
    status:'connected',lastSyncedAt:new Date().toISOString(),error:null,unread:messages.filter(message => message.unread).length,
  }];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length);
    const respond = (body: unknown, status = 200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if (path === '/auth/me') return respond({user:{id:'fixture',email:'ui@example.com',name:'测试管理员'}});
    if (path === '/config') return respond({googleConfigured:false,pushPublicKey:null,pollingInterval:3600});
    if (path === '/accounts') return respond({accounts});
    if (path === '/events') return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
    if (path === '/messages') {
      const filtered = messages.filter(message => (!url.searchParams.get('accountId') || message.accountId === url.searchParams.get('accountId')) && message.folder === url.searchParams.get('folder') && (url.searchParams.get('filter') !== 'unread' || message.unread) && (url.searchParams.get('filter') !== 'starred' || message.starred));
      return respond({messages:filtered,total:filtered.length,page:1,pageSize:30});
    }
    const message = messages.find(message => path === `/messages/${message.id}`);
    if (message && request.method() === 'GET') return respond({message});
    if (message && request.method() === 'PATCH') {Object.assign(message,request.postDataJSON()); return respond({message});}
    if (path === '/sync') return respond({ok:true});
    return respond({error:{code:'NOT_FOUND',message:`Unhandled fixture ${request.method()} ${path}`}},404);
  });
}

test('real login, account setup, API token access/revocation, documentation and logout', async ({ page }) => {
  const tokenName = `E2E-${test.info().project.name}-${Date.now()}`;
  await login(page);
  await expect(page.getByText('还没有连接邮箱')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole('button', {name:'连接邮箱',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', {name:'连接 Google'})).toBeDisabled();
  await dialog.getByRole('tab', {name:'IMAP / SMTP'}).click();
  await expect(dialog.getByText('收信服务器 · IMAP')).toBeVisible();
  await dialog.getByLabel('邮箱地址', {exact:true}).fill('test@example.com');
  await noHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await (await headerUtility(page,'邮件提醒设置')).click();
  await page.getByRole('tab',{name:'安全与 API'}).click();
  await page.getByLabel('令牌名称').fill(tokenName);
  await page.getByRole('button',{name:'创建令牌'}).click();
  const token = await page.locator('.new-token code').textContent();
  expect(token).toMatch(/^mn_/);
  const accountResponse = await page.request.get('/api/v1/accounts',{headers:{Authorization:`Bearer ${token}`}});
  expect(accountResponse.status()).toBe(200);
  const forbidden = await page.request.post('/api/v1/tokens',{headers:{Authorization:`Bearer ${token}`},data:{name:'cannot-create'}});
  expect(forbidden.status()).toBe(403);
  const specResponse = await page.request.get('/api/v1/openapi.json');
  expect(specResponse.ok()).toBe(true);
  expect((await specResponse.json()).openapi).toBe('3.0.3');
  const docs = await page.context().newPage();
  await docs.goto('/api/v1/docs');
  await expect(docs.getByRole('heading',{name:/MailNest API/})).toBeVisible();
  await docs.close();
  page.once('dialog', event => event.accept());
  await page.getByRole('button',{name:`撤销令牌 ${tokenName}`}).click();
  await expect(page.getByRole('button',{name:`撤销令牌 ${tokenName}`})).toHaveCount(0);
  expect((await page.request.get('/api/v1/accounts',{headers:{Authorization:`Bearer ${token}`}})).status()).toBe(401);
  await page.getByRole('tab',{name:'应用与提醒'}).click();
  await expect(page.getByText('iPhone / iPad', {exact:true})).toBeVisible();
  await page.getByRole('button',{name:'退出登录'}).click();
  await expect(page.getByRole('button',{name:'登录工作空间'})).toBeVisible();
  expect((await page.request.get('/api/v1/accounts')).status()).toBe(401);
  await noHorizontalOverflow(page);
});

test('mailbox selection, safe HTML reader, attachments and compose failure/retry', async ({ page }) => {
  const accounts = [
    {id:'alpha',name:'工作邮箱',email:'alpha@example.com',color:'#377a75',provider:'imap',username:'alpha@example.com',imap:{host:'imap.example.com',port:993,secure:true},smtp:{host:'smtp.example.com',port:465,secure:true},status:'partial',lastSyncedAt:new Date().toISOString(),error:'[草稿箱] 服务器暂时拒绝打开目录',unread:1},
    {id:'beta',name:'个人邮箱',email:'beta@example.com',color:'#627dcc',provider:'gmail',username:'beta@example.com',imap:{host:'imap.gmail.com',port:993,secure:true},smtp:{host:'smtp.gmail.com',port:465,secure:true},status:'connected',lastSyncedAt:new Date().toISOString(),error:null,unread:0},
  ];
  const messages = [
    {id:'mail-one',accountId:'alpha',folder:'INBOX',from:{name:'项目团队',address:'team@example.com'},to:[{name:'',address:'alpha@example.com'}],cc:[],subject:'项目进展与设计文件',preview:'请查收项目进展与附件',date:new Date().toISOString(),unread:true,starred:false,hasAttachments:true,text:'请查收项目进展与附件。',html:'<p>安全阅读测试</p><table width="2400"><tr><td><img src="cid:mail-logo" alt="邮件内嵌图片" width="2400"></td></tr></table><img src="https://tracker.invalid/pixel" alt="跟踪图片"><script>parent.window.__mailExecuted=true</script><img src="x" onerror="parent.window.__mailExecuted=true"><a href="javascript:alert(1)">恶意链接</a>',messageId:'<test@example.com>',attachments:[{id:'attachment-one',filename:'设计说明.txt',contentType:'text/plain',size:8},{id:'inline-logo',filename:'logo.png',contentType:'image/png',size:68,contentId:'mail-logo',inline:true}]},
    {id:'mail-two',accountId:'beta',folder:'INBOX',from:{name:'阅读周刊',address:'news@example.com'},to:[{name:'',address:'beta@example.com'}],cc:[],subject:'周末阅读清单',preview:'本周收藏',date:new Date().toISOString(),unread:false,starred:true,hasAttachments:false,text:'一份阅读清单。',html:null,messageId:'<two@example.com>',attachments:[]},
  ];
  let sends = 0;
  let lastPayload: any;
  let trackerRequests = 0;
  let inlineRequests = 0;
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6icAAAAAASUVORK5CYII=','base64');
  let delayInlineImage = false;
  let delayedImageStarted = false;
  let releaseInlineImage = () => {};
  await page.addInitScript(() => {
    (window as any).__mailImageAborts = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (String(input).includes('/attachments/inline-logo')) options?.signal?.addEventListener('abort', () => { (window as any).__mailImageAborts++; });
      return originalFetch(input, options);
    };
  });
  await page.route('https://tracker.invalid/**', route => route.fulfill({status:200,contentType:'image/png',body:pixel}));
  page.on('request', request => { if (request.url().includes('tracker.invalid')) trackerRequests++; });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.slice('/api/v1'.length);
    const method = request.method();
    const respond = (body: unknown, status = 200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if (path === '/auth/me') return respond({user:{id:'fixture',email:'ui@example.com',name:'测试管理员'}});
    if (path === '/config') return respond({googleConfigured:false,pushPublicKey:null,pollingInterval:3600});
    if (path === '/accounts') return respond({accounts});
    if (path === '/events') return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
    if (path === '/messages') {
      const filtered = messages.filter(message => (!url.searchParams.get('accountId') || message.accountId === url.searchParams.get('accountId')) && message.folder === url.searchParams.get('folder') && (url.searchParams.get('filter') !== 'unread' || message.unread) && (url.searchParams.get('filter') !== 'starred' || message.starred) && (!url.searchParams.get('q') || message.subject.includes(url.searchParams.get('q')!)));
      return respond({messages:filtered,total:filtered.length,page:1,pageSize:30});
    }
    if (path === '/messages/send') {
      lastPayload = request.postDataJSON();
      if (++sends === 1) return respond({error:{code:'MAIL_SEND_FAILED',message:'测试 SMTP 连接失败，请重试。'}},400);
      return respond({ok:true,messageId:'<sent@example.com>'});
    }
    if (path.endsWith('/attachments/inline-logo')) {
      inlineRequests++; expect(url.searchParams.get('inline')).toBe('true');
      if (delayInlineImage) { delayedImageStarted = true; await new Promise<void>(resolve => { releaseInlineImage = resolve; }); }
      return route.fulfill({status:200,contentType:'image/png',body:pixel}).catch(() => {});
    }
    if (path.endsWith('/attachments/attachment-one')) return route.fulfill({status:200,contentType:'application/octet-stream',headers:{'content-disposition':'attachment; filename="design.txt"'},body:'fixture!'});
    const message = messages.find(message => `/messages/${message.id}` === path);
    if (message && method === 'GET') return respond({message});
    if (message && method === 'PATCH') {Object.assign(message,request.postDataJSON()); return respond({message});}
    if (path === '/sync') return respond({ok:true});
    return respond({error:{code:'NOT_FOUND',message:`Unhandled fixture ${method} ${path}`}},404);
  });
  await page.goto('/');
  await expect(page.getByRole('button',{name:'打开邮件：项目进展与设计文件'})).toBeVisible();
  await noHorizontalOverflow(page);
  await expect(page.locator('.sync-error-banner')).toContainText('部分目录未同步');
  await expect(page.locator('.sync-error-banner')).toContainText('[草稿箱] 服务器暂时拒绝打开目录');
  const menu = page.getByRole('button',{name:'打开导航菜单'});
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button',{name:'展开 个人邮箱文件夹',exact:true}).click();
  await page.getByRole('navigation',{name:'个人邮箱文件夹',exact:true}).getByRole('button',{name:'收件箱',exact:true}).click();
  await expect(page.getByRole('button',{name:'打开邮件：周末阅读清单'})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：项目进展与设计文件'})).toHaveCount(0);
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation',{name:'所有邮箱文件夹',exact:true}).getByRole('button',{name:'收件箱',exact:true}).click();
  await page.getByLabel('搜索邮件').fill('项目进展');
  await expect(page.getByRole('button',{name:'打开邮件：周末阅读清单'})).toHaveCount(0);
  await page.getByRole('button',{name:'打开邮件：项目进展与设计文件'}).click();
  await expect(page.getByRole('heading',{name:'项目进展与设计文件',exact:true})).toBeVisible();
  const body = page.frameLocator('iframe[title="邮件正文"]');
  await expect(body.getByText('安全阅读测试')).toBeVisible();
  await expect(body.locator('script[data-mailnest-measure]')).toHaveCount(1);
  await expect(body.locator('script:not([data-mailnest-measure])')).toHaveCount(0);
  const inlineImage = body.getByRole('img',{name:'邮件内嵌图片'});
  await expect(inlineImage).toHaveAttribute('src',/^data:image\/png;base64,/);
  await expect.poll(() => inlineImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(inlineRequests).toBeGreaterThan(0);
  await expect(page.getByRole('link',{name:/logo.png/})).toHaveCount(0);
  expect(await body.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.getByRole('button',{name:'显示图片',exact:true})).toHaveCount(0);
  const externalImage = body.getByRole('img',{name:'跟踪图片'});
  await expect(externalImage).toBeVisible();
  await expect.poll(() => externalImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(externalImage).toHaveAttribute('referrerpolicy','no-referrer');
  await expect.poll(() => trackerRequests).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__mailExecuted)).toBeUndefined();
  await expect(body.getByText('恶意链接')).not.toHaveAttribute('href');
  await noHorizontalOverflow(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link',{name:/设计说明.txt/}).click();
  expect((await downloadPromise).suggestedFilename()).toBeTruthy();
  await page.locator('.reply-actions').getByRole('button',{name:'回复邮件',exact:true}).click();
  const composer = page.getByRole('dialog');
  await expect(composer.getByLabel('发件人')).toHaveValue('alpha');
  await expect(composer.getByLabel(/^收件人/)).toHaveValue('team@example.com');
  await expect(composer.getByLabel('主题',{exact:true})).toHaveValue('Re: 项目进展与设计文件');
  await composer.getByLabel('邮件正文').fill('测试回复草稿');
  await composer.locator('input[type="file"]').setInputFiles({name:'reply.txt',mimeType:'text/plain',buffer:Buffer.from('browser attachment')});
  await expect(composer.getByRole('button',{name:'移除附件 reply.txt'})).toBeVisible();
  await composer.getByRole('button',{name:'发送邮件'}).click();
  await expect(composer.getByRole('alert')).toContainText('测试 SMTP 连接失败');
  await expect(composer.getByLabel('邮件正文')).toHaveValue('测试回复草稿');
  await composer.getByRole('button',{name:'发送邮件'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('邮件已成功发送。')).toBeVisible();
  expect(lastPayload.accountId).toBe('alpha');
  expect(lastPayload.inReplyTo).toBe('<test@example.com>');
  expect(lastPayload.references).toBe('<test@example.com>');
  expect(Buffer.from(lastPayload.attachments[0].content,'base64').toString()).toBe('browser attachment');
  const back = page.getByRole('button',{name:'返回邮件列表'});
  if (await back.isVisible()) await back.click();
  await page.getByLabel('搜索邮件').fill('');
  await page.getByRole('button',{name:'打开邮件：周末阅读清单'}).click();
  await expect(page.getByText('一份阅读清单。',{exact:true})).toBeVisible();
  await expect(page.locator('iframe[title="邮件正文"]')).toHaveCount(0);
  delayInlineImage = true;
  if (await back.isVisible()) await back.click();
  await page.getByRole('button',{name:'打开邮件：项目进展与设计文件'}).click();
  await expect.poll(() => delayedImageStarted).toBe(true);
  const previousImageAborts = await page.evaluate(() => (window as any).__mailImageAborts);
  if (await back.isVisible()) await back.click();
  await page.getByRole('button',{name:'打开邮件：周末阅读清单'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__mailImageAborts)).toBeGreaterThan(previousImageAborts);
  releaseInlineImage();
  await expect(page.getByText('一份阅读清单。',{exact:true})).toBeVisible();
  await expect(page.locator('iframe[title="邮件正文"]')).toHaveCount(0);
});

test('unified and individual mailbox groups keep real folders, filters and navigation state separate with one settings entry', async ({ page }) => {
  const folder = (path: string, name: string, kind: string, specialUse: string | null = null, selectable = true) => ({path,name,kind,specialUse,selectable});
  const accountFolders = {
    alpha:[folder('INBOX','Inbox','inbox'),folder('[Work]/Sent','Sent','sent','\\Sent'),folder('[Work]/Drafts','Drafts','drafts','\\Drafts'),folder('[Work]/Junk','Junk','junk','\\Junk'),folder('[Work]/Trash','Trash','trash','\\Trash'),folder('[Work]/Archive','Archive','archive','\\Archive'),folder('[Work]/Important','Important','important','\\Important'),folder('Clients','客户','custom',null,false),folder('Clients/Shared','项目','custom')],
    beta:[folder('INBOX','Inbox','inbox'),folder('Sent Items','Sent Items','sent','\\Sent'),folder('草稿箱','草稿箱','drafts','\\Drafts'),folder('垃圾箱','垃圾箱','junk','\\Junk'),folder('已删除邮件','已删除邮件','trash','\\Trash'),folder('Archive','Archive','archive','\\Archive'),folder('Other/Shared','项目','custom')],
  };
  const accounts = (['alpha','beta'] as const).map(id => ({
    id,name:id === 'alpha' ? '工作邮箱' : '个人邮箱',email:`${id}@example.test`,color:'#3478f6',provider:'imap',username:`${id}@example.test`,
    imap:{host:'imap.example.test',port:993,secure:true},smtp:{host:'smtp.example.test',port:465,secure:true},
    status:'connected',lastSyncedAt:new Date().toISOString(),error:null,unread:1,folders:accountFolders[id],
  }));
  let sequence = 0;
  const makeMessage = (accountId: 'alpha' | 'beta', path: string, subject: string): Message => ({
    ...mailboxMessages(1)[0],id:`${accountId}-navigation-${sequence++}`,accountId,folder:path,subject,
    unread:path === 'INBOX',starred:path === 'INBOX',hasAttachments:false,attachments:[],text:`正文：${subject}`,
  });
  const messages = [
    makeMessage('alpha','INBOX','工作收件'),makeMessage('beta','INBOX','个人收件'),
    makeMessage('beta','Sent Items','个人已发送'),
    ...Array.from({length:35},(_,index) => makeMessage('alpha','[Work]/Sent',`工作已发送 ${index + 1}`)),
    makeMessage('alpha','[Work]/Drafts','工作草稿'),makeMessage('beta','草稿箱','个人草稿'),
    makeMessage('alpha','[Work]/Junk','工作垃圾'),makeMessage('beta','垃圾箱','个人垃圾'),
    makeMessage('alpha','[Work]/Important','工作重要'),
    makeMessage('alpha','Clients/Shared','工作项目'),makeMessage('beta','Other/Shared','个人项目'),
  ];
  const requests: {accountId:string|null;folder:string|null;filter:string|null;q:string|null;page:number}[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length);
    const respond = (body: unknown, status = 200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if (path === '/auth/me') return respond({user:{id:'owner',email:'owner@example.test',name:'我的邮箱'}});
    if (path === '/config') return respond({googleConfigured:false,pushPublicKey:null,pollingInterval:3600});
    if (path === '/accounts') return respond({accounts});
    if (path === '/accounts/beta' && request.method() === 'DELETE') {
      const index = accounts.findIndex(account => account.id === 'beta');
      if (index >= 0) accounts.splice(index,1);
      return respond({ok:true});
    }
    if (path === '/events') return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
    if (path === '/messages') {
      const accountId = url.searchParams.get('accountId'), requestedFolder = url.searchParams.get('folder'), filter = url.searchParams.get('filter'), q = url.searchParams.get('q');
      const pageNumber = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 30);
      requests.push({accountId,folder:requestedFolder,filter,q,page:pageNumber});
      const filtered = messages.filter(message => {
        const semanticKind = requestedFolder === 'INBOX' ? 'inbox' : requestedFolder;
        const actualPath = accountId ? requestedFolder : accountFolders[message.accountId as 'alpha'|'beta'].find(item => item.kind === semanticKind && item.selectable)?.path;
        return accounts.some(account => account.id === message.accountId) && (!accountId || message.accountId === accountId) && message.folder === actualPath && (filter !== 'unread' || message.unread) && (filter !== 'starred' || message.starred) && (!q || message.subject.includes(q));
      });
      return respond({messages:filtered.slice((pageNumber - 1) * pageSize,pageNumber * pageSize),total:filtered.length,page:pageNumber,pageSize});
    }
    const message = messages.find(item => path === `/messages/${item.id}`);
    if (message && request.method() === 'GET') return respond({message});
    if (message && request.method() === 'PATCH') {Object.assign(message,request.postDataJSON());return respond({message});}
    if (path === '/tokens') return respond({tokens:[]});
    return respond({error:{code:'NOT_FOUND',message:`Unhandled navigation fixture ${request.method()} ${path}`}},404);
  });
  await page.goto('/');
  await expect(page.getByRole('button',{name:'打开邮件：工作收件',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：个人收件',exact:true})).toBeVisible();
  const sidebar = page.getByRole('complementary',{name:'邮箱导航',exact:true});
  const all = sidebar.getByRole('navigation',{name:'所有邮箱文件夹',exact:true});
  const work = sidebar.getByRole('navigation',{name:'工作邮箱文件夹',exact:true});
  const personal = sidebar.getByRole('navigation',{name:'个人邮箱文件夹',exact:true});
  const openNavigation = async () => {
    const menu = page.getByRole('button',{name:'打开导航菜单',exact:true});
    if (await menu.isVisible() && !(await sidebar.getAttribute('class'))?.split(' ').includes('open')) await menu.click();
    await expect(sidebar).toBeVisible();
  };
  const choose = async (scope: typeof all, label: string) => {
    await openNavigation();
    const expand = scope.getByRole('button',{name:/^展开 .*文件夹$/});
    if (await expand.count()) await expand.click();
    await scope.getByRole('button',{name:label,exact:true}).click();
  };
  await openNavigation();
  const expectDefaultGroups = async () => {
    await expect(sidebar.locator('.brand')).toHaveCount(0);
    await expect(sidebar.getByText('邮屿',{exact:true})).toHaveCount(0);
    await expect(sidebar.getByText('MAILNEST',{exact:true})).toHaveCount(0);
    await expect(all.getByRole('button',{name:'收起 所有邮箱文件夹',exact:true})).toHaveAttribute('aria-expanded','true');
    await expect(all.getByRole('button',{name:'收件箱',exact:true})).toBeVisible();
    for (const [scope,name] of [[work,'工作邮箱'],[personal,'个人邮箱']] as const) {
      await expect(scope.getByRole('button',{name:`展开 ${name}文件夹`,exact:true})).toHaveAttribute('aria-expanded','false');
      await expect(scope.getByRole('button',{name:'收件箱',exact:true})).toBeHidden();
    }
  };
  await expectDefaultGroups();
  await work.getByRole('button',{name:'展开 工作邮箱文件夹',exact:true}).click();
  await personal.getByRole('button',{name:'展开 个人邮箱文件夹',exact:true}).click();
  await all.getByRole('button',{name:'收起 所有邮箱文件夹',exact:true}).click();
  await expect(work.getByRole('button',{name:'收起 工作邮箱文件夹',exact:true})).toHaveAttribute('aria-expanded','true');
  await expect(personal.getByRole('button',{name:'收起 个人邮箱文件夹',exact:true})).toHaveAttribute('aria-expanded','true');
  await expect(all.getByRole('button',{name:'展开 所有邮箱文件夹',exact:true})).toHaveAttribute('aria-expanded','false');
  await page.reload();
  await expect(page.getByRole('button',{name:'打开邮件：工作收件',exact:true})).toBeVisible();
  await openNavigation();
  await expectDefaultGroups();
  await work.getByRole('button',{name:'展开 工作邮箱文件夹',exact:true}).click();
  await personal.getByRole('button',{name:'展开 个人邮箱文件夹',exact:true}).click();
  for (const label of ['收件箱','草稿','已发送','垃圾邮件','已删除','归档邮件','重要邮件','星标邮件','未读邮件']) {
    await expect(all.getByRole('button',{name:label,exact:true})).toBeVisible();
    await expect(work.getByRole('button',{name:label,exact:true})).toBeVisible();
  }
  await expect(personal.getByRole('button',{name:'重要邮件',exact:true})).toHaveCount(0);
  await expect(work.getByRole('button',{name:'客户',exact:true})).toHaveCount(0);
  await expect(all.getByRole('button',{name:'项目',exact:true})).toHaveCount(0);
  await expect(work.getByRole('button',{name:'项目',exact:true})).toBeVisible();
  await expect(personal.getByRole('button',{name:'项目',exact:true})).toBeVisible();
  await sidebar.getByRole('button',{name:'收起 工作邮箱文件夹',exact:true}).click();
  await expect(work.getByRole('button',{name:'收件箱',exact:true})).toBeHidden();
  await expect(personal.getByRole('button',{name:'收件箱',exact:true})).toBeVisible();
  await sidebar.getByRole('button',{name:'展开 工作邮箱文件夹',exact:true}).click();
  await expect(work.getByRole('button',{name:'收件箱',exact:true})).toBeVisible();
  await expect(sidebar.locator('.sidebar-bottom').getByRole('button')).toHaveCount(1);
  await expect(sidebar.locator('.sidebar-bottom').getByRole('button',{name:/^设置(?:\s|$)/})).toBeVisible();
  await expect(sidebar.locator('.user-card')).toHaveCount(0);
  await sidebar.locator('.sidebar-bottom').getByRole('button',{name:/^设置(?:\s|$)/}).click();
  const settings = page.getByRole('dialog');
  await expect(settings.getByRole('tab',{name:'邮箱管理',exact:true})).toBeVisible();
  await expect(settings.getByRole('tab',{name:'安全与 API',exact:true})).toBeVisible();
  await expect(settings).not.toContainText('管理员');
  await settings.getByRole('button',{name:'关闭弹窗',exact:true}).click();

  await choose(all,'已发送');
  await expect(page.getByRole('button',{name:'打开邮件：个人已发送',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：工作已发送 1',exact:true})).toBeVisible();
  expect(requests.at(-1)).toMatchObject({accountId:null,folder:'sent',filter:'all',q:null,page:1});
  await choose(work,'已发送');
  await expect(page.getByRole('button',{name:'打开邮件：个人已发送',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'打开邮件：工作已发送 1',exact:true})).toBeVisible();
  expect(requests.at(-1)).toMatchObject({accountId:'alpha',folder:'[Work]/Sent',filter:'all',q:null,page:1});
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.getByRole('button',{name:'打开邮件：工作已发送 31',exact:true})).toBeVisible();
  expect(requests.at(-1)?.page).toBe(2);
  await page.getByRole('button',{name:'打开邮件：工作已发送 31',exact:true}).click();
  await expect(page.getByRole('heading',{name:'工作已发送 31',exact:true})).toBeVisible();
  await page.getByLabel('搜索邮件',{exact:true}).fill('工作已发送 31');
  await expect.poll(() => requests.at(-1)?.q).toBe('工作已发送 31');
  expect(requests.at(-1)?.page).toBe(1);
  await choose(personal,'已发送');
  await expect(page.getByLabel('搜索邮件',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'打开邮件：个人已发送',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'工作已发送 31',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
  expect(requests.at(-1)).toMatchObject({accountId:'beta',folder:'Sent Items',filter:'all',q:null,page:1});

  await choose(work,'项目');
  await expect(page.getByRole('button',{name:'打开邮件：工作项目',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：个人项目',exact:true})).toHaveCount(0);
  expect(requests.at(-1)).toMatchObject({accountId:'alpha',folder:'Clients/Shared'});
  await choose(personal,'项目');
  await expect(page.getByRole('button',{name:'打开邮件：个人项目',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：工作项目',exact:true})).toHaveCount(0);
  expect(requests.at(-1)).toMatchObject({accountId:'beta',folder:'Other/Shared'});
  await choose(all,'草稿');
  await expect(page.getByRole('button',{name:'打开邮件：工作草稿',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：个人草稿',exact:true})).toBeVisible();
  expect(requests.at(-1)).toMatchObject({accountId:null,folder:'drafts'});
  await choose(all,'垃圾邮件');
  await expect(page.getByRole('button',{name:'打开邮件：工作垃圾',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：个人垃圾',exact:true})).toBeVisible();
  expect(requests.at(-1)).toMatchObject({accountId:null,folder:'junk'});
  await choose(personal,'未读邮件');
  await expect(page.getByRole('button',{name:'打开邮件：个人收件',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：工作收件',exact:true})).toHaveCount(0);
  expect(requests.at(-1)).toMatchObject({accountId:'beta',folder:'INBOX',filter:'unread'});
  await choose(personal,'星标邮件');
  await expect(page.getByRole('button',{name:'打开邮件：个人收件',exact:true})).toBeVisible();
  expect(requests.at(-1)).toMatchObject({accountId:'beta',folder:'INBOX',filter:'starred'});

  // Removing a selected account must not leave its real server path in the unified view.
  await choose(personal,'已发送');
  await expect(page.getByRole('button',{name:'打开邮件：个人已发送',exact:true})).toBeVisible();
  await page.getByLabel('搜索邮件',{exact:true}).fill('个人已发送');
  await expect.poll(() => requests.at(-1)?.q).toBe('个人已发送');
  await page.getByRole('button',{name:'打开邮件：个人已发送',exact:true}).click();
  await expect(page.getByRole('heading',{name:'个人已发送',exact:true})).toBeVisible();
  expect(requests.at(-1)).toMatchObject({accountId:'beta',folder:'Sent Items',q:'个人已发送'});
  await openNavigation();
  await sidebar.locator('.sidebar-bottom').getByRole('button',{name:/^设置(?:\s|$)/}).click();
  page.once('dialog',dialog => dialog.accept());
  await settings.getByRole('button',{name:'断开 个人邮箱',exact:true}).click();
  await expect(settings.getByRole('button',{name:'断开 个人邮箱',exact:true})).toHaveCount(0);
  await settings.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await expect(page.getByLabel('搜索邮件',{exact:true})).toHaveValue('');
  await expect(page.locator('.folder-heading-copy h1')).toHaveAttribute('title','收件箱 — 所有邮箱');
  await expect(page.getByRole('button',{name:'打开邮件：工作收件',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'打开邮件：个人收件',exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'个人已发送',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
  await expect(sidebar.locator('nav[aria-label="个人邮箱文件夹"]')).toHaveCount(0);
  expect(requests.at(-1)).toMatchObject({accountId:null,folder:'INBOX',filter:'all',q:null,page:1});
  await noHorizontalOverflow(page);
});

test('editing a password mailbox preserves blank secrets, retries changes and resets only changed mailbox identity', async ({ page }) => {
  const account: Account = {
    id:'density-account',name:'工作邮箱',email:'work@example.test',color:'#627dcc',provider:'imap',username:'imap-login@example.test',
    smtpUsername:'smtp-login@example.test',imap:{host:'imap.example.test',port:993,secure:true},smtp:{host:'smtp.example.test',port:587,secure:false},
    status:'connected',lastSyncedAt:new Date().toISOString(),error:null,unread:0,
    authType:'password',hasSeparateSmtpCredentials:true,
    folders:[{path:'INBOX',name:'Inbox',kind:'inbox',specialUse:null,selectable:true},{path:'Sent Items',name:'Sent Items',kind:'sent',specialUse:'\\Sent',selectable:true}],
  };
  const messages = [
    {...mailboxMessages(1)[0],id:'edit-inbox',folder:'INBOX',subject:'编辑后的收件箱',unread:false,hasAttachments:false,attachments:[]},
    {...mailboxMessages(1)[0],id:'edit-sent',folder:'Sent Items',subject:'编辑前的已发送',unread:false,hasAttachments:false,attachments:[]},
  ];
  const payloads: Record<string,any>[] = [];
  const views: {folder:string|null;accountId:string|null;q:string|null;page:string|null}[] = [];
  await mockMailbox(page,messages);
  await page.route('**/api/v1/accounts**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const respond = (body: unknown, status = 200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if (path === '/accounts' && request.method() === 'GET') return respond({accounts:[account]});
    if (path !== '/accounts/density-account' || request.method() !== 'PATCH') return route.fallback();
    const changes = request.postDataJSON();
    payloads.push(changes);
    if (payloads.length === 1) return respond({error:{code:'MAIL_OPERATION_FAILED',message:'测试 SMTP 验证失败，请重试。'}},400);
    const cacheReset = changes.email !== undefined && changes.email !== account.email || changes.username !== undefined && changes.username !== account.username || changes.imap?.host !== undefined && changes.imap.host !== account.imap.host;
    for (const key of ['name','email','username','color','imap','smtp'] as const) if (changes[key] !== undefined) (account as any)[key] = changes[key];
    if (changes.smtpUsername === null && changes.smtpPassword === null) {
      account.hasSeparateSmtpCredentials = false;
      delete account.smtpUsername;
    } else if (typeof changes.smtpUsername === 'string') {
      account.smtpUsername = changes.smtpUsername;
      account.hasSeparateSmtpCredentials = true;
    }
    if (cacheReset) account.folders = [];
    return respond({account,cacheReset});
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/messages') views.push({folder:url.searchParams.get('folder'),accountId:url.searchParams.get('accountId'),q:url.searchParams.get('q'),page:url.searchParams.get('page')});
  });
  await page.goto('/');
  await expect(page.getByRole('button',{name:'打开邮件：编辑后的收件箱',exact:true})).toBeVisible();
  const navigationMenu = page.getByRole('button',{name:'打开导航菜单',exact:true});
  if (await navigationMenu.isVisible()) await navigationMenu.click();
  await page.getByRole('button',{name:'展开 工作邮箱文件夹',exact:true}).click();
  await page.getByRole('navigation',{name:'工作邮箱文件夹',exact:true}).getByRole('button',{name:'已发送',exact:true}).click();
  await expect(page.getByRole('button',{name:'打开邮件：编辑前的已发送',exact:true})).toBeVisible();
  await (await headerUtility(page,'邮件提醒设置')).click();
  const settings = page.getByRole('dialog',{name:'设置',exact:true});
  await settings.getByRole('button',{name:'编辑 工作邮箱',exact:true}).click();
  const editor = page.getByRole('dialog',{name:'编辑邮箱',exact:true});
  await expect(editor).toBeVisible();
  await expect(settings).toHaveCount(0);
  await expect(editor.getByRole('tablist')).toHaveCount(0);
  await expect(editor.getByLabel('邮箱名称',{exact:true})).toHaveValue('工作邮箱');
  await expect(editor.getByLabel('邮箱地址',{exact:true})).toHaveValue('work@example.test');
  await expect(editor.getByLabel('登录用户名',{exact:true})).toHaveValue('imap-login@example.test');
  await expect(editor.getByLabel('服务器地址',{exact:true}).nth(0)).toHaveValue('imap.example.test');
  await expect(editor.getByLabel('服务器地址',{exact:true}).nth(1)).toHaveValue('smtp.example.test');
  await expect(editor.getByLabel('端口',{exact:true}).nth(0)).toHaveValue('993');
  await expect(editor.getByLabel('端口',{exact:true}).nth(1)).toHaveValue('587');
  await expect(editor.getByRole('combobox',{name:'加密',exact:true}).nth(0)).toHaveValue('tls');
  await expect(editor.getByRole('combobox',{name:'加密',exact:true}).nth(1)).toHaveValue('starttls');
  await expect(editor.getByRole('button',{name:'选择颜色 #627dcc',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(editor.getByLabel(/^邮箱密码 \/ 授权码/)).toHaveValue('');
  await expect(editor.getByLabel('SMTP 使用不同的登录凭据',{exact:true})).toBeChecked();
  await expect(editor.getByLabel('SMTP 用户名',{exact:true})).toHaveValue('smtp-login@example.test');
  await expect(editor.getByLabel(/^SMTP 密码/)).toHaveValue('');
  await editor.getByLabel('邮箱名称',{exact:true}).fill('更新工作邮箱');
  await editor.getByRole('button',{name:'选择颜色 #af7486',exact:true}).click();
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(editor.getByRole('alert')).toContainText('测试 SMTP 验证失败，请重试。');
  await expect(editor.getByLabel('邮箱名称',{exact:true})).toHaveValue('更新工作邮箱');
  await expect(editor.getByRole('button',{name:'选择颜色 #af7486',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(editor.getByLabel(/^邮箱密码 \/ 授权码/)).toHaveValue('');
  await expect(editor.getByLabel(/^SMTP 密码/)).toHaveValue('');
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({name:'更新工作邮箱',color:'#af7486'});
  for (const key of ['password','smtpPassword','provider','authType']) expect(payloads[0]).not.toHaveProperty(key);
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(editor).toHaveCount(0);
  await expect(settings.getByRole('button',{name:'编辑 更新工作邮箱',exact:true})).toBeVisible();
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
  await settings.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await expect(page.locator('.folder-heading-copy h1')).toHaveAttribute('title','已发送 — 更新工作邮箱');
  await expect(page.getByRole('button',{name:'打开邮件：编辑前的已发送',exact:true})).toBeVisible();
  await expect(page.locator('nav[aria-label="更新工作邮箱文件夹"]')).toHaveCount(1);

  await (await headerUtility(page,'邮件提醒设置')).click();
  await settings.getByRole('button',{name:'编辑 更新工作邮箱',exact:true}).click();
  await expect(editor.getByLabel(/^邮箱密码 \/ 授权码/)).toHaveValue('');
  await expect(editor.getByLabel(/^SMTP 密码/)).toHaveValue('');
  await editor.getByLabel('邮箱地址',{exact:true}).fill('updated@example.test');
  await editor.getByLabel('登录用户名',{exact:true}).fill('updated-login@example.test');
  await editor.getByLabel('服务器地址',{exact:true}).nth(0).fill('imap.updated.example.test');
  await expect(editor).toContainText(/(?:清理|重建).*缓存/);
  await editor.getByLabel('SMTP 使用不同的登录凭据',{exact:true}).uncheck();
  await expect(editor.getByLabel('SMTP 用户名',{exact:true})).toHaveCount(0);
  await expect(editor.getByLabel(/^SMTP 密码/)).toHaveCount(0);
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(editor).toHaveCount(0);
  expect(payloads).toHaveLength(3);
  expect(payloads[2]).toMatchObject({email:'updated@example.test',username:'updated-login@example.test',imap:{host:'imap.updated.example.test'},smtpUsername:null,smtpPassword:null});
  expect(payloads[2]).not.toHaveProperty('password');
  await settings.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await expect(page.locator('.folder-heading-copy h1')).toHaveAttribute('title','收件箱 — 更新工作邮箱');
  await expect(page.getByRole('button',{name:'打开邮件：编辑后的收件箱',exact:true})).toBeVisible();
  expect(views.at(-1)).toMatchObject({folder:'INBOX',accountId:'density-account',q:null,page:'1'});

  await (await headerUtility(page,'邮件提醒设置')).click();
  await settings.getByRole('button',{name:'编辑 更新工作邮箱',exact:true}).click();
  await expect(editor.getByLabel('SMTP 使用不同的登录凭据',{exact:true})).not.toBeChecked();
  await editor.getByLabel('SMTP 使用不同的登录凭据',{exact:true}).check();
  await editor.getByLabel('SMTP 用户名',{exact:true}).fill('new-smtp@example.test');
  const newSmtpPassword = editor.getByLabel(/^SMTP 密码/);
  await expect(newSmtpPassword).toHaveValue('');
  await expect(newSmtpPassword).toHaveAttribute('required','');
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(editor).toBeVisible();
  expect(payloads).toHaveLength(3);
  await newSmtpPassword.fill('Synthetic-SMTP-password-only-2026!');
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(editor).toHaveCount(0);
  expect(payloads).toHaveLength(4);
  expect(payloads[3]).toMatchObject({smtpUsername:'new-smtp@example.test',smtpPassword:'Synthetic-SMTP-password-only-2026!'});
  expect(payloads[3]).not.toHaveProperty('password');
  await settings.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await expect(page.locator('.folder-heading-copy h1')).toHaveAttribute('title','收件箱 — 更新工作邮箱');
  await noHorizontalOverflow(page);
});

test('editing an OAuth mailbox exposes metadata and reauthorization without editing passwords or mail servers', async ({ page }) => {
  const account: Account = {
    id:'density-account',name:'Google 邮箱',email:'oauth-owner@example.test',color:'#377a75',provider:'gmail',username:'oauth-owner@example.test',
    imap:{host:'imap.gmail.com',port:993,secure:true},smtp:{host:'smtp.gmail.com',port:465,secure:true},
    status:'connected',lastSyncedAt:new Date().toISOString(),error:null,unread:0,authType:'oauth',hasSeparateSmtpCredentials:false,
  };
  const payloads: Record<string,unknown>[] = [];
  await mockMailbox(page);
  await page.route('**/api/v1/config', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({googleConfigured:true,pushPublicKey:null,pollingInterval:3600})}));
  await page.route('**/api/v1/accounts**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const respond = (body: unknown) => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if (path === '/accounts' && request.method() === 'GET') return respond({accounts:[account]});
    if (path !== '/accounts/density-account' || request.method() !== 'PATCH') return route.fallback();
    const changes = request.postDataJSON();
    payloads.push(changes);
    Object.assign(account,changes);
    return respond({account,cacheReset:false});
  });
  await page.goto('/');
  await (await headerUtility(page,'邮件提醒设置')).click();
  const settings = page.getByRole('dialog',{name:'设置',exact:true});
  await settings.getByRole('button',{name:'编辑 Google 邮箱',exact:true}).click();
  const editor = page.getByRole('dialog',{name:'编辑邮箱',exact:true});
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('tablist')).toHaveCount(0);
  await expect(editor.getByLabel('邮箱名称',{exact:true})).toHaveValue('Google 邮箱');
  await expect(editor.getByLabel('邮箱地址',{exact:true})).toHaveValue('oauth-owner@example.test');
  await expect(editor.getByLabel('邮箱地址',{exact:true})).toHaveAttribute('readonly','');
  await expect(editor.locator('input[type="password"]')).toHaveCount(0);
  await expect(editor.getByLabel('登录用户名',{exact:true})).toHaveCount(0);
  await expect(editor.locator('.protocol-card')).toHaveCount(0);
  await expect(editor.getByRole('button',{name:'重新授权 Google',exact:true})).toBeEnabled();
  await editor.getByLabel('邮箱名称',{exact:true}).fill('私人 Google 邮箱');
  await editor.getByRole('button',{name:'选择颜色 #7c6a9e',exact:true}).click();
  await editor.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(editor).toHaveCount(0);
  await expect(settings.getByRole('button',{name:'编辑 私人 Google 邮箱',exact:true})).toBeVisible();
  expect(payloads).toEqual([{name:'私人 Google 邮箱',color:'#7c6a9e'}]);
  await settings.getByRole('button',{name:'编辑 私人 Google 邮箱',exact:true}).click();
  await expect(editor.getByLabel('邮箱名称',{exact:true})).toHaveValue('私人 Google 邮箱');
  await expect(editor.getByRole('button',{name:'选择颜色 #7c6a9e',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(editor.getByLabel('邮箱地址',{exact:true})).toHaveValue('oauth-owner@example.test');
  await expect(editor.getByRole('button',{name:'重新授权 Google',exact:true})).toBeEnabled();
  await editor.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await expect(settings).toBeVisible();
  await settings.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await expect(page.locator('nav[aria-label="私人 Google 邮箱文件夹"]')).toHaveCount(1);
  await noHorizontalOverflow(page);
});

test('visible mail actions forward editable drafts and retry original attachments before sending, then reply and delete', async ({ page, context }) => {
  const originalBytes = Buffer.from('original fixture attachment');
  const additionalBytes = Buffer.from('new browser attachment');
  const source: Message = {
    ...mailboxMessages(1)[0],id:'forward-source',subject:'原始项目附件',
    from:{name:'源发件人',address:'sender@example.test'},unread:false,starred:false,
    text:'这是一封包含原始附件的合成邮件。',messageId:'<forward-source@example.test>',hasAttachments:true,
    attachments:[
      {id:'original',filename:'source.txt',contentType:'text/plain',size:originalBytes.length},
      {id:'skipped',filename:'skip.txt',contentType:'text/plain',size:4},
    ],
  };
  const alreadyForwarded: Message = {...source,id:'prefixed-forward',subject:'FW: 已转发的项目',hasAttachments:false,attachments:[]};
  const payloads: any[] = [], destinations: string[] = [];
  let originalRequests = 0, skippedRequests = 0;
  await mockMailbox(page,[source,alreadyForwarded]);
  await page.route('**/api/v1/messages/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const respond = (body: unknown, status = 200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if (path === '/messages/forward-source/attachments/original') {
      originalRequests++;
      expect(request.method()).toBe('GET');
      expect((await request.allHeaders()).cookie).toContain('mailnest_attachment_fixture=present');
      if (originalRequests === 1) return respond({},404);
      return route.fulfill({status:200,contentType:'text/plain',body:originalBytes});
    }
    if (path === '/messages/forward-source/attachments/skipped') {
      skippedRequests++;
      return route.fulfill({status:200,contentType:'text/plain',body:'skip'});
    }
    if (path === '/messages/send') {
      expect(request.method()).toBe('POST');
      payloads.push(request.postDataJSON());
      return respond({ok:true,messageId:'<sent-fixture@example.test>'});
    }
    if (path === '/messages/forward-source/move') {
      expect(request.method()).toBe('POST');
      const {destination} = request.postDataJSON();
      destinations.push(destination);
      source.folder = destination;
      return respond({ok:true});
    }
    return route.fallback();
  });
  await page.goto('/');
  await context.addCookies([{name:'mailnest_attachment_fixture',value:'present',url:new URL(page.url()).origin,httpOnly:true,sameSite:'Lax'}]);
  const toolbar = page.getByRole('toolbar',{name:'邮件操作',exact:true});
  for (const name of ['回复邮件','转发邮件','删除邮件','标记邮件']) {
    await expect(toolbar.getByRole('button',{name,exact:true})).toBeVisible();
    await expect(toolbar.getByRole('button',{name,exact:true})).toBeDisabled();
  }
  await page.getByRole('button',{name:`打开邮件：${alreadyForwarded.subject}`,exact:true}).click();
  await toolbar.getByRole('button',{name:'转发邮件',exact:true}).click();
  const forward = page.getByRole('dialog',{name:'转发邮件',exact:true});
  await expect(forward.getByLabel('主题',{exact:true})).toHaveValue('FW: 已转发的项目');
  await expect(forward.getByLabel(/^收件人/)).toHaveValue('');
  await forward.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await expect(forward).toHaveCount(0);
  await page.getByRole('button',{name:'返回邮件列表',exact:true}).click();
  await page.getByRole('button',{name:`打开邮件：${source.subject}`,exact:true}).click();
  for (const name of ['回复邮件','转发邮件','删除邮件','标记邮件']) {
    await expect(toolbar.getByRole('button',{name,exact:true})).toBeVisible();
    await expect(toolbar.getByRole('button',{name,exact:true})).toBeEnabled();
  }
  await toolbar.getByRole('button',{name:'转发邮件',exact:true}).click();
  await expect(forward).toBeVisible();
  await expect(forward.getByLabel('发件人',{exact:true})).toHaveValue('density-account');
  await expect(forward.getByLabel(/^收件人/)).toHaveValue('');
  await expect(forward.getByLabel('主题',{exact:true})).toHaveValue('Fwd: 原始项目附件');
  const originalDraft = await forward.getByLabel('邮件正文',{exact:true}).inputValue();
  expect(originalDraft).toContain('sender@example.test');
  expect(originalDraft).toContain(source.text);
  await expect(forward.getByText(/原邮件附件 · 点击发送时载入/)).toHaveCount(2);
  expect(originalRequests).toBe(0);
  await forward.getByRole('button',{name:'移除附件 skip.txt',exact:true}).click();
  await forward.locator('input[type="file"]').setInputFiles({name:'extra.txt',mimeType:'text/plain',buffer:additionalBytes});
  await expect(forward.getByRole('button',{name:'移除附件 extra.txt',exact:true})).toBeVisible();
  await forward.getByLabel(/^收件人/).fill('recipient@example.test');
  const editedText = `请协助处理。${originalDraft}`;
  await forward.getByLabel('邮件正文',{exact:true}).fill(editedText);
  await forward.getByRole('button',{name:'发送邮件',exact:true}).click();
  await expect(forward.getByRole('alert')).toContainText('无法读取原邮件附件“source.txt”：附件不存在或已不可用。');
  await expect(forward.getByLabel(/^收件人/)).toHaveValue('recipient@example.test');
  await expect(forward.getByLabel('主题',{exact:true})).toHaveValue('Fwd: 原始项目附件');
  await expect(forward.getByLabel('邮件正文',{exact:true})).toHaveValue(editedText);
  await expect(forward.getByRole('button',{name:'移除附件 source.txt',exact:true})).toBeVisible();
  await expect(forward.getByRole('button',{name:'移除附件 extra.txt',exact:true})).toBeVisible();
  expect(payloads).toHaveLength(0);
  await forward.getByRole('button',{name:'发送邮件',exact:true}).click();
  await expect(forward).toHaveCount(0);
  expect(originalRequests).toBe(2);
  expect(skippedRequests).toBe(0);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({accountId:'density-account',to:'recipient@example.test',subject:'Fwd: 原始项目附件',text:editedText});
  expect(payloads[0]).not.toHaveProperty('inReplyTo');
  expect(payloads[0]).not.toHaveProperty('references');
  expect(payloads[0].attachments).toHaveLength(2);
  const sentAttachments = Object.fromEntries(payloads[0].attachments.map((attachment: {filename:string;contentType:string;content:string}) => [attachment.filename,{contentType:attachment.contentType,text:Buffer.from(attachment.content,'base64').toString()}]));
  expect(sentAttachments).toEqual({'source.txt':{contentType:'text/plain',text:originalBytes.toString()},'extra.txt':{contentType:'text/plain',text:additionalBytes.toString()}});

  await toolbar.getByRole('button',{name:'回复邮件',exact:true}).click();
  const reply = page.getByRole('dialog',{name:'回复邮件',exact:true});
  await expect(reply.getByLabel('发件人',{exact:true})).toHaveValue('density-account');
  await expect(reply.getByLabel(/^收件人/)).toHaveValue('sender@example.test');
  await reply.getByLabel('邮件正文',{exact:true}).fill('线程回复内容');
  await reply.getByRole('button',{name:'发送邮件',exact:true}).click();
  await expect(reply).toHaveCount(0);
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toMatchObject({to:'sender@example.test',inReplyTo:source.messageId,references:source.messageId,text:'线程回复内容'});
  expect(originalRequests).toBe(2);
  await toolbar.getByRole('button',{name:'删除邮件',exact:true}).click();
  await expect.poll(() => destinations).toEqual(['trash']);
  await expect(page.getByText('邮件已移到已删除。',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:`打开邮件：${source.subject}`,exact:true})).toHaveCount(0);
  await noHorizontalOverflow(page);
});

test('long mail subjects stay compact, with enough visible rows and usable star controls', async ({ page }) => {
  // The reported regression was a tablet in landscape mode using the desktop layout.
  if (test.info().project.name === 'tablet') await page.setViewportSize({width:1280,height:800});
  const messages = mailboxMessages();
  await mockMailbox(page,messages);
  await page.goto('/');
  const rows = page.locator('.message-row');
  await expect(rows).toHaveCount(messages.length);
  const mobile = test.info().project.name === 'mobile';
  const rowHeights = await rows.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(Math.max(...rowHeights)).toBeLessThanOrEqual(80);
  expect(Math.max(...rowHeights) - Math.min(...rowHeights)).toBeLessThanOrEqual(2);
  const visibleRows = await rows.evaluateAll(elements => {
    const list = document.querySelector('.message-list-scroll')!.getBoundingClientRect();
    return elements.filter(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= list.top && bounds.bottom <= Math.min(list.bottom,window.innerHeight);
    }).length;
  });
  expect(visibleRows).toBeGreaterThanOrEqual(mobile ? 6 : test.info().project.name === 'tablet' ? 8 : 7);
  await noHorizontalOverflow(page);
  const firstStar = page.getByRole('button',{name:`标记星标：${messages[0].subject}`,exact:true});
  const starBounds = await firstStar.boundingBox();
  expect(starBounds).not.toBeNull();
  const touchTarget = test.info().project.name === 'desktop' ? 36 : 40;
  expect(starBounds!.width).toBeGreaterThanOrEqual(touchTarget);
  expect(starBounds!.height).toBeGreaterThanOrEqual(touchTarget);
  await firstStar.click();
  await expect(page.getByRole('button',{name:`取消星标：${messages[0].subject}`,exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('heading',{name:messages[0].subject,exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:`打开邮件：${messages[0].subject}`,exact:true}).click();
  await expect(page.getByRole('heading',{name:messages[0].subject,exact:true})).toBeVisible();
  if (await page.getByRole('region',{name:'邮件列表'}).isVisible()) {
    expect((await rows.first().boundingBox())!.height).toBeLessThanOrEqual(80);
  }
  await noHorizontalOverflow(page);
  const back = page.getByRole('button',{name:'返回邮件列表',exact:true});
  const scroll = page.locator('.workspace-scroll');
  const overviewScroll = page.viewportSize()!.width >= 1151 ? page.locator('.message-list-scroll') : scroll;
  await back.evaluate((button: HTMLButtonElement) => button.click());
  await overviewScroll.evaluate(element => {element.scrollTop = 160;});
  await expect.poll(() => overviewScroll.evaluate(element => element.scrollTop)).toBe(160);
  const middleMail = page.getByRole('button',{name:`打开邮件：${messages[5].subject}`,exact:true});
  await expect(middleMail).toBeInViewport();
  await middleMail.click();
  await expect(page.getByRole('heading',{name:messages[5].subject,exact:true})).toBeVisible();
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
  await back.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => overviewScroll.evaluate(element => Math.abs(element.scrollTop - 160))).toBeLessThanOrEqual(2);
});

test('compact reader chrome scrolls away with the message and changing mail starts at the top', async ({ page }) => {
  const viewports = test.info().project.name === 'tablet'
    ? [{width:768,height:1024},{width:1280,height:800}]
    : [page.viewportSize()!];
  const messages = mailboxMessages(2).map((message,index) => ({
    ...message,subject:index ? '第二封长文本邮件' : '第一封长文本邮件',
    text:`${index ? '第二封' : '第一封'}正文起点\n` + Array.from({length:100},(_,paragraph) => `第 ${paragraph + 1} 段：${'阅读长邮件时，标题栏和发件人信息应随正文滚动，留下更多阅读空间。'.repeat(4)}`).join('\n\n'),
  }));
  await mockMailbox(page,messages);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const mobile = viewport.width < 768;
    const sidebar = page.getByRole('complementary',{name:'邮箱导航'});
    if (!mobile) expect((await sidebar.boundingBox())!.width).toBeLessThanOrEqual(184);
    expect((await page.locator('.workspace-header').boundingBox())!.height).toBeLessThanOrEqual(mobile ? 88 : 48);
    const bottomNav = page.getByRole('navigation',{name:'快捷导航'});
    if (await bottomNav.isVisible()) expect((await bottomNav.boundingBox())!.height).toBeLessThanOrEqual(58);
    await page.getByRole('button',{name:`打开邮件：${messages[0].subject}`,exact:true}).click();
    await expect(page.getByRole('heading',{name:messages[0].subject,exact:true})).toBeVisible();
    await expect(page.locator('.message-body')).toContainText('第一封正文起点');
    expect((await page.locator('.reader-toolbar').boundingBox())!.height).toBeLessThanOrEqual(48);
    const scroll = page.locator('.workspace-scroll');
    const scrollDown = async () => {
      const body = (await page.locator('.message-body').boundingBox())!;
      await page.mouse.move(body.x + Math.min(150,body.width / 2),Math.min(viewport.height - 100,body.y + 100));
      await page.mouse.wheel(0,900);
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(500);
    };
    await scrollDown();
    for (const selector of ['.workspace-header','.reader-toolbar','.message-heading','.message-sender-block']) {
      await expect.poll(() => page.locator(selector).evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
    }
    await noHorizontalOverflow(page);
    const nextMail = page.getByRole('button',{name:`打开邮件：${messages[1].subject}`,exact:true});
    const back = page.getByRole('button',{name:'返回邮件列表',exact:true});
    if (!(await nextMail.isVisible())) {
      // Activate without Playwright scrolling the control into view first, so
      // the assertion checks the app's reset rather than browser auto-scroll.
      await back.evaluate((button: HTMLButtonElement) => button.click());
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
    }
    await nextMail.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByRole('heading',{name:messages[1].subject,exact:true})).toBeVisible();
    await expect(page.locator('.message-body')).toContainText('第二封正文起点');
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
    await scrollDown();
    await back.evaluate((button: HTMLButtonElement) => button.click());
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('button',{name:`打开邮件：${messages[0].subject}`,exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:messages[1].subject,exact:true})).toHaveCount(0);
    await noHorizontalOverflow(page);
  }
});

test('one compact header and three metadata rows leave room for mail, with usable narrow-reader menus', async ({ page }) => {
  const messages = mailboxMessages(2);
  messages[0] = {...messages[0],subject:'简短主题',from:{name:'项目团队',address:'sender@example.com'},to:[{name:'测试管理员',address:'ui@example.com'}],unread:false,text:'正文应从更靠近顶部的位置开始。'};
  const longAddress = `long.sender.${'x'.repeat(52)}@${'long-domain.'.repeat(8)}example.test`;
  messages[1] = {...messages[1],subject:'长主题与长地址应保持紧凑：'.repeat(16),from:{name:'客户成功与账户安全支持团队'.repeat(5),address:longAddress},to:[{name:'收件人名称'.repeat(8),address:longAddress}],unread:false,starred:false,text:'长主题和地址不能遮挡正文或操作按钮。'};
  await mockMailbox(page,messages);
  await page.goto('/');
  await page.getByRole('button',{name:`打开邮件：${messages[0].subject}`,exact:true}).click();
  await expect(page.getByRole('heading',{name:messages[0].subject,exact:true})).toBeVisible();
  const mobile = test.info().project.name === 'mobile';
  const header = page.locator('.workspace-header');
  const toolbar = page.locator('.reader-toolbar');
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(mobile ? 88 : 48);
  await expect(toolbar).toHaveCount(1);
  const toolbarBounds = (await toolbar.boundingBox())!, headerBounds = (await header.boundingBox())!;
  expect(toolbarBounds.y).toBeGreaterThanOrEqual(headerBounds.y - 1);
  expect(toolbarBounds.y + toolbarBounds.height).toBeLessThanOrEqual(headerBounds.y + headerBounds.height + 1);
  const checkPrimaryActions = async () => {
    const controls = [];
    for (const name of ['回复邮件','转发邮件','删除邮件','标记邮件','更多邮件操作']) {
      const button = toolbar.getByRole('button',{name,exact:true});
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      const bounds = (await button.boundingBox())!;
      const targetSize = test.info().project.name === 'desktop' ? 32 : 40;
      expect(bounds.width).toBeGreaterThanOrEqual(targetSize);
      expect(bounds.height).toBeGreaterThanOrEqual(targetSize);
      controls.push(bounds);
    }
    const centers = controls.map(bounds => bounds.y + bounds.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
    const ordered = controls.sort((left,right) => left.x - right.x);
    for (let index = 1; index < ordered.length; index++) expect(ordered[index].x).toBeGreaterThanOrEqual(ordered[index - 1].x + ordered[index - 1].width - 1);
  };
  await checkPrimaryActions();
  const metadata = await page.locator('.message-metadata').boundingBox();
  const sender = (await page.locator('.message-sender-block').boundingBox())!;
  const subject = (await page.locator('.message-heading').boundingBox())!;
  const recipients = (await page.locator('.message-recipient-details').boundingBox())!;
  expect(metadata!.height).toBeLessThanOrEqual(85);
  expect(subject.y).toBeGreaterThanOrEqual(sender.y + sender.height - 1);
  expect(recipients.y).toBeGreaterThanOrEqual(subject.y + subject.height - 1);
  expect((await page.locator('.message-body').boundingBox())!.y).toBeLessThanOrEqual(mobile ? 210 : 160);
  await noHorizontalOverflow(page);

  await page.getByRole('button',{name:'返回邮件列表',exact:true}).evaluate((button: HTMLButtonElement) => button.click());
  if (mobile) {
    await page.setViewportSize({width:320,height:851});
  } else {
    await page.setViewportSize({width:1152,height:800});
    await page.getByRole('separator',{name:'调整邮箱导航宽度',exact:true}).press('End');
    await page.getByRole('separator',{name:'调整邮件列表宽度',exact:true}).press('End');
  }
  await page.getByRole('button',{name:`打开邮件：${messages[1].subject}`,exact:true}).click();
  await expect(page.getByRole('heading',{name:messages[1].subject,exact:true})).toBeVisible();
  await expect.poll(() => page.getByRole('main',{name:'邮件内容'}).evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(321);
  const narrowMetadata = await page.locator('.message-metadata').evaluate(element => {
    const outer = element.getBoundingClientRect(), main = element.querySelector('.message-metadata-main')!.getBoundingClientRect(), side = element.querySelector('.message-metadata-side')!.getBoundingClientRect();
    return {height:outer.height,mainRight:main.right,sideLeft:side.left,contained:main.left >= outer.left - 1 && side.right <= outer.right + 1};
  });
  expect(narrowMetadata.height).toBeLessThanOrEqual(110);
  expect(narrowMetadata.contained).toBe(true);
  expect(narrowMetadata.mainRight).toBeLessThanOrEqual(narrowMetadata.sideLeft + 1);
  await noHorizontalOverflow(page);
  await checkPrimaryActions();
  const flag = page.getByRole('button',{name:'标记邮件',exact:true});
  const more = page.getByRole('button',{name:'更多邮件操作',exact:true});
  const flagMenu = page.getByRole('menu',{name:'邮件标记',exact:true});
  await flag.click();
  await expect(flagMenu).toBeVisible();
  await flagMenu.getByRole('menuitem',{name:'标记为未读',exact:true}).click();
  await expect(flagMenu).toHaveCount(0);
  await expect.poll(() => messages[1].unread).toBe(true);
  await flag.click();
  await expect(flagMenu.getByRole('menuitem',{name:'标记为已读',exact:true})).toBeVisible();
  await flagMenu.getByRole('menuitem',{name:'标记星标',exact:true}).click();
  await expect(flagMenu).toHaveCount(0);
  await expect.poll(() => messages[1].starred).toBe(true);
  await flag.click();
  await expect(flagMenu.getByRole('menuitem',{name:'取消星标',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(flag).toBeFocused();
  await more.click();
  const menu = page.getByRole('menu',{name:'更多邮件操作',exact:true});
  await expect(menu.getByRole('menuitem',{name:'归档邮件',exact:true})).toBeVisible();
  const visibleInstallButtons = page.getByRole('button',{name:'安装应用',exact:true}), installItem = menu.getByRole('menuitem',{name:'安装应用',exact:true});
  const installCount = await visibleInstallButtons.count() + await installItem.count();
  expect(installCount).toBe(1);
  if (await installItem.isVisible()) await installItem.click();
  else { await page.keyboard.press('Escape'); await visibleInstallButtons.click(); }
  await expect(page.getByRole('dialog',{name:'安装邮屿',exact:true})).toBeVisible();
  await noHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await more.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('long HTML mail scrolls the workspace by wheel and touch while wide tables scroll locally', async ({ page, context }) => {
  const viewports = test.info().project.name === 'tablet'
    ? [{width:768,height:1024},{width:1280,height:800}]
    : [page.viewportSize()!];
  const message = mailboxMessages(1)[0];
  message.subject = '长 HTML 正文与宽表格';
  message.html = `<p>HTML 正文起点</p><table><tr>${Array.from({length:80},(_,index) => `<th>字段${index + 1}</th>`).join('')}</tr><tr>${'<td>合成数据</td>'.repeat(80)}</tr></table>` +
    Array.from({length:120},(_,index) => `<p>第 ${index + 1} 段：${'正文使用独立安全页面呈现，滑动时整个阅读界面继续滚动。'.repeat(3)}</p>`).join('') +
    '<script>parent.window.__mailExecuted=true</script><img src="invalid" onerror="parent.window.__mailExecuted=true">';
  const shortMessage = {...mailboxMessages(1)[0],id:'short-html',subject:'短 HTML 邮件',html:'<p>短邮件正文。</p>'};
  await page.addInitScript(() => {
    window.addEventListener('message',event => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="邮件正文"]');
      if (event.source === iframe?.contentWindow && event.data?.type === 'mailnest:body-height') (window as any).__lastBodyHeightReport = event.data;
    });
  });
  await mockMailbox(page,[message,shortMessage]);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button',{name:`打开邮件：${message.subject}`,exact:true}).click();
    await expect(page.getByRole('heading',{name:message.subject,exact:true})).toBeVisible();
    const frame = page.frameLocator('iframe[title="邮件正文"]');
    await expect(frame.getByText('HTML 正文起点',{exact:true})).toBeVisible();
    await expect(frame.locator('script[data-mailnest-measure]')).toHaveCount(1);
    await expect(frame.locator('script:not([data-mailnest-measure])')).toHaveCount(0);
    await expect(frame.locator('[onerror],[onclick],[onload]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__mailExecuted)).toBeUndefined();
    expect(await frame.locator('html').evaluate(() => {
      try { void window.parent.document; return 'parent was accessible'; }
      catch (error) { return (error as DOMException).name; }
    })).toBe('SecurityError');
    // A normal long message should use the surrounding page's scroll, instead
    // of a second vertical scrollbar inside the isolated reader.
    await expect.poll(() => frame.locator('html').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2);
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__lastBodyHeightReport?.token))).toBe(true);
    const forgedHeights = await page.evaluate(async () => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="邮件正文"]')!;
      const valid = (window as any).__lastBodyHeightReport;
      const originalHeight = iframe.clientHeight;
      const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      // Even a valid payload must come from this frame. A payload with the
      // right source must also carry the private measurement token.
      window.dispatchEvent(new MessageEvent('message',{source:window,data:{...valid,height:16,capped:false}}));
      await settle();
      const afterWrongSource = iframe.clientHeight;
      window.dispatchEvent(new MessageEvent('message',{source:iframe.contentWindow,data:{...valid,token:'forged-measurement-token',height:16,capped:false}}));
      await settle();
      return {originalHeight,afterWrongSource,afterWrongToken:iframe.clientHeight};
    });
    expect(forgedHeights.afterWrongSource).toBe(forgedHeights.originalHeight);
    expect(forgedHeights.afterWrongToken).toBe(forgedHeights.originalHeight);
    const table = frame.locator('.mail-table-scroll');
    expect(await table.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100);
    expect(await table.evaluate(element => {element.scrollLeft = 150; return element.scrollLeft;})).toBeGreaterThan(0);
    expect(await frame.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await noHorizontalOverflow(page);
    const scroll = page.locator('.workspace-scroll');
    const iframe = (await page.locator('iframe[title="邮件正文"]').boundingBox())!;
    const pointer = {x:iframe.x + Math.min(150,iframe.width / 2),y:Math.min(viewport.height - 100,iframe.y + 100)};
    await page.mouse.move(pointer.x,pointer.y);
    await page.mouse.wheel(0,750);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(400);
    await expect.poll(() => page.locator('.workspace-header').evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
    if (viewport.width < 768) {
      await scroll.evaluate(element => {element.scrollTop = 0;});
      const session = await context.newCDPSession(page);
      let touchActive = false;
      try {
        // Use actual touch events: Chromium's synthesized scroll gesture sends
        // no touchmove in this mobile emulation, even over plain text.
        const startY = viewport.height - 140;
        const distance = Math.min(400,startY - iframe.y - 32);
        await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:pointer.x,y:startY}]});
        touchActive = true;
        for (let step = 1; step <= 10; step++) {
          await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:pointer.x,y:startY - distance * step / 10}]});
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        }
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        touchActive = false;
        await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(300);
      } finally {
        if (touchActive) await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await session.detach();
      }
    }
    await noHorizontalOverflow(page);
    await page.getByRole('button',{name:'返回邮件列表',exact:true}).evaluate((button: HTMLButtonElement) => button.click());
    await page.getByRole('button',{name:`打开邮件：${shortMessage.subject}`,exact:true}).click();
    await expect(frame.getByText('短邮件正文。',{exact:true})).toBeVisible();
    await expect.poll(async () => Math.abs(
      await page.locator('iframe[title="邮件正文"]').evaluate((iframe: HTMLIFrameElement) => iframe.clientHeight) -
      await frame.locator('.mailnest-document-root').evaluate(element => Math.ceil(element.getBoundingClientRect().height)),
    )).toBeLessThanOrEqual(2);
    expect(await page.locator('iframe[title="邮件正文"]').evaluate((iframe: HTMLIFrameElement) => iframe.clientHeight)).toBeLessThan(100);
  }
});

test('desktop panes resize by drag and keyboard, persist after reload and stay usable on narrow screens', async ({ page }) => {
  if (test.info().project.name === 'tablet') await page.setViewportSize({width:1280,height:800});
  const messages = mailboxMessages();
  messages[0].subject = '拖动时保持 HTML 正文';
  messages[0].unread = false;
  messages[0].html = '<style>.resize-copy{font-size:14px;line-height:20px}@media(max-width:700px){.resize-copy{font-size:20px;line-height:30px}}</style>' +
    `<div class="resize-copy">${Array.from({length:12},(_,index) => `<p>第 ${index + 1} 段：${'调整阅读区宽度时，保留原正文并更新响应式排版。'.repeat(5)}</p>`).join('')}</div>` +
    '<img src="https://resize-image.example.test/pixel.png" alt="调整宽度测试图片" width="24" height="24">';
  let resizeImageRequests = 0;
  await page.route('https://resize-image.example.test/**',route => {
    resizeImageRequests++;
    return route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6icAAAAAASUVORK5CYII=','base64')});
  });
  await mockMailbox(page,messages);
  await page.goto('/');
  await expect(page.locator('.message-row')).toHaveCount(18);
  const separators = page.getByRole('separator');
  if (test.info().project.name === 'mobile') {
    await expect(separators).toHaveCount(0);
    await noHorizontalOverflow(page);
    return;
  }
  const navigation = page.getByRole('complementary',{name:'邮箱导航'});
  const list = page.getByRole('region',{name:'邮件列表'});
  const reader = page.getByRole('main',{name:'邮件内容'});
  const sidebarDivider = page.getByRole('separator',{name:'调整邮箱导航宽度',exact:true});
  const listDivider = page.getByRole('separator',{name:'调整邮件列表宽度',exact:true});
  const widths = async () => ({sidebar:(await navigation.boundingBox())!.width,list:(await list.boundingBox())!.width,reader:(await reader.boundingBox())!.width});
  const drag = async (name: string, distance: number) => {
    const bounds = (await page.getByRole('separator',{name,exact:true}).boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2,bounds.y + Math.min(250,bounds.height / 2));
    await page.mouse.down();
    try { await page.mouse.move(bounds.x + bounds.width / 2 + distance,bounds.y + Math.min(250,bounds.height / 2),{steps:8}); }
    finally { await page.mouse.up(); }
  };
  await expect(separators).toHaveCount(2);
  await expect(navigation).toBeVisible();
  await expect(list).toBeVisible();
  await expect(reader).toBeVisible();
  const initial = await widths();
  expect(initial.sidebar).toBeGreaterThan(100);
  expect(initial.list).toBeGreaterThanOrEqual(239);
  expect(initial.reader).toBeGreaterThanOrEqual(319);
  expect((await list.boundingBox())!.x).toBeGreaterThanOrEqual((await navigation.boundingBox())!.width);
  expect((await reader.boundingBox())!.x).toBeGreaterThanOrEqual((await list.boundingBox())!.x + initial.list);
  await page.locator('.message-row-main').first().click();
  await expect(page.locator('.message-heading')).toBeVisible();
  expect(Math.abs((await widths()).list - initial.list)).toBeLessThanOrEqual(1);
  expect(Math.abs((await widths()).sidebar - initial.sidebar)).toBeLessThanOrEqual(1);
  const frame = page.frameLocator('iframe[title="邮件正文"]');
  await expect.poll(() => frame.getByRole('img',{name:'调整宽度测试图片',exact:true}).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await expect.poll(() => frame.locator('.resize-copy').evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
  await expect.poll(async () => Math.abs(
    await page.locator('iframe[title="邮件正文"]').evaluate((iframe: HTMLIFrameElement) => iframe.clientHeight) -
    await frame.locator('.mailnest-document-root').evaluate(element => Math.ceil(element.getBoundingClientRect().height)),
  )).toBeLessThanOrEqual(2);
  const originalBodyHeight = await page.locator('iframe[title="邮件正文"]').evaluate((iframe: HTMLIFrameElement) => iframe.clientHeight);
  await frame.locator('html').evaluate(() => {(window as any).__mountSentinel = 'same-mail-document';});
  await page.locator('iframe[title="邮件正文"]').evaluate(iframe => {
    (window as any).__resizeFrameLoads = 0;
    iframe.addEventListener('load',() => {(window as any).__resizeFrameLoads++;});
  });
  const requestsBeforeResize = resizeImageRequests;
  await drag('调整邮箱导航宽度',50);
  await expect.poll(async () => (await widths()).sidebar - initial.sidebar).toBeGreaterThan(35);
  expect(Math.abs((await widths()).list - initial.list)).toBeLessThanOrEqual(1);
  const beforeListDrag = await widths();
  await drag('调整邮件列表宽度',80);
  await expect.poll(async () => (await widths()).list - beforeListDrag.list).toBeGreaterThan(60);
  expect((await widths()).reader).toBeLessThan(beforeListDrag.reader - 50);
  await expect.poll(() => frame.locator('.resize-copy').evaluate(element => getComputedStyle(element).fontSize)).toBe('20px');
  await expect.poll(() => page.locator('iframe[title="邮件正文"]').evaluate((iframe: HTMLIFrameElement) => iframe.clientHeight)).toBeGreaterThan(originalBodyHeight + 100);
  await expect.poll(async () => Math.abs(
    await page.locator('iframe[title="邮件正文"]').evaluate((iframe: HTMLIFrameElement) => iframe.clientHeight) -
    await frame.locator('.mailnest-document-root').evaluate(element => Math.ceil(element.getBoundingClientRect().height)),
  )).toBeLessThanOrEqual(2);
  expect(await frame.locator('html').evaluate(() => (window as any).__mountSentinel)).toBe('same-mail-document');
  expect(await page.evaluate(() => (window as any).__resizeFrameLoads)).toBe(0);
  expect(resizeImageRequests).toBe(requestsBeforeResize);
  await page.getByRole('button',{name:'返回邮件列表',exact:true}).click();
  await expect(page.locator('.message-heading')).toHaveCount(0);
  expect(Math.abs((await widths()).list - beforeListDrag.list - 80)).toBeLessThanOrEqual(1);
  const saved = await widths();
  await page.reload();
  await expect(separators).toHaveCount(2);
  await expect.poll(async () => Math.abs((await widths()).sidebar - saved.sidebar)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs((await widths()).list - saved.list)).toBeLessThanOrEqual(1);
  await sidebarDivider.focus();
  await sidebarDivider.press('ArrowRight');
  await expect.poll(async () => (await widths()).sidebar).toBeGreaterThan(saved.sidebar + 5);
  const beforeKeyboardList = await widths();
  await listDivider.focus();
  await listDivider.press('Shift+ArrowLeft');
  await expect.poll(async () => (await widths()).list).toBeLessThan(beforeKeyboardList.list - 20);
  await sidebarDivider.dblclick();
  await listDivider.dblclick();
  await expect.poll(async () => Math.abs((await widths()).sidebar - initial.sidebar)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs((await widths()).list - initial.list)).toBeLessThanOrEqual(1);
  await drag('调整邮箱导航宽度',1200);
  await drag('调整邮件列表宽度',1200);
  expect((await widths()).reader).toBeGreaterThanOrEqual(319);
  await noHorizontalOverflow(page);
  await page.setViewportSize({width:1152,height:720});
  await expect(separators).toHaveCount(2);
  await expect.poll(async () => (await widths()).reader).toBeGreaterThanOrEqual(319);
  await noHorizontalOverflow(page);
  await page.setViewportSize({width:900,height:800});
  await expect(separators).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.setViewportSize({width:393,height:851});
  await expect(separators).toHaveCount(0);
  await noHorizontalOverflow(page);
});

test('HTML mail preserves styled cards, responsive typography, buttons, table layout and poster proportions', async ({ page }) => {
  const message = mailboxMessages(1)[0];
  message.subject = '带原始样式的邮件';
  const poster = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAQCAIAAAC+1EmkAAAAEUlEQVR4nGPInLYUjhiGPgcAnEZpAZhz838AAAAASUVORK5CYII=';
  message.html = `<!doctype html><html><head><style>
    @import url("https://css-should-not-load.invalid/remote.css");
    body { margin:0; background:#f8fafc; font-family:Arial,sans-serif; }
    .mail-card { width:600px; max-width:100%; padding:24px; box-sizing:border-box; }
    .mail-heading { line-height:32px; }
    @media (max-width:600px) { .mail-card { padding:12px; } .mail-heading { font-size:20px !important; line-height:28px; } }
    .mailnest-document-root,[data-mailnest-mail-host] { display:none !important; height:200000px !important; }
    :host { display:none !important; }
    </style></head><body><div data-test-card class="mail-card" style="background-color:#ffffff;border:1px solid #dadce0;border-radius:12px;">
    <h2 class="mail-heading" style="font-size:24px;color:#202124;">账户安全提醒</h2>
    <p style="font-size:18px;color:#188038;">原始邮件的颜色、卡片和按钮应保留。</p>
    <a href="https://example.test/security" onclick="parent.window.__mailExecuted=true" style="display:inline-block;background-color:#1a73e8;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:16px;">查看账户活动</a>
    <table data-test-table width="100%" cellpadding="8" style="border-collapse:separate;border-spacing:6px;background-color:#e8f0fe;"><tr style="background-color:#f1f3f4;"><td style="font-size:13px;">设备</td><td>合成测试设备</td></tr></table>
    </div><img alt="完整长海报" src="${poster}" style="display:block;width:400px;height:auto;max-width:100%;">
    <a href="javascript:parent.window.__mailExecuted=true" style="background-image:url(javascript:alert(1));">恶意链接</a>
    <img alt="不安全图片" src="javascript:parent.window.__mailExecuted=true" onerror="parent.window.__mailExecuted=true">
    <script>parent.window.__mailExecuted=true</script></body></html>`;
  let importedStyles = 0;
  page.on('request',request => { if (request.url().includes('css-should-not-load.invalid')) importedStyles++; });
  await page.route('https://css-should-not-load.invalid/**',route => route.abort());
  await mockMailbox(page,[message]);
  await page.goto('/');
  const parentBackground = await page.locator('.workspace-header').evaluate(element => getComputedStyle(element).backgroundColor);
  await page.getByRole('button',{name:`打开邮件：${message.subject}`,exact:true}).click();
  const frame = page.frameLocator('iframe[title="邮件正文"]');
  const card = frame.locator('[data-test-card]');
  await expect(card).toBeVisible();
  const readingSurface = await page.getByRole('main',{name:'邮件内容',exact:true}).evaluate(element => getComputedStyle(element).backgroundColor);
  expect(readingSurface).not.toBe('rgba(0, 0, 0, 0)');
  expect(await page.locator('iframe[title="邮件正文"]').evaluate(element => getComputedStyle(element).backgroundColor)).toBe(readingSurface);
  expect(await frame.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await frame.locator('[data-mailnest-email-body]').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(248, 250, 252)');
  const cardStyles = await card.evaluate(element => {
    const style = getComputedStyle(element);
    return {background:style.backgroundColor,borderColor:style.borderTopColor,borderWidth:style.borderTopWidth,radius:style.borderTopLeftRadius,padding:style.paddingTop,width:element.getBoundingClientRect().width};
  });
  expect(cardStyles.background).toBe('rgb(255, 255, 255)');
  expect(cardStyles.borderColor).toBe('rgb(218, 220, 224)');
  expect(cardStyles.borderWidth).toBe('1px');
  expect(cardStyles.radius).toBe('12px');
  expect(cardStyles.width).toBeGreaterThan(200);
  const narrowFrame = await frame.locator('html').evaluate(element => element.clientWidth <= 600);
  expect(cardStyles.padding).toBe(narrowFrame ? '12px' : '24px');
  const heading = frame.getByRole('heading',{name:'账户安全提醒',exact:true});
  expect(await heading.evaluate(element => getComputedStyle(element).fontSize)).toBe(narrowFrame ? '20px' : '24px');
  expect(await frame.getByText('原始邮件的颜色、卡片和按钮应保留。',{exact:true}).evaluate(element => getComputedStyle(element).color)).toBe('rgb(24, 128, 56)');
  const button = frame.getByRole('link',{name:'查看账户活动',exact:true});
  await expect(button).toHaveAttribute('href','https://example.test/security');
  const buttonStyles = await button.evaluate(element => {
    const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
    return {background:style.backgroundColor,color:style.color,radius:style.borderRadius,fontSize:style.fontSize,width:bounds.width,height:bounds.height};
  });
  expect(buttonStyles.background).toBe('rgb(26, 115, 232)');
  expect(buttonStyles.color).toBe('rgb(255, 255, 255)');
  expect(buttonStyles.radius).toBe('6px');
  expect(buttonStyles.fontSize).toBe('16px');
  expect(buttonStyles.width).toBeGreaterThan(100);
  expect(buttonStyles.height).toBeGreaterThan(40);
  expect(await frame.locator('[data-test-table]').evaluate(element => getComputedStyle(element).borderSpacing)).toBe('6px');
  expect(await frame.locator('[data-test-table] tr').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(241, 243, 244)');
  const image = frame.getByRole('img',{name:'完整长海报',exact:true});
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(4);
  const imageBounds = (await image.boundingBox())!;
  expect(imageBounds.height).toBeGreaterThan(640);
  expect(Math.abs(imageBounds.height / imageBounds.width - 4)).toBeLessThan(0.02);
  await expect.poll(async () => Math.abs(
    await page.locator('iframe[title="邮件正文"]').evaluate((iframe: HTMLIFrameElement) => iframe.clientHeight) -
    await frame.locator('.mailnest-document-root').evaluate(element => Math.ceil(element.getBoundingClientRect().height)),
  )).toBeLessThanOrEqual(2);
  expect(await page.locator('iframe[title="邮件正文"]').evaluate((iframe: HTMLIFrameElement) => iframe.clientHeight)).toBeLessThan(10000);
  expect(await page.locator('.workspace-header').evaluate(element => getComputedStyle(element).backgroundColor)).toBe(parentBackground);
  await expect(frame.locator('script[data-mailnest-measure]')).toHaveCount(1);
  await expect(frame.locator('script:not([data-mailnest-measure])')).toHaveCount(0);
  await expect(frame.locator('[onerror],[onclick],[onload]')).toHaveCount(0);
  await expect(frame.getByText('恶意链接',{exact:true})).not.toHaveAttribute('href');
  await expect(frame.getByRole('img',{name:'不安全图片',exact:true})).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__mailExecuted)).toBeUndefined();
  expect(importedStyles).toBe(0);
  await noHorizontalOverflow(page);
});

test('install entry remains available without a browser prompt and explains HTTP limitations', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window,'isSecureContext',{value:false,configurable:true}));
  await mockMailbox(page);
  await page.goto('/');
  const install = await headerUtility(page,'安装应用');
  await expect(install).toBeVisible();
  await expect(install).toBeEnabled();
  await (await headerUtility(page,'安装应用')).click();
  const guide = page.getByRole('dialog',{name:'安装邮屿',exact:true});
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('当前地址使用 HTTP');
  await expect(guide).toContainText('请使用 HTTPS 地址');
  await expect(guide).toContainText('浏览器菜单');
  await noHorizontalOverflow(page);
  await guide.getByRole('button',{name:'知道了',exact:true}).click();
  await expect(guide).toHaveCount(0);
  await (await headerUtility(page,'安装应用')).click();
  await expect(guide).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
  await expect(await headerUtility(page,'安装应用')).toBeEnabled();
});

test('native install handles dismissal, prompt errors, acceptance and installed state', async ({ page }) => {
  await mockMailbox(page);
  await page.goto('/');
  const install = await headerUtility(page,'安装应用');
  const guide = page.getByRole('dialog',{name:'安装邮屿',exact:true});
  await expect(install).toBeVisible();
  await install.click();
  await expect(guide).toContainText('浏览器暂未提供一键安装');
  await guide.getByRole('button',{name:'知道了',exact:true}).click();
  const dispatchPrompt = async (outcome: 'dismissed' | 'error' | 'deferred') => {
    expect(await page.evaluate(outcome => {
      const target = window as any;
      target.__installPromptCalls ??= 0;
      const event = new Event('beforeinstallprompt',{cancelable:true});
      Object.assign(event,{
        prompt:async () => {target.__installPromptCalls++; if (outcome === 'error') throw new Error('fixture prompt error');},
        userChoice:outcome === 'deferred'
          ? new Promise(resolve => {target.__finishInstallChoice = () => resolve({outcome:'accepted'});})
          : Promise.resolve({outcome:'dismissed'}),
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    },outcome)).toBe(true);
  };
  await dispatchPrompt('dismissed');
  await (await headerUtility(page,'安装应用')).click();
  await expect(guide).toContainText('已取消安装');
  expect(await page.evaluate(() => (window as any).__installPromptCalls)).toBe(1);
  await guide.getByRole('button',{name:'知道了',exact:true}).click();
  await expect(await headerUtility(page,'安装应用')).toBeEnabled();
  await dispatchPrompt('error');
  await (await headerUtility(page,'安装应用')).click();
  await expect(guide).toContainText('未能打开安装窗口');
  expect(await page.evaluate(() => (window as any).__installPromptCalls)).toBe(2);
  await guide.getByRole('button',{name:'知道了',exact:true}).click();
  await expect(await headerUtility(page,'安装应用')).toBeEnabled();
  await dispatchPrompt('deferred');
  await (await headerUtility(page,'安装应用')).click();
  await expect(await headerUtility(page,'安装中…')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__installPromptCalls)).toBe(3);
  await page.evaluate(() => (window as any).__finishInstallChoice());
  await expect(guide).toContainText('已确认安装');
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(guide).toHaveCount(0);
  const installed = page.locator('button[aria-label="已安装"]');
  await expect(await headerUtility(page,'已安装')).toBeVisible();
  for (const button of await installed.all()) await expect(button).toBeDisabled();
  await noHorizontalOverflow(page);
});

test('production PWA serves an offline shell without caching private APIs', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByLabel('登录邮箱')).toBeVisible();
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((icon: {sizes:string}) => icon.sizes)).toEqual(expect.arrayContaining(['192x192','512x512']));
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForFunction(async () => {
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      if ((await cache.keys()).some(request => new URL(request.url).pathname.startsWith('/assets/'))) return true;
    }
    return false;
  });
  const cachedPaths = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) urls.push(new URL(request.url).pathname);
    return urls;
  });
  expect(cachedPaths.some(path => path.startsWith('/api/'))).toBe(false);
  // Test the first installation, before a second controlled online navigation.
  const session = await context.newCDPSession(page);
  await session.send('Network.clearBrowserCache');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('无法连接服务器');
  await noHorizontalOverflow(page);
  await context.setOffline(false);
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.getByLabel('登录邮箱')).toBeVisible();
});
