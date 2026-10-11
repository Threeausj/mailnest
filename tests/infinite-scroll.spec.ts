import { test, expect, type Page } from '@playwright/test';
import type { Account, Message } from '../web/src/types';

function mail(index: number): Message {
  return {
    id: `scroll-${index}`, accountId: index % 2 ? 'scroll-a' : 'scroll-b', folder: 'INBOX',
    from: { name: `发件人 ${index}`, address: 'sender@example.test' }, to: [{ name: '', address: 'me@example.test' }], cc: [],
    subject: `${index >= 90 ? '筛选 ' : ''}邮件 ${index}`, preview: `第 ${index} 封邮件的摘要`,
    date: new Date(Date.UTC(2026, 9, 12, 12) - index * 60_000).toISOString(), unread: false, starred: false, hasAttachments: false,
    text: `正文 ${index}`, html: `<p>正文 ${index}</p>`, attachments: [], messageId: `<scroll-${index}@example.test>`,
  };
}

async function mailbox(page: Page, count = 95) {
  const state = { messages: Array.from({ length: count }, (_, index) => mail(index)), calls: [] as { page: number; query: string; folder: string; accountId: string; filter: string }[], detailCalls: [] as string[], failNextPage: 0 };
  let held: { page: number; requested: Promise<void>; announce: () => void; release: () => void; wait: Promise<void> } | null = null;
  let detailHeld: { id: string; announce: () => void; wait: Promise<void> } | null = null;
  await page.addInitScript(() => {
    const sources = new Set<EventTarget>();
    class Source extends EventTarget {
      constructor(_url: string) { super(); sources.add(this); }
      close() { sources.delete(this); }
    }
    Object.defineProperty(window, 'EventSource', { value: Source, configurable: true });
    (window as any).__emitScrollEvent = (type: string, data: unknown) => {
      for (const source of sources) source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    };
  });
  const accounts: Account[] = ['a', 'b'].map(id => ({
    id: `scroll-${id}`, name: `邮箱 ${id}`, email: `${id}@example.test`, color: '#2563eb', provider: 'imap', username: `${id}@example.test`,
    imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true },
    status: 'connected', lastSyncedAt: new Date().toISOString(), error: null, unread: 0,
  }));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length);
    const respond = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/me') return respond({ user: { id: 'scroll-user', email: 'me@example.test', name: '测试用户' } });
    if (path === '/config') return respond({ googleConfigured: false, pushPublicKey: null, pollingInterval: 3600 });
    if (path === '/accounts') return respond({ accounts });
    if (path === '/messages') {
      const entry = { page: Number(url.searchParams.get('page')), query: url.searchParams.get('q') || '', folder: url.searchParams.get('folder') || '', accountId: url.searchParams.get('accountId') || '', filter: url.searchParams.get('filter') || '' };
      state.calls.push(entry);
      if (state.failNextPage === entry.page) { state.failNextPage = 0; return respond({ error: { message: '加载暂时失败', code: 'UNAVAILABLE' } }, 503); }
      const filtered = state.messages.filter(item => item.folder === entry.folder && (!entry.accountId || item.accountId === entry.accountId) && (!entry.query || item.subject.includes(entry.query)) && (entry.filter !== 'starred' || item.starred) && (entry.filter !== 'unread' || item.unread));
      const response = { messages: filtered.slice((entry.page - 1) * 30, entry.page * 30), total: filtered.length };
      if (held?.page === entry.page) { const current = held; held = null; current.announce(); await current.wait; }
      return respond(response);
    }
    const message = state.messages.find(item => path === `/messages/${item.id}`);
    if (message && request.method() === 'GET') {
      state.detailCalls.push(message.id);
      const snapshot = JSON.parse(JSON.stringify(message));
      if (detailHeld?.id === message.id) { const current = detailHeld; detailHeld = null; current.announce(); await current.wait; }
      return respond({ message: snapshot });
    }
    if (message && request.method() === 'PATCH') { Object.assign(message, request.postDataJSON()); return respond({ message }); }
    return respond({ error: { message: `Unhandled ${path}`, code: 'NOT_FOUND' } }, 404);
  });
  return {
    state,
    hold(pageNumber: number) {
      let announce!: () => void, release!: () => void;
      const requested = new Promise<void>(resolve => { announce = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
      held = { page: pageNumber, requested, announce, release, wait };
      return { requested, release };
    },
    holdDetail(id: string) {
      let announce!: () => void, release!: () => void;
      const requested = new Promise<void>(resolve => { announce = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
      detailHeld = { id, announce, wait };
      return { requested, release };
    },
    async emit(type: string, data: unknown = {}) { await page.evaluate(({ type, data }) => (window as any).__emitScrollEvent(type, data), { type, data }); },
  };
}

async function bottom(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector<HTMLDivElement>(document.querySelector('.mail-app.panes-desktop') ? '.message-list-scroll' : '.workspace-scroll')!;
    root.scrollTop = root.scrollHeight; root.dispatchEvent(new Event('scroll'));
  });
}
const rows = (page: Page) => page.locator('.message-row');
async function ready(page: Page) { await page.goto('/'); await expect(rows(page)).toHaveCount(30); }
async function noDuplicates(page: Page) {
  const ids = await rows(page).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.messageId));
  expect(new Set(ids).size).toBe(ids.length);
}

