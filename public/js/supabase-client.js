// Cortex Alarm — Supabase client (frontend, anon key only)
const SUPABASE_URL  = 'https://gplatvbhqwqcmceawtub.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwbGF0dmJocXdxY21jZWF3dHViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMDM0MDAsImV4cCI6MjA5MTU3OTQwMH0.Fwr0jhD9bwzHiND2errtkBxzEXEpsR8ma2YFYW5KpXw';

async function sbFetch(method, table, qs = '', body = null, prefer = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`;
  const headers = {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} /${table}: ${res.status} — ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

window.sb = {
  select:  (table, qs = '')  => sbFetch('GET',    table, qs),
  insert:  (table, body)     => sbFetch('POST',   table, '', body, 'return=representation'),
  update:  (table, qs, body) => sbFetch('PATCH',  table, qs, body, 'return=representation'),
  upsert:  (table, body)     => sbFetch('POST',   table, '', body, 'resolution=merge-duplicates,return=representation'),
  delete:  (table, qs)       => sbFetch('DELETE', table, qs),
};

window.SUPABASE_URL  = SUPABASE_URL;
window.SUPABASE_ANON = SUPABASE_ANON;
