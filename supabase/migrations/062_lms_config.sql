-- ============================================================
-- 062_lms_config.sql — LMS integration (enrollments in the inbox)
-- (Renumbered from 044 when syncing with upstream: upstream took that number. Safe to re-run.)
--
-- Account-scoped, UNIQUE(account_id) — one LMS per workspace.
-- `api_key` is the LMS API secret, stored AES-256-GCM-encrypted
-- (same encrypt()/decrypt() as ai_configs.api_key) and never returned
-- to the browser; the inbox reads enrollments through the server
-- route /api/integrations/lms/enrollments, which attaches it as the
-- `x-api-key` header.
--
-- RLS mirrors ai_configs: members read, admin+ write.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS lms_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  base_url    text NOT NULL,
  api_key     text NOT NULL,   -- AES-256-GCM-encrypted LMS API secret
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lms_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lms_configs_select ON lms_configs;
CREATE POLICY lms_configs_select ON lms_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS lms_configs_insert ON lms_configs;
CREATE POLICY lms_configs_insert ON lms_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lms_configs_update ON lms_configs;
CREATE POLICY lms_configs_update ON lms_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lms_configs_delete ON lms_configs;
CREATE POLICY lms_configs_delete ON lms_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_lms_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lms_configs_updated_at ON lms_configs;
CREATE TRIGGER trg_lms_configs_updated_at
  BEFORE UPDATE ON lms_configs
  FOR EACH ROW EXECUTE FUNCTION public.update_lms_configs_updated_at();
