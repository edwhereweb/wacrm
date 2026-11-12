// ============================================================
// Inbox helpers for the mobile API: per-user rate limit, offset
// cursors for the conversation list, and the derived fields the app
// renders but must not compute itself.
// ============================================================

import type { Conversation, Message, MessageReaction } from '@/types'
import { checkRateLimit } from '@/lib/rate-limit'
import { MobileError } from './respond'

const WINDOW_MS = 24 * 60 * 60 * 1000
const PROXY_PREFIX = '/api/whatsapp/media/'

/** 240/min per user — sized for 4 s thread polling plus normal use. */
export function limitUser(userId: string) {
  const limit = checkRateLimit(`mobile:${userId}`, { limit: 240, windowMs: 60_000 })
  if (!limit.success) {
    throw new MobileError('RATE_LIMITED', 'Too many requests. Slow down a little.', 429)
  }
}

// shortcut: offset paging for the conversation list (ordered by last
// message, which is nullable, so the keyset helpers don't fit). A thread
// that jumps to the top while the user scrolls can appear twice — the app
// dedupes by id. Upgrade to a (last_message_at, id) keyset if lists get long.
export function decodeOffset(cursor: string | null): number {
  const n = Number(cursor)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Whether a free-form (non-template) message may be sent right now. */
export function canReplyFreeform(
  conv: Pick<Conversation, 'last_inbound_at'>,
  now = Date.now()
): boolean {
  if (!conv.last_inbound_at) return false
  return now - new Date(conv.last_inbound_at).getTime() < WINDOW_MS
}

export function serializeConversation(conv: Conversation, now = Date.now()) {
  return { ...conv, can_reply_freeform: canReplyFreeform(conv, now) }
}

/**
 * Inbound media that wasn't mirrored to storage is a dashboard proxy path
 * that only accepts cookies. Point it at the mobile proxy instead; the app
 * resolves a leading "/" against its API base and sends its bearer token.
 */
export function mobileMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null
  return url.startsWith(PROXY_PREFIX) ? `/media/${url.slice(PROXY_PREFIX.length)}` : url
}

export function serializeMessage(m: Message, reactions: MessageReaction[]) {
  return {
    ...m,
    media_url: mobileMediaUrl(m.media_url),
    reactions: reactions
      .filter((r) => r.message_id === m.id)
      .map((r) => ({ emoji: r.emoji, actor_type: r.actor_type })),
  }
}
