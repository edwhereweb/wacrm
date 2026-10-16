# LMS integration

Shows a contact's LMS course and webinar enrollments in the inbox contact
sidebar (**LMS Enrollments**).

## Admin setup

1. Apply `supabase/migrations/044_lms_config.sql` (creates `lms_configs`).
2. In **Settings → LMS integration** (admin+), enter the **LMS base URL**
   (e.g. `https://lms.example.com`) and the **LMS API secret key**, then save.
   The key is encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`) and is never
   returned to the browser; leave the field blank on later saves to keep it.

## How it works

- The browser calls `GET /api/integrations/lms/enrollments?phone=…`; the
  server decrypts the key and calls
  `GET {LMS_URL}/api/v1/contacts/enrollments?phone=…` with the `x-api-key`
  header (8s timeout). Responses are normalized to
  `{ enrollments: [{ id, kind, title, status, enrolledAt }] }`.
- Proxy error codes: `misconfigured`, `unauthorized`, `unreachable`,
  `timeout`, `bad_response`, `invalid_phone`.
- **Caching:** an in-memory per-tab cache keyed by phone with a 7-minute TTL
  (max 100 contacts, in-flight requests de-duplicated). Switching contacts or
  tabs inside the TTL makes no request; the **Refresh** button forces a refetch.
  Errors are not cached.
- Contacts without a phone number (username-only) don't show the section.
