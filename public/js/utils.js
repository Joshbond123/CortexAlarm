// ── Shared utilities for Cortex Alarm GitHub Pages ──────────────

export const BASE = '/CortexAlarm';
export const REPO = 'Joshbond123/CortexAlarm';

// ── DOM helpers ──────────────────────────────────────────────────
export const $ = (s, ctx = document) => ctx.querySelector(s);
export const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];

// ── Toast notifications ──────────────────────────────────────────
export function toast(msg, type = 'info', duration = 3500) {
  let tc = document.getElementById('toast-container');
  if (!tc) { tc = document.createElement('div'); tc.id = 'toast-container'; document.body.appendChild(tc); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  tc.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; el.style.transition = 'all .3s'; setTimeout(() => el.remove(), 320); }, duration);
}

// ── Date/time formatting ─────────────────────────────────────────
export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
export function fmtShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ── Escape HTML ──────────────────────────────────────────────────
export function esc(s) {
  const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML;
}

// ── Storage fetch (reads JSON from repo) ─────────────────────────
export async function fetchStorage(name) {
  try {
    const r = await fetch(`${BASE}/storage/${name}.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── GitHub API write helper ──────────────────────────────────────
export async function saveJsonToRepo(path, data, message = 'chore: update storage') {
  const token = localStorage.getItem('cortex_gh_token');
  if (!token) return { ok: false, error: 'No GitHub token configured.' };
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
  let sha = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { headers });
    if (r.ok) { const f = await r.json(); sha = f.sha; }
  } catch {}
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT', headers,
    body: JSON.stringify({ message, content, ...(sha ? { sha } : {}) }),
  });
  return { ok: res.ok };
}

// ── VAPID / Push helpers ─────────────────────────────────────────
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export function detectDevice() {
  const ua = navigator.userAgent;
  let browser = 'Unknown', platform = 'Unknown', deviceName = 'Unknown';
  if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/OPR|Opera/.test(ua)) browser = 'Opera';
  if (/Windows/.test(ua)) platform = 'Windows';
  else if (/Android/.test(ua)) platform = 'Android';
  else if (/iPhone|iPad/.test(ua)) platform = 'iOS';
  else if (/Macintosh|Mac OS/.test(ua)) platform = 'macOS';
  else if (/Linux/.test(ua)) platform = 'Linux';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (/Android/.test(ua)) { const m = ua.match(/; ([^;)]+) Build/); deviceName = m ? m[1] : 'Android Device'; }
  else if (/iPhone/.test(ua)) deviceName = 'iPhone';
  else if (/iPad/.test(ua)) deviceName = 'iPad';
  else deviceName = `${platform} / ${browser}`;
  return { browser, platform, deviceName, timezone: tz };
}

export function getSavedSubscription() {
  try { return JSON.parse(localStorage.getItem('cortex_subscriber') || 'null'); } catch { return null; }
}
export function saveSubscription(s) { localStorage.setItem('cortex_subscriber', JSON.stringify(s)); }
export function clearSubscription() { localStorage.removeItem('cortex_subscriber'); }

export async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    return { ok: false, error: 'Push notifications are not supported in this browser.' };
  const reg = await navigator.serviceWorker.register(`${BASE}/sw.js`);
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, error: 'Notification permission denied.' };
  const vapid = await fetchStorage('vapid_keys');
  if (!vapid?.publicKey) return { ok: false, error: 'VAPID key not found. Run the scheduler at least once first.' };
  try {
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapid.publicKey) });
    return { ok: true, subscription: sub.toJSON(), ...detectDevice() };
  } catch (err) { return { ok: false, error: err.message }; }
}

export async function saveSubscriberToRepo(sub) {
  const token = localStorage.getItem('cortex_gh_token');
  if (!token) return { ok: false };
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
  let sha = null, existing = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/storage/subscribers.json`, { headers });
    if (r.ok) { const f = await r.json(); sha = f.sha; existing = JSON.parse(atob(f.content.replace(/\n/g, ''))); }
  } catch {}
  const idx = existing.findIndex(s => s.endpoint === sub.endpoint);
  if (idx >= 0) existing[idx] = { ...existing[idx], ...sub }; else existing.push(sub);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2))));
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/storage/subscribers.json`, {
    method: 'PUT', headers, body: JSON.stringify({ message: 'chore: add subscriber', content, ...(sha ? { sha } : {}) }),
  });
  return { ok: r.ok };
}

export async function removeSubscriberFromRepo(id) {
  const token = localStorage.getItem('cortex_gh_token');
  if (!token) return { ok: false };
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/storage/subscribers.json`, { headers });
  if (!r.ok) return { ok: false };
  const f = await r.json();
  const data = JSON.parse(atob(f.content.replace(/\n/g, ''))).filter(s => s.id !== id);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const r2 = await fetch(`https://api.github.com/repos/${REPO}/contents/storage/subscribers.json`, {
    method: 'PUT', headers, body: JSON.stringify({ message: 'chore: remove subscriber', content, sha: f.sha }),
  });
  return { ok: r2.ok };
}

