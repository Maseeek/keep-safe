/* No fetch handler: credentials and live browser frames are never cached.
   The only stored item is the paired computer's current address. */
function notificationIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId) ||
      typeof value.sourceKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value.sourceKey)) return null;
  try {
    const decoded = atob(value.sourceKey.replace(/-/g, '+').replace(/_/g, '/'));
    if (decoded.length !== 65 || decoded.charCodeAt(0) !== 4 ||
        btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== value.sourceKey) return null;
  } catch { return null; }
  return { version: 1, requestId: value.requestId.toLowerCase(), sourceKey: value.sourceKey };
}
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* Use safe defaults. */ }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const intent = notificationIntent(data.notificationIntent);
  // The computer's public address can change. Its notifications say where it
  // is now, so the app can follow. Only an address is kept, never page data.
  const moved = intent && typeof data.bridge === 'string' && /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(data.bridge)
    ? { sourceKey: intent.sourceKey, url: data.bridge, at: Date.now() } : null;
  if (moved) event.waitUntil((async () => {
    try {
      const cache = await caches.open('keep-safe-link-v1');
      await cache.put('/__keep-safe/link', new Response(JSON.stringify(moved), { headers: { 'Content-Type': 'application/json' } }));
      for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'bridge-address', sourceKey: moved.sourceKey, url: moved.url });
    } catch { /* The notification still shows; the app can pair again. */ }
  })());
  event.waitUntil(self.registration.showNotification('Keep Safe · Your agent needs you', {
    body: typeof data.body === 'string' ? data.body.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240) : 'A browser request is waiting for your approval.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: intent ? `request-${intent.sourceKey}-${intent.requestId}` : 'keep-safe-request',
    data: intent ? { notificationIntent: intent } : {},
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const intent = notificationIntent(event.notification.data?.notificationIntent);
  const url = new URL('/', self.location.origin);
  url.hash = intent ? new URLSearchParams({ notificationRequest: intent.requestId, notificationSource: intent.sourceKey }).toString() : 'notificationInbox=1';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const client = clients.find((item) => {
      try { const candidate = new URL(item.url); return item.frameType === 'top-level' && candidate.origin === self.location.origin && candidate.pathname === '/'; }
      catch { return false; }
    });
    if (client) {
      try { await client.focus(); } catch { /* A background window may refuse focus. */ }
      try { client.postMessage(intent ? { type: 'notification-request', ...intent } : { type: 'notification-inbox' }); }
      catch { await self.clients.openWindow(url.href); }
    } else await self.clients.openWindow(url.href);
  }).catch(() => {}));
});
