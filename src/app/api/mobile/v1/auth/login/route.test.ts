import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rate-limit'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const signInWithPassword = vi.fn()
const tables: Record<string, { data: unknown; error: unknown }> = {}
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { signInWithPassword },
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve(tables[table] ?? { data: null, error: null }),
      }
      return builder
    },
  }),
}))

const { POST } = await import('./route')

function login(body: unknown, ip = '1.1.1.1') {
  return POST(
    new Request('http://x/api/mobile/v1/auth/login', {
      method: 'POST',
      headers: { 'x-real-ip': ip },
      body: JSON.stringify(body),
    })
  )
}

const session = {
  access_token: 'a.b.c',
  refresh_token: 'r',
  expires_at: 123,
  user: { id: 'user-1' },
}

beforeEach(() => {
  __resetRateLimitForTests()
  signInWithPassword.mockReset()
  for (const key of Object.keys(tables)) delete tables[key]
})

describe('POST /api/mobile/v1/auth/login', () => {
  it('returns tokens, account, role and capabilities', async () => {
    signInWithPassword.mockResolvedValue({ data: { session }, error: null })
    tables.profiles = {
      data: {
        full_name: 'Asha',
        email: 'asha@edwhere.com',
        avatar_url: null,
        account_id: 'acct-1',
        account_role: 'viewer',
      },
      error: null,
    }
    tables.accounts = {
      data: { id: 'acct-1', name: 'EdWhere', default_currency: 'INR' },
      error: null,
    }

    const res = await login({ email: ' asha@edwhere.com ', password: 'pw' })
    expect(res.status).toBe(200)
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'asha@edwhere.com',
      password: 'pw',
    })
    const { data, meta } = await res.json()
    expect(meta).toBeNull()
    expect(data).toMatchObject({
      accessToken: 'a.b.c',
      refreshToken: 'r',
      expiresAt: 123,
      account: { id: 'acct-1', default_currency: 'INR' },
      role: 'viewer',
      capabilities: { canSend: false, canEditSettings: false, canManageMembers: false },
    })
  })

  it('answers a wrong password and an unknown user identically', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { message: 'User not found' },
    })
    const res = await login({ email: 'ghost@edwhere.com', password: 'pw' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid email or password',
      details: null,
    })
  })

  it('refuses a signed-in user whose profile has no account', async () => {
    signInWithPassword.mockResolvedValue({ data: { session }, error: null })
    tables.profiles = { data: { account_id: null, account_role: null }, error: null }
    const res = await login({ email: 'a@edwhere.com', password: 'pw' })
    expect(res.status).toBe(403)
  })

  it('rejects a body without credentials before calling Supabase', async () => {
    const res = await login({ email: 'a@edwhere.com' })
    expect(res.status).toBe(400)
    expect(signInWithPassword).not.toHaveBeenCalled()
  })

  it('rate-limits repeated attempts for one email from one IP', async () => {
    signInWithPassword.mockResolvedValue({ data: { session: null }, error: {} })
    for (let i = 0; i < 10; i++) {
      expect((await login({ email: 'a@edwhere.com', password: 'x' })).status).toBe(401)
    }
    const res = await login({ email: 'A@edwhere.com', password: 'x' })
    expect(res.status).toBe(429)
    expect((await res.json()).error.code).toBe('RATE_LIMITED')
  })
})
