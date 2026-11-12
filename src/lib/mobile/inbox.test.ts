import { describe, expect, it } from 'vitest'

import type { Message, MessageReaction } from '@/types'
import { canReplyFreeform, decodeOffset, mobileMediaUrl, serializeMessage } from './inbox'

describe('canReplyFreeform', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  it('is open within 24h of the last inbound message and closed after', () => {
    expect(canReplyFreeform({ last_inbound_at: '2026-11-12T12:00:01Z' }, now)).toBe(true)
    expect(canReplyFreeform({ last_inbound_at: '2026-11-12T12:00:00Z' }, now)).toBe(false)
  })
  it('is closed when the customer never wrote', () => {
    expect(canReplyFreeform({ last_inbound_at: null }, now)).toBe(false)
  })
})

describe('decodeOffset', () => {
  it('accepts positive integers only', () => {
    expect(decodeOffset('40')).toBe(40)
    for (const bad of [null, '', '-5', '1.5', 'abc', '0']) expect(decodeOffset(bad)).toBe(0)
  })
})

describe('mobileMediaUrl', () => {
  it('rewrites cookie-only proxy paths and leaves public URLs alone', () => {
    expect(mobileMediaUrl('/api/whatsapp/media/123')).toBe('/media/123')
    expect(mobileMediaUrl('https://x.supabase.co/a.jpg')).toBe('https://x.supabase.co/a.jpg')
    expect(mobileMediaUrl(undefined)).toBeNull()
  })
})

describe('serializeMessage', () => {
  it('attaches only this message’s reactions', () => {
    const msg = { id: 'm1', media_url: '/api/whatsapp/media/9' } as Message
    const reactions = [
      { message_id: 'm1', emoji: '👍', actor_type: 'customer' },
      { message_id: 'm2', emoji: '❤️', actor_type: 'agent' },
    ] as MessageReaction[]
    expect(serializeMessage(msg, reactions)).toMatchObject({
      media_url: '/media/9',
      reactions: [{ emoji: '👍', actor_type: 'customer' }],
    })
  })
})
