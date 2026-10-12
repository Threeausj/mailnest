import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Account, Message } from '../web/src/types';

test.use({ serviceWorkers: 'block' });

async function mailbox(page: Page, authenticated = true) {
  const state = { authenticated, details: [] as string[], attachments: [] as string[], errors: [] as string[] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => {
    class Source extends EventTarget { close() {} }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: Source });
  });
  const account: Account = {
    id: 'theme-account', name: '工作邮箱', email: 'me@example.test', provider: 'imap', username: 'me@example.test', color: '#2563eb',
    imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true },
    status: 'connected', error: null, unread: 0, lastSyncedAt: '2026-10-13T08:00:00.000Z',
  };
  const base: Message = {
    id: 'theme-plain-html', accountId: account.id, folder: 'INBOX', from: { name: '项目团队', address: 'team@example.test' },
    to: [{ name: account.name, address: account.email }], cc: [], date: '2026-10-13T08:00:00.000Z', subject: '没有指定配色的邮件',
    preview: '明天下午讨论项目进度。', unread: false, starred: false, hasAttachments: true, text: '明天下午讨论项目进度。',
    html: '<p id="plain-body">明天下午讨论项目进度。</p><img src="cid:theme-picture" alt="项目图标" width="24" height="24">',
    attachments: [{ id: 'theme-picture', filename: 'project.png', contentType: 'image/png', size: 68, contentId: 'theme-picture', inline: true }],
    messageId: '<theme-plain@example.test>',
  };
  const messages: Message[] = [base, {
    ...base, id: 'theme-authored', subject: '作者指定白底的邮件', html: '<body style="background:#ffffff;color:#171717"><p id="author-body">品牌邮件保持原有颜色。</p></body>',
    attachments: [], hasAttachments: false,
  }, {
    ...base, id: 'theme-css-card', subject: '带白色卡片的邮件',
    html: '<style>@media (min-width:1px){@supports (display:block){.author-card{background:#fff}}}</style><div class="author-card"><p id="card-body">只指定背景的卡片也能清晰阅读。</p></div>',
    attachments: [], hasAttachments: false,
  }, {
    ...base, id: 'theme-legacy', subject: '传统格式的邮件', html: '<table bgcolor="#ffffff"><tr><td id="legacy-body">传统白底邮件保持清晰。</td></tr></table>',
    attachments: [], hasAttachments: false,
  }, { ...base, id: 'theme-text', subject: '纯文字邮件', text: '没有 HTML 的纯文字内容。', html: null, attachments: [], hasAttachments: false }];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return state.authenticated ? respond({ user: { id: 'theme-user', name: '测试用户', email: account.email } }) : respond({ error: { code: 'UNAUTHORIZED', message: '请登录' } }, 401);
    if (path === '/config') return respond({ googleConfigured: false, pushPublicKey: null, pollingInterval: 3600 });
    if (path === '/accounts') return respond({ accounts: [account] });
    if (path === '/messages') return respond({ messages, total: messages.length, page: 1, pageSize: 30 });
    if (path.includes('/attachments/')) {
      state.attachments.push(path);
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
    }
    const message = messages.find(item => path === `/messages/${item.id}`);
    if (message && request.method() === 'GET') { state.details.push(message.id); return respond({ message }); }
    if (message && request.method() === 'PATCH') { Object.assign(message, request.postDataJSON()); return respond({ message }); }
    return respond({ error: { code: 'NOT_FOUND', message: '测试接口不存在' } }, 404);
  });
  return state;
}

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开邮件：没有指定配色的邮件', exact: true })).toBeVisible();
}

async function appearance(page: Page) {
  const mobile = page.getByRole('navigation', { name: '快捷导航', exact: true }).getByRole('button', { name: '设置', exact: true });
  if (await mobile.isVisible()) await mobile.click();
  else await page.getByRole('complementary', { name: '邮箱导航', exact: true }).getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('tab', { name: '应用与提醒', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '跟随系统', exact: true })).toBeVisible();
  return dialog;
}

async function theme(page: Page, resolved: 'light' | 'dark', mode: 'light' | 'dark' | 'system') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', resolved);
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', mode);
}

async function setTheme(page: Page, value: '浅色' | '深色' | '跟随系统') {
  const dialog = await appearance(page);
  await dialog.getByRole('radio', { name: value, exact: true }).check();
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
}

