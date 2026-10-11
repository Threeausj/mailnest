import { test, expect, type Page } from '@playwright/test';

async function mockReminders(page: Page) {
  await page.addInitScript(() => {
    const state = { permission: 'granted', subscribed: true, permissionRequests: 0, newSubscriptions: 0, hidden: false };
    const subscription = {
      endpoint: 'https://push.example.test/lockscreen-fixture',
      toJSON: () => ({ keys: { p256dh: 'fixture-key', auth: 'fixture-auth' } }),
      unsubscribe: async () => { state.subscribed = false; return true; },
    };
    const registration = Object.assign(new EventTarget(), {
      active: { postMessage() {} }, waiting: null, installing: null,
      update: async () => registration,
      pushManager: {
        getSubscription: async () => state.subscribed ? subscription : null,
        subscribe: async () => { state.newSubscriptions++; return subscription; },
      },
    });
    Object.defineProperty(window, 'Notification', { configurable: true, value: {
      get permission() { return state.permission; },
      requestPermission: async () => { state.permissionRequests++; return state.permission; },
    } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: Object.assign(new EventTarget(), {
      controller: registration.active, ready: Promise.resolve(registration),
      getRegistration: async () => registration, register: async () => registration,
    }) });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.hidden });
    (window as any).__lockscreenFixture = state;
  });
  const requests = { registrations: 0, tests: 0, registrationFails: false };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.slice('/api/v1'.length);
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/me') return json({ user: { id: 'lockscreen-user', name: '测试用户', email: 'lockscreen@example.test' } });
    if (path === '/config') return json({ googleConfigured: false, pushPublicKey: 'AQID', pollingInterval: 3600 });
    if (path === '/accounts') return json({ accounts: [] });
    if (path === '/messages') return json({ messages: [], total: 0, page: 1, pageSize: 30 });
    if (path === '/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
    if (path === '/push/subscriptions') {
      requests.registrations++;
      return requests.registrationFails
        ? json({ error: { code: 'PUSH_UNAVAILABLE', message: '测试订阅恢复失败，请重试。' } }, 503)
        : json({ ok: true });
    }
    if (path === '/push/test') { requests.tests++; return json({ ok: true, accepted: true }); }
    return json({ error: { code: 'NOT_FOUND', message: `Unhandled lockscreen fixture ${path}` } }, 404);
  });
  return requests;
}

async function openReminders(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('toolbar', { name: '邮件操作', exact: true })).toBeVisible();
  const reminder = page.getByRole('button', { name: '邮件提醒设置', exact: true });
  if (await reminder.isVisible()) await reminder.click();
  else {
    await page.getByRole('button', { name: '更多邮件操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '邮件提醒设置', exact: true }).click();
  }
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('tab', { name: '应用与提醒', exact: true }).click();
  return settings;
}

test('returning from device settings updates reminder permission and restores only the existing subscription', async ({ page }) => {
  const requests = await mockReminders(page);
  const settings = await openReminders(page);
  await expect(settings.getByRole('button', { name: '关闭后台提醒', exact: true })).toBeEnabled();
  await expect(settings.getByText(/无需一直打开页面/)).toBeVisible();
  const guide = settings.locator('details').filter({ hasText: '锁屏提醒设置' });
  await expect(guide).not.toHaveAttribute('open', '');
  await guide.locator('summary').click();
  await expect(guide).toContainText('16.4 及以上');
  await expect(guide).toContainText('添加到主屏幕');
  await expect(guide).toContainText('不限制');
  await expect(guide).toContainText('强行停止');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  await page.evaluate(() => { (window as any).__lockscreenFixture.permission = 'denied'; window.dispatchEvent(new Event('focus')); });
  await expect(settings.getByRole('button', { name: '开启提醒', exact: true })).toBeEnabled();
  await expect(settings.getByText('浏览器已阻止通知，请在网站设置中修改通知权限。', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '发送测试通知', exact: true })).toBeDisabled();

  await page.evaluate(() => {
    Object.assign((window as any).__lockscreenFixture, { permission: 'granted', subscribed: false, hidden: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(settings.getByText('已允许浏览器通知，可继续开启后台提醒。', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '发送测试通知', exact: true })).toBeDisabled();

  await page.evaluate(() => { (window as any).__lockscreenFixture.subscribed = true; window.dispatchEvent(new Event('online')); });
  await expect(settings.getByRole('button', { name: '关闭后台提醒', exact: true })).toBeEnabled();
  await expect(settings.getByText('浏览器已阻止通知，请在网站设置中修改通知权限。', { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('推送服务已接受测试通知');
  expect(requests.tests).toBe(1);
  expect(await page.evaluate(() => {
    const state = (window as any).__lockscreenFixture;
    return { permissionRequests: state.permissionRequests, newSubscriptions: state.newSubscriptions };
  })).toEqual({ permissionRequests: 0, newSubscriptions: 0 });
});

test('a failed foreground subscription check stops advertising active background reminders', async ({ page }) => {
  const requests = await mockReminders(page);
  const settings = await openReminders(page);
  await expect(settings.getByRole('button', { name: '关闭后台提醒', exact: true })).toBeEnabled();
  requests.registrationFails = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(settings.getByRole('alert')).toContainText('测试订阅恢复失败，请重试。');
  await expect(settings.getByRole('button', { name: '开启提醒', exact: true })).toBeEnabled();
  await expect(settings.getByRole('button', { name: '发送测试通知', exact: true })).toBeDisabled();
  expect(requests.tests).toBe(0);
  expect(await page.evaluate(() => (window as any).__lockscreenFixture.permissionRequests)).toBe(0);
});
