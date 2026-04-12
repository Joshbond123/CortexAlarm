import webpush from 'web-push';
import { db } from './supabase.js';
import { generateMessage } from './cerebras.js';
import { getTodayTimetable, getYesterdayTimetable, getLastLectureEndTime, isWeekend, getAllCourses } from './timetable.js';

// ── Logging ───────────────────────────────────────────────────────
async function log(level, message, details = null) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  try {
    await db.insert('logs', { level, message, details, created_at: new Date().toISOString() });
    // Keep log table trim (delete entries older than 30 days)
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
  // Generate new keys
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
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = p.find(x => x.type === 'hour')?.value   || '00';
  const m = p.find(x => x.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}

function timesMatch(a, b, tol = 5) {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return Math.abs(ah * 60 + am - (bh * 60 + bm)) <= tol;
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

// ── Push notification ─────────────────────────────────────────────
async function sendPush(title, body, type, aiGenerated = false) {
  const vapid = await getVapidKeys();
  webpush.setVapidDetails('mailto:cortexalarm@study.app', vapid.public_key, vapid.private_key);

  // Store notification in Supabase
  await db.insert('notifications', {
    title, body, type,
    read: false,
    ai_generated: aiGenerated,
    sent_at: new Date().toISOString(),
  });

  const subs = await db.select('subscribers', 'active=eq.true');
  if (!Array.isArray(subs) || !subs.length) {
    await log('info', `No active subscribers — notification stored: "${title}"`);
    return;
  }

  let sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, type })
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410) {
        // Subscription expired — deactivate
        await db.update('subscribers', `id=eq.${sub.id}`, { active: false });
      }
    }
  }

  await log(
    failed === subs.length && subs.length > 0 ? 'error' : 'success',
    `Push "${title}": ${sent} delivered, ${failed} failed`
  );
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const settings  = await getSettings();
  if (!settings.notifications_enabled) {
    console.log('[SCHEDULER] Notifications disabled — skipping.');
    return;
  }

  const tz        = settings.timezone || 'Africa/Lagos';
  const current   = nowHHMM(tz);
  const sentToday = await getSentToday();
  const today     = getTodayTimetable(tz);
  const yesterday = getYesterdayTimetable(tz);
  const weekend   = isWeekend(today);

  console.log(`\n[SCHEDULER] ${new Date().toISOString()}`);
  console.log(`  Day: ${today.day} | Time: ${current} | Weekend: ${weekend}`);
  console.log(`  Sent today: ${sentToday.join(', ') || 'none'}`);

  // ── Morning ────────────────────────────────────────────────────
  if (timesMatch(current, settings.morning_time) && !sentToday.includes('morning')) {
    let body, prompt;
    if (weekend) {
      const all = getAllCourses().join(', ');
      prompt = `Generate a ${today.day} morning revision reminder for an ND1 Computer Science student. No lectures today. Semester courses: ${all}. Tell them to identify their weakest topic and dedicate focused time today. Be strict, direct, professional. No emojis.`;
      body = `Good morning. Today is ${today.day} — no lectures, which means no excuses. Identify your weakest topic from this semester and spend focused time on it. The exam hall has no lectures, only what you already know.`;
    } else {
      const yc = yesterday.lectures.map(l => `${l.code} (${l.subject})`).join(', ') || 'previous material';
      prompt = `Generate a morning study reminder for an ND1 CS student. Yesterday's courses: ${yc}. Remind them to review before today's lectures. Be strict, direct. No emojis.`;
      body = `Good morning. Yesterday you covered: ${yc}. Review those notes before class today — gaps only widen without revision. No one will rescue you in the exam hall.`;
    }
    if (settings.ai_enabled) { const ai = await generateMessage(prompt); if (ai) body = ai; }
    const title = weekend ? `${today.day} Morning Revision` : 'Morning Review Directive';
    await sendPush(title, body, weekend ? 'weekend' : 'morning', settings.ai_enabled);
    await markSent('morning');
  }

  // ── Post-lecture (weekday only) ────────────────────────────────
  if (!weekend && settings.afternoon_trigger && !sentToday.includes('afternoon')) {
    const lastEnd = getLastLectureEndTime(today);
    if (lastEnd) {
      const [lh, lm] = lastEnd.split(':').map(Number);
      const trigMin  = lh * 60 + lm + 60;
      const trigger  = `${String(Math.floor(trigMin / 60)).padStart(2, '0')}:${String(trigMin % 60).padStart(2, '0')}`;
      if (timesMatch(current, trigger)) {
        const courses = today.lectures.map(l => `${l.code} (${l.subject})`).join(', ');
        const prompt = `Generate a post-lecture consolidation message for an ND1 CS student. Today's lectures: ${courses}. Urge immediate note review. Strict and professional. No emojis.`;
        let body = `Lectures done. Now consolidate: review every note from ${courses}. This is where understanding is locked in or lost. The exam hall has no lectures — only what you already know.`;
        if (settings.ai_enabled) { const ai = await generateMessage(prompt); if (ai) body = ai; }
        await sendPush('Post-Lecture Consolidation', body, 'afternoon', settings.ai_enabled);
        await markSent('afternoon');
      }
    }
  }

  // ── Evening ────────────────────────────────────────────────────
  if (timesMatch(current, settings.evening_time) && !sentToday.includes('evening')) {
    let body, prompt;
    if (weekend) {
      prompt = `Generate a ${today.day} evening reminder for an ND1 CS student. Review today's study session and prepare for next week. Be strict, professional. No emojis.`;
      body = `Evening check-in. Before you sleep, review what you studied today and read ahead for next week. Consistent daily preparation is the only thing separating those who pass from those who do not.`;
    } else {
      const tc = today.lectures.map(l => `${l.code} (${l.subject})`).join(', ') || 'today\'s material';
      prompt = `Generate an evening review message for an ND1 CS student. Today's subjects: ${tc}. Final review before sleep. Strict, professional. No emojis.`;
      body = `Evening directive: if you have not reviewed today's material (${tc}), do it now. A final pass before sleep locks information into long-term memory. Discipline today is performance in the exam hall.`;
    }
    if (settings.ai_enabled) { const ai = await generateMessage(prompt); if (ai) body = ai; }
    const title = weekend ? `${today.day} Evening Prep` : 'Evening Study Directive';
    await sendPush(title, body, weekend ? 'weekend' : 'evening', settings.ai_enabled);
    await markSent('evening');
  }

  console.log('[SCHEDULER] Run complete.\n');
}

main().catch(err => {
  console.error('[SCHEDULER] Fatal error:', err);
  process.exit(1);
});