async function paint(locator: Locator) {
  return locator.evaluate(element => {
    const rgba = (value: string) => {
      const values = value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
      return { rgb: values.slice(0, 3), alpha: values[3] ?? 1 };
    };
    const layers: { rgb: number[]; alpha: number }[] = [];
    let node: Element | null = element;
    while (node) {
      const background = rgba(getComputedStyle(node).backgroundColor);
      layers.push(background);
      if (background.alpha === 1) break;
      const root = node.getRootNode();
      node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    let background = [255, 255, 255];
    for (const layer of layers.reverse()) background = background.map((value, index) => value * (1 - layer.alpha) + layer.rgb[index] * layer.alpha);
    return { foreground: rgba(getComputedStyle(element).color).rgb, background };
  });
}

function luminance(rgb: number[]) {
  const values = rgb.map(value => { const unit = value / 255; return unit <= .04045 ? unit / 12.92 : ((unit + .055) / 1.055) ** 2.4; });
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}

async function readable(locator: Locator, dark: boolean) {
  // Native form controls can animate their backgrounds after the root theme
  // changes. Check the settled colors without weakening the readability bounds.
  await expect.poll(async () => {
    const colors = await paint(locator), foreground = luminance(colors.foreground), background = luminance(colors.background);
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  }).toBeGreaterThanOrEqual(4.5);
  const background = () => paint(locator).then(colors => luminance(colors.background));
  if (dark) await expect.poll(background).toBeLessThan(.2);
  else await expect.poll(background).toBeGreaterThan(.75);
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

test('appearance changes the real surfaces immediately and persists after reopening settings and reloading', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const state = await mailbox(page); await ready(page);
  await theme(page, 'light', 'system');
  await readable(page.locator('.message-row-subject > strong').first(), false);
  const dialog = await appearance(page);
  await expect(dialog.getByRole('radio', { name: '跟随系统', exact: true })).toBeChecked();
  await dialog.getByRole('radio', { name: '深色', exact: true }).check();
  await theme(page, 'dark', 'dark');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mailnest-theme'))).toBe('dark');
  await readable(dialog.getByRole('heading', { name: '外观', exact: true }), true);
  await noOverflow(page);
  await page.screenshot({ path: `/tmp/mailnest-dark-settings-${testInfo.project.name}.png` });
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await readable(page.locator('.message-row-subject > strong').first(), true);
  await page.reload();
  await theme(page, 'dark', 'dark');
  const reopened = await appearance(page);
  await expect(reopened.getByRole('radio', { name: '深色', exact: true })).toBeChecked();
  await reopened.getByRole('radio', { name: '浅色', exact: true }).check();
  await theme(page, 'light', 'light');
  await reopened.getByRole('radio', { name: '浅色', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(reopened.getByRole('radio', { name: '深色', exact: true })).toBeChecked();
  await theme(page, 'dark', 'dark');
  await page.keyboard.press('ArrowLeft');
  await expect(reopened.getByRole('radio', { name: '浅色', exact: true })).toBeChecked();
  await theme(page, 'light', 'light');
  await readable(reopened.getByRole('heading', { name: '外观', exact: true }), false);
  await reopened.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.reload(); await theme(page, 'light', 'light');
  await readable(page.locator('.message-row-subject > strong').first(), false);
  expect(state.errors).toEqual([]);
});

test('system mode follows live device changes while explicit choices and other tabs stay consistent', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'dark' }); await mailbox(page); await ready(page);
  await theme(page, 'dark', 'system');
  await page.emulateMedia({ colorScheme: 'light' }); await theme(page, 'light', 'system');
  await setTheme(page, '深色');
  await page.emulateMedia({ colorScheme: 'dark' }); await page.emulateMedia({ colorScheme: 'light' });
  await theme(page, 'dark', 'dark');
  const other = await context.newPage();
  try {
    await other.emulateMedia({ colorScheme: 'light' }); await mailbox(other); await ready(other);
    await theme(other, 'dark', 'dark');
    await setTheme(page, '浅色'); await theme(other, 'light', 'light');
    await other.evaluate(() => localStorage.removeItem('mailnest-theme'));
    await theme(page, 'light', 'system');
    await page.emulateMedia({ colorScheme: 'dark' }); await theme(page, 'dark', 'system');
    await other.evaluate(() => localStorage.setItem('mailnest-theme', 'invalid-theme'));
    await page.reload(); await theme(page, 'dark', 'system');
    await noOverflow(page);
  } finally { await other.close(); }
});

test('login and settings remain usable when theme storage is unavailable', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key: string) { if (key === 'mailnest-theme') throw new DOMException('Unavailable', 'SecurityError'); return read.call(this, key); };
    Storage.prototype.setItem = function(key: string, value: string) { if (key === 'mailnest-theme') throw new DOMException('Unavailable', 'QuotaExceededError'); return write.call(this, key, value); };
  });
  const state = await mailbox(page, false); await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录你的工作空间', exact: true })).toBeVisible();
  await theme(page, 'dark', 'system');
  await readable(page.getByLabel('登录邮箱', { exact: true }), true); await noOverflow(page);
  await page.emulateMedia({ colorScheme: 'light' }); await theme(page, 'light', 'system');
  await readable(page.getByLabel('登录邮箱', { exact: true }), false);
  state.authenticated = true; await page.reload();
  await setTheme(page, '深色'); await theme(page, 'dark', 'dark');
  await readable(page.locator('.message-row-subject > strong').first(), true);
  await page.reload(); await theme(page, 'light', 'system');
  expect(state.errors).toEqual([]);
});

