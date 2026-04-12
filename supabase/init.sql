-- Cortex Alarm — Supabase Database Init
-- Run this once in Supabase Dashboard → SQL Editor

-- ── Tables ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        NOT NULL,
  label       TEXT        NOT NULL DEFAULT '',
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  requests    INTEGER     NOT NULL DEFAULT 0,
  success     INTEGER     NOT NULL DEFAULT 0,
  fail        INTEGER     NOT NULL DEFAULT 0,
  last_used   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vapid_keys (
  id          INTEGER     PRIMARY KEY DEFAULT 1,
  public_key  TEXT,
  private_key TEXT
);
INSERT INTO vapid_keys (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscribers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,
  auth        TEXT        NOT NULL,
  device_name TEXT        NOT NULL DEFAULT 'Unknown Device',
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT        NOT NULL,
  body         TEXT        NOT NULL,
  type         TEXT        NOT NULL DEFAULT 'general',
  read         BOOLEAN     NOT NULL DEFAULT FALSE,
  ai_generated BOOLEAN     NOT NULL DEFAULT FALSE,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  id                   INTEGER     PRIMARY KEY DEFAULT 1,
  ai_enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  notifications_enabled BOOLEAN    NOT NULL DEFAULT TRUE,
  morning_time         TEXT        NOT NULL DEFAULT '06:00',
  evening_time         TEXT        NOT NULL DEFAULT '18:00',
  afternoon_trigger    BOOLEAN     NOT NULL DEFAULT TRUE,
  weekend_reminders    BOOLEAN     NOT NULL DEFAULT TRUE,
  timezone             TEXT        NOT NULL DEFAULT 'Africa/Lagos',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  level      TEXT        NOT NULL DEFAULT 'info',
  message    TEXT        NOT NULL,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sent_today (
  id   INTEGER  PRIMARY KEY DEFAULT 1,
  date TEXT,
  sent TEXT[]   NOT NULL DEFAULT '{}'
);
INSERT INTO sent_today (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Row Level Security ───────────────────────────────────────────

ALTER TABLE notifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscribers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE vapid_keys     ENABLE ROW LEVEL SECURITY;

-- Notifications: public read + update (mark read)
CREATE POLICY "anon_read_notifications"   ON notifications FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_notifications" ON notifications FOR UPDATE TO anon USING (true);

-- Settings: public read + update
CREATE POLICY "anon_read_settings"   ON settings FOR SELECT TO anon USING (true);
CREATE POLICY "anon_update_settings" ON settings FOR UPDATE TO anon USING (true);

-- Subscribers: public full access (personal app)
CREATE POLICY "anon_all_subscribers" ON subscribers FOR ALL TO anon USING (true) WITH CHECK (true);

-- API Keys: public insert + read stats (key value masked in app code)
CREATE POLICY "anon_all_api_keys"    ON api_keys   FOR ALL TO anon USING (true) WITH CHECK (true);

-- Logs: public read
CREATE POLICY "anon_read_logs"       ON logs       FOR SELECT TO anon USING (true);

-- VAPID: public read (for push subscription public key)
CREATE POLICY "anon_read_vapid"      ON vapid_keys FOR SELECT TO anon USING (true);
