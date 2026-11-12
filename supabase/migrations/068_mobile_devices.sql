-- ============================================================
-- 068_mobile_devices.sql — Expo push tokens for the EdWhere CRM mobile app.
--
-- One row per installed app. Written and read only by the server
-- (service role): RLS is on with no policies, so the browser client
-- can't see or forge tokens. A token moves to whoever signs in on that
-- phone last (unique on expo_push_token). Keyed by user, not account:
-- recipients are resolved through profiles, so a user who moves to
-- another account keeps getting the right pushes.
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS mobile_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mobile_devices_user ON mobile_devices(user_id);

ALTER TABLE mobile_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_devices FROM anon, authenticated;
