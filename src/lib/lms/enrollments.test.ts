import { describe, expect, it, vi } from 'vitest'
import {
  fetchLmsEnrollments,
  normalizeEmail,
  LmsError,
  normalizeLmsBaseUrl,
  normalizeLmsEnrollments,
  getPhoneCandidates,
} from './enrollments'
import { TtlCache } from './cache'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

describe('normalizeLmsBaseUrl', () => {
  it('accepts http(s) and strips trailing slashes', () => {
    expect(normalizeLmsBaseUrl('https://lms.example.com/')).toBe('https://lms.example.com')
    expect(normalizeLmsBaseUrl(' https://x.io/app// ')).toBe('https://x.io/app')
  })
  it('rejects other schemes, credentials, queries', () => {
    expect(normalizeLmsBaseUrl('ftp://x.io')).toBeNull()
    expect(normalizeLmsBaseUrl('******x.io')).toBeNull()
    expect(normalizeLmsBaseUrl('https://x.io?a=1')).toBeNull()
    expect(normalizeLmsBaseUrl('nope')).toBeNull()
  })
})

describe('normalizeLmsEnrollments', () => {
  it('handles courses/webinars arrays', () => {
    const r = normalizeLmsEnrollments({
      courses: [{ id: 1, title: 'A', status: 'active', enrolledAt: '2026-01-02T00:00:00Z' }],
      webinars: [{ id: 'w', name: 'W', enrolled_at: 'garbage' }],
    })
    expect(r.enrollments).toEqual([
      { id: '1', kind: 'course', title: 'A', status: 'active', enrolledAt: '2026-01-02T00:00:00Z' },
      { id: 'w', kind: 'webinar', title: 'W', status: 'enrolled', enrolledAt: null },
    ])
  })
  it('handles flat enrollments with type', () => {
    const r = normalizeLmsEnrollments({
      data: { enrollments: [{ id: 'x', type: 'webinar', title: 'T' }, { nope: 1 }] },
    })
    expect(r.enrollments).toHaveLength(1)
    expect(r.enrollments[0].kind).toBe('webinar')
  })
  it('handles direct array and course_name fields', () => {
    const r = normalizeLmsEnrollments([
      { id: 'c1', course_name: 'Python for Beginners', status: 'enrolled' },
    ])
    expect(r.enrollments).toHaveLength(1)
    expect(r.enrollments[0].title).toBe('Python for Beginners')
  })
  it('rejects unknown shapes', () => {
    expect(() => normalizeLmsEnrollments({ foo: 1 })).toThrow(LmsError)
    expect(() => normalizeLmsEnrollments(null)).toThrow(LmsError)
  })
})

describe('getPhoneCandidates', () => {
  it('generates candidates for 10-digit number like 7356543520', () => {
    const c = getPhoneCandidates('7356543520')
    expect(c).toContain('7356543520')
    expect(c).toContain('+917356543520')
    expect(c).toContain('917356543520')
  })

  it('generates candidates for +91 formatted number', () => {
    const c = getPhoneCandidates('+917356543520')
    expect(c).toContain('+917356543520')
    expect(c).toContain('7356543520')
    expect(c).toContain('917356543520')
  })
})

describe('fetchLmsEnrollments', () => {
  const base = { baseUrl: 'https://lms.test', apiKey: 'secret', phone: '+1555' }

  it('calls the LMS endpoint with the x-api-key header', async () => {
    const f = vi.fn().mockImplementation(async () => json({ enrollments: [] }))
    await fetchLmsEnrollments({ ...base, fetchImpl: f })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://lms.test/api/v1/contacts/enrollments?phone=%2B1555')
    expect(init.headers['x-api-key']).toBe('secret')
  })
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [500, 'unreachable'],
  ])('maps status %i to %s', async (status, code) => {
    const f = vi.fn().mockResolvedValue(json({}, status))
    await expect(fetchLmsEnrollments({ ...base, fetchImpl: f })).rejects.toMatchObject({ code })
  })
  it('treats 404 as empty', async () => {
    const f = vi.fn().mockResolvedValue(json({}, 404))
    expect(await fetchLmsEnrollments({ ...base, fetchImpl: f })).toEqual({ enrollments: [] })
  })
  it('maps network failure and timeout', async () => {
    const net = vi.fn().mockRejectedValue(new TypeError('fail'))
    await expect(fetchLmsEnrollments({ ...base, fetchImpl: net })).rejects.toMatchObject({ code: 'unreachable' })
    const to = vi.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }))
    await expect(fetchLmsEnrollments({ ...base, fetchImpl: to })).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('fetchLmsEnrollments identifiers', () => {
  const base = { baseUrl: 'https://lms.test', apiKey: 'secret' }
  const hit = { enrollments: [{ id: '1', title: 'Course A' }] }

  it('phone-only returns enrollment', async () => {
    const f = vi.fn().mockResolvedValue(json(hit))
    const r = await fetchLmsEnrollments({ ...base, phone: '+917356543520', fetchImpl: f })
    expect(r.enrollments).toHaveLength(1)
    expect(f.mock.calls[0][0]).toContain('phone=')
  })
  it('email-only returns enrollment with normalized email', async () => {
    const f = vi.fn().mockResolvedValue(json(hit))
    const r = await fetchLmsEnrollments({ ...base, email: '  A@B.Com ', fetchImpl: f })
    expect(r.enrollments).toHaveLength(1)
    expect(f.mock.calls[0][0]).toBe('https://lms.test/api/v1/contacts/enrollments?email=a%40b.com')
  })
  it('falls back to email when phone matches nothing', async () => {
    const f = vi.fn().mockImplementation(async (url: string) =>
      url.includes('email=') ? json(hit) : json({}, 404),
    )
    const r = await fetchLmsEnrollments({ ...base, phone: '+917356543520', email: 'a@b.com', fetchImpl: f })
    expect(r.enrollments).toHaveLength(1)
  })
  it('falls back to phone when email mismatches (phone has precedence)', async () => {
    const f = vi.fn().mockImplementation(async (url: string) =>
      url.includes('phone=') ? json(hit) : json({}, 404),
    )
    const r = await fetchLmsEnrollments({ ...base, phone: '+917356543520', email: 'wrong@x.com', fetchImpl: f })
    expect(r.enrollments).toHaveLength(1)
    expect(f.mock.calls.every(([u]) => !String(u).includes('email='))).toBe(true)
  })
  it('rejects when neither identifier is present', async () => {
    const f = vi.fn()
    await expect(fetchLmsEnrollments({ ...base, fetchImpl: f })).rejects.toMatchObject({ code: 'invalid_phone' })
    expect(f).not.toHaveBeenCalled()
  })
  it('normalizeEmail trims, lowercases and rejects junk', () => {
    expect(normalizeEmail(' X@Y.io ')).toBe('x@y.io')
    expect(normalizeEmail('nope')).toBeNull()
    expect(normalizeEmail('')).toBeNull()
  })
})

describe('TtlCache', () => {
  it('serves cached values until TTL expires, dedupes in-flight, force bypasses', async () => {
    let t = 0
    const c = new TtlCache<number>(1000, () => t)
    const loader = vi.fn().mockResolvedValue(1)
    await Promise.all([c.get('a', loader), c.get('a', loader)])
    expect(loader).toHaveBeenCalledTimes(1)
    await c.get('a', loader)
    expect(loader).toHaveBeenCalledTimes(1)
    await c.get('a', loader, { force: true })
    expect(loader).toHaveBeenCalledTimes(2)
    t = 1001
    await c.get('a', loader)
    expect(loader).toHaveBeenCalledTimes(3)
  })
  it('does not cache failures', async () => {
    const c = new TtlCache<number>()
    const loader = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(2)
    await expect(c.get('a', loader)).rejects.toThrow()
    expect(await c.get('a', loader)).toBe(2)
  })
})
