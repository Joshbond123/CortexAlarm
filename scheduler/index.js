import webpush from 'web-push';
import { db } from './supabase.js';
import { generateMessage } from './cerebras.js';
import { getTodayTimetable, getYesterdayTimetable, getLastLectureEndTime, isWeekend, getAllCourses } from './timetable.js';

// ── Logging ───────────────────────────────────────────────────────
async function log(level, message, details = null) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  try {
    await db.insert('logs', { level, message, details, created_at: new Date().toISOString() });
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await db.delete('logs', `created_at=lt.${cutoff}`);
  } catch (err) {
    console.error('[LOG] Write failed:', err.message);
  }
}

// ── VAPID ─────────────────────────────────────────────────────────
async function getVapidKeys() {
  const rows = await db.select('vapid_keys', 'id=eq.1');
  const existing = rows?.[0];
  if (existing?.public_key && existing?.private_key) return existing;
  const keys = webpush.generateVAPIDKeys();
  await db.upsert('vapid_keys', { id: 1, public_key: keys.publicKey, private_key: keys.privateKey });
  await log('info', 'Generated new VAPID keys');
  return { public_key: keys.publicKey, private_key: keys.privateKey };
}

// ── Settings ──────────────────────────────────────────────────────
async function getSettings() {
  const defaults = {
    ai_enabled: true,
    notifications_enabled: true,
    morning_time: '06:00',
    evening_time: '18:00',
    afternoon_trigger: true,
    weekend_reminders: true,
    timezone: 'Africa/Lagos',
  };
  try {
    const rows = await db.select('settings', 'id=eq.1');
    return { ...defaults, ...(rows?.[0] || {}) };
  } catch { return defaults; }
}

// ── Time helpers ──────────────────────────────────────────────────
function nowHHMM(tz) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = p.find(x => x.type === 'hour')?.value   || '00';
  const m = p.find(x => x.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}

// Convert HH:MM to total minutes
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Returns true if current time is >= scheduled time AND <= scheduled + maxDelayMins
// This handles GitHub Actions cron delays gracefully — any run after the scheduled
// time (up to maxDelayMins late) will still fire the notification
function shouldFire(currentHHMM, scheduledHHMM, maxDelayMins = 90) {
  const cur  = toMinutes(currentHHMM);
  const sched = toMinutes(scheduledHHMM);
  return cur >= sched && cur <= sched + maxDelayMins;
}

// ── Sent-today dedup ──────────────────────────────────────────────
async function getSentToday() {
  const today = new Date().toDateString();
  const rows  = await db.select('sent_today', 'id=eq.1');
  const data  = rows?.[0] || {};
  return data.date === today ? (data.sent || []) : [];
}

async function markSent(type) {
  const today = new Date().toDateString();
  const sent  = await getSentToday();
  if (!sent.includes(type)) {
    await db.upsert('sent_today', { id: 1, date: today, sent: [...sent, type] });
  }
}

// ── Push notification with TTL + retry ────────────────────────────
// TTL=86400: push service holds the message for 24 hours and delivers it
// when the device comes online, instead of discarding immediately (TTL=0)
const PUSH_TTL = 86400;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

async function sendToSubscriber(pushConfig, payload, attempt = 1) {
  try {
    await webpush.sendNotification(pushConfig, payload, { TTL: PUSH_TTL });
    return { ok: true };
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Subscription expired or invalid — deactivate, do not retry
      return { ok: false, expired: true, code: err.statusCode };
    }
    if (attempt < MAX_RETRIES) {
      // Transient error — wait and retry
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      return sendToSubscriber(pushConfig, payload, attempt + 1);
    }
    return { ok: false, expired: false, error: err.message, code: err.statusCode };
  }
}

