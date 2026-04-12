// Weekly inbox reset — runs every Monday at 12:00 AM
import { db } from './supabase.js';

async function resetInbox() {
  console.log('[RESET] Starting weekly inbox reset...');

  const allNotifs = await db.select('notifications', 'select=id');
  const count = Array.isArray(allNotifs) ? allNotifs.length : 0;

  // Delete all notifications
  await db.delete('notifications', 'id=neq.00000000-0000-0000-0000-000000000000');

  console.log(`[RESET] Deleted ${count} notifications.`);

  // Log the operation
  await db.insert('logs', {
    level: 'info',
    message: `Weekly inbox reset — ${count} notifications cleared`,
    details: { resetAt: new Date().toISOString(), count },
    created_at: new Date().toISOString(),
  });

  console.log('[RESET] Done.');
}

resetInbox().catch(err => {
  console.error('[RESET] Error:', err);
  process.exit(1);
});
