-- ============================================================
-- 067_whatsapp_spend_countries.sql
--
-- Spend card, part 2: country pricing and custom date ranges.
--
-- Meta prices each template message by the recipient's country
-- (read from the phone number's calling code), so one flat rate
-- under- or over-counts accounts that message abroad.
--
-- 1. whatsapp_message_charges.recipient_prefix — first 4 digits of
--    the recipient's number, stored by the status webhook. Enough to
--    tell calling codes apart without keeping the full number.
-- 2. whatsapp_country_rates — per-account rates for one country.
--    Countries without a row use the account's default rate card
--    (whatsapp_rate_cards); currency and tax stay account-wide,
--    because Meta bills every market in the account's one currency.
-- 3. whatsapp_spend_range() — like whatsapp_spend_daily() but for any
--    local date range (max 366 days), and split by phone prefix. The
--    app maps prefixes to countries (src/lib/whatsapp/pricing-countries.ts).
--    whatsapp_spend_daily() is left in place, unused.
--
-- 4. redeem_invitation — also checks whatsapp_country_rates (same
--    reason as 064). Body = 066 + one line.
-- ============================================================

-- ---- 1. recipient prefix on reported charges -----------------------
ALTER TABLE whatsapp_message_charges
  ADD COLUMN IF NOT EXISTS recipient_prefix TEXT;

-- ---- 2. country rates ------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_country_rates (
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  country        TEXT NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  marketing      NUMERIC(12, 4) NOT NULL CHECK (marketing >= 0),
  utility        NUMERIC(12, 4) NOT NULL CHECK (utility >= 0),
  authentication NUMERIC(12, 4) NOT NULL CHECK (authentication >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, country)
);

ALTER TABLE whatsapp_country_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_country_rates_select ON whatsapp_country_rates;
CREATE POLICY whatsapp_country_rates_select ON whatsapp_country_rates FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_country_rates_insert ON whatsapp_country_rates;
CREATE POLICY whatsapp_country_rates_insert ON whatsapp_country_rates FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_country_rates_update ON whatsapp_country_rates;
CREATE POLICY whatsapp_country_rates_update ON whatsapp_country_rates FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_country_rates_delete ON whatsapp_country_rates;
CREATE POLICY whatsapp_country_rates_delete ON whatsapp_country_rates FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ---- 3. spend counts for a date range, by country ----------------
CREATE OR REPLACE FUNCTION public.whatsapp_spend_range(
  p_from     DATE,
  p_to       DATE,
  p_timezone TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  day          DATE,
  category     TEXT,
  source       TEXT,
  phone_prefix TEXT,
  messages     BIGINT
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
  days AS (
    -- Whole local days from p_from to p_to, at most 366 of them.
    SELECT greatest(least(p_from, p_to), greatest(p_from, p_to) - 365) AS first_day,
           greatest(p_from, p_to) AS last_day
  ),
  bounds AS (
    SELECT (days.first_day::TIMESTAMP AT TIME ZONE tz.name) AS since,
           ((days.last_day + 1)::TIMESTAMP AT TIME ZONE tz.name) AS until
    FROM days CROSS JOIN tz
  ),
  tracked AS (
    SELECT c.delivered_at AS at,
           lower(c.pricing_category) AS category,
           coalesce(
             c.recipient_prefix,
             -- Charges recorded before 067 have no prefix: find the
             -- recipient through the message or broadcast send.
             (SELECT left(ct.phone_normalized, 4)
              FROM messages m
              JOIN conversations cv ON cv.id = m.conversation_id
              JOIN contacts ct ON ct.id = cv.contact_id
              WHERE m.message_id = c.wamid AND cv.account_id = c.account_id
              LIMIT 1),
             (SELECT left(ct.phone_normalized, 4)
              FROM broadcast_recipients r
              JOIN contacts ct ON ct.id = r.contact_id
              WHERE r.whatsapp_message_id = c.wamid AND ct.account_id = c.account_id
              LIMIT 1)
           ) AS phone_prefix
    FROM whatsapp_message_charges c
    JOIN me ON me.account_id = c.account_id
    CROSS JOIN bounds
    WHERE c.billable
      AND c.delivered_at >= bounds.since
      AND c.delivered_at < bounds.until
  ),
  -- Older sends Meta never reported pricing for: delivered template
  -- messages, categorised by their template.
  broadcast_sends AS (
    SELECT r.whatsapp_message_id AS wamid,
           coalesce(r.delivered_at, r.read_at, r.sent_at, r.created_at) AS at,
           b.template_name, b.account_id,
           left(ct.phone_normalized, 4) AS phone_prefix
    FROM broadcast_recipients r
    JOIN broadcasts b ON b.id = r.broadcast_id
    JOIN me ON me.account_id = b.account_id
    LEFT JOIN contacts ct ON ct.id = r.contact_id
    CROSS JOIN bounds
    WHERE r.status IN ('delivered', 'read', 'replied')
      AND coalesce(r.delivered_at, r.read_at, r.sent_at, r.created_at) >= bounds.since
      AND coalesce(r.delivered_at, r.read_at, r.sent_at, r.created_at) < bounds.until
  ),
  direct_sends AS (
    SELECT m.message_id AS wamid, m.created_at AS at, m.template_name, c.account_id,
           left(ct.phone_normalized, 4) AS phone_prefix
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN me ON me.account_id = c.account_id
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    CROSS JOIN bounds
    WHERE m.content_type = 'template'
      AND m.sender_type <> 'customer'
      AND m.status IN ('delivered', 'read')
      AND m.created_at >= bounds.since
      AND m.created_at < bounds.until
  ),
  estimated AS (
    SELECT s.at,
           coalesce(lower(t.category), 'marketing') AS category,
           s.phone_prefix
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
  SELECT (x.at AT TIME ZONE tz.name)::DATE AS day, x.category, x.source,
         nullif(x.phone_prefix, '') AS phone_prefix, count(*)::BIGINT
  FROM (
    SELECT at, category, 'tracked'::TEXT AS source, phone_prefix FROM tracked
    UNION ALL
    SELECT at, category, 'estimated'::TEXT, phone_prefix FROM estimated
  ) x
  CROSS JOIN tz
  GROUP BY 1, 2, 3, 4
  ORDER BY 1, 2, 3, 4;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_spend_range(DATE, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_spend_range(DATE, DATE, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_spend_range(DATE, DATE, TEXT) TO authenticated;

-- ---- 4. redeem_invitation: also check the new table --------------
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
    UNION ALL SELECT 1 FROM whatsapp_country_rates WHERE account_id = v_old_account_id
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
