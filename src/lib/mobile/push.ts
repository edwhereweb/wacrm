// ============================================================
// Push notifications for the EdWhere CRM mobile app, via the Expo push
// service (which relays to FCM / APNs).
//
// Who gets what:
//   - inbound message on an assigned chat  → the assignee
//   - inbound message on an unassigned chat → every agent, admin and owner
//   - a chat assigned to someone            → that person
//
// Everything here is best-effort and never throws: a push failure must
// not fail the webhook that triggered it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const PREVIEW_CHARS = 100
const CHUNK = 100 // Expo's per-request limit

export interface PushMessage {
  to: string
  title: string
  body: string
  data: { conversationId?: string; type: string }
}

interface ExpoTicket {
  status: 'ok' | 'error'
  details?: { error?: string }
}

export function preview(text: string | null | undefined, fallback: string): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return fallback
  return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS - 1)}…` : t
}

async function tokensFor(db: SupabaseClient, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return []
  const { data, error } = await db
    .from('mobile_devices')
    .select('expo_push_token')
    .in('user_id', userIds)
  if (error) {
    console.error('[push] device lookup failed:', error.message)
    return []
  }
  return (data ?? []).map((d) => d.expo_push_token as string)
}

/** Send, then forget tokens Expo reports as uninstalled. */
export async function sendPush(
  db: SupabaseClient,
  messages: PushMessage[],
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  for (let i = 0; i < messages.length; i += CHUNK) {
    const batch = messages.slice(i, i + CHUNK).map((m) => ({
      ...m,
      sound: 'default',
      priority: 'high',
      channelId: 'messages',
    }))
    try {
      const res = await fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(process.env.EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        console.error('[push] Expo rejected the batch:', res.status)
        continue
      }
      const { data } = (await res.json()) as { data?: ExpoTicket[] }
      const dead = (data ?? [])
        .map((t, j) => (t.details?.error === 'DeviceNotRegistered' ? batch[j].to : null))
        .filter((t): t is string => t !== null)
      if (dead.length > 0) {
        await db.from('mobile_devices').delete().in('expo_push_token', dead)
      }
    } catch (err) {
      console.error('[push] send failed:', err)
    }
  }
}

/** Agent-or-above members of an account: who can act on an unassigned chat. */
async function agentIds(db: SupabaseClient, accountId: string): Promise<string[]> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin', 'agent'])
  if (error) {
    console.error('[push] member lookup failed:', error.message)
    return []
  }
  return (data ?? []).map((p) => p.user_id as string)
}

/** Called by the WhatsApp webhook after an inbound message is stored. `db` is the service-role client. */
export async function notifyInboundMessage(
  db: SupabaseClient,
  opts: { accountId: string; conversationId: string; text: string | null; contentType: string }
): Promise<void> {
  try {
    // Read the thread fresh: the AI may have handed it to someone moments ago.
    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id, contact:contacts(name, phone)')
      .eq('id', opts.conversationId)
      .eq('account_id', opts.accountId)
      .maybeSingle()
    if (!conv) return

    const recipients = conv.assigned_agent_id
      ? [conv.assigned_agent_id as string]
      : await agentIds(db, opts.accountId)
    const tokens = await tokensFor(db, recipients)
    if (tokens.length === 0) return

    const contact = conv.contact as unknown as { name?: string | null; phone?: string | null } | null
    const title = contact?.name?.trim() || contact?.phone || 'New message'
    const body = preview(opts.text, opts.contentType === 'text' ? 'New message' : `Sent a ${opts.contentType}`)

    await sendPush(
      db,
      tokens.map((to) => ({ to, title, body, data: { conversationId: opts.conversationId, type: 'message' } }))
    )
  } catch (err) {
    console.error('[push] inbound notify failed:', err)
  }
}

/** A `notifications` row (migration 027), relayed by the database webhook. */
export async function notifyNotificationRow(
  db: SupabaseClient,
  row: { user_id: string; title: string; body?: string | null; conversation_id?: string | null; type: string }
): Promise<void> {
  try {
    const tokens = await tokensFor(db, [row.user_id])
    await sendPush(
      db,
      tokens.map((to) => ({
        to,
        title: row.title,
        body: preview(row.body, ''),
        data: { conversationId: row.conversation_id ?? undefined, type: row.type },
      }))
    )
  } catch (err) {
    console.error('[push] notification relay failed:', err)
  }
}
