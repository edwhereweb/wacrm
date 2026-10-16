# LMS enrollment webhook → WhatsApp confirmation

`POST /api/webhooks/lms-enrollment` lets an LMS trigger a WhatsApp
enrollment confirmation.

## Configuration

| Env var | Required | Purpose |
| --- | --- | --- |
| `LMS_WEBHOOK_SECRET` | yes | Shared secret. Sent as `X-Webhook-Secret: <secret>` or `Authorization: ****** Missing/wrong → `401` (`503` if unset on the server). |
| `LMS_ENROLLMENT_ACCOUNT_ID` | if several accounts | Account whose WhatsApp number sends the message. Defaults to the only account with WhatsApp configured. |
| `LMS_ENROLLMENT_TEMPLATE_NAME` | no | Template name (default `lms_enrollment_confirmation`). |
| `LMS_ENROLLMENT_TEMPLATE_LANGUAGE` | no | Template language (default `en_US`). |
| `LMS_ENROLLMENT_APP_URL` | no | Static app download URL used when the payload omits one. |

No database migration is needed.

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
