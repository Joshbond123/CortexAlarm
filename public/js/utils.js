// ── Shared utilities ──────────────────────────────────────────────
const BASE = '/CortexAlarm';

export const $ = (sel, ctx = document) => ctx.querySelector(sel);
export const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

// Identify current page and set active nav
export function initNav() {
  const path = location.pathname.replace(BASE, '').replace(/\/$/, '') || '/index.html';
  document.querySelectorAll('.nav-link').forEach(a => {
    const href = a.getAttribute('href').replace(/^\.\//, '/');
    if (path === href || (path === '/' && href === '/index.html') ||
        (path === '' && href === '/index.html')) {
      a.classList.add('active');
    }
  });
}

// Toast
export function toast(msg, type = 'info') {
  let tc = document.getElementById('toast-container');
  if (!tc) { tc = document.createElement('div'); tc.id = 'toast-container'; document.body.appendChild(tc); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  tc.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3500);
}

// Format timestamp
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
export function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}
export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// Modal
export function openModal(titleHTML, bodyText, onClose) {
  let overlay = document.getElementById('global-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'global-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title" id="modal-title"></div>
        <div class="modal-body" id="modal-body"></div>
        <button class="btn btn-ghost modal-close" id="modal-close-btn">Close</button>
      </div>`;
    document.body.appendChild(overlay);
  }
  document.getElementById('modal-title').innerHTML = titleHTML;
  document.getElementById('modal-body').textContent = bodyText;
  overlay.classList.add('open');
  const close = () => { overlay.classList.remove('open'); if (onClose) onClose(); };
  document.getElementById('modal-close-btn').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

// Notification icon map
export const NOTIF_ICONS = {
  morning: { icon: '☀', cls: 'morning' },
  afternoon: { cls: 'afternoon', icon: '📚' },
  evening: { icon: '🌙', cls: 'evening' },
  manual: { icon: '⚡', cls: 'manual' },
};

// Storage path — reads from repo's storage/*.json via relative URL
export async function fetchStorage(name) {
  try {
    const r = await fetch(`${BASE}/storage/${name}.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Push subscription helpers
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

export function detectDevice() {
  const ua = navigator.userAgent;
  let browser = 'Unknown', platform = 'Unknown', deviceName = 'Unknown';

  if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Opera|OPR/.test(ua)) browser = 'Opera';

  if (/Windows/.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS/.test(ua)) platform = 'macOS';
  else if (/Linux/.test(ua)) platform = 'Linux';
  else if (/Android/.test(ua)) platform = 'Android';
  else if (/iPhone|iPad/.test(ua)) platform = 'iOS';

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (/Android/.test(ua)) { const m = ua.match(/; ([^;)]+) Build/); deviceName = m ? m[1] : 'Android Device'; }
  else if (/iPhone/.test(ua)) deviceName = 'iPhone';
  else if (/iPad/.test(ua)) deviceName = 'iPad';
  else deviceName = `${platform} / ${browser}`;

  return { browser, platform, deviceName, timezone: tz };
}

// VAPID key — served as static JSON in the repo
export async function getVapidPublicKey() {
  const data = await fetchStorage('vapid_keys');
  return data?.publicKey || null;
}

