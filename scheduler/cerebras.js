import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const STORAGE_DIR = join(process.cwd(), "storage");
const KEYS_FILE = join(STORAGE_DIR, "api_keys.json");

let keyIndex = 0;

function getKeys() {
  if (!existsSync(KEYS_FILE)) return [];
  try { return JSON.parse(readFileSync(KEYS_FILE, "utf-8")); }
  catch { return []; }
}

function saveKeys(keys) {
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

export async function generateMessage(prompt) {
  const allKeys = getKeys();
  const activeKeys = allKeys.filter((k) => k.active);
  if (!activeKeys.length) {
    console.log("[AI] No active Cerebras API keys. Using default message.");
    return null;
  }

  const startIndex = keyIndex % activeKeys.length;

  for (let attempts = 0; attempts < activeKeys.length; attempts++) {
    const idx = (startIndex + attempts) % activeKeys.length;
    const keyEntry = activeKeys[idx];
    keyIndex = (startIndex + attempts + 1) % activeKeys.length;

    // Update stats
    const all = getKeys();
    const k = all.find((x) => x.id === keyEntry.id);
    if (k) {
      k.requests = (k.requests || 0) + 1;
      k.lastUsed = new Date().toISOString();
      saveKeys(all);
    }

    try {
      const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keyEntry.key}`,
        },
        body: JSON.stringify({
          model: "llama3.1-8b",
          messages: [
            {
              role: "system",
              content:
                "You are a strict but supportive academic discipline coach for ND1 Computer Science students. Write professional, direct, motivational messages (2-3 sentences max). Always remind students that no one will teach them in the exam hall. No emojis. Be real, not generic.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 180,
          temperature: 0.75,
        }),
      });

      const all2 = getKeys();
      const k2 = all2.find((x) => x.id === keyEntry.id);

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        console.error(`[AI] Key ${keyEntry.id} failed: HTTP ${response.status} — ${err.slice(0, 80)}`);
        if (k2) { k2.fail = (k2.fail || 0) + 1; saveKeys(all2); }
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (k2) { k2.success = (k2.success || 0) + 1; saveKeys(all2); }
      if (content) { console.log(`[AI] Generated with key ${keyEntry.id.slice(0,8)}...`); return content; }
      continue;
    } catch (err) {
      console.error(`[AI] Request error for key ${keyEntry.id}: ${err.message}`);
      const all3 = getKeys();
      const k3 = all3.find((x) => x.id === keyEntry.id);
      if (k3) { k3.fail = (k3.fail || 0) + 1; saveKeys(all3); }
    }
  }

  console.log("[AI] All keys exhausted. Using default message.");
  return null;
}
