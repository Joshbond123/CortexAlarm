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
    // Only generates keys if truly absent — new keys invalidate all existing
    // subscriptions, so this should only run on the very first scheduler run.
    const keys = webpush.generateVAPIDKeys();
    await db.upsert('vapid_keys', { id: 1, public_key: keys.publicKey, private_key: keys.privateKey });
    await log('warn', 'Generated new VAPID keys — all existing subscriptions are now invalid and must re-subscribe');
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

  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  // Returns the current calendar date in the given timezone as "YYYY-MM-DD".
  // CRITICAL: do NOT use new Date().toDateString() — that gives the UTC date,
  // which drifts from Africa/Lagos (UTC+1) and causes the dedup to reset 1 hour
  // early, allowing duplicate notifications or missing a slot.
  function todayDateString(tz) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
  }

  // Returns true if current time has passed (or met) the scheduled time.
  // No upper bound — sentToday dedup prevents re-firing. This tolerates late
  // GitHub Actions runs which are common on the free tier.
  function shouldFire(currentHHMM, scheduledHHMM) {
    return toMinutes(currentHHMM) >= toMinutes(scheduledHHMM);
  }

  // ── Sent-today dedup ──────────────────────────────────────────────
  async function getSentToday(tz) {
    const today = todayDateString(tz);
    const rows  = await db.select('sent_today', 'id=eq.1');
    const data  = rows?.[0] || {};
    return data.date === today ? (data.sent || []) : [];
  }

  async function markSent(type, tz) {
    const today = todayDateString(tz);
    const sent  = await getSentToday(tz);
    if (!sent.includes(type)) {
      await db.upsert('sent_today', { id: 1, date: today, sent: [...sent, type] });
    }
  }

  // ── Push notification with TTL + retry ────────────────────────────
  // TTL=2419200 (28 days — the Web Push protocol maximum).
  // The push service (FCM / Mozilla) queues messages offline and delivers them
  // the moment the device reconnects — nothing is dropped within 28 days.
  const PUSH_TTL    = 2419200;
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 3000;

  async function sendToSubscriber(pushConfig, payload, attempt = 1) {
    try {
      await webpush.sendNotification(pushConfig, payload, { TTL: PUSH_TTL });
      return { ok: true };
    } catch (err) {
      const code = err.statusCode;

      if (code === 410 || code === 404) {
        // Subscription gone or not found — permanently expired
        return { ok: false, expired: true, code };
      }

      if (code === 401) {
        // VAPID signature mismatch — server configuration error, not a
        // subscription problem. The private key in vapid_keys DB row does not
        // match the public key that was used when the browser subscribed.
        // Do NOT deactivate the subscription; the fix is to restore the original
        // key pair or re-subscribe all devices with the current public key.
        return { ok: false, vapidError: true, code };
      }

      if (code === 413) {
        // Payload too large — not retriable
        return { ok: false, error: 'Payload too large (413)', code };
      }

      if (attempt < MAX_RETRIES) {
        // Transient error (5xx, network) — exponential backoff and retry
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        return sendToSubscriber(pushConfig, payload, attempt + 1);
      }

      return { ok: false, error: err.message, code };
    }
  }

  async function sendPush(title, body, type, aiGenerated = false) {
    const vapid = await getVapidKeys();
    webpush.setVapidDetails('mailto:cortexalarm@study.app', vapid.public_key, vapid.private_key);

    // Always persist the notification so the Inbox is populated regardless of
    // push delivery outcome — this is the fallback for offline users.
    // BUG FIX: capture the returned row so we can embed the real DB UUID in the
    // push payload. Without it the SW stores a fake "push-TIMESTAMP" shown-ID,
    // the background sync never matches it, and old notifications get re-pushed.
    const inserted = await db.insert('notifications', {
      title, body, type,
      read: false,
      ai_generated: aiGenerated,
      sent_at: new Date().toISOString(),
    });
    const dbNotifId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;

    const subs = await db.select('subscribers', 'active=eq.true');
    if (!Array.isArray(subs) || !subs.length) {
      await log('info', `No active subscribers — notification stored in inbox: "${title}"`);
      return;
    }

    // Include the DB UUID so the SW can mark this exact record as shown
    // and the background-sync recovery won't re-push it later.
    const payload = JSON.stringify({ title, body, type, ...(dbNotifId ? { id: dbNotifId } : {}) });
    let sent = 0, failed = 0, expired = 0, vapidErrors = 0;

    for (const sub of subs) {
      const pushConfig = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      const result = await sendToSubscriber(pushConfig, payload);

      if (result.ok) {
        sent++;
      } else if (result.vapidError) {
        vapidErrors++;
        await log('error',
          `VAPID rejected (401) for ${sub.device_name || sub.id}. ` +
          `The VAPID public key used at subscription time does not match the private key in vapid_keys table. ` +
          `Fix: ensure supabase-client.js fetches the public key from DB (not hardcoded), or re-generate keys and re-subscribe all devices.`
        );
      } else if (result.expired) {
        expired++;
        await db.update('subscribers', `id=eq.${sub.id}`, { active: false });
        await log('warn', `Subscription expired (${result.code}) — deactivated: ${sub.device_name || sub.id}`);
      } else {
        failed++;
        await log('warn', `Push failed for ${sub.device_name || sub.id}: ${result.error || result.code}`);
      }
    }

    const level = vapidErrors > 0 ? 'error' : (sent === 0 && subs.length > 0) ? 'error' : 'success';
    await log(level,
      `Push "${title}": ${sent} delivered, ${failed} failed, ${expired} expired, ${vapidErrors} VAPID-error — TTL ${PUSH_TTL}s`
    );
  }

  // ── Fallback messages ─────────────────────────────────────────────
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
    const settings = await getSettings();
    if (!settings.notifications_enabled) {
      console.log('[SCHEDULER] Notifications disabled — skipping.');
      return;
    }

    const tz        = settings.timezone || 'Africa/Lagos';
    const current   = nowHHMM(tz);
    const today     = getTodayTimetable(tz);
    const yesterday = getYesterdayTimetable(tz);
    const weekend   = isWeekend(today);
    const sentToday = await getSentToday(tz);

    console.log(`\n[SCHEDULER] ${new Date().toISOString()}`);
    console.log(`  Day: ${today.day} | Time: ${current} (${tz}) | Weekend: ${weekend}`);
    console.log(`  Today (Lagos): ${todayDateString(tz)}`);
    console.log(`  Sent today: ${sentToday.join(', ') || 'none'}`);

    let fired = 0;

    // ── Morning ─────────────────────────────────────────────────────
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
        if (settings.ai_enabled) { const ai = await generateMessage(SYSTEM_PROMPT, prompt); if (ai) body = ai; }
        const title = weekend ? `${today.day} Morning Revision` : 'Morning Review — Open Your Notes';
        await sendPush(title, body, weekend ? 'weekend' : 'morning', settings.ai_enabled);
        await markSent('morning', tz);
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
          if (settings.ai_enabled) { const ai = await generateMessage(SYSTEM_PROMPT, prompt); if (ai) body = ai; }
          await sendPush('Post-Lecture — Consolidate Now', body, 'afternoon', settings.ai_enabled);
          await markSent('afternoon', tz);
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
          prompt = buildPrompt(`It is ${today.day} evening. The student should recall today's self-study topics from memory. Focus on identifying gaps before sleep.`);
          body = FALLBACKS.evening_weekend();
        } else {
          const courses = today.lectures.map(l => `${l.code} (${l.subject})`).join(', ') || "today's material";
          prompt = buildPrompt(`It is evening after a full study day. Today's courses: ${courses}. The student should do a final review before resting.`);
          body = FALLBACKS.evening_weekday(courses);
        }
        if (settings.ai_enabled) { const ai = await generateMessage(SYSTEM_PROMPT, prompt); if (ai) body = ai; }
        const title = weekend ? `${today.day} Evening Recall` : 'Evening Review — Close the Day';
        await sendPush(title, body, weekend ? 'weekend' : 'evening', settings.ai_enabled);
        await markSent('evening', tz);
        fired++;
        await log('info', `Evening notification fired at ${current} (scheduled ${settings.evening_time})`);
      }
    }

    if (fired === 0) console.log('[SCHEDULER] No notifications due at this time.');
  }

  main().catch(async err => {
    console.error('[FATAL]', err);
    try { await log('error', `Scheduler crashed: ${err.message}`, { stack: err.stack }); } catch {}
    process.exit(1);
  });
  