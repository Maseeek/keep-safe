/* No fetch handler: credentials and live browser frames are never cached. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* Use safe defaults. */ }
  event.waitUntil(self.registration.showNotification('Keep Safe · Your agent needs you', {
    body: typeof data.body === 'string' ? data.body : 'A browser request is waiting for your approval.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: typeof data.requestId === 'string' ? `request-${data.requestId}` : 'keep-safe-request',
    data: { requestId: typeof data.requestId === 'string' ? data.requestId : '' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestId = event.notification.data?.requestId;
  const url = new URL('/', self.location.origin);
  if (requestId) url.hash = `request=${encodeURIComponent(requestId)}`;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const client = clients.find((item) => new URL(item.url).origin === self.location.origin);
    if (client) { await client.focus(); client.postMessage({ type: 'open-request', requestId }); }
    else await self.clients.openWindow(url.href);
  }));
});
