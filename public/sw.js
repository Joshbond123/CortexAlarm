// Cortex Alarm — Service Worker v4 (Supabase backend)
const BASE = '/CortexAlarm';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { title: 'Cortex Alarm', body: event.data ? event.data.text() : 'Study reminder.' }; }

  const options = {
    body:             data.body || 'You have a new study directive.',
    icon:             `${BASE}/icon.svg`,
    badge:            `${BASE}/icon.svg`,
    tag:              `cortex-${data.type || 'alert'}-${Date.now()}`,
    requireInteraction: true,
    vibrate:          [200, 100, 200, 100, 200],
    data: {
      url:  `https://joshbond123.github.io${BASE}/notifications.html`,
      type: data.type,
    },
    actions: [
      { action: 'view', title: 'View' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(self.registration.showNotification(data.title || 'Cortex Alarm', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || `https://joshbond123.github.io${BASE}/notifications.html`;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('joshbond123.github.io') && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('supabase.co')) return; // never cache API calls
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).catch(() => cached))
  );
});