async function sendPush(title, body, type, aiGenerated = false) {
  const vapid = await getVapidKeys();
  webpush.setVapidDetails('mailto:cortexalarm@study.app', vapid.public_key, vapid.private_key);

  // Always store the notification so the Inbox shows it regardless of delivery
  await db.insert('notifications', {
    title, body, type,
    read: false,
    ai_generated: aiGenerated,
    sent_at: new Date().toISOString(),
  });

  const subs = await db.select('subscribers', 'active=eq.true');
  if (!Array.isArray(subs) || !subs.length) {
    await log('info', `No active subscribers — notification stored in inbox: "${title}"`);
    return;
  }

  const payload = JSON.stringify({ title, body, type });
  let sent = 0, failed = 0, expired = 0, retried = 0;

  for (const sub of subs) {
    const pushConfig = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    const result = await sendToSubscriber(pushConfig, payload);

    if (result.ok) {
      sent++;
    } else if (result.expired) {
      expired++;
      // Remove expired subscription from DB
      await db.update('subscribers', `id=eq.${sub.id}`, { active: false });
      await log('warn', `Subscription expired (${result.code}) — deactivated: ${sub.device_name || sub.id}`);
    } else {
      failed++;
      if (result.error?.includes('retry') || false) retried++;
      await log('warn', `Push failed for ${sub.device_name || sub.id}: ${result.error || result.code}`);
    }
  }

  const allFailed = sent === 0 && subs.length > 0;
  await log(
    allFailed ? 'error' : 'success',
    `Push "${title}": ${sent} delivered, ${failed} failed, ${expired} expired — TTL ${PUSH_TTL}s (24h queued delivery)`
  );
}

// ── Fallback messages (used when AI is disabled or unavailable) ───
// Every message reinforces: discipline + "no one will help in the exam hall"
const FALLBACKS = {
  morning_weekday: (yc) =>
    `Good morning. Yesterday you covered ${yc}. Do not move to today's lectures with unresolved gaps — review those notes now, close every gap, and go into class prepared. In the exam hall, no lecturer will be there. Only you and what you already know.`,

  morning_weekend: (day) =>
    `Good morning. Today is ${day} — no lectures, no structure, no one checking on you. That is exactly when discipline separates serious students from those who will struggle in May. Pick your weakest topic right now and study it for two focused hours. The exam hall does not reward intention; it rewards preparation.`,

  afternoon: (courses) =>
    `Lectures are done. The 60 minutes immediately after class are the most powerful for retention — your memory of today's material is at its peak right now. Open your notes for ${courses} and consolidate before it fades. No one will walk you through these topics in the exam hall.`,

  evening_weekday: (courses) =>
    `Evening check. Before you rest, do a final review of ${courses}. This is not optional — a deliberate 30-minute revision before sleep is scientifically proven to lock content into long-term memory. The students sitting next to you in the exam hall will not be able to help you. Study tonight.`,

  evening_weekend: () =>
    `The day is ending. Take 20 minutes right now to recall the key concepts you studied today — not by reading, but by writing them from memory. If you cannot recall it now, you will not recall it in the exam hall. Find the gaps tonight while you still have time to fix them.`,
};

// ── AI prompts ────────────────────────────────────────────────────
// Every prompt instructs the model to include the "exam hall" theme naturally
const SYSTEM_PROMPT = `You are a firm, focused academic discipline coach for ND1 Computer Science students in Nigeria.
Write exactly 2-3 sentences. Rules:
- Be direct, specific, and psychologically sharp
- Every message must naturally include the idea that in the exam hall, no one will help the student — only their own preparation will matter
- Use simple, clear English — no complex words, no slang
- Sound professional and serious, not cheerful or generic
- NO emojis, NO phrases like "keep going", "you can do it", "great work", or "I believe in you"
- Focus on discipline, responsibility, and the real consequences of not studying
- The student is in Nigeria studying for ND1 CS exams — make it feel real and relevant`;

