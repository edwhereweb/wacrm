-- ============================================================
-- 065_search_pipeline_deals.sql
--
-- Keyword search for the pipeline board: which deals in a pipeline
-- have a WhatsApp message or a contact note containing the keyword
-- (e.g. "second week", "recording"). Name / phone search runs in the
-- browser on the deals already loaded; this covers the text the board
-- does not have.
--
-- SECURITY INVOKER: runs as the caller, so the normal RLS on deals,
-- conversations, messages and contact_notes decides what is visible.
-- It can never return a deal from another account.
--
-- Returns at most one row per deal: the most recent match, with a
-- short snippet around the keyword so the card can show why it
-- matched.
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_pipeline_deals(
  p_pipeline_id UUID,
  p_query       TEXT
)
RETURNS TABLE (
  deal_id    UUID,
  source     TEXT,
  snippet    TEXT,
  matched_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (
    SELECT
      btrim(p_query) AS raw,
      -- Escape LIKE wildcards so "50%" or "a_b" match literally.
      '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pat
  ),
  d AS (
    SELECT deals.id, deals.contact_id
    FROM deals
    WHERE deals.pipeline_id = p_pipeline_id
      AND deals.contact_id IS NOT NULL
  ),
  hits AS (
    SELECT d.id AS deal_id, 'message'::TEXT AS source, m.content_text AS body, m.created_at
    FROM d
    JOIN conversations c ON c.contact_id = d.contact_id
    JOIN messages m ON m.conversation_id = c.id
    CROSS JOIN q
    WHERE m.content_text ILIKE q.pat
    UNION ALL
    SELECT d.id, 'note'::TEXT, n.note_text, n.created_at
    FROM d
    JOIN contact_notes n ON n.contact_id = d.contact_id
    CROSS JOIN q
    WHERE n.note_text ILIKE q.pat
  ),
  latest AS (
    SELECT DISTINCT ON (hits.deal_id) hits.*
    FROM hits
    ORDER BY hits.deal_id, hits.created_at DESC NULLS LAST
  )
  SELECT
    latest.deal_id,
    latest.source,
    -- ~120 characters starting a little before the keyword.
    substr(
      latest.body,
      greatest(strpos(lower(latest.body), lower(q.raw)) - 40, 1),
      120
    ) AS snippet,
    latest.created_at AS matched_at
  FROM latest
  CROSS JOIN q
  WHERE char_length(q.raw) >= 2
  ORDER BY latest.created_at DESC NULLS LAST
  LIMIT 500;
$$;

REVOKE ALL ON FUNCTION public.search_pipeline_deals(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_pipeline_deals(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.search_pipeline_deals(UUID, TEXT) TO authenticated;
