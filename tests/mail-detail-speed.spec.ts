import { test, expect, type Page } from '@playwright/test';
import type { Account, Message } from '../web/src/types';

test.use({ serviceWorkers: 'block' });

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function mailbox(page: Page) {
  const account: Account = {
    id: 'speed-account', name: '测试邮箱', email: 'me@example.test', color: '#2563eb', provider: 'imap', username: 'me@example.test',
    imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true },
    status: 'connected', lastSyncedAt: '2026-10-13T08:00:00.000Z', error: null, unread: 1,
  };
  const first: Message = {
    id: 'speed-one', accountId: account.id, folder: 'INBOX', from: { name: '项目团队', address: 'team@example.test' },
    to: [{ name: '', address: account.email }], cc: [], subject: '未读邮件', preview: '收到后立即阅读',
    date: '2026-10-13T08:00:00.000Z', unread: true, starred: false, hasAttachments: false,
    text: '第一封正文已经可读', html: '<p>第一封正文已经可读</p><img src="cid:speed-picture" alt="正文图片">',
    messageId: '<speed-one@example.test>', attachments: [{ id: 'speed-picture', filename: 'image.png', contentId: 'speed-picture', inline: true, contentType: 'image/png', size: 68 }],
  };
  const second: Message = { ...first, id: 'speed-two', subject: '另一封邮件', text: '第二封正文', html: null, unread: false, attachments: [], messageId: '<speed-two@example.test>' };
  const messages = [first, second];
  const state = { details: [] as string[], reads: [] as string[], attachments: 0, errors: [] as string[], readStatus: 200 };
  const read = { requested: deferred(), complete: deferred(), fulfilled: deferred() };
  let heldDetail: { id: string; requested: ReturnType<typeof deferred>; complete: ReturnType<typeof deferred> } | null = null;
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => {
    const sources = new Set<EventTarget>();
    class Source extends EventTarget { constructor(_url: string) { super(); sources.add(this); } close() { sources.delete(this); } }
    Object.defineProperty(window, 'EventSource', { value: Source, configurable: true });
    (window as any).__speedEvent = (data: unknown) => { for (const source of sources) source.dispatchEvent(new MessageEvent('change', { data: JSON.stringify(data) })); };
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return respond({ user: { id: 'speed-user', email: account.email, name: '测试用户' } });
    if (path === '/config') return respond({ googleConfigured: false, pushPublicKey: null, pollingInterval: 3600 });
    if (path === '/accounts') return respond({ accounts: [account] });
    if (path === '/messages') return respond({ messages, total: messages.length });
    if (path.endsWith('/attachments/speed-picture')) {
      state.attachments++;
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
    }
    const message = messages.find(item => path === `/messages/${item.id}`);
    if (message && request.method() === 'GET') {
      state.details.push(message.id);
      const snapshot = JSON.parse(JSON.stringify(message));
      if (heldDetail?.id === message.id) { const held = heldDetail; heldDetail = null; held.requested.release(); await held.complete.promise; }
      return respond({ message: snapshot });
    }
    if (message && request.method() === 'PATCH') {
      state.reads.push(message.id); read.requested.release(); await read.complete.promise;
      if (state.readStatus === 200) { Object.assign(message, request.postDataJSON()); account.unread = 0; }
      await respond(state.readStatus === 200 ? { message } : { error: { code: 'MAIL_OPERATION_FAILED', message: '远端暂时无法标记已读' } }, state.readStatus);
      read.fulfilled.release(); return;
    }
    return respond({ error: { code: 'NOT_FOUND', message: `Unhandled ${path}` } }, 404);
  });
  return {
    state, messages, read,
    holdDetail(id: string) { heldDetail = { id, requested: deferred(), complete: deferred() }; return heldDetail; },
    async remote(summary: Partial<Message>) { await page.evaluate(summary => (window as any).__speedEvent({ action: 'message-updated', accountId: 'speed-account', messageId: summary.id, message: summary, unreadCount: 0 }), summary); },
  };
}

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开邮件：未读邮件', exact: true })).toBeVisible();
}
async function backToList(page: Page) {
  await page.getByRole('toolbar', { name: '邮件操作', exact: true }).getByRole('button', { name: '返回邮件列表', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开邮件：另一封邮件', exact: true })).toBeVisible();
}

test('an unread body and its inline image render while marking read is still pending', async ({ page }) => {
  const fixture = await mailbox(page); await ready(page);
  await page.getByRole('button', { name: '打开邮件：未读邮件', exact: true }).click(); await fixture.read.requested.promise;
  await expect(page.frameLocator('iframe[title="邮件正文"]').getByText('第一封正文已经可读', { exact: true })).toBeVisible();
  await expect(page.locator('.reader-loading')).toHaveCount(0);
  await expect.poll(() => fixture.state.attachments).toBe(1);
  await expect(page.frameLocator('iframe[title="邮件正文"]').getByRole('img', { name: '正文图片' })).toBeVisible();
  fixture.read.complete.release(); await fixture.read.fulfilled.promise;
  await expect(page.locator('[data-message-id="speed-one"]')).not.toHaveClass(/unread/);
  await expect(page.frameLocator('iframe[title="邮件正文"]').getByText('第一封正文已经可读', { exact: true })).toBeVisible();
  expect(fixture.state.details).toEqual(['speed-one']); expect(fixture.state.reads).toEqual(['speed-one']); expect(fixture.state.errors).toEqual([]);
});

test('a failed read update leaves the successful body visible and reports a recoverable warning', async ({ page }) => {
  const fixture = await mailbox(page); fixture.state.readStatus = 503; await ready(page);
  await page.getByRole('button', { name: '打开邮件：未读邮件', exact: true }).click(); await fixture.read.requested.promise;
  await expect(page.frameLocator('iframe[title="邮件正文"]').getByText('第一封正文已经可读', { exact: true })).toBeVisible();
  fixture.read.complete.release(); await fixture.read.fulfilled.promise;
  await expect(page.locator('.toast')).toContainText('邮件已打开，但标记已读失败：远端暂时无法标记已读');
  await expect(page.locator('.reader-loading')).toHaveCount(0);
  await expect(page.frameLocator('iframe[title="邮件正文"]').getByText('第一封正文已经可读', { exact: true })).toBeVisible();
  expect(fixture.state.details).toEqual(['speed-one']); expect(fixture.state.errors).toEqual([]);
});

test('switching away ignores late read results and preserves newer remote metadata during a body request', async ({ page }) => {
  const fixture = await mailbox(page); await ready(page);
  await page.getByRole('button', { name: '打开邮件：未读邮件', exact: true }).click(); await fixture.read.requested.promise;
  await expect(page.frameLocator('iframe[title="邮件正文"]').getByText('第一封正文已经可读', { exact: true })).toBeVisible();
  await backToList(page);
  const pending = fixture.holdDetail('speed-two');
  await page.getByRole('button', { name: '打开邮件：另一封邮件', exact: true }).click(); await pending.requested.promise;
  fixture.messages[1].starred = true;
  const { text, html, attachments, messageId, ...summary } = fixture.messages[1];
  await fixture.remote(summary);
  fixture.state.readStatus = 503; fixture.read.complete.release(); await fixture.read.fulfilled.promise;
  pending.complete.release();
  await expect(page.getByRole('heading', { name: '另一封邮件', exact: true })).toBeVisible();
  await expect(page.locator('.message-body > pre')).toHaveText('第二封正文');
  await expect(page.locator('.message-metadata').getByRole('button', { name: '取消星标', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(fixture.state.details).toEqual(['speed-one', 'speed-two']); expect(fixture.state.reads).toEqual(['speed-one']); expect(fixture.state.errors).toEqual([]);
});