function buildPrompt(context) {
  return `${context}\n\nWrite a 2-3 sentence push notification that includes the exam hall consequence naturally.`;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const settings  = await getSettings();
  if (!settings.notifications_enabled) {
    console.log('[SCHEDULER] Notifications disabled — skipping.');
    return;
  }

  const tz      = settings.timezone || 'Africa/Lagos';
  const current = nowHHMM(tz);
  const today   = getTodayTimetable(tz);
  const yesterday = getYesterdayTimetable(tz);
  const weekend = isWeekend(today);

  const sentToday = await getSentToday();

  console.log(`\n[SCHEDULER] ${new Date().toISOString()}`);
  console.log(`  Day: ${today.day} | Time: ${current} (${tz}) | Weekend: ${weekend}`);
  console.log(`  Sent today: ${sentToday.join(', ') || 'none'}`);

  let fired = 0;

  // ── Morning ─────────────────────────────────────────────────────
  // Fire if: morning time has passed today AND not already sent
  if (shouldFire(current, settings.morning_time) && !sentToday.includes('morning')) {
    if (!weekend || settings.weekend_reminders) {
      let body, prompt;

      if (weekend) {
        const day = today.day;
        prompt = buildPrompt(`It is ${day} morning. No lectures today. All semester courses: ${getAllCourses().join(', ')}. The student needs a reminder to study their weakest topic. Emphasise that weekends without structure often lead to exam failure.`);
        body = FALLBACKS.morning_weekend(day);
      } else {
        const yc = yesterday.lectures.map(l => `${l.code} (${l.subject})`).join(', ') || 'previous material';
        prompt = buildPrompt(`It is a weekday morning. Yesterday's courses were: ${yc}. The student needs to review those before today's lectures. Stress that unclosed gaps compound over time.`);
        body = FALLBACKS.morning_weekday(yc);
      }

      if (settings.ai_enabled) {
        const ai = await generateMessage(SYSTEM_PROMPT, prompt);
        if (ai) body = ai;
      }

      const title = weekend ? `${today.day} Morning Revision` : 'Morning Review — Open Your Notes';
      await sendPush(title, body, weekend ? 'weekend' : 'morning', settings.ai_enabled);
      await markSent('morning');
      fired++;
      await log('info', `Morning notification fired at ${current} (scheduled ${settings.morning_time})`);
    }
  }

  // ── Post-lecture (weekday only) ──────────────────────────────────
  if (!weekend && settings.afternoon_trigger && !sentToday.includes('afternoon')) {
    const lastEnd = getLastLectureEndTime(today);
    if (lastEnd) {
      const [lh, lm] = lastEnd.split(':').map(Number);
      const trigMin  = lh * 60 + lm + 60;
      const trigger  = `${String(Math.floor(trigMin / 60)).padStart(2,'0')}:${String(trigMin % 60).padStart(2,'0')}`;

      if (shouldFire(current, trigger, 90)) {
        const courses = today.lectures.map(l => `${l.code} (${l.subject})`).join(', ');
        const prompt = buildPrompt(`Lectures just ended for the day. Today's subjects: ${courses}. The student should consolidate notes immediately while the content is fresh. Stress the cost of delayed revision.`);
        let body = FALLBACKS.afternoon(courses);
        if (settings.ai_enabled) {
          const ai = await generateMessage(SYSTEM_PROMPT, prompt);
          if (ai) body = ai;
        }
        await sendPush('Post-Lecture — Consolidate Now', body, 'afternoon', settings.ai_enabled);
        await markSent('afternoon');
        fired++;
        await log('info', `Post-lecture notification fired at ${current} (1hr after ${lastEnd})`);
      }
    }
  }

  // ── Evening ──────────────────────────────────────────────────────
  if (shouldFire(current, settings.evening_time) && !sentToday.includes('evening')) {
    if (!weekend || settings.weekend_reminders) {
      let body, prompt;

      if (weekend) {
        prompt = buildPrompt(`It is ${today.day} evening. The student should review what they studied today and plan for the coming week. Stress that consistent evening reviews separate passing students from failing ones.`);
        body = FALLBACKS.evening_weekend();
      } else {
        const tc = today.lectures.map(l => `${l.code} (${l.subject})`).join(', ') || "today's material";
        prompt = buildPrompt(`It is a weekday evening. Today's lectures were: ${tc}. This is the last review window before sleep. Stress that a pre-sleep review dramatically improves long-term retention.`);
        body = FALLBACKS.evening_weekday(tc);
      }

      if (settings.ai_enabled) {
        const ai = await generateMessage(SYSTEM_PROMPT, prompt);
        if (ai) body = ai;
      }

      const title = weekend ? `${today.day} Evening Prep` : 'Evening Study Directive';
      await sendPush(title, body, weekend ? 'weekend' : 'evening', settings.ai_enabled);
      await markSent('evening');
      fired++;
      await log('info', `Evening notification fired at ${current} (scheduled ${settings.evening_time})`);
    }
  }

  if (fired === 0) {
    console.log('[SCHEDULER] No notifications due this run.');
  } else {
    console.log(`[SCHEDULER] ${fired} notification(s) sent.`);
  }

  console.log('[SCHEDULER] Run complete.\n');
}

main().catch(err => {
  console.error('[SCHEDULER] Fatal error:', err);
  process.exit(1);
});
