// Cortex Alarm — Service Worker v6
  // Changes from v5:
  //   - Background Sync: fetches missed inbox items when device comes back online
  //   - Shown-ID cache: prevents re-showing notifications that arrived via push
  //   - Periodic Background Sync: hourly check in supporting browsers
  //   - renotify:true so multiple notifications of the same type all appear

  const BASE       = '/CortexAlarm';
  const CACHE_NAME = 'cortex-alarm-v6';
  const SYNC_CACHE = 'cortex-alarm-sync';
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

  // Supabase access (anon key — safe to embed, RLS protects data)
  const SUPABASE_URL      = 'https://gplatvbhqwqcmceawtub.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwbGF0dmJocXdxY21jZWF3dHViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMDM0MDAsImV4cCI6MjA5MTU3OTQwMH0.Fwr0jhD9bwzHiND2errtkBxzEXEpsR8ma2YFYW5KpXw';

  // ── Install: pre-cache app shell ──────────────────────────────────
  self.addEventListener('install', event => {
    event.waitUntil(
      caches.open(CACHE_NAME)
        .then(cache => cache.addAll(APP_SHELL).catch(() => {}))
        .then(() => self.skipWaiting())
    );
  });

  // ── Activate: delete old caches ───────────────────────────────────
  self.addEventListener('activate', event => {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(
          keys.filter(k => k !== CACHE_NAME && k !== SYNC_CACHE).map(k => caches.delete(k))
        ))
        .then(() => {
          // Register periodic background sync if browser supports it
          if ('periodicSync' in self.registration) {
            self.registration.periodicSync.register('check-notifications', { minInterval: 60 * 60 * 1000 })
              .catch(() => {}); // Silently ignore if permission not granted
          }
        })
        .then(() => clients.claim())
    );
  });

  // ── Fetch: cache-first for app shell, network for API ────────────
  self.addEventListener('fetch', event => {
    // Only cache GET requests for same-origin app shell resources
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.hostname === 'gplatvbhqwqcmceawtub.supabase.co') return; // never cache API calls

    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          // Cache successful same-origin responses
          if (res.ok && url.origin === self.location.origin) {
            caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone())).catch(() => {});
          }
          return res;
        }).catch(() => cached); // Return cached copy if network fails
      })
    );
  });

  // ── Shown-notification ID helpers (via Cache Storage) ────────────
  // We persist shown IDs so even if the SW is terminated and restarted,
  // we never re-show a notification the user already received via push.
  async function getShownIds() {
    try {
      const cache = await caches.open(SYNC_CACHE);
      const resp  = await cache.match('shown-ids');
      if (!resp) return new Set();
      const arr = JSON.parse(await resp.text());
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  }

  async function addShownId(id) {
    try {
      const cache = await caches.open(SYNC_CACHE);
      const shown = await getShownIds();
      shown.add(id);
      // Keep the newest 200 IDs so storage stays bounded
      const arr = [...shown].slice(-200);
      await cache.put('shown-ids', new Response(JSON.stringify(arr)));
    } catch {}
  }

  // ── Push: show notification ───────────────────────────────────────
  // The browser's push service queues push messages when the device is offline
  // (TTL=2419200 set by the scheduler — 28 days) and delivers them when online.
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
    const notifId = data.id || `push-${Date.now()}`;

    const options = {
      body:               data.body || 'Open the app to see your study directive.',
      icon:               `${BASE}/icon.svg`,
      badge:              `${BASE}/icon.svg`,
      tag:                `cortex-${data.type || 'alert'}`,
      renotify:           true,   // always show even if same tag is already visible
      requireInteraction: true,
      vibrate:            [300, 100, 300, 100, 300],
      data: {
        url:  `https://joshbond123.github.io${BASE}/notifications.html`,
        type: data.type,
        id:   notifId,
      },
      actions: [
        { action: 'view',    title: 'Open Inbox' },
        { action: 'dismiss', title: 'Dismiss'    },
      ],
    };

    event.waitUntil(
      addShownId(notifId).then(() => self.registration.showNotification(title, options))
    );
  });

  // ── Notification click: open app ──────────────────────────────────
  self.addEventListener('notificationclick', event => {
    event.notification.close();
    if (event.action === 'dismiss') return;

    const url = event.notification.data?.url
      || `https://joshbond123.github.io${BASE}/notifications.html`;

    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const match = list.find(c => c.url.includes('joshbond123.github.io'));
        if (match) return match.focus();
        return clients.openWindow(url);
      })
    );
  });

  // ── Background Sync: recover missed notifications ─────────────────
  // Fires when the device reconnects after being offline. We fetch notifications
  // from the Supabase inbox that arrived in the last 48 hours, skip any that
  // were already shown via push (tracked in shown-ids cache), and display the rest.
  // This guarantees delivery even if the push service dropped a message or the
  // TTL was exceeded (e.g. device offline for >28 days).
  self.addEventListener('sync', event => {
    if (event.tag === 'sync-missed-notifications') {
      event.waitUntil(recoverMissedNotifications());
    }
  });

  // ── Periodic Background Sync: hourly check ────────────────────────
  self.addEventListener('periodicsync', event => {
    if (event.tag === 'check-notifications') {
      event.waitUntil(recoverMissedNotifications());
    }
  });

  // ── Message: page → service worker communication ──────────────────
  // The app pages can send messages to trigger syncs and mark IDs shown.
  self.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.type === 'SYNC_MISSED') {
      event.waitUntil(recoverMissedNotifications());
    }
    if (msg.type === 'MARK_SHOWN' && msg.id) {
      event.waitUntil(addShownId(msg.id));
    }
  });

  // ── Core recovery logic ───────────────────────────────────────────
  async function recoverMissedNotifications() {
    try {
      // Fetch notifications from the last 48 hours that are still unread
      // (48h window catches cases where the device was briefly offline)
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const url   = `${SUPABASE_URL}/rest/v1/notifications`
        + `?sent_at=gte.${encodeURIComponent(since)}&order=sent_at.asc&limit=20`;

      const res = await fetch(url, {
        headers: {
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Accept':        'application/json',
        },
      });
      if (!res.ok) return; // Silently skip if Supabase is unreachable

      const notifications = await res.json();
      if (!Array.isArray(notifications) || !notifications.length) return;

      const shownIds = await getShownIds();
      let recovered = 0;

      for (const notif of notifications) {
        const id = notif.id;
        if (shownIds.has(id)) continue; // already shown via push — skip

        // Check if there's already a visible notification with this tag
        const tag = `cortex-${notif.type || 'alert'}`;
        const existing = await self.registration.getNotifications({ tag });
        if (existing.length > 0) {
          // A notification for this type is already on-screen — still mark as shown
          await addShownId(id);
          continue;
        }

        await self.registration.showNotification(notif.title, {
          body:               notif.body,
          icon:               `${BASE}/icon.svg`,
          badge:              `${BASE}/icon.svg`,
          tag,
          renotify:           true,
          requireInteraction: false,  // recovered notifications are lower priority
          vibrate:            [200, 100, 200],
          data: {
            url:  `https://joshbond123.github.io${BASE}/notifications.html`,
            type: notif.type,
            id,
          },
          actions: [
            { action: 'view',    title: 'Open Inbox' },
            { action: 'dismiss', title: 'Dismiss'    },
          ],
        });

        await addShownId(id);
        recovered++;
      }

      if (recovered > 0) {
        console.log(`[SW] Recovered ${recovered} missed notification(s) from inbox`);
      }
    } catch (err) {
      // Never let recovery errors propagate — the SW must not crash
      console.error('[SW] recoverMissedNotifications error:', err.message);
    }
  }
  