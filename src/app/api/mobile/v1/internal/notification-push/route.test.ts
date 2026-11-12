import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn()
vi.mock('@/lib/mobile/push', () => ({ notifyNotificationRow: (...a: unknown[]) => notify(...a) }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { POST } = await import('./route')

const record = { user_id: 'u1', title: 'New conversation assigned', body: 'Asha', conversation_id: 'c1', type: 'conversation_assigned' }
const call = (body: unknown, secret?: string) =>
  POST(
    new Request('http://x', {
      method: 'POST',
      headers: secret ? { 'x-webhook-secret': secret } : {},
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  vi.stubEnv('MOBILE_PUSH_WEBHOOK_SECRET', 'right-secret')
  notify.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('notification push relay', () => {
  it('rejects a missing or wrong secret', async () => {
    expect((await call({ type: 'INSERT', table: 'notifications', record })).status).toBe(401)
    expect((await call({ type: 'INSERT', table: 'notifications', record }, 'wrong-secret')).status).toBe(401)
    expect(notify).not.toHaveBeenCalled()
  })

  it('is disabled until a secret is configured', async () => {
    vi.stubEnv('MOBILE_PUSH_WEBHOOK_SECRET', '')
    expect((await call({ type: 'INSERT', table: 'notifications', record }, 'x')).status).toBe(503)
  })

  it('relays an inserted notification to its recipient', async () => {
    const res = await call({ type: 'INSERT', table: 'notifications', record }, 'right-secret')
    expect(res.status).toBe(200)
    expect(notify).toHaveBeenCalledWith({}, expect.objectContaining({ user_id: 'u1', conversation_id: 'c1' }))
  })

  it('acknowledges other events without sending', async () => {
    const res = await call({ type: 'UPDATE', table: 'notifications', record }, 'right-secret')
    expect(res.status).toBe(200)
    expect(notify).not.toHaveBeenCalled()
  })
})