test('scrolling appends all pages once and replaces pagination with compact progress', async ({ page }) => {
  const fixture = await mailbox(page);
  await ready(page);
  await expect(page.getByRole('button', { name: /上一页|下一页/ })).toHaveCount(0);
  for (const count of [60, 90, 95]) { await bottom(page); await expect(rows(page)).toHaveCount(count); }
  await expect(page.locator('.list-pagination')).toHaveText('已加载 95 / 共 95 封');
  await expect(page.locator('.list-load-more')).toHaveText('已显示全部邮件');
  await bottom(page);
  await noDuplicates(page);
  expect(fixture.state.calls.filter(call => call.page > 1).map(call => call.page)).toEqual([2, 3, 4]);
  expect(await rows(page).first().getAttribute('data-message-id')).toBe('scroll-0');
  expect(await rows(page).last().getAttribute('data-message-id')).toBe('scroll-94');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('load failures keep existing mail, retry the same page, and ignore a pending append after search changes', async ({ page }) => {
  const fixture = await mailbox(page); fixture.state.failNextPage = 2;
  await ready(page); await bottom(page);
  await expect(page.getByRole('button', { name: '重试加载' })).toBeVisible();
  await expect(rows(page)).toHaveCount(30);
  await bottom(page); await bottom(page);
  expect(fixture.state.calls.filter(call => call.page === 2)).toHaveLength(1);
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(rows(page)).toHaveCount(60);
  const pending = fixture.hold(3); await bottom(page); await pending.requested;
  await expect(page.locator('.list-load-more')).toContainText('正在加载更多邮件');
  await page.getByRole('textbox', { name: '搜索邮件' }).fill('筛选');
  await expect(rows(page)).toHaveCount(5);
  pending.release();
  await expect(page.locator('.list-pagination')).toHaveText('已加载 5 / 共 5 封');
  await expect(rows(page).first()).toHaveAttribute('data-message-id', 'scroll-90');
  await noDuplicates(page);
});

test('background events retain loaded ranges and scroll anchors while remote metadata keeps the reader intact', async ({ page }) => {
  const fixture = await mailbox(page);
  await ready(page); await bottom(page); await expect(rows(page)).toHaveCount(60);
  await page.locator('[data-message-id="scroll-40"] .message-row-main').scrollIntoViewIfNeeded();
  const anchor = await page.locator('[data-message-id="scroll-40"]').boundingBox();
  fixture.state.messages.unshift({ ...mail(100), id: 'new-mail', subject: '新来邮件' });
  await fixture.emit('mail', { accountId: 'scroll-a', count: 1, notificationId: 'scroll-new', unreadCount: 1 });
  await expect(rows(page).first()).toHaveAttribute('data-message-id', 'new-mail');
  await expect(rows(page)).toHaveCount(90);
  const after = await page.locator('[data-message-id="scroll-40"]').boundingBox();
  expect(Math.abs(after!.y - anchor!.y)).toBeLessThan(3);
  await page.locator('[data-message-id="scroll-40"] .message-row-main').click();
  await expect(page.getByRole('heading', { name: '邮件 40', exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe[title="邮件正文"]').getByText('正文 40', { exact: true })).toBeVisible();
  await page.locator('iframe[title="邮件正文"]').evaluate(frame => { (window as any).__retainedMailFrame = frame; (window as any).__retainedMailDocument = (frame as HTMLIFrameElement).contentWindow; });
  const updated = fixture.state.messages.find(item => item.id === 'scroll-40')!; updated.starred = true;
  const { html, text, attachments, messageId, ...summary } = updated;
  await fixture.emit('change', { accountId: updated.accountId, action: 'message-updated', messageId: updated.id, message: summary, unreadCount: 0 });
  await expect(page.locator('.message-metadata').getByRole('button', { name: '取消星标', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('iframe[title="邮件正文"]').evaluate(frame => frame === (window as any).__retainedMailFrame && (frame as HTMLIFrameElement).contentWindow === (window as any).__retainedMailDocument)).toBe(true);
  updated.starred = false;
  await fixture.emit('ready', { unreadCount: 0 });
  await expect(page.locator('.message-metadata').getByRole('button', { name: '标记星标', exact: true })).toHaveAttribute('aria-pressed', 'false');
  updated.starred = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.message-metadata').getByRole('button', { name: '取消星标', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('iframe[title="邮件正文"]').evaluate(frame => frame === (window as any).__retainedMailFrame && (frame as HTMLIFrameElement).contentWindow === (window as any).__retainedMailDocument)).toBe(true);
  expect(fixture.state.detailCalls).toEqual(['scroll-40']);
  const refreshes = fixture.state.calls.length;
  await expect(rows(page)).toHaveCount(90);
  await noDuplicates(page);
  fixture.state.messages = fixture.state.messages.filter(item => item.id !== updated.id);
  await fixture.emit('change', { accountId: updated.accountId, action: 'message-moved', messageId: updated.id, unreadCount: 0 });
  await expect(page.locator('.message-detail')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(90);
  await expect(page.locator(`[data-message-id="${updated.id}"]`)).toHaveCount(0);
  expect(fixture.state.calls.length).toBeGreaterThan(refreshes);
});

test('sync bursts complete an in-flight refresh and coalesce without flashing or losing the loaded prefix', async ({ page }) => {
  const fixture = await mailbox(page);
  await ready(page); await bottom(page); await expect(rows(page)).toHaveCount(60);
  const initialCalls = fixture.state.calls.length;
  const pending = fixture.hold(1);
  await fixture.emit('sync', { unreadCount: 0 }); await pending.requested;
  for (let index = 0; index < 5; index++) await fixture.emit('sync', { unreadCount: index });
  await expect(rows(page)).toHaveCount(60);
  await expect(page.locator('.list-loading')).toHaveCount(0);
  pending.release();
  await expect.poll(() => fixture.state.calls.length).toBe(initialCalls + 4);
  await expect(rows(page)).toHaveCount(60);
  await noDuplicates(page);
  await page.getByRole('tab', { name: '星标', exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('.list-pagination')).toHaveText('没有邮件');
});

test('account and folder changes reset the loaded range independently', async ({ page }) => {
  const fixture = await mailbox(page);
  fixture.state.messages.push(...Array.from({ length: 35 }, (_, index) => ({ ...mail(index + 200), accountId: 'scroll-a', folder: 'sent' })));
  await ready(page); await bottom(page); await expect(rows(page)).toHaveCount(60);
  const openNavigation = async () => { const button = page.getByRole('button', { name: '打开导航菜单', exact: true }); if (await button.isVisible()) await button.click(); };
  await openNavigation();
  const account = page.getByRole('navigation', { name: '邮箱 a文件夹', exact: true });
  await account.getByRole('button', { name: '展开 邮箱 a文件夹', exact: true }).click();
  await account.getByRole('button', { name: '收件箱', exact: true }).click();
  await expect(rows(page)).toHaveCount(30);
  await expect(page.locator('.list-pagination')).toHaveText('已加载 30 / 共 47 封');
  await expect(rows(page).first()).toHaveAttribute('data-message-id', 'scroll-1');
  await openNavigation();
  await page.getByRole('navigation', { name: '所有邮箱文件夹', exact: true }).getByRole('button', { name: '已发送', exact: true }).click();
  await expect(rows(page)).toHaveCount(30);
  await expect(rows(page).first()).toHaveAttribute('data-message-id', 'scroll-200');
  await bottom(page); await expect(rows(page)).toHaveCount(35);
  await noDuplicates(page);
});

test('batch arrivals extend the refreshed range and overlapping next pages preserve the original tail', async ({ page }) => {
  const fixture = await mailbox(page, 150);
  await ready(page); await bottom(page); await expect(rows(page)).toHaveCount(60);
  await page.locator('[data-message-id="scroll-45"] .message-row-main').scrollIntoViewIfNeeded();
  const anchor = await page.locator('[data-message-id="scroll-45"]').boundingBox();
  fixture.state.messages.unshift(...Array.from({ length: 30 }, (_, index) => ({ ...mail(index + 500), id: `batch-${index}` })));
  await fixture.emit('sync', { unreadCount: 30 });
  await expect(rows(page)).toHaveCount(90);
  await expect(page.locator('[data-message-id="scroll-59"]')).toHaveCount(1);
  const after = await page.locator('[data-message-id="scroll-45"]').boundingBox();
  expect(Math.abs(after!.y - anchor!.y)).toBeLessThan(3);
  await noDuplicates(page);

  // Shift the offsets before the next response, so it overlaps the existing
  // range entirely. Its old total must not hide the growth from the refresh.
  fixture.state.messages.unshift(...Array.from({ length: 60 }, (_, index) => ({ ...mail(index + 600), id: `second-batch-${index}` })));
  const pending = fixture.hold(4);
  await bottom(page); await pending.requested;
  await fixture.emit('mail', { count: 60, unreadCount: 90, notificationId: 'batch-mail' });
  pending.release();
  await expect(rows(page)).toHaveCount(150);
  await expect(page.locator('[data-message-id="scroll-59"]')).toHaveCount(1);
  await noDuplicates(page);
});

test('a remote update received during the body request survives its older response', async ({ page }) => {
  const fixture = await mailbox(page);
  await ready(page);
  const olderList = fixture.hold(1);
  await fixture.emit('sync', { unreadCount: 0 }); await olderList.requested;
  const pending = fixture.holdDetail('scroll-2');
  await page.locator('[data-message-id="scroll-2"] .message-row-main').click(); await pending.requested;
  const updated = fixture.state.messages.find(item => item.id === 'scroll-2')!; updated.starred = true;
  const { html, text, attachments, messageId, ...summary } = updated;
  await fixture.emit('change', { accountId: updated.accountId, action: 'message-updated', messageId: updated.id, message: summary, unreadCount: 0 });
  const freshList = fixture.hold(1);
  olderList.release(); await freshList.requested;
  pending.release();
  await expect(page.locator('.message-metadata').getByRole('button', { name: '取消星标', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.frameLocator('iframe[title="邮件正文"]').getByText('正文 2', { exact: true })).toBeVisible();
  expect(fixture.state.detailCalls).toEqual(['scroll-2']);
  freshList.release();
});
