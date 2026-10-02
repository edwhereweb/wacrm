-- ============================================================
-- 043_flow_media_audio_mime_types.sql
--
-- Adds audio MIME types to the `flow-media` Storage bucket so the
-- flow builder can upload voice notes for the `send_media` node
-- (media_type = 'audio').
--
-- Meta's WhatsApp Cloud API accepts the following audio formats when
-- sent via a public link (the only mode we use for flow sends):
--   audio/ogg  — OGG Opus, the native WhatsApp voice-note encoding
--   audio/mpeg — MP3
--   audio/mp4  — M4A / AAC-in-MP4
--   audio/amr  — AMR narrowband
--   audio/aac  — raw AAC
--
-- The bucket's 16 MB file_size_limit already covers Meta's 16 MB
-- audio cap, so no size-limit change is needed.
--
-- This is an UPDATE-only migration: the bucket row exists from
-- migration 016. The ON CONFLICT DO UPDATE ensures it is idempotent.
-- ============================================================

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  -- Images (unchanged from 016)
  'image/png', 'image/jpeg', 'image/webp',
  -- Videos (unchanged from 016)
  'video/mp4', 'video/3gpp',
  -- Audio (new) — Meta WhatsApp Cloud API supported formats
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/amr', 'audio/aac',
  -- Documents (unchanged from 016)
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain'
]
WHERE id = 'flow-media';
