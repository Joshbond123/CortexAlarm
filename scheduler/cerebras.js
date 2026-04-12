// Cerebras AI client — gpt-oss-120b with key rotation
import { db } from './supabase.js';

let rotationIndex = 0;

async function getActiveKeys() {
  try {
    const rows = await db.select('api_keys', 'active=eq.true&order=created_at.asc');
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[AI] Failed to fetch API keys from Supabase:', err.message);
    // Fall back to environment variable
    const envKeys = (process.env.CEREBRAS_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    return envKeys.map((k, i) => ({ id: `env-${i}`, key: k, requests: 0, success: 0, fail: 0 }));
  }
}

async function updateKeyStats(id, success) {
  if (id.startsWith('env-')) return; // skip env fallback keys
  try {
    const rows = await db.select('api_keys', `id=eq.${id}`);
    if (!rows?.length) return;
    const k = rows[0];
    await db.update('api_keys', `id=eq.${id}`, {
      requests: (k.requests || 0) + 1,
      success:  (k.success  || 0) + (success ? 1 : 0),
      fail:     (k.fail     || 0) + (success ? 0 : 1),
      last_used: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[AI] Failed to update key stats:', err.message);
  }
}

export async function generateMessage(prompt) {
  const keys = await getActiveKeys();
  if (!keys.length) {
    console.log('[AI] No active Cerebras keys — skipping AI generation.');
    return null;
  }

  const start = rotationIndex % keys.length;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (start + attempt) % keys.length;
    const entry = keys[idx];
    rotationIndex = (start + attempt + 1) % keys.length;

    try {
      const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${entry.key}`,
        },
        body: JSON.stringify({
          model: 'gpt-oss-120b',
          messages: [
            {
              role: 'system',
              content:
                'You are a strict, professional academic discipline coach for ND1 Computer Science students in Nigeria. Write 2-3 direct, motivational sentences. Remind them that no one will teach them in the exam hall. Be real and impactful — not generic or cheerful. Never use emojis.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 180,
          temperature: 0.75,
        }),
        signal: AbortSignal.timeout(20000),
      });

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }

      if (!res.ok) {
        console.error(`[AI] Key ${entry.id.slice(0,8)} failed: HTTP ${res.status} — ${text.slice(0,80)}`);
        await updateKeyStats(entry.id, false);
        continue;
      }

      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) { await updateKeyStats(entry.id, false); continue; }

      await updateKeyStats(entry.id, true);
      console.log(`[AI] Generated with key ${entry.id.slice(0,8)}...`);
      return content;

    } catch (err) {
      console.error(`[AI] Request error for key ${entry.id.slice(0,8)}: ${err.message}`);
      await updateKeyStats(entry.id, false);
    }
  }

  console.log('[AI] All keys exhausted — using default message.');
  return null;
}
