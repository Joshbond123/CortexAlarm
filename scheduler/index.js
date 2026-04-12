import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import webpush from "web-push";
import { getTodayTimetable, getYesterdayTimetable, getLastLectureEndTime } from "./timetable.js";
import { generateMessage } from "./cerebras.js";

const STORAGE_DIR = join(process.cwd(), "storage");
const SUBS_FILE = join(STORAGE_DIR, "subscribers.json");
const NOTIFS_FILE = join(STORAGE_DIR, "notifications.json");
const VAPID_FILE = join(STORAGE_DIR, "vapid_keys.json");
const SETTINGS_FILE = join(STORAGE_DIR, "settings.json");
const LOGS_FILE = join(STORAGE_DIR, "logs.json");
const SENT_TODAY_FILE = join(STORAGE_DIR, "sent_today.json");

function ensureStorage() {
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

function appendLog(level, message, details) {
  const logs = read(LOGS_FILE, []);
  logs.unshift({
    id: crypto.randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
    details: details || null,
  });
  write(LOGS_FILE, logs.slice(0, 1000));
}

function getVapidKeys() {
  let keys = read(VAPID_FILE, null);
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    write(VAPID_FILE, keys);
  }
  return keys;
}

function getSettings() {
  const defaults = {
    aiEnabled: true,
    notificationsEnabled: true,
    morningTime: "06:00",
    afternoonTrigger: true,
    eveningTime: "18:00",
    timezone: "Africa/Lagos",
  };
  return { ...defaults, ...read(SETTINGS_FILE, {}) };
}

async function sendPush(title, body, type, aiGenerated = false) {
  const keys = getVapidKeys();
  webpush.setVapidDetails("mailto:cortexalarm@study.app", keys.publicKey, keys.privateKey);

  const subs = read(SUBS_FILE, []).filter((s) => s.active);
  const notification = {
    id: crypto.randomUUID(),
    title,
    body,
    type,
    sentAt: new Date().toISOString(),
    read: false,
    aiGenerated,
  };
  const notifs = read(NOTIFS_FILE, []);
  notifs.unshift(notification);
  write(NOTIFS_FILE, notifs.slice(0, 500));

  console.log(`[${type.toUpperCase()}] Sending: "${title}" to ${subs.length} subscriber(s)`);

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify({ title, body, type })
      );
      console.log(`  Sent to ${sub.deviceName}`);
    } catch (err) {
      console.error(`  Failed for ${sub.id}:`, err.message);
      if (err.statusCode === 410) {
        const cs = read(SUBS_FILE, []);
        const i = cs.findIndex((s) => s.id === sub.id);
        if (i !== -1) { cs[i].active = false; write(SUBS_FILE, cs); }
      }
    }
  }
}

function getCurrentHHMM(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = parts.find((p) => p.type === "hour")?.value || "00";
  const m = parts.find((p) => p.type === "minute")?.value || "00";
  return `${h}:${m}`;
}

function timesMatch(a, b, toleranceMinutes = 5) {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  const diff = Math.abs((ah * 60 + am) - (bh * 60 + bm));
  return diff <= toleranceMinutes;
}

function getSentToday() {
  const today = new Date().toDateString();
  const data = read(SENT_TODAY_FILE, { date: null, sent: [] });
  if (data.date !== today) return [];
  return data.sent;
}

function markSent(type) {
  const today = new Date().toDateString();
  const data = read(SENT_TODAY_FILE, { date: null, sent: [] });
  if (data.date !== today) {
    write(SENT_TODAY_FILE, { date: today, sent: [type] });
  } else {
    if (!data.sent.includes(type)) {
      data.sent.push(type);
      write(SENT_TODAY_FILE, data);
    }
  }
}

async function main() {
  ensureStorage();
  const settings = getSettings();

  if (!settings.notificationsEnabled) {
    console.log("Notifications are disabled. Exiting.");
    return;
  }

  const currentTime = getCurrentHHMM(settings.timezone);
  const sentToday = getSentToday();
  console.log(`Current time (${settings.timezone}): ${currentTime}`);
  console.log(`Already sent today: ${sentToday.join(", ") || "none"}`);

  const today = getTodayTimetable();
  const yesterday = getYesterdayTimetable();
  const lastLecture = getLastLectureEndTime(today);

  // Morning notification at configured time
  if (timesMatch(currentTime, settings.morningTime) && !sentToday.includes("morning")) {
    console.log("Triggering morning notification...");
    const yesterdayCourses = yesterday.lectures.map((l) => l.subject).join(", ") || "general review";

    let body = `Good morning. Yesterday's lectures covered: ${yesterdayCourses}. Before anything else, review those materials now. No one will teach you in the exam hall.`;

    if (settings.aiEnabled) {
      const aiMsg = await generateMessage(
        `Generate a morning study review reminder for an ND1 engineering student. Yesterday's courses were: ${yesterdayCourses}. Remind them to review these before the day begins. Be strict, professional, and motivating.`
      );
      if (aiMsg) { body = aiMsg; }
    }

    await sendPush("Morning Review Directive", body, "morning", settings.aiEnabled);
    markSent("morning");
    appendLog("success", "Morning notification sent");
  }

  // Afternoon notification - 1 hour after last lecture
  if (settings.afternoonTrigger && lastLecture && !sentToday.includes("afternoon")) {
    const [lh, lm] = lastLecture.split(":").map(Number);
    const afterH = Math.floor((lh * 60 + lm + 60) / 60);
    const afterM = (lh * 60 + lm + 60) % 60;
    const triggerTime = `${String(afterH).padStart(2, "0")}:${String(afterM).padStart(2, "0")}`;

    if (timesMatch(currentTime, triggerTime)) {
      console.log("Triggering afternoon notification...");
      const courses = today.lectures.map((l) => l.subject).join(", ") || "today's subjects";
      let body = `Lectures done for the day. The real work begins now. Review every note from today's classes: ${courses}. Consolidation is the difference between passing and failing.`;

      if (settings.aiEnabled) {
        const aiMsg = await generateMessage(
          `Generate a post-lecture study discipline message for an ND1 engineering student. Today's completed lectures were: ${courses}. Encourage them to review immediately. Be strict and professional.`
        );
        if (aiMsg) { body = aiMsg; }
      }

      await sendPush("Post-Lecture Consolidation", body, "afternoon", settings.aiEnabled);
      markSent("afternoon");
      appendLog("success", "Afternoon notification sent");
    }
  }

  // Evening notification at configured time
  if (timesMatch(currentTime, settings.eveningTime) && !sentToday.includes("evening")) {
    console.log("Triggering evening notification...");
    const courses = today.lectures.map((l) => l.subject).join(", ") || "today's subjects";
    let body = `Evening study session begins now. If you have not reviewed today's material: ${courses}, stop what you are doing and open your notes. Mediocrity is a choice. Don't make it.`;

    if (settings.aiEnabled) {
      const aiMsg = await generateMessage(
        `Generate an evening study discipline reminder for an ND1 engineering student. Today's subjects were: ${courses}. Remind them that evening study is non-negotiable. Be professional and strict.`
      );
      if (aiMsg) { body = aiMsg; }
    }

    await sendPush("Evening Study Directive", body, "evening", settings.aiEnabled);
    markSent("evening");
    appendLog("success", "Evening notification sent");
  }

  console.log("Scheduler run complete.");
}

main().catch((err) => {
  console.error("Scheduler error:", err);
  process.exit(1);
});