// Subscribe to push
export async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, error: 'Push notifications are not supported in this browser.' };
  }
  const reg = await navigator.serviceWorker.register(`${BASE}/sw.js`);
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, error: 'Notification permission denied.' };

  const vapidKey = await getVapidPublicKey();
  if (!vapidKey) return { ok: false, error: 'VAPID key not found. Ensure the scheduler has run at least once.' };

  try {
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    const { browser, platform, deviceName, timezone } = detectDevice();
    return { ok: true, subscription: sub.toJSON(), browser, platform, deviceName, timezone };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Load saved subscriber from localStorage
export function getSavedSubscription() {
  try { return JSON.parse(localStorage.getItem('cortex_subscriber') || 'null'); }
  catch { return null; }
}
export function saveSubscription(sub) {
  localStorage.setItem('cortex_subscriber', JSON.stringify(sub));
}
export function clearSubscription() {
  localStorage.removeItem('cortex_subscriber');
}

// API call to backend (for Replit environment) OR save to GitHub via API
// Since GitHub Pages is static, subscriber data must be sent to a backend.
// We use the GitHub API to update storage files directly from the browser.
export async function saveSubscriberToRepo(subscriberData) {
  const token = localStorage.getItem('cortex_gh_token');
  const repo = 'Joshbond123/CortexAlarm';
  const path = 'storage/subscribers.json';

  if (!token) return { ok: false, error: 'GitHub token not configured in Settings.' };

  // Fetch current file
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
  let sha = null, existing = [];

  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers });
    if (r.ok) {
      const f = await r.json();
      sha = f.sha;
      existing = JSON.parse(atob(f.content.replace(/\n/g, '')));
    }
  } catch { existing = []; }

  // Add or update subscriber
  const idx = existing.findIndex(s => s.endpoint === subscriberData.endpoint);
  if (idx >= 0) existing[idx] = { ...existing[idx], ...subscriberData };
  else existing.push(subscriberData);

  const content = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2))));
  const body = JSON.stringify({ message: 'chore: add subscriber', content, ...(sha ? { sha } : {}) });

  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers, body,
  });
  return { ok: r.ok, error: r.ok ? null : 'Failed to save subscriber to repo.' };
}

export async function removeSubscriberFromRepo(id) {
  const token = localStorage.getItem('cortex_gh_token');
  const repo = 'Joshbond123/CortexAlarm';
  const path = 'storage/subscribers.json';
  if (!token) return { ok: false };

  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers });
  if (!r.ok) return { ok: false };
  const f = await r.json();
  const existing = JSON.parse(atob(f.content.replace(/\n/g, '')));
  const filtered = existing.filter(s => s.id !== id);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(filtered, null, 2))));
  const body = JSON.stringify({ message: 'chore: remove subscriber', content, sha: f.sha });
  const r2 = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers, body,
  });
  return { ok: r2.ok };
}

// GitHub API helper for saving any JSON file
export async function saveJsonToRepo(path, data, message = 'chore: update storage') {
  const token = localStorage.getItem('cortex_gh_token');
  const repo = 'Joshbond123/CortexAlarm';
  if (!token) return { ok: false, error: 'No GitHub token.' };
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
  let sha = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers });
    if (r.ok) { const f = await r.json(); sha = f.sha; }
  } catch {}
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const body = JSON.stringify({ message, content, ...(sha ? { sha } : {}) });
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers, body,
  });
  return { ok: r.ok };
}

// HTML sidebar shared by all pages
export const SIDEBAR_HTML = `
<aside class="sidebar">
  <div class="sidebar-brand">
    <span class="icon">⊛</span>
    <span>CORTEX_ALARM</span>
    <span class="dot"></span>
  </div>
  <nav>
    <div class="nav-section">Navigation</div>
    <a class="nav-link" href="./index.html"><span class="icon">⬡</span><span>Dashboard</span></a>
    <a class="nav-link" href="./notifications.html"><span class="icon">◈</span><span>Inbox</span></a>
    <a class="nav-link" href="./timetable.html"><span class="icon">◫</span><span>Timetable</span></a>
    <div class="nav-section">System</div>
    <a class="nav-link" href="./settings.html"><span class="icon">⚙</span><span>Settings</span></a>
    <a class="nav-link" href="./keys.html"><span class="icon">⌗</span><span>API Keys</span></a>
    <a class="nav-link" href="./device.html"><span class="icon">⌖</span><span>Device</span></a>
    <a class="nav-link" href="./logs.html"><span class="icon">≡</span><span>Logs</span></a>
  </nav>
  <div class="sidebar-footer">
    <span class="status-dot"></span>
    <span>SYS_ONLINE</span>
  </div>
</aside>`;
