import { test, expect, type Page } from '@playwright/test';

async function mockMailboxNotifications(page: Page) {
  await page.addInitScript(() => {
    const state = { messages: [] as any[], sources: [] as EventTarget[] };
    class Source extends EventTarget {
      constructor(_url: string) { super(); state.sources.push(this); }
      close() { const index = state.sources.indexOf(this); if (index >= 0) state.sources.splice(index, 1); }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: Source });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
    const registration = Object.assign(new EventTarget(), {
      active: { postMessage(data: any) { state.messages.push(data); } }, waiting: null, installing: null,
      update: async () => registration,
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: Object.assign(new EventTarget(), {
      controller: registration.active, ready: Promise.resolve(registration),
      getRegistration: async () => registration, register: async () => registration,
    }) });
    (window as any).__notificationAppearance = {
      state,
      emit(data: unknown) { for (const source of state.sources) source.dispatchEvent(new MessageEvent('mail', { data: JSON.stringify(data) })); },
    };
  });
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname.slice('/api/v1'.length);
    const values: Record<string, unknown> = {
      '/auth/me': { user: { id: 'appearance-user', name: '测试用户', email: 'appearance@example.test' } },
      '/config': { googleConfigured: false, pushPublicKey: null, pollingInterval: 3600 },
      '/accounts': { accounts: [] },
      '/messages': { messages: [], total: 0, page: 1, pageSize: 30 },
    };
    return route.fulfill({ status: path in values ? 200 : 404, contentType: 'application/json', body: JSON.stringify(values[path] || {}) });
  });
}

test('mail events show the subject and excerpt identically through the worker push and foreground paths', async ({ page }) => {
  await mockMailboxNotifications(page);
  await page.goto('/');
  await expect(page.getByRole('toolbar', { name: '邮件操作', exact: true })).toBeVisible();
  const cases = [
    { count: 3, notification: { subject: '项目进度更新', preview: '明天下午两点讨论下阶段计划。', from: { name: '项目团队', address: 'team@example.test' } } },
    { count: 1, notification: { subject: ' \r\n', preview: '\0\n', from: { name: '', address: 'sender@example.test' } } },
    { count: 1, notification: { subject: '📨'.repeat(130), preview: `开始\t${'内容📨'.repeat(100)}`, from: { name: '📨'.repeat(90), address: '' } } },
    { count: 2 },
  ];
  await page.evaluate(cases => {
    for (const entry of cases) (window as any).__notificationAppearance.emit({ ...entry, notificationId: crypto.randomUUID(), accountId: 'appearance-account', unreadCount: 7 });
  }, cases);
  await expect.poll(() => page.evaluate(() => (window as any).__notificationAppearance.state.messages.length)).toBe(cases.length);
  const messages = await page.evaluate(() => (window as any).__notificationAppearance.state.messages);
  expect(messages[0]).toMatchObject({ type: 'MAIL_NOTIFICATION', payload: {
    title: '项目进度更新', body: '项目团队：明天下午两点讨论下阶段计划。 · 另有 2 封新邮件', unreadCount: 7,
  } });
  expect(messages[1].payload).toMatchObject({ title: '无主题', body: 'sender@example.test：（无正文摘要）' });
  expect(Array.from(messages[2].payload.title)).toHaveLength(120);
  expect(messages[2].payload.title).toBe(`${'📨'.repeat(119)}…`);
  expect(messages[2].payload.body).not.toMatch(/[\u0000-\u001f\u007f\ufffd]/u);
  expect(messages[3].payload).toMatchObject({ title: 'MailNest 新邮件', body: '有 2 封新邮件等待查看' });

  const workerSource = await (await page.request.get('/sw.js')).text();
  const shown = await page.evaluate(async ({ source, messages }) => {
    const setup = `
      const handlers = {}, shown = [], badgeCounts = [];
      const listen = self.addEventListener.bind(self);
      self.addEventListener = (type, callback) => { handlers[type] = callback; };
      self.registration = {showNotification: async (title, options) => { shown.push({title, options}); }};
      Object.defineProperty(self, 'indexedDB', {value: {open() {throw Error('Fixture memory history');}}});
      Object.defineProperty(self.navigator, 'setAppBadge', {value: async count => badgeCounts.push(count)});
    `;
    const run = `
      listen('message', async event => {
        try {
          const origin = event.data.origin;
          for (const message of event.data.messages) {
            let complete;
            handlers.push({data:{json:()=>message.payload},waitUntil(value){complete=value;}});
            await complete;
            handlers.message({data:message,source:{type:'window',url:origin+'/'},origin,waitUntil(value){complete=value;}});
            await complete;
          }
          self.postMessage({shown,badgeCounts});
        } catch(error) {self.postMessage({error:String(error)});}
      });
    `;
    const workerURL = URL.createObjectURL(new Blob([setup, source, run], { type: 'text/javascript' }));
    const worker = new Worker(workerURL);
    try {
      return await new Promise<any>((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage({ messages, origin: location.origin });
      });
    } finally { worker.terminate(); URL.revokeObjectURL(workerURL); }
  }, { source: workerSource, messages });
  expect(shown.error).toBeUndefined();
  expect(shown.shown).toHaveLength(cases.length);
  expect(shown.badgeCounts).toEqual(Array(cases.length * 2).fill(7));
  for (let index = 0; index < messages.length; index++) {
    expect(shown.shown[index]).toMatchObject({ title: messages[index].payload.title, options: {
      body: messages[index].payload.body, icon: '/icon-blue-192-v2.png', badge: '/notification-badge-v2.png',
      tag: 'mail-appearance-account', renotify: true, data: { url: '/' },
    } });
  }
});

