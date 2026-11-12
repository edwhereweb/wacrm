import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rate-limit'

const CONV = '11111111-1111-4111-8111-111111111111'

// Records every query so tests can assert account scoping.
const calls: { table: string; eq: [string, unknown][] }[] = []
const tables: Record<string, { data: unknown; error: unknown }> = {}
const client = {
  from(table: string) {
    const call = { table, eq: [] as [string, unknown][] }
    calls.push(call)
    const result = () => Promise.resolve(tables[table] ?? { data: null, error: null })
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'order', 'limit', 'or', 'in']) b[m] = () => b
    b.eq = (c: string, v: unknown) => (call.eq.push([c, v]), b)
    b.maybeSingle = result
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => result().then(ok, bad)
    return b
  },
}

const ctx = { supabase: client, accountId: 'acct-1', userId: 'user-1', role: 'agent' }
const requireRole = vi.fn()
vi.mock('@/lib/auth/account', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: () => Promise.resolve(ctx),
  requireRole: (min: string) => requireRole(min),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const send = vi.fn()
vi.mock('@/lib/whatsapp/send-message', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: (...a: unknown[]) => send(...a),
}))

const { ForbiddenError } = await import('@/lib/auth/account')
const { SendMessageError } = await import('@/lib/whatsapp/send-message')
const { GET, POST } = await import('./route')

const params = (id = CONV) => ({ params: Promise.resolve({ id }) })
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), params())

beforeEach(() => {
  __resetRateLimitForTests()
  calls.length = 0
  for (const k of Object.keys(tables)) delete tables[k]
  requireRole.mockReset().mockResolvedValue(ctx)
  send.mockReset()
})

describe('GET messages', () => {
  it('404s a conversation outside the caller’s account before reading messages', async () => {
    tables.conversations = { data: null, error: null }
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
    expect(calls[0].eq).toContainEqual(['account_id', 'acct-1'])
    expect(calls.some((c) => c.table === 'messages')).toBe(false)
  })

  it('404s a malformed id without querying', async () => {
    const res = await GET(new Request('http://x'), params('not-a-uuid'))
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('returns the page with reactions and pagination meta', async () => {
    tables.conversations = { data: { id: CONV }, error: null }
    tables.messages = {
      data: [{ id: 'm1', created_at: '2026-11-13T10:00:00Z', media_url: null }],
      error: null,
    }
    tables.message_reactions = {
      data: [{ message_id: 'm1', emoji: '👍', actor_type: 'customer' }],
      error: null,
    }
    const res = await GET(new Request('http://x'), params())
    const body = await res.json()
    expect(body.meta).toEqual({ nextCursor: null, hasMore: false })
    expect(body.data[0].reactions).toEqual([{ emoji: '👍', actor_type: 'customer' }])
  })
})

describe('POST messages', () => {
  it('refuses a viewer before anything is sent', async () => {
    requireRole.mockRejectedValue(new ForbiddenError('Agents only'))
    const res = await post({ message_type: 'text', content_text: 'hi' })
    expect(res.status).toBe(403)
    expect(requireRole).toHaveBeenCalledWith('agent')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends as the caller into the verified conversation', async () => {
    tables.conversations = { data: { id: CONV }, error: null }
    send.mockResolvedValue({ messageId: 'm9', whatsappMessageId: 'wamid.9' })
    const res = await post({ message_type: 'text', content_text: 'hi', template_params: [1] })
    expect(res.status).toBe(201)
    expect(send).toHaveBeenCalledWith(client, 'acct-1', expect.objectContaining({
      conversationId: CONV,
      contentText: 'hi',
      senderId: 'user-1',
      templateParams: ['1'],
    }))
  })

  it('passes the send core’s reason through for the app to branch on', async () => {
    tables.conversations = { data: { id: CONV }, error: null }
    send.mockRejectedValue(new SendMessageError('meta_error', 'Meta said no', 502))
    const res = await post({ message_type: 'text', content_text: 'hi' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toEqual({
      code: 'INTERNAL',
      message: 'Meta said no',
      details: { reason: 'meta_error' },
    })
  })
})
