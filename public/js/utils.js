// Cortex Alarm — Shared Utilities
const BASE = '/CortexAlarm';

// ── Navigation ────────────────────────────────────────────────────
const NAV_PAGES = [
  { href: `${BASE}/index.html`,         icon: '◈', label: 'Dashboard' },
  { href: `${BASE}/notifications.html`, icon: '◉', label: 'Inbox'     },
  { href: `${BASE}/timetable.html`,     icon: '◷', label: 'Timetable' },
  { href: `${BASE}/settings.html`,      icon: '◎', label: 'Settings'  },
  { href: `${BASE}/logs.html`,          icon: '◈', label: 'Logs'      },
];

function buildNav(activePage) {
  const path = window.location.pathname;

  // Desktop sidebar
  const sidebar = document.getElementById('sidebar-nav');
  if (sidebar) {
    sidebar.innerHTML = NAV_PAGES.map(p => {
      const active = path.includes(p.href.split('/').at(-1).replace('.html', '')) || (p.href.includes('index') && (path.endsWith('/') || path.includes('index')));
      return `<a href="${p.href}" class="nav-item ${active ? 'active' : ''}">
        <span class="nav-icon">${p.icon}</span><span class="nav-label">${p.label}</span>
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
        <span class="bottom-nav-icon">${p.icon}</span>
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
