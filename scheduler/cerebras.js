// Cerebras AI client — llama3.1-8b with key rotation
import { db } from './supabase.js';

let rotationIndex = 0;

async function getActiveKeys() {
  try {
    const rows = await db.select('api_keys', 'active=eq.true&order=created_at.asc');
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[AI] Failed to fetch API keys from Supabase:', err.message);
    const envKeys = (process.env.CEREBRAS_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    return envKeys.map((k, i) => ({ id: `env-${i}`, key: k, requests: 0, success: 0, fail: 0 }));
  }
}

async function updateKeyStats(id, success) {
  if (id.startsWith('env-')) return;
  try {
    const rows = await db.select('api_keys', `id=eq.${id}`);
    if (!rows?.length) return;
    const k = rows[0];
    await db.update('api_keys', `id=eq.${id}`, {
      requests:  (k.requests || 0) + 1,
      success:   (k.success  || 0) + (success ? 1 : 0),
      fail:      (k.fail     || 0) + (success ? 0 : 1),
      last_used: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[AI] Failed to update key stats:', err.message);
  }
}

// generateMessage(systemPrompt, userPrompt)
// systemPrompt: the strict persona/rules for the AI
// userPrompt:   the specific study context for this notification
export async function generateMessage(systemPrompt, userPrompt) {
  const keys = await getActiveKeys();
  if (!keys.length) {
    console.log('[AI] No active Cerebras keys — using fallback message.');
    return null;
  }

  const start = rotationIndex % keys.length;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx   = (start + attempt) % keys.length;
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
          model: 'llama3.1-8b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
          max_tokens: 160,
          temperature: 0.82,
        }),
        signal: AbortSignal.timeout(20000),
      });

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }

      if (!res.ok) {
        console.error(`[AI] Key ${entry.id.slice(0,8)} HTTP ${res.status}: ${text.slice(0,80)}`);
        await updateKeyStats(entry.id, false);
        continue;
      }

      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) {
        await updateKeyStats(entry.id, false);
        continue;
      }

      await updateKeyStats(entry.id, true);
      console.log(`[AI] Generated with key ${entry.id.slice(0,8)}… (${content.length} chars)`);
      return content;

    } catch (err) {
      console.error(`[AI] Request error for key ${entry.id.slice(0,8)}: ${err.message}`);
      await updateKeyStats(entry.id, false);
    }
  }

  console.log('[AI] All keys exhausted — using fallback message.');
  return null;
}
