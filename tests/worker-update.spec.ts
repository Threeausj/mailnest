import { test, expect, type Page } from '@playwright/test';

async function mockMailbox(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/v1'.length);
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/auth/me') return json({ user: { id: 'worker-fixture', email: 'worker@example.test', name: '测试管理员' } });
    if (path === '/config') return json({ googleConfigured: false, pushPublicKey: null, pollingInterval: 3600 });
    if (path === '/accounts') return json({ accounts: [{
      id: 'worker-account', name: '测试邮箱', email: 'worker@example.test', color: '#377a75', provider: 'imap', username: 'worker@example.test',
      imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true },
      status: 'connected', lastSyncedAt: new Date().toISOString(), error: null, unread: 0,
    }] });
    if (path === '/messages') return json({ messages: [], total: 0, page: 1, pageSize: 30 });
    if (path === '/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: `Unhandled worker fixture ${path}` } }) });
  });
}

type FixtureOptions = {
  worker?: 'installing' | 'installed' | 'waiting' | 'first-install';
  controller?: boolean;
  active?: boolean;
  readyComplete?: boolean;
  throwRegisterOnce?: boolean;
  minimalRegistration?: boolean;
};

async function mockWorker(page: Page, options: FixtureOptions = {}) {
  await page.addInitScript((options) => {
    const loadKey = 'worker-update-fixture-loads';
    sessionStorage.setItem(loadKey, String(Number(sessionStorage.getItem(loadKey) || 0) + 1));
    const state = {
      registers: [] as { url: string; options: unknown }[],
      messages: [] as { worker: string; data: unknown }[],
      earlyUpdateFound: 0,
      updates: 0,
      updateMode: 'resolve' as 'resolve' | 'reject' | 'hang',
      hidden: false,
      online: true,
      registerFailed: false,
      readyAtRegister: [] as DocumentReadyState[],
    };
    class Worker extends EventTarget {
      constructor(public name: string, public state: string) { super(); }
      postMessage(data: unknown) { state.messages.push({ worker: this.name, data }); }
    }
    const firstInstall = options.worker === 'first-install';
    const oldWorker = new Worker('old', 'activated');
    const initialWorker = new Worker('initial', options.worker === 'installed' || options.worker === 'waiting' ? 'installed' : 'installing');
    const workers = new Map([['initial', initialWorker]]);
    const registration = Object.assign(new EventTarget(), {
      active: options.active === false || firstInstall ? null : oldWorker,
      waiting: options.worker === 'waiting' ? initialWorker : null as Worker | null,
      installing: options.worker === 'waiting' ? null : initialWorker as Worker | null,
      update() {
        state.updates++;
        if (state.updateMode === 'reject') return Promise.reject(new Error('Fixture update offline'));
        if (state.updateMode === 'hang') return new Promise(() => {});
        return Promise.resolve(registration);
      },
    });
    const exposedRegistration = options.minimalRegistration ? { active: {}, waiting: null, installing: null } : registration;
    const container = Object.assign(new EventTarget(), {
      controller: options.controller === false || firstInstall ? null : oldWorker,
      ready: Promise.resolve(exposedRegistration),
      getRegistration: async () => exposedRegistration,
      register(url: string, registrationOptions: unknown) {
        state.registers.push({ url, options: registrationOptions });
        state.readyAtRegister.push(document.readyState);
        if (options.throwRegisterOnce && !state.registerFailed) {
          state.registerFailed = true;
          throw new Error('Fixture synchronous registration failure');
        }
        // Match the real race: updatefound happens before the register promise
        // delivers the registration to the application bundle.
        registration.dispatchEvent(new Event('updatefound'));
        state.earlyUpdateFound++;
        return Promise.resolve(exposedRegistration);
      },
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => state.online });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.hidden });
    if (options.readyComplete) Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'complete' });
    (window as any).__workerUpdateFixture = {
      state,
      install(name = 'initial') {
        const worker = workers.get(name)!;
        worker.state = 'installed';
        registration.waiting = worker;
        registration.installing = null;
        worker.dispatchEvent(new Event('statechange'));
      },
      found(name: string) {
        const worker = new Worker(name, 'installing');
        workers.set(name, worker);
        registration.installing = worker;
        registration.waiting = null;
        registration.dispatchEvent(new Event('updatefound'));
      },
      activate() {
        initialWorker.state = 'activated';
        registration.active = initialWorker;
        registration.waiting = null;
        container.controller = initialWorker;
        initialWorker.dispatchEvent(new Event('statechange'));
        container.dispatchEvent(new Event('controllerchange'));
      },
    };
  }, options);
}

const workerState = (page: Page) => page.evaluate(() => (window as any).__workerUpdateFixture.state as {
  registers: { url: string; options: unknown }[];
  messages: { worker: string; data: unknown }[];
  earlyUpdateFound: number;
  updates: number;
  readyAtRegister: DocumentReadyState[];
});

