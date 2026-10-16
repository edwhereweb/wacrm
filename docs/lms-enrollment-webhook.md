# LMS enrollment webhook → WhatsApp confirmation

`POST /api/webhooks/lms-enrollment` lets an LMS trigger a WhatsApp
enrollment confirmation.

## Configuration

| Env var | Required | Purpose |
| --- | --- | --- |
| `LMS_WEBHOOK_SECRET` | yes | Shared secret, sent in the `X-Webhook-Secret` header or as a ****** in `Authorization`. Missing/wrong → `401` (`503` if unset on the server). |
| `LMS_ENROLLMENT_ACCOUNT_ID` | if several accounts | Account whose WhatsApp number sends the message. Defaults to the only account with WhatsApp configured. |
| `LMS_ENROLLMENT_TEMPLATE_NAME` | no | Template name (default `lms_enrollment_confirmation`). |
| `LMS_ENROLLMENT_TEMPLATE_LANGUAGE` | no | Template language (default `en_US`). |
| `LMS_ENROLLMENT_APP_URL` | no | Static app download URL used when the payload omits one. |
| `LMS_REPLAY_SECRET` | for replay | Secret for the replay endpoint (`X-Replay-Secret` or Bearer). Unset → replay returns `503`. |

Run migration `045_lms_enrollment_events.sql` (audit table). If it is not
applied, the webhook still delivers (audit/idempotency are skipped and
`audit_insert_failed` is logged).

## Payload

```json
{
  "phone": "+14155550123",
  "student_name": "Jane",
  "course_title": "Algebra",
  "app_download_url": "https://app.example.com/download",
  "group_url": "https://chat.whatsapp.com/abc123"
}
```

camelCase keys are also accepted. Invalid payloads return `400` with a
`details` array. Success returns `201` with `mode` (`template` or
`fallback_text`), `message_id`, `conversation_id`, `contact_id`.

## WhatsApp template

Create and get approved (then "Sync from Meta" in Settings) a template
named as above:

- Body: `Hi {{1}}, congratulations! You have successfully enrolled in {{2}}.`
- Button 1 (URL) `Open App / Download` — static URL, or dynamic `https://host/{{1}}`
- Button 2 (URL) `Join WhatsApp Group` — dynamic, e.g. `https://chat.whatsapp.com/{{1}}`

For dynamic buttons the payload URL must start with the template's
static prefix; the remainder is sent as `{{1}}`.

## Fallback

If the template is missing, the button params can't be built, or Meta
rejects the template send, the failure is logged
(`[lms-enrollment] template send with buttons failed, falling back…`)
and a plain text message is sent instead, with the app and group URLs
inline. Note Meta only delivers free-form text inside the 24-hour
customer-service window.

## Status tracking

Sent messages are stored in the contact's conversation, and the existing
Meta status callback (`/api/whatsapp/webhook`) updates them to
`sent` / `delivered` / `failed`, storing Meta's error code, title and
details. If both the template and fallback sends fail, a `failed`
message with the error reason is recorded on the timeline.

## Idempotency

Each delivery is keyed by `Idempotency-Key` header, else `idempotency_key`
in the body, else a deterministic hash of
`account + normalized phone + (enrollment_id | course_id | course_title)`.
Optional payload fields `enrollment_id`, `course_id`, `idempotency_key`
(camelCase also accepted) refine the key. Rows are unique per
`(account_id, idempotency_key)` in `lms_enrollment_events`.

- First delivery → `201 {status: "sent"}`; row `received` → `processed`.
- Repeat of a processed/in-flight event → `200 {status: "duplicate"}` with the
  stored ids; nothing is sent or created (`duplicate_count` is incremented).
- Repeat of a `failed` event (or a `received` claim older than 5 min) is
  re-claimed atomically and retried.

Contacts/conversations still go through `resolveConversationByPhone`
(normalized phone, account-scoped, one conversation per account+contact,
unique-violation reselect on races).

## Audit trail

`lms_enrollment_events` stores `received_at`, `account_id`, `phone_raw`,
`phone_normalized`, enrollment refs, `idempotency_key`,
`processing_status` (`received | processed | failed`; `duplicate_count`
tracks repeats), `error_code`/`error_message`, `correlation_id`, the
payload (for replay) and linked `contact_id` / `conversation_id` /
`message_id`. It holds PII (phone, name) like `contacts`; RLS is enabled
with no policies, so only the service role can read it.

## Logs

Each request logs JSON lines prefixed `[lms-enrollment]` with
`correlation_id` (from `X-Correlation-Id` / `X-Request-Id`, else generated,
and echoed in the response header). Events: `auth`, `accepted` (account,
masked phone, key), `conversation_resolved` (`new_contact` /
`existing_contact`), `dedupe`, `processed`, `failed`. Errors carry
`error_category`: `auth | validation | account_resolution |
whatsapp_config | meta_send | db | unknown`. Secrets are never logged.

## Replay

```bash
curl -X POST "$CRM/api/internal/lms-enrollment/replay" \
  -H "X-Replay-Secret: $LMS_REPLAY_SECRET" -H 'content-type: application/json' \
  -d '{"account_id":"<uuid>","from":"2026-10-01T00:00:00Z","limit":25}'
```

Optional filters: `ids`, `account_id`, `from`, `to`, `limit` (≤100). Only
`failed` rows are replayed, through the same idempotent claim, so running it
twice (or concurrently) sends once; each row's status is updated.

## Troubleshooting: enrolled in LMS but missing in inbox

1. Find the attempt:
   `select * from lms_enrollment_events where account_id = '<id>' and phone_normalized = '917356543520' order by received_at desc;`
2. No row → LMS never called (check LMS logs), or a `401` / `400` (search logs
   for `[lms-enrollment]` `auth` / `invalid_payload`), or the migration is missing.
3. `failed` → read `error_code` / `error_message` (`whatsapp_not_configured`,
   `account_ambiguous` → set `LMS_ENROLLMENT_ACCOUNT_ID`; `meta_error` → Meta/template
   issue). Fix and call the replay endpoint.
4. `processed` → open `conversation_id` in the inbox; check the contact's
   phone format and that the inbox is not filtered/assigned elsewhere.
5. `received` for > 5 min → crashed mid-flight; resend or replay.
