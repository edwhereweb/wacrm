// POST /api/mobile/v1/internal/notification-push
//
// Target of a Supabase Database Webhook on INSERT into `notifications`
// (see docs/mobile-push.md). Those rows are written by a database trigger
// whenever a chat is assigned, from the web or the app, so this is how a
// web assignment reaches the assignee's phone without touching the
// dashboard code. Authenticated by a shared secret header.

import { timingSafeEqual } from 'node:crypto'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { notifyNotificationRow } from '@/lib/mobile/push'
import { fail, ok } from '@/lib/mobile/respond'

function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const expected = process.env.MOBILE_PUSH_WEBHOOK_SECRET
  if (!expected) return fail('INTERNAL', 'Push relay is not configured', 503)
  if (!secretMatches(request.headers.get('x-webhook-secret'), expected)) {
    return fail('UNAUTHORIZED', 'Bad webhook secret', 401)
  }

  const payload = (await request.json().catch(() => null)) as {
    type?: string
    table?: string
    record?: Record<string, unknown>
  } | null
  const row = payload?.record
  if (payload?.type !== 'INSERT' || payload.table !== 'notifications' || !row) {
    return ok({ skipped: true }) // not ours; acknowledge so Supabase doesn't retry
  }
  if (typeof row.user_id !== 'string' || typeof row.title !== 'string') {
    return fail('VALIDATION', 'Malformed notification record', 400)
  }

  await notifyNotificationRow(supabaseAdmin(), {
    user_id: row.user_id,
    title: row.title,
    body: typeof row.body === 'string' ? row.body : null,
    conversation_id: typeof row.conversation_id === 'string' ? row.conversation_id : null,
    type: typeof row.type === 'string' ? row.type : 'notification',
  })
  return ok({ sent: true })
}