test('reader switches unstyled content without reloading the document or images and preserves author colors', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const state = await mailbox(page); await ready(page);
  await page.getByRole('button', { name: '打开邮件：没有指定配色的邮件', exact: true }).click();
  const frame = page.locator('iframe[title="邮件正文"]'), body = page.frameLocator('iframe[title="邮件正文"]');
  await expect(body.getByText('明天下午讨论项目进度。', { exact: true })).toBeVisible();
  await expect.poll(() => body.getByRole('img', { name: '项目图标', exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => state.attachments.length).toBe(1);
  await frame.evaluate(element => { (window as any).__themeFrame = element; (window as any).__themeWindow = (element as HTMLIFrameElement).contentWindow; });
  await readable(body.locator('#plain-body'), false);
  await body.locator('#plain-body').evaluate(element => { (element as HTMLElement).dataset.retainedThemeMarker = 'same-document'; });
  await setTheme(page, '深色'); await theme(page, 'dark', 'dark');
  await readable(body.locator('#plain-body'), true);
  await expect(body.locator('#plain-body')).toHaveAttribute('data-retained-theme-marker', 'same-document');
  expect(luminance((await paint(body.locator('.mailnest-document-root'))).background)).toBeLessThan(.2);
  expect(await frame.evaluate(element => element === (window as any).__themeFrame && (element as HTMLIFrameElement).contentWindow === (window as any).__themeWindow)).toBe(true);
  expect(state.details).toEqual(['theme-plain-html']); expect(state.attachments).toHaveLength(1);
  await noOverflow(page); await page.screenshot({ path: `/tmp/mailnest-dark-reader-${testInfo.project.name}.png` });
  const back = page.getByRole('toolbar', { name: '邮件操作', exact: true }).getByRole('button', { name: '返回邮件列表', exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole('button', { name: '打开邮件：作者指定白底的邮件', exact: true }).click();
  await expect(body.locator('#author-body')).toBeVisible();
  const authorColors = await paint(body.locator('#author-body'));
  expect(authorColors.background).toEqual([255, 255, 255]); expect(authorColors.foreground).toEqual([23, 23, 23]);
  await setTheme(page, '浅色'); await setTheme(page, '深色');
  expect(await paint(body.locator('#author-body'))).toEqual(authorColors);
  expect(state.details).toEqual(['theme-plain-html', 'theme-authored']); expect(state.attachments).toHaveLength(1);
  for (const [subject, selector] of [['带白色卡片的邮件', '#card-body'], ['传统格式的邮件', '#legacy-body']]) {
    if (await back.isVisible()) await back.click();
    await page.getByRole('button', { name: `打开邮件：${subject}`, exact: true }).click();
    await expect(body.locator(selector)).toBeVisible();
    await readable(body.locator(selector), false);
  }
  if (await back.isVisible()) await back.click();
  await page.getByRole('button', { name: '打开邮件：纯文字邮件', exact: true }).click();
  await readable(page.locator('.message-body > pre'), true); await noOverflow(page);
  expect(state.errors).toEqual([]);
});

test('a theme update from another tab preserves an open draft and makes compose controls readable', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' }); await mailbox(page); await ready(page);
  const mobile = page.getByRole('navigation', { name: '快捷导航', exact: true }).getByRole('button', { name: '写邮件', exact: true });
  if (await mobile.isVisible()) await mobile.click();
  else await page.getByRole('complementary', { name: '邮箱导航', exact: true }).getByRole('button', { name: /^写邮件/ }).click();
  const compose = page.getByRole('dialog', { name: '写一封新邮件', exact: true });
  await compose.getByLabel('主题', { exact: true }).fill('未发送的主题');
  const text = compose.getByRole('textbox', { name: '邮件正文', exact: true }); await text.fill('切换外观后仍然保留的草稿。');
  const other = await context.newPage();
  try {
    await mailbox(other); await ready(other);
    await other.evaluate(() => localStorage.setItem('mailnest-theme', 'dark')); await theme(page, 'dark', 'dark');
    await expect(compose.getByLabel('主题', { exact: true })).toHaveValue('未发送的主题');
    await expect(text).toHaveValue('切换外观后仍然保留的草稿。');
    await readable(text, true); await readable(compose.getByLabel('发件人名称', { exact: true }), true); await noOverflow(page);
    await other.evaluate(() => localStorage.setItem('mailnest-theme', 'light')); await theme(page, 'light', 'light');
    await readable(text, false); await expect(text).toHaveValue('切换外观后仍然保留的草稿。');
  } finally { await other.close(); }
});
