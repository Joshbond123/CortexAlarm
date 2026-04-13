// Cortex Alarm — Service Worker v5
// Push notifications use TTL=86400 so they are queued by the browser's push
// service and delivered as soon as the device comes back online.
const BASE       = '/CortexAlarm';
const CACHE_NAME = 'cortex-alarm-v5';
const APP_SHELL  = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/notifications.html`,
  `${BASE}/timetable.html`,
  `${BASE}/settings.html`,
  `${BASE}/logs.html`,
  `${BASE}/css/style.css`,
  `${BASE}/js/supabase-client.js`,
  `${BASE}/js/utils.js`,
  `${BASE}/icon.svg`,
  `${BASE}/manifest.json`,
];

// ── Install: pre-cache app shell ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL).catch(() => {})) // ignore missing files
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => clients.claim())
  );
});

// ── Push: show notification ───────────────────────────────────────
// The browser's push service queues push messages when the device is offline
// (thanks to TTL=86400 set by the scheduler) and delivers them when back online.
// This handler fires whenever a push arrives — device does NOT need to be active.
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: 'Cortex Alarm',
      body: event.data ? event.data.text() : 'You have a new study directive.',
    };
  }

  const title = data.title || 'Cortex Alarm — Study Alert';
  const options = {
    body:             data.body || 'Open the app to see your study directive.',
    icon:             `${BASE}/icon.svg`,
    badge:            `${BASE}/icon.svg`,
    tag:              `cortex-${data.type || 'alert'}`,
    renotify:         false,
    requireInteraction: true,
    vibrate:          [300, 100, 300, 100, 300],
    data: {
      url:  `https://joshbond123.github.io${BASE}/notifications.html`,
      type: data.type,
    },
    actions: [
      { action: 'view',    title: 'Open Inbox' },
      { action: 'dismiss', title: 'Dismiss'    },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click: open app ──────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url
    || `https://joshbond123.github.io${BASE}/notifications.html`;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus an already-open tab if found
      const match = list.find(c => c.url.includes('joshbond123.github.io'));
      if (match && 'focus' in match) {
        match.focus();
        match.navigate(url);
        return;
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Fetch: cache-first for app shell, network-first for everything else ──
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Never intercept Supabase API or Cerebras API calls
  const url = event.request.url;
  if (url.includes('supabase.co') || url.includes('cerebras.ai')) return;

  // For app shell files: serve from cache, fall back to network
  const isAppShell = APP_SHELL.some(path => url.endsWith(path) || url.includes(path));
  if (isAppShell) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          // Update cache with fresh copy
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached); // offline: serve stale
      })
    );
    return;
  }

  // For everything else: network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
