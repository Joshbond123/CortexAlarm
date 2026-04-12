import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const STORAGE_DIR = join(process.cwd(), "storage");
const SUBS_FILE = join(STORAGE_DIR, "subscribers.json");
const NOTIFS_FILE = join(STORAGE_DIR, "notifications.json");
const VAPID_FILE = join(STORAGE_DIR, "vapid_keys.json");

function ensureDir() {
  if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });
}

function read(file, def) {
  if (!existsSync(file)) return def;
  try { return JSON.parse(readFileSync(file, "utf-8")); }
  catch { return def; }
}

function write(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

export function getVapidKeys() {
  ensureDir();
  let keys = read(VAPID_FILE, null);
  if (!keys || !keys.publicKey) {
    keys = webpush.generateVAPIDKeys();
    write(VAPID_FILE, keys);
    console.log("Generated new VAPID keys");
  }
  return keys;
}

export async function sendNotifications(title, body, type, aiGenerated = false) {
  ensureDir();
  const keys = getVapidKeys();
  webpush.setVapidDetails("mailto:cortexalarm@study.app", keys.publicKey, keys.privateKey);

  const subs = read(SUBS_FILE, []).filter((s) => s.active);
  const notification = {
    id: crypto.randomUUID(),
    title, body, type,
    sentAt: new Date().toISOString(),
    read: false,
    aiGenerated,
  };

  const notifs = read(NOTIFS_FILE, []);
  notifs.unshift(notification);
  write(NOTIFS_FILE, notifs.slice(0, 500));

  console.log("[PUSH] Sending \"" + title + "\" to " + subs.length + " subscriber(s)...");

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify({ title, body, type, id: notification.id })
      );
      console.log("  Sent to " + (sub.deviceName || sub.id));
    } catch (err) {
      console.error("  Failed for " + sub.id + ": " + err.message);
      if (err.statusCode === 410) {
        const current = read(SUBS_FILE, []);
        const i = current.findIndex((s) => s.id === sub.id);
        if (i !== -1) { current[i].active = false; write(SUBS_FILE, current); }
      }
    }
  }
  return notification;
}
