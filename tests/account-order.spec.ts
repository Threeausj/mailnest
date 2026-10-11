import { test, expect, type Page } from '@playwright/test';

async function mockAccounts(page: Page) {
  const initial = ['QQ', 'SIAT', 'SUAT', 'SZU'].map((name, index) => ({
    id: `ordered-${name}`, name, email: `${name.toLowerCase()}@example.test`, color: '#377a75', provider: 'imap', username: `${name.toLowerCase()}@example.test`,
    imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true },
    status: 'connected', lastSyncedAt: new Date().toISOString(), error: null, unread: index === 0 ? 3 : 0,
  }));
  const state = { accounts: initial, patches: [] as string[][], failSave: true };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.slice('/api/v1'.length);
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/me') return json({ user: { id: 'account-order-user', name: '测试用户', email: 'ordering@example.test' } });
    if (path === '/config') return json({ googleConfigured: false, pushPublicKey: null, pollingInterval: 3600 });
    if (path === '/accounts') return json({ accounts: state.accounts });
    if (path === '/messages') return json({ messages: [], total: 0, page: 1, pageSize: 30 });
    if (path === '/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
    if (path === '/accounts/order' && route.request().method() === 'PATCH') {
      const { accountIds } = route.request().postDataJSON();
      state.patches.push(accountIds);
      if (state.failSave) return json({ error: { code: 'ORDER_NOT_SAVED', message: '测试排序保存失败，请重试。' } }, 503);
      state.accounts = accountIds.map((id: string) => state.accounts.find(account => account.id === id)!);
      return json({ accounts: state.accounts });
    }
    return json({ error: { code: 'NOT_FOUND', message: `Unhandled order fixture ${path}` } }, 404);
  });
  return state;
}

async function showNavigation(page: Page) {
  await expect(page.getByRole('toolbar', { name: '邮件操作', exact: true })).toBeVisible();
  const sidebar = page.getByRole('complementary', { name: '邮箱导航', exact: true });
  const open = page.getByRole('button', { name: '打开导航菜单', exact: true });
  if (await open.isVisible() && !await sidebar.evaluate(element => element.classList.contains('open'))) await open.click();
  return sidebar;
}

async function openSettings(page: Page) {
  const button = page.getByRole('button', { name: '邮件提醒设置', exact: true });
  if (await button.isVisible()) await button.click();
  else {
    await page.getByRole('button', { name: '更多邮件操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '邮件提醒设置', exact: true }).click();
  }
  return page.getByRole('dialog', { name: '设置', exact: true });
}

test('account order can be retried without losing edits and is reused by the sidebar after reload', async ({ page }) => {
  const state = await mockAccounts(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('toolbar', { name: '邮件操作', exact: true })).toBeVisible();
  const sidebar = await showNavigation(page);
  await sidebar.getByRole('button', { name: '展开 SIAT文件夹', exact: true }).click();
  await sidebar.getByRole('navigation', { name: 'SIAT文件夹', exact: true }).getByRole('button', { name: '收件箱', exact: true }).click();
  const settings = await openSettings(page);
  const names = settings.locator('.account-card-main strong');
  await expect(names).toHaveText(['QQ', 'SIAT', 'SUAT', 'SZU']);
  await expect(settings.getByRole('button', { name: '上移 QQ', exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: '下移 SZU', exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: '下移 QQ', exact: true }).click();
  await settings.getByRole('button', { name: '上移 SZU', exact: true }).click();
  const expectedNames = ['SIAT', 'QQ', 'SZU', 'SUAT'];
  const expectedIds = expectedNames.map(name => `ordered-${name}`);
  await expect(names).toHaveText(expectedNames);
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await settings.getByRole('button', { name: '保存排序', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('测试排序保存失败，请重试。');
  await expect(names).toHaveText(expectedNames);
  await expect(settings.getByRole('button', { name: '保存排序', exact: true })).toBeEnabled();
  expect(state.accounts.map(account => account.name)).toEqual(['QQ', 'SIAT', 'SUAT', 'SZU']);
  state.failSave = false;
  await settings.getByRole('button', { name: '保存排序', exact: true }).click();
  await expect(settings.getByRole('button', { name: '保存排序', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('alert')).toHaveCount(0);
  expect(state.patches).toEqual([expectedIds, expectedIds]);
  await expect(names).toHaveText(expectedNames);
  await settings.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const reorderedSidebar = await showNavigation(page);
  await expect(reorderedSidebar.locator('.mailbox-folder-group:not(.unified-folder-group) .mailbox-group-heading > span')).toHaveText(expectedNames);
  await expect(reorderedSidebar.getByRole('navigation', { name: 'SIAT文件夹', exact: true }).getByRole('button', { name: '收件箱', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.reload();
  const loadedSidebar = await showNavigation(page);
  await expect(loadedSidebar.locator('.mailbox-folder-group:not(.unified-folder-group) .mailbox-group-heading > span')).toHaveText(expectedNames);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('collapsed account groups use compact spacing with usable touch headings', async ({ page }) => {
  await mockAccounts(page);
  await page.goto('/');
  const sidebar = await showNavigation(page);
  await sidebar.getByRole('button', { name: '收起 所有邮箱文件夹', exact: true }).click();
  const headings = sidebar.locator('.mailbox-folder-group:not(.unified-folder-group) .mailbox-group-heading');
  await expect(headings).toHaveCount(4);
  const boxes = await headings.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  }));
  for (let index = 1; index < boxes.length; index++) {
    expect(boxes[index].top - boxes[index - 1].top).toBeLessThanOrEqual(44.5);
    expect(boxes[index].top - boxes[index - 1].top - boxes[index - 1].height).toBeLessThanOrEqual(4.5);
  }
  if (test.info().project.name !== 'desktop') expect(boxes[0].height).toBeGreaterThanOrEqual(40);
});
