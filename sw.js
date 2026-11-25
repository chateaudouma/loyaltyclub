// Service worker: shows push notifications and opens the card when tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let data = { title: 'Château Douma', body: '' };
  try { data = event.data.json(); } catch (_) { if (event.data) data.body = event.data.text(); }
  event.waitUntil(self.registration.showNotification(data.title || 'Château Douma', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: '/card' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (new URL(c.url).pathname.startsWith('/card')) { c.focus(); c.postMessage('refresh'); return; }
    await self.clients.openWindow('/card');
  })());
});