async function openFixture(page: Page) {
  await mockMailbox(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '收件箱', exact: false }).first()).toBeVisible();
  await expect.poll(async () => (await workerState(page)).registers.length).toBe(1);
}

test('worker update observes installing before the registration promise resolves and handles future updatefound once', async ({ page }) => {
  await mockWorker(page, { worker: 'installing' });
  await openFixture(page);
  expect((await workerState(page)).earlyUpdateFound).toBe(1);
  expect((await workerState(page)).registers).toEqual([{ url: '/sw.js', options: { scope: '/', updateViaCache: 'none' } }]);
  await page.evaluate(() => (window as any).__workerUpdateFixture.install());
  await expect.poll(async () => (await workerState(page)).messages).toEqual([{ worker: 'initial', data: { type: 'SKIP_WAITING' } }]);
  await page.evaluate(() => {
    const fixture = (window as any).__workerUpdateFixture;
    fixture.install();
    fixture.found('future');
    fixture.install('future');
    fixture.install('future');
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(async () => (await workerState(page)).messages).toEqual([
    { worker: 'initial', data: { type: 'SKIP_WAITING' } },
    { worker: 'future', data: { type: 'SKIP_WAITING' } },
  ]);
});

test('worker update activates an initially waiting worker on an uncontrolled page without reloading its draft', async ({ page }) => {
  await mockWorker(page, { worker: 'waiting', controller: false, active: true, readyComplete: true });
  await openFixture(page);
  expect((await workerState(page)).readyAtRegister).toEqual(['complete']);
  await expect.poll(async () => (await workerState(page)).messages).toEqual([{ worker: 'initial', data: { type: 'SKIP_WAITING' } }]);
  const mobileCompose = page.getByRole('navigation', { name: '快捷导航', exact: true }).getByRole('button', { name: '写邮件', exact: true });
  if (await mobileCompose.isVisible()) await mobileCompose.click();
  else await page.getByRole('complementary', { name: '邮箱导航', exact: true }).getByRole('button', { name: /^写邮件/ }).click();
  await page.getByRole('textbox', { name: '邮件正文', exact: true }).fill('Worker 更新后必须保留这份草稿。');
  await page.evaluate(() => (window as any).__workerUpdateFixture.activate());
  await expect(page.getByRole('textbox', { name: '邮件正文', exact: true })).toHaveValue('Worker 更新后必须保留这份草稿。');
  expect(await page.evaluate(() => sessionStorage.getItem('worker-update-fixture-loads'))).toBe('1');
});

test('worker update coalesces foreground events, retries rejection and releases a hung update deadline', async ({ page }) => {
  await mockWorker(page, { worker: 'installed' });
  await openFixture(page);
  await page.clock.install();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(async () => (await workerState(page)).updates).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await workerState(page)).updates).toBe(1);
  await page.clock.runFor(60_001);
  await page.evaluate(() => {
    (window as any).__workerUpdateFixture.state.updateMode = 'reject';
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(async () => (await workerState(page)).updates).toBe(2);
  await page.evaluate(() => {
    (window as any).__workerUpdateFixture.state.updateMode = 'hang';
    window.dispatchEvent(new Event('online'));
  });
  await expect.poll(async () => (await workerState(page)).updates).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await workerState(page)).updates).toBe(3);
  await page.clock.runFor(15_001);
  await page.evaluate(() => {
    (window as any).__workerUpdateFixture.state.updateMode = 'resolve';
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(async () => (await workerState(page)).updates).toBe(4);
  await page.evaluate(() => {
    const fixture = (window as any).__workerUpdateFixture;
    fixture.state.hidden = true;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(60_001);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect((await workerState(page)).updates).toBe(4);
  await page.evaluate(() => {
    (window as any).__workerUpdateFixture.state.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await workerState(page)).updates).toBe(5);
});

test('worker update lets first installation activate naturally without skip waiting or a reload', async ({ page }) => {
  await mockWorker(page, { worker: 'first-install' });
  await openFixture(page);
  await page.evaluate(() => {
    const fixture = (window as any).__workerUpdateFixture;
    fixture.install();
    fixture.activate();
  });
  expect((await workerState(page)).messages).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('worker-update-fixture-loads'))).toBe('1');
  await expect(page.getByRole('heading', { name: '收件箱', exact: false }).first()).toBeVisible();
});

test('worker update recovers from a synchronous registration failure with optional update and observer APIs absent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockWorker(page, { throwRegisterOnce: true, minimalRegistration: true });
  await openFixture(page);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await workerState(page)).registers.length).toBe(2);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect((await workerState(page)).updates).toBe(0);
  expect((await workerState(page)).registers).toHaveLength(2);
  expect(errors).toEqual([]);
});
