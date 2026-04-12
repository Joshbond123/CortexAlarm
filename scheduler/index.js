import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import webpush from "web-push";
import { getTodayTimetable, getYesterdayTimetable, getLastLectureEndTime, isWeekend, getAllCourseNames } from "./timetable.js";
import { generateMessage } from "./cerebras.js";

const STORAGE_DIR = join(process.cwd(), "storage");
const SUBS_FILE    = join(STORAGE_DIR, "subscribers.json");
const NOTIFS_FILE  = join(STORAGE_DIR, "notifications.json");
const VAPID_FILE   = join(STORAGE_DIR, "vapid_keys.json");
const SETTINGS_FILE = join(STORAGE_DIR, "settings.json");
const LOGS_FILE    = join(STORAGE_DIR, "logs.json");
const SENT_FILE    = join(STORAGE_DIR, "sent_today.json");

// ── File helpers ─────────────────────────────────────────────────
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

// ── Logging ──────────────────────────────────────────────────────
function log(level, message, details) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  const logs = read(LOGS_FILE, []);
  logs.unshift({ id: crypto.randomUUID(), level, message, details: details || null, timestamp: new Date().toISOString() });
  write(LOGS_FILE, logs.slice(0, 1000));
}

// ── VAPID keys ───────────────────────────────────────────────────
function getVapidKeys() {
  let keys = read(VAPID_FILE, null);
  if (!keys || !keys.publicKey) {
    keys = webpush.generateVAPIDKeys();
    write(VAPID_FILE, keys);
    log("info", "Generated new VAPID keys");
  }
  return keys;
}

// ── Settings ─────────────────────────────────────────────────────
function getSettings() {
  return {
    aiEnabled: true,
    notificationsEnabled: true,
    morningTime: "06:00",
    eveningTime: "18:00",
    afternoonTrigger: true,
    weekendReminders: true,
    timezone: "Africa/Lagos",
    ...read(SETTINGS_FILE, {}),
  };
}

// ── Current time in timezone ─────────────────────────────────────
function getCurrentHHMM(timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value || "00";
  const m = parts.find((p) => p.type === "minute")?.value || "00";
  return `${h}:${m}`;
}

function timesMatch(a, b, toleranceMinutes = 4) {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  return Math.abs(ah * 60 + am - (bh * 60 + bm)) <= toleranceMinutes;
}

// ── Duplicate send prevention ─────────────────────────────────────
function getSentToday() {
  const today = new Date().toDateString();
  const data = read(SENT_FILE, { date: null, sent: [] });
  if (data.date !== today) return [];
  return data.sent;
}

function markSent(type) {
  const today = new Date().toDateString();
  const data = read(SENT_FILE, { date: null, sent: [] });
  const sent = data.date === today ? data.sent : [];
  if (!sent.includes(type)) sent.push(type);
  write(SENT_FILE, { date: today, sent });
}

// ── Send push to all subscribers ──────────────────────────────────
async function sendPush(title, body, type, aiGenerated = false) {
  const keys = getVapidKeys();
  webpush.setVapidDetails("mailto:cortexalarm@study.app", keys.publicKey, keys.privateKey);

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

  const subs = read(SUBS_FILE, []).filter((s) => s.active);
  log("info", `Sending "${title}" [${type}] to ${subs.length} subscriber(s)`);

  let sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify({ title, body, type, id: notification.id })
      );
      sent++;
      console.log(`  ✓ Sent to ${sub.deviceName || sub.id}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ Failed for ${sub.id}: ${err.message}`);
      if (err.statusCode === 410) {
        const current = read(SUBS_FILE, []);
        const i = current.findIndex((s) => s.id === sub.id);
        if (i !== -1) { current[i].active = false; write(SUBS_FILE, current); }
      }
    }
  }

  log(failed === subs.length && subs.length > 0 ? "error" : "success",
    `Push sent: ${sent} delivered, ${failed} failed`);
}