test('installed app and notification resources use the blue identity and a transparent monochrome badge', async ({ page }) => {
  await page.goto('/');
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.theme_color).toBe('#2563eb');
  expect(manifest.background_color).toBe('#f2f4f7');
  expect(manifest.icons).toEqual([
    { src: '/icon-blue-192-v2.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-blue-512-v2.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-blue-maskable-512-v2.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#2563eb');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icon-blue-v2.svg');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icon-blue-192-v2.png');
  const svg = await (await page.request.get('/icon-blue-v2.svg')).text();
  expect(svg).toContain('#3b82f6');
  expect(svg).toContain('#1d4ed8');
  expect(svg).not.toContain('#193b3c');
  const images = await page.evaluate(async () => {
    async function pixels(path: string) {
      const image = new Image(); image.src = path; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      return { width: image.width, height: image.height, data };
    }
    const icon = await pixels('/icon-blue-192-v2.png');
    const badge = await pixels('/notification-badge-v2.png');
    const maskable = await pixels('/icon-blue-maskable-512-v2.png');
    let white = true, visible = 0, transparent = 0, opaqueMaskable = true;
    for (let index = 0; index < badge.data.length; index += 4) {
      if (badge.data[index + 3] > 0) {
        visible++;
        if (badge.data[index] !== 255 || badge.data[index + 1] !== 255 || badge.data[index + 2] !== 255) white = false;
      } else transparent++;
    }
    for (let index = 3; index < maskable.data.length; index += 4) if (maskable.data[index] !== 255) opaqueMaskable = false;
    const point = ((20 * icon.width) + 96) * 4;
    return {
      iconSize: [icon.width, icon.height], badgeSize: [badge.width, badge.height], maskableSize: [maskable.width, maskable.height],
      blueDominates: icon.data[point + 2] > icon.data[point] + 50, white, visible, transparent, opaqueMaskable,
    };
  });
  expect(images).toMatchObject({ iconSize: [192, 192], badgeSize: [96, 96], maskableSize: [512, 512], blueDominates: true, white: true, opaqueMaskable: true });
  expect(images.visible).toBeGreaterThan(500);
  expect(images.transparent).toBeGreaterThan(images.visible);
  const worker = await (await page.request.get('/sw.js')).text();
  for (const path of [...manifest.icons.map((icon: {src:string}) => icon.src), '/notification-badge-v2.png']) expect(worker).toContain(`'${path}'`);
});
