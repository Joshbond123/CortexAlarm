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

// Returns true if the current time is at or past the scheduled time.
// There is NO upper bound — the sentToday dedup table is the sole guard against
// re-firing. This ensures the scheduler always fires each slot once per day even
// if GitHub Actions runs hours late (common with free-tier cron scheduling).
function shouldFire(currentHHMM, scheduledHHMM) {
  return toMinutes(currentHHMM) >= toMinutes(scheduledHHMM);
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
// TTL=2419200 (28 days — the maximum allowed by the Web Push protocol).
// The browser push service (FCM/Mozilla) holds the message for up to 28 days
// and delivers it the moment the device comes back online, regardless of how
// long it has been offline. Nothing is dropped as long as the subscription
// is still valid.
const PUSH_TTL = 2419200;
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
    `Push "${title}": ${sent} delivered, ${failed} failed, ${expired} expired — TTL ${PUSH_TTL}s (28-day queued delivery)`
  );
}

// ── Fallback messages (used when AI is disabled or unavailable) ───
// Focus: daily discipline and consistency — no exam dates, no countdowns
const FALLBACKS = {
  morning_weekday: (yc) =>
    `Good morning. Yesterday you covered ${yc} — do not move forward with unresolved gaps. Review those notes now, close what you do not yet understand, and go into class prepared. In the exam hall, you will rely only on what you have built yourself.`,

  morning_weekend: (day) =>
    `Good morning. Today is ${day} — no lectures, no structure, no one pushing you. This is exactly where consistent students separate from inconsistent ones. Open your books now and spend two focused hours on your weakest topic; the habit of daily study is what builds real understanding.`,

  afternoon: (courses) =>
    `The time immediately after class is the most powerful for retention — your memory of today's material is at its peak right now. Open your notes for ${courses} and consolidate before it fades. What you do not reinforce today will remain a weakness, and in the exam hall, no one will clarify it for you.`,

  evening_weekday: (courses) =>
    `Before you rest, take 30 minutes to review ${courses}. A consistent evening revision builds the long-term understanding that no cramming session can replace. What you understand deeply today is what you will be able to apply on your own when it matters.`,

  evening_weekend: () =>
    `Take 20 minutes right now to recall the key ideas you studied today — write them from memory, not by re-reading. If you cannot recall it now, you will not recall it when you need it most. Find those gaps tonight while you still have time to address them.`,
};

// ── AI prompts ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a firm, focused academic discipline coach for ND1 Computer Science students in Nigeria.
Write exactly 2-3 sentences. Rules:
- Be direct, specific, and psychologically sharp
- Focus on daily discipline, consistent reading habits, and personal responsibility
- Naturally include the idea that in the exam hall, the student relies only on what they have prepared themselves — present this as a fact about self-reliance, not as urgency or threat
- Use simple, clear English — no complex words, no slang
- Sound professional and serious, not cheerful or generic
- NO emojis, NO phrases like "keep going", "you can do it", "great work", or "I believe in you"
- NEVER mention exam dates, countdowns, weeks or days remaining, or any specific timeline
- NEVER create urgency based on when exams are — urgency must come from the value of daily consistency, not from a deadline
- Focus on building the habit of regular study as the foundation of real understanding`;

function buildPrompt(context) {
  return `${context}\n\nWrite a 2-3 sentence push notification focused on daily discipline and consistent study habits. Include the idea that the student relies only on their own preparation — naturally, not as a warning.`;
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
        prompt = buildPrompt(`It is ${day} morning. No lectures today. All semester courses: ${getAllCourses().join(', ')}. The student needs a reminder to study their weakest topic. Emphasise that consistent daily study — especially on unstructured days — is what builds real, lasting understanding.`);
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

      if (shouldFire(current, trigger)) {
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
        prompt = buildPrompt(`It is ${today.day} evening. The student should review what they studied today. Emphasise that a consistent evening review is a daily habit that builds deep understanding over time — not a reaction to upcoming exams.`);
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
