/* TableNest service worker — receives web push notifications. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: 'TableNest', body: 'Aapka order update aa gaya.', url: '/' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (_) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body || '',
    icon: data.icon || '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: data.tag || 'tablenest',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(data.title || 'TableNest', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an already-open tab if possible.
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
