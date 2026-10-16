-- ============================================================
-- 045_lms_enrollment_events.sql — audit trail + idempotency for the
-- LMS enrollment webhook (POST /api/webhooks/lms-enrollment).
--
-- One row per (account_id, idempotency_key). The webhook claims the
-- row with an INSERT (unique violation => duplicate delivery), then
-- moves it received -> processed | failed. Failed rows keep the
-- original payload so they can be replayed.
--
-- PII: phone_raw / payload hold the student's phone and name, like
-- contacts. Service-role only: RLS is enabled with no policies, so
-- end-user clients cannot read it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS lms_enrollment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_raw         text,
  phone_normalized  text,
  enrollment_id     text,
  course_id         text,
  course_title      text,
  idempotency_key   text NOT NULL,
  processing_status text NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received', 'processed', 'duplicate', 'failed')),
  attempts          integer NOT NULL DEFAULT 1,
  duplicate_count   integer NOT NULL DEFAULT 0,
  error_code        text,
  error_message     text,
  correlation_id    text,
  payload           jsonb,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id        uuid REFERENCES messages(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS lms_enrollment_events_idem_uniq
  ON lms_enrollment_events (account_id, idempotency_key);
CREATE INDEX IF NOT EXISTS lms_enrollment_events_idem_idx
  ON lms_enrollment_events (idempotency_key);
CREATE INDEX IF NOT EXISTS lms_enrollment_events_phone_idx
  ON lms_enrollment_events (account_id, phone_normalized);
CREATE INDEX IF NOT EXISTS lms_enrollment_events_received_idx
  ON lms_enrollment_events (received_at DESC);

ALTER TABLE lms_enrollment_events ENABLE ROW LEVEL SECURITY;
