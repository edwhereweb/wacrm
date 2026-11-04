-- ============================================================
-- 066_whatsapp_spend.sql
--
-- Approximate Meta (WhatsApp) messaging spend for the admin dashboard.
--
-- Meta bills per DELIVERED template message, by template category
-- (marketing / utility / authentication). Free-form replies inside the
-- 24h customer-service window are free.
--
-- 1. whatsapp_message_charges — from now on, every delivery status
--    webhook carries Meta's own `pricing` block (billable, category,
--    type). We store it per message, so tracked days are exact counts.
-- 2. whatsapp_rate_cards — per-account price per category. Defaults
--    are Meta's India list rates (INR, before GST) as of 2026; admins
--    edit them on the dashboard when Meta changes prices.
-- 3. whatsapp_spend_daily() — per day / category message counts:
--    'tracked' rows from (1), and 'estimated' rows for older delivered
--    template messages (broadcast recipients + template messages)
--    that predate tracking, categorised by their template. Estimated
--    utility counts are an upper bound: Meta does not charge utility
--    templates sent inside an open service window, which we cannot
--    see after the fact.
-- 4. redeem_invitation — also checks both new tables (same reason as
--    064). Body = 064 + two lines.
-- ============================================================

-- ---- 1. charges reported by Meta --------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_message_charges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wamid            TEXT NOT NULL,
  billable         BOOLEAN NOT NULL,
  pricing_category TEXT NOT NULL,
  pricing_type     TEXT,
  pricing_model    TEXT,
  delivered_at     TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, wamid)
);

CREATE INDEX IF NOT EXISTS whatsapp_message_charges_account_time_idx
  ON whatsapp_message_charges (account_id, delivered_at);

ALTER TABLE whatsapp_message_charges ENABLE ROW LEVEL SECURITY;

-- Spend is admin information. Rows are written only by the webhook
-- (service role), so there are no write policies.
DROP POLICY IF EXISTS whatsapp_message_charges_select ON whatsapp_message_charges;
CREATE POLICY whatsapp_message_charges_select ON whatsapp_message_charges FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- ---- 2. rate card ----------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_rate_cards (
  account_id     UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  currency       TEXT NOT NULL DEFAULT 'INR',
  marketing      NUMERIC(12, 4) NOT NULL DEFAULT 0.8631 CHECK (marketing >= 0),
  utility        NUMERIC(12, 4) NOT NULL DEFAULT 0.115  CHECK (utility >= 0),
  authentication NUMERIC(12, 4) NOT NULL DEFAULT 0.115  CHECK (authentication >= 0),
  tax_percent    NUMERIC(5, 2)  NOT NULL DEFAULT 18     CHECK (tax_percent >= 0 AND tax_percent <= 100),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE whatsapp_rate_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_rate_cards_select ON whatsapp_rate_cards;
CREATE POLICY whatsapp_rate_cards_select ON whatsapp_rate_cards FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_rate_cards_insert ON whatsapp_rate_cards;
CREATE POLICY whatsapp_rate_cards_insert ON whatsapp_rate_cards FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_rate_cards_update ON whatsapp_rate_cards;
CREATE POLICY whatsapp_rate_cards_update ON whatsapp_rate_cards FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ---- 3. daily spend counts --------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_spend_daily(
  p_days     INTEGER,
  p_timezone TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  day      DATE,
  category TEXT,
  source   TEXT,
  messages BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH me AS (
    -- Caller's account, and only if they are admin+ (spend is admin data).
    SELECT p.account_id
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND is_account_member(p.account_id, 'admin')
    LIMIT 1
  ),
  tz AS (
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN p_timezone
      ELSE 'UTC'
    END AS name
  ),
  bounds AS (
    -- Whole local days: today plus the previous (p_days - 1) days.
    SELECT ((date_trunc('day', now() AT TIME ZONE tz.name)
             - make_interval(days => greatest(least(p_days, 366), 1) - 1))
            AT TIME ZONE tz.name) AS since
    FROM tz
  ),
  tracked AS (
    SELECT c.wamid, c.delivered_at AS at, lower(c.pricing_category) AS category
    FROM whatsapp_message_charges c
    JOIN me ON me.account_id = c.account_id
    CROSS JOIN bounds
    WHERE c.billable
      AND c.delivered_at >= bounds.since
  ),
  -- Older sends Meta never reported pricing for: delivered template
  -- messages, categorised by their template.
  broadcast_sends AS (
    SELECT r.whatsapp_message_id AS wamid,
           coalesce(r.delivered_at, r.read_at, r.sent_at, r.created_at) AS at,
           b.template_name, b.account_id
    FROM broadcast_recipients r
    JOIN broadcasts b ON b.id = r.broadcast_id
    JOIN me ON me.account_id = b.account_id
    CROSS JOIN bounds
    WHERE r.status IN ('delivered', 'read', 'replied')
      AND coalesce(r.delivered_at, r.read_at, r.sent_at, r.created_at) >= bounds.since
  ),
  direct_sends AS (
    SELECT m.message_id AS wamid, m.created_at AS at, m.template_name, c.account_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN me ON me.account_id = c.account_id
    CROSS JOIN bounds
    WHERE m.content_type = 'template'
      AND m.sender_type <> 'customer'
      AND m.status IN ('delivered', 'read')
      AND m.created_at >= bounds.since
  ),
  estimated AS (
    SELECT s.at,
           coalesce(lower(t.category), 'marketing') AS category
    FROM (SELECT * FROM broadcast_sends UNION ALL SELECT * FROM direct_sends) s
    LEFT JOIN LATERAL (
      SELECT mt.category
      FROM message_templates mt
      WHERE mt.account_id = s.account_id AND mt.name = s.template_name
      ORDER BY mt.updated_at DESC NULLS LAST
      LIMIT 1
    ) t ON TRUE
    WHERE s.wamid IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM whatsapp_message_charges c
         WHERE c.account_id = s.account_id AND c.wamid = s.wamid
       )
  )
  SELECT (x.at AT TIME ZONE tz.name)::DATE AS day, x.category, x.source, count(*)::BIGINT
  FROM (
    SELECT at, category, 'tracked'::TEXT AS source FROM tracked
    UNION ALL
    SELECT at, category, 'estimated'::TEXT FROM estimated
  ) x
  CROSS JOIN tz
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_spend_daily(INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_spend_daily(INTEGER, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_spend_daily(INTEGER, TEXT) TO authenticated;

-- ---- 4. redeem_invitation: also check the new tables -------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    -- Edwhere customisation: LMS integration tables (062, 063).
    UNION ALL SELECT 1 FROM lms_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM lms_enrollment_events WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_message_charges WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_rate_cards WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
