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
self.addEventListener('push', (event) => {
  let payload = { title: '邮屿 · 新邮件', body: '你有新的邮件，打开邮屿查看。', url: '/' };
  try { Object.assign(payload, event.data?.json()); } catch { /* Use generic text. */ }
  const notification = self.registration.showNotification(payload.title, {
    body: payload.body, icon: '/icon-192.png', badge: '/icon-192.png',
    tag: payload.tag === 'mailnest-test' ? 'mailnest-test' : 'mailnest-new-mail',
    data: { url: '/' },
  });
  // NotificationOptions.badge is only an icon mask; the OS app's numerical
  // unread badge uses WorkerNavigator's Badging API independently.
  event.waitUntil(Promise.all([notification,updateAppBadge(payload.unreadCount)]));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    return existing ? existing.focus() : self.clients.openWindow('/');
  }));
});
