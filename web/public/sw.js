const CACHE = '__MAILNEST_CACHE_VERSION__';
const BUILT_ASSETS = /* __MAILNEST_PRECACHE_ASSETS__ */ [];
const STATIC = ['/', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', ...BUILT_ASSETS];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('mailnest-shell-') && key !== CACHE).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CLEAR_PRIVATE_DATA') {
    // The service worker stores the public application shell only.
  }
  if (event.data?.type === 'MAIL_NOTIFICATION' && isTrustedClientMessage(event)) {
    event.waitUntil(queueMailNotification(event.data.payload));
  }
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/src/') || url.pathname.startsWith('/@')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put('/', clone));
      }
      return response;
    }).catch(() => caches.match('/')));
  } else if (url.pathname.startsWith('/assets/') || STATIC.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    })));
  }
});
async function updateAppBadge(unreadCount) {
  if (!Number.isSafeInteger(unreadCount) || unreadCount < 0) return;
  try {
    if (unreadCount > 0) {
      if (typeof self.navigator?.setAppBadge === 'function') await self.navigator.setAppBadge(unreadCount);
    } else if (typeof self.navigator?.clearAppBadge === 'function') await self.navigator.clearAppBadge();
    else if (typeof self.navigator?.setAppBadge === 'function') await self.navigator.setAppBadge(0);
  } catch { /* App badges are optional and may require notification permission. */ }
}

const NOTIFICATION_RETENTION = 7 * 24 * 60 * 60 * 1000;
const NOTIFICATION_LIMIT = 128;
const shownNotifications = new Map();
let notificationQueue = Promise.resolve();
let notificationHistoryReady;
let notificationDatabase;
let canPersistNotifications = true;

function notificationId(payload) {
  // Store only opaque identifiers, never a title, body, endpoint or credential.
  return typeof payload.notificationId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(payload.notificationId) ? payload.notificationId : null;
}

function isTrustedClientMessage(event) {
  try {
    return event.source?.type === 'window' && new URL(event.source.url).origin === self.location.origin &&
      (!event.origin || event.origin === self.location.origin);
  } catch { return false; }
}

function openNotificationDatabase() {
  if (!notificationDatabase) notificationDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open('mailnest-notification-history', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('shown', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Notification history unavailable'));
  });
  return notificationDatabase;
}

function pruneMemoryHistory() {
  const cutoff = Date.now() - NOTIFICATION_RETENTION;
  for (const [id, timestamp] of shownNotifications) if (timestamp < cutoff) shownNotifications.delete(id);
  while (shownNotifications.size > NOTIFICATION_LIMIT) shownNotifications.delete(shownNotifications.keys().next().value);
}

async function loadNotificationHistory() {
  if (!notificationHistoryReady) notificationHistoryReady = (async () => {
    try {
      const database = await openNotificationDatabase();
      const records = await new Promise((resolve, reject) => {
        const transaction = database.transaction('shown', 'readonly');
        const request = transaction.objectStore('shown').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      });
      for (const record of records.sort((a, b) => a.shownAt - b.shownAt)) {
        if (notificationId({ notificationId: record.id }) && Number.isFinite(record.shownAt)) shownNotifications.set(record.id, record.shownAt);
      }
      pruneMemoryHistory();
    } catch { canPersistNotifications = false; }
  })();
  await notificationHistoryReady;
}

async function recordShownNotification(id) {
  const shownAt = Date.now();
  shownNotifications.set(id, shownAt);
  pruneMemoryHistory();
  if (!canPersistNotifications) return;
  try {
    const database = await openNotificationDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('shown', 'readwrite');
      const store = transaction.objectStore('shown');
      store.put({ id, shownAt });
      const request = store.getAll();
      request.onsuccess = () => {
        const records = request.result.sort((a, b) => b.shownAt - a.shownAt);
        const cutoff = shownAt - NOTIFICATION_RETENTION;
        records.forEach((record, index) => {
          if (record.shownAt < cutoff || index >= NOTIFICATION_LIMIT) store.delete(record.id);
        });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch { canPersistNotifications = false; }
}

function mailNotificationTag(payload) {
  if (payload.tag === 'mailnest-test') return 'mailnest-test';
  if (typeof payload.tag === 'string' && /^mail-[a-z0-9_-]{1,100}$/i.test(payload.tag)) return payload.tag;
  if (typeof payload.accountId === 'string' && /^[a-z0-9_-]{1,100}$/i.test(payload.accountId)) return `mail-${payload.accountId}`;
  return 'mailnest-new-mail';
}

function queueMailNotification(data) {
  const payload = Object.assign({ title: '邮屿 · 新邮件', body: '你有新的邮件，打开邮屿查看。', url: '/' }, data && typeof data === 'object' ? data : {});
  const badge = updateAppBadge(payload.unreadCount);
  const display = notificationQueue.then(async () => {
    const id = notificationId(payload);
    if (id) {
      await loadNotificationHistory();
      pruneMemoryHistory();
      if (shownNotifications.has(id)) return;
    }
    const tag = mailNotificationTag(payload);
    await self.registration.showNotification(payload.title, {
      body: payload.body, icon: '/icon-192.png', badge: '/icon-192.png', tag,
      renotify: true, data: { url: '/' },
    });
    if (id) await recordShownNotification(id);
  });
  // A rejected display must leave the next attempt available for the same ID.
  notificationQueue = display.catch(() => {});
  return Promise.all([badge, display]);
}

self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data?.json(); } catch { /* Use generic text. */ }
  event.waitUntil(queueMailNotification(payload));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      if (self.location.protocol !== 'https:') return;
      const subscription = event.newSubscription || (event.oldSubscription?.options && await self.registration.pushManager.subscribe(event.oldSubscription.options));
      if (!subscription) return;
      const { keys } = subscription.toJSON();
      const url = new URL('/api/v1/push/subscriptions', self.location.origin);
      const options = { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
      const response = await fetch(url, { ...options, method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint, keys }) });
      if (!response.ok) return;
      if (event.oldSubscription?.endpoint && event.oldSubscription.endpoint !== subscription.endpoint) {
        await fetch(url, { ...options, method: 'DELETE', body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }) });
      }
    } catch { /* The next signed-in foreground session will retry registration. */ }
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    return existing ? existing.focus() : self.clients.openWindow('/');
  }));
});