// ── Notification type metadata ───────────────────────────────────
export const NOTIF_META = {
  morning:   { icon: '☀️', cls: 'morning',   label: 'Morning' },
  afternoon: { icon: '📚', cls: 'afternoon', label: 'Afternoon' },
  evening:   { icon: '🌙', cls: 'evening',   label: 'Evening' },
  weekend:   { icon: '🔁', cls: 'weekend',   label: 'Weekend' },
  manual:    { icon: '⚡', cls: 'manual',    label: 'Manual' },
};

// ── ND1 Timetable (2nd Semester) ─────────────────────────────────
export const TIMETABLE = {
  Monday: [
    { code: 'COM 121', subject: 'Programming Using C',       startTime: '08:00', endTime: '09:00' },
    { code: 'GNS 102', subject: 'Communication in English II', startTime: '09:00', endTime: '10:00' },
  ],
  Tuesday: [
    { code: 'COM 124', subject: 'Data Structures & Algorithms', startTime: '11:00', endTime: '12:00' },
    { code: 'MTH 121', subject: 'Calculus I',                   startTime: '13:00', endTime: '14:00' },
  ],
  Wednesday: [
    { code: 'COM 123', subject: 'Programming Using Java I', startTime: '08:00', endTime: '09:00' },
    { code: 'EED 126', subject: 'Entrepreneurship',         startTime: '10:00', endTime: '11:00' },
  ],
  Thursday: [
    { code: 'GNS 121', subject: 'Citizenship Education II', startTime: '12:00', endTime: '13:00' },
    { code: 'COM 125', subject: 'System Analysis & Design', startTime: '14:00', endTime: '15:00' },
  ],
  Friday: [
    { code: 'COM 126', subject: 'PC Upgrade & Maintenance', startTime: '08:00', endTime: '09:00' },
  ],
  Saturday: [],
  Sunday: [],
};

export const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function todayName() { return DAYS[new Date().getDay()]; }
export function todayLectures() { return TIMETABLE[todayName()] || []; }
export function lastLectureEnd(lectures) {
  if (!lectures?.length) return null;
  return [...lectures].sort((a,b) => a.endTime.localeCompare(b.endTime)).at(-1).endTime;
}
export function isWeekend(dayName) { return dayName === 'Saturday' || dayName === 'Sunday'; }

// ── Sidebar HTML ─────────────────────────────────────────────────
export function renderSidebar(activePage) {
  const links = [
    { href: 'index.html', icon: '⬡', label: 'Dashboard', id: 'dashboard' },
    { href: 'notifications.html', icon: '◈', label: 'Inbox', id: 'notifications' },
    { href: 'timetable.html', icon: '◫', label: 'Timetable', id: 'timetable' },
    { href: 'settings.html', icon: '⚙', label: 'Settings', id: 'settings' },
    { href: 'keys.html', icon: '⌗', label: 'API Keys', id: 'keys' },
    { href: 'device.html', icon: '⌖', label: 'Device', id: 'device' },
    { href: 'logs.html', icon: '≡', label: 'Logs', id: 'logs' },
  ];
  const navLinks = links.map(l => `
    <a class="nav-link${activePage === l.id ? ' active' : ''}" href="./${l.href}">
      <span class="nav-icon">${l.icon}</span>
      <span>${l.label}</span>
    </a>`).join('');
  return `
    <div class="sidebar-brand">
      <div class="brand-icon">⊛</div>
      <div><div class="brand-name">Cortex Alarm</div><div class="brand-sub">ND1 Study System</div></div>
      <div class="brand-pulse"></div>
    </div>
    <nav style="padding:8px 8px;flex:1">
      <div class="nav-group"><div class="nav-group-label">Main</div>
        ${navLinks.slice(0, 3 * (navLinks.split('nav-link').length))}
      </div>
    </nav>
    <div class="sidebar-footer">
      <div class="sys-dot"></div>
      <span class="sys-label">System Online</span>
    </div>`;
}
