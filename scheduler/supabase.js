// Supabase REST client (server-side, uses service_role key)
const BASE = process.env.SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_KEY;

if (!BASE || !KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required.');
}

async function req(method, table, qs = '', body = null, prefer = '') {
  const url = `${BASE}/rest/v1/${table}${qs ? `?${qs}` : ''}`;
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;

  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204 || method === 'DELETE') return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} /${table}: ${res.status} — ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

export const db = {
  select:  (table, qs = '')     => req('GET',   table, qs),
  insert:  (table, body)        => req('POST',  table, '', body, 'return=representation'),
  update:  (table, qs, body)    => req('PATCH', table, qs, body, 'return=representation'),
  upsert:  (table, body)        => req('POST',  table, '', body, 'resolution=merge-duplicates,return=representation'),
  delete:  (table, qs)          => req('DELETE', table, qs),
};
