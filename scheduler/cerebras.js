import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const STORAGE_DIR = join(process.cwd(), "storage");
const KEYS_FILE = join(STORAGE_DIR, "api_keys.json");

let keyIndex = 0;

function getKeys() {
  if (!existsSync(KEYS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveKeys(keys) {
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

export async function generateMessage(prompt) {
  const keys = getKeys().filter((k) => k.active);
  if (keys.length === 0) {
    console.log("No active Cerebras API keys. Using default message.");
    return null;
  }

  const startIndex = keyIndex % keys.length;
  let attempts = 0;

  while (attempts < keys.length) {
    const idx = (startIndex + attempts) % keys.length;
    const keyEntry = keys[idx];
    attempts++;
    keyIndex = (startIndex + attempts) % keys.length;

    const allKeys = getKeys();
    const k = allKeys.find((k) => k.id === keyEntry.id);
    if (!k) continue;

    k.requestCount = (k.requestCount || 0) + 1;
    k.lastUsed = new Date().toISOString();
    saveKeys(allKeys);

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
                "You are a strict academic discipline coach for ND1 engineering students. Your messages are professional, direct, motivational, and remind students that no one will teach them in the exam hall. Keep responses to 2-3 sentences maximum. No emojis.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 150,
          temperature: 0.8,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error(`Cerebras key ${keyEntry.id} failed: ${response.status} - ${err}`);
        const updatedKeys = getKeys();
        const ku = updatedKeys.find((k) => k.id === keyEntry.id);
        if (ku) {
          ku.failCount = (ku.failCount || 0) + 1;
          saveKeys(updatedKeys);
        }
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      const updatedKeys = getKeys();
      const ku = updatedKeys.find((k) => k.id === keyEntry.id);
      if (ku) {
        ku.successCount = (ku.successCount || 0) + 1;
        saveKeys(updatedKeys);
      }
      return content || null;
    } catch (err) {
      console.error(`Cerebras request failed for key ${keyEntry.id}:`, err.message);
      const updatedKeys = getKeys();
      const ku = updatedKeys.find((k) => k.id === keyEntry.id);
      if (ku) {
        ku.failCount = (ku.failCount || 0) + 1;
        saveKeys(updatedKeys);
      }
    }
  }

  return null;
}
