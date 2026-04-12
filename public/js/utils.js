// Cortex Alarm — Shared Utilities
const BASE = '/CortexAlarm';

// SVG icons for nav
const NAV_ICONS = {
  dashboard: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  inbox:     `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  timetable: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  settings:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  logs:      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
};

// ── Navigation ────────────────────────────────────────────────────
const NAV_PAGES = [
  { href: `${BASE}/index.html`,         iconKey: 'dashboard', label: 'Dashboard' },
  { href: `${BASE}/notifications.html`, iconKey: 'inbox',     label: 'Inbox'     },
  { href: `${BASE}/timetable.html`,     iconKey: 'timetable', label: 'Schedule'  },
  { href: `${BASE}/settings.html`,      iconKey: 'settings',  label: 'Settings'  },
  { href: `${BASE}/logs.html`,          iconKey: 'logs',      label: 'Logs'      },
];

function buildNav(activePage) {
  const path = window.location.pathname;

  // Desktop sidebar
  const sidebar = document.getElementById('sidebar-nav');
  if (sidebar) {
    sidebar.innerHTML = NAV_PAGES.map(p => {
      const active = path.includes(p.href.split('/').at(-1).replace('.html', '')) || (p.href.includes('index') && (path.endsWith('/') || path.includes('index')));
      return `<a href="${p.href}" class="nav-item ${active ? 'active' : ''}">
        <span class="nav-icon">${NAV_ICONS[p.iconKey]}</span>
        <span class="nav-label">${p.label}</span>
      </a>`;
    }).join('');
  }

  // Mobile bottom bar
  const bottomBar = document.getElementById('bottom-nav');
  if (bottomBar) {
    bottomBar.innerHTML = NAV_PAGES.map(p => {
      const file = p.href.split('/').at(-1).replace('.html', '');
      const active = path.includes(file) || (file === 'index' && (path.endsWith('/') || path.includes('index')));
      return `<a href="${p.href}" class="bottom-nav-item ${active ? 'active' : ''}">
        <span class="bottom-nav-icon">${NAV_ICONS[p.iconKey]}</span>
        <span class="bottom-nav-label">${p.label}</span>
      </a>`;
    }).join('');
  }
}

// ── Time format ───────────────────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Toast ─────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
}

// ── ND1 Timetable (client side) ───────────────────────────────────
const ND1_TIMETABLE = [
  { day: 'Monday',    lectures: [
    { code: 'COM 121', subject: 'Programming Using C',          startTime: '08:00', endTime: '09:00' },
    { code: 'GNS 102', subject: 'Communication in English II',  startTime: '09:00', endTime: '10:00' },
  ]},
  { day: 'Tuesday',   lectures: [
    { code: 'COM 124', subject: 'Data Structures & Algorithms', startTime: '11:00', endTime: '12:00' },
    { code: 'MTH 121', subject: 'Calculus I',                   startTime: '13:00', endTime: '14:00' },
  ]},
  { day: 'Wednesday', lectures: [
    { code: 'COM 123', subject: 'Programming Using Java I',     startTime: '08:00', endTime: '09:00' },
    { code: 'EED 126', subject: 'Entrepreneurship',             startTime: '10:00', endTime: '11:00' },
  ]},
  { day: 'Thursday',  lectures: [
    { code: 'GNS 121', subject: 'Citizenship Education II',     startTime: '12:00', endTime: '13:00' },
    { code: 'COM 125', subject: 'System Analysis & Design',     startTime: '14:00', endTime: '15:00' },
  ]},
  { day: 'Friday',    lectures: [
    { code: 'COM 126', subject: 'PC Upgrade & Maintenance',     startTime: '08:00', endTime: '09:00' },
  ]},
  { day: 'Saturday',  lectures: [] },
  { day: 'Sunday',    lectures: [] },
];

function getTodaySchedule() {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'long' }).format(new Date());
  return ND1_TIMETABLE.find(d => d.day === day) || { day, lectures: [] };
}

window.utils = { buildNav, fmtTime, timeAgo, toast, ND1_TIMETABLE, getTodaySchedule };
