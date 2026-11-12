import { describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

import { parseBearerJwt } from './bearer'

// respond.ts imports the auth error classes, which pull in next/headers.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { ForbiddenError, UnauthorizedError } = await import('@/lib/auth/account')
const { MobileError, ok, toMobileErrorResponse, withEnvelope } = await import('./respond')

describe('parseBearerJwt', () => {
  it('accepts a three-segment JWT, case-insensitively', () => {
    expect(parseBearerJwt('Bearer aaa.bbb.ccc')).toBe('aaa.bbb.ccc')
    expect(parseBearerJwt('bearer   aaa.bbb.ccc ')).toBe('aaa.bbb.ccc')
  })

  it('ignores public-API keys, so they never become a user session', () => {
    expect(parseBearerJwt('Bearer wacrm_live_abcdef0123456789')).toBeNull()
  })

  it('ignores missing, empty and malformed headers', () => {
    expect(parseBearerJwt(null)).toBeNull()
    expect(parseBearerJwt('')).toBeNull()
    expect(parseBearerJwt('Basic aaa.bbb.ccc')).toBeNull()
    expect(parseBearerJwt('Bearer aaa.bbb')).toBeNull()
    expect(parseBearerJwt('Bearer aaa.bbb.ccc extra')).toBeNull()
  })
})

describe('mobile envelope', () => {
  it('always includes meta on success (the app only unwraps data when it is present)', async () => {
    expect(await ok({ a: 1 }).json()).toEqual({ data: { a: 1 }, meta: null })
  })

  it('maps typed errors to stable codes and hides unknown error text', async () => {
    const cases: [unknown, number, string][] = [
      [new UnauthorizedError('nope'), 401, 'UNAUTHORIZED'],
      [new ForbiddenError('nope'), 403, 'FORBIDDEN'],
      [new MobileError('VALIDATION', 'bad', 400), 400, 'VALIDATION'],
    ]
    for (const [err, status, code] of cases) {
      const res = toMobileErrorResponse(err)
      expect(res.status).toBe(status)
      expect((await res.json()).error.code).toBe(code)
    }

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = toMobileErrorResponse(new Error('secret db detail'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error', details: null },
    })
  })
})

describe('withEnvelope', () => {
  it('wraps a dashboard success payload', async () => {
    const handler = withEnvelope(async () => NextResponse.json({ success: true }))
    const res = await handler()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { success: true }, meta: null })
  })

  it('rewrites the internal { error: string } shape, keeping status and Retry-After', async () => {
    const handler = withEnvelope(async (id: string) =>
      NextResponse.json(
        { error: `no ${id}` },
        { status: 429, headers: { 'Retry-After': '7' } }
      )
    )
    const res = await handler('budget')
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(await res.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'no budget', details: null },
    })
  })
})