// ── Main scheduler logic ──────────────────────────────────────────
async function main() {
  ensureStorage();
  const settings = getSettings();

  if (!settings.notificationsEnabled) {
    log("info", "Notifications disabled — skipping");
    return;
  }

  const tz = settings.timezone || "Africa/Lagos";
  const currentTime = getCurrentHHMM(tz);
  const sentToday = getSentToday();
  const today = getTodayTimetable(tz);
  const yesterday = getYesterdayTimetable(tz);
  const weekend = isWeekend(today);

  console.log(`\n[SCHEDULER] ${new Date().toISOString()}`);
  console.log(`  Timezone: ${tz} | Local time: ${currentTime}`);
  console.log(`  Day: ${today.day} | Weekend: ${weekend}`);
  console.log(`  Sent today: ${sentToday.join(", ") || "none"}`);

  // ── Morning notification ──────────────────────────────────────
  if (timesMatch(currentTime, settings.morningTime) && !sentToday.includes("morning")) {
    let body, prompt;

    if (weekend) {
      // Weekend morning: revision of weak/pending topics
      const allCourses = getAllCourseNames().join(", ");
      prompt = `Generate a Saturday/Sunday morning study reminder for an ND1 Computer Science student. Today is ${today.day} — no lectures. All courses this semester: ${allCourses}. Tell them to identify their weakest topics and dedicate focused time to revising them today. Be strict, professional, and direct. No emojis.`;
      body = `Good morning. Today is ${today.day} — no lectures, which means zero excuses. Identify your weakest topic from this semester's courses and spend focused time on it. Remember: no one will teach you in the exam hall. Open your notes.`;
    } else {
      const yesterdayCourses = yesterday.lectures.map((l) => `${l.code} (${l.subject})`).join(", ") || "previous work";
      prompt = `Generate a morning study reminder for an ND1 Computer Science student. Yesterday's courses were: ${yesterdayCourses}. Remind them to review these materials before attending today's lectures. Be strict, professional, and direct. No emojis.`;
      body = `Good morning. Yesterday you covered: ${yesterdayCourses}. Review those notes before class today — understanding compounds and gaps widen fast. No one will rescue you in the exam hall.`;
    }

    if (settings.aiEnabled) {
      const ai = await generateMessage(prompt);
      if (ai) body = ai;
    }

    const title = weekend ? `${today.day} Morning Revision` : "Morning Review Directive";
    await sendPush(title, body, weekend ? "weekend" : "morning", settings.aiEnabled);
    markSent("morning");
    log("success", `Morning notification sent (${today.day})`);
  }

  // ── Post-lecture notification (weekdays only) ─────────────────
  if (!weekend && settings.afternoonTrigger && !sentToday.includes("afternoon")) {
    const lastEnd = getLastLectureEndTime(today);
    if (lastEnd) {
      const [lh, lm] = lastEnd.split(":").map(Number);
      const total = lh * 60 + lm + 60;
      const triggerTime = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

      if (timesMatch(currentTime, triggerTime)) {
        const courses = today.lectures.map((l) => `${l.code} (${l.subject})`).join(", ") || "today's subjects";
        const prompt = `Generate a post-lecture study consolidation message for an ND1 Computer Science student. Today's completed lectures were: ${courses}. Urge them to review all lecture notes immediately. Be strict and professional. No emojis.`;
        let body = `Lectures done for the day. Now consolidate: review every note from ${courses}. This is where understanding is either locked in or lost. The exam hall has no lectures — only what you already know.`;

        if (settings.aiEnabled) {
          const ai = await generateMessage(prompt);
          if (ai) body = ai;
        }

        await sendPush("Post-Lecture Consolidation", body, "afternoon", settings.aiEnabled);
        markSent("afternoon");
        log("success", "Post-lecture notification sent");
      }
    }
  }

  // ── Evening notification ──────────────────────────────────────
  if (timesMatch(currentTime, settings.eveningTime) && !sentToday.includes("evening")) {
    let body, prompt;

    if (weekend) {
      // Weekend evening: read before sleep, prepare for next week
      const allCourses = getAllCourseNames().join(", ");
      prompt = `Generate a weekend evening study reminder for an ND1 Computer Science student. Today is ${today.day}. Tell them to review what they studied today, read ahead, and prepare mentally for the coming week. Courses this semester: ${allCourses}. Be strict, professional. No emojis.`;
      body = `Evening check-in. Before you sleep tonight, review everything you studied today. Read ahead for next week's lectures. Consistent daily preparation is the only thing that separates those who pass from those who don't.`;
    } else {
      const courses = today.lectures.map((l) => `${l.code} (${l.subject})`).join(", ") || "today's subjects";
      prompt = `Generate an evening study discipline message for an ND1 Computer Science student. Today's subjects were: ${courses}. Tell them to do a final review session before sleep. Be strict, professional. No emojis.`;
      body = `Evening directive: if you have not yet reviewed today's material (${courses}), do it now. A final pass before sleep locks information into long-term memory. Discipline today is performance in the exam hall.`;
    }

    if (settings.aiEnabled) {
      const ai = await generateMessage(prompt);
      if (ai) body = ai;
    }

    const title = weekend ? `${today.day} Evening Prep` : "Evening Study Directive";
    await sendPush(title, body, weekend ? "weekend" : "evening", settings.aiEnabled);
    markSent("evening");
    log("success", `Evening notification sent (${today.day})`);
  }

  console.log("\n[SCHEDULER] Run complete.\n");
}

main().catch((err) => {
  console.error("[SCHEDULER] Fatal error:", err);
  process.exit(1);
});
