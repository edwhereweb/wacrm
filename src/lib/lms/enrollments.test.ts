import { describe, expect, it, vi } from 'vitest'
import {
  fetchLmsEnrollments,
  LmsError,
  normalizeLmsBaseUrl,
  normalizeLmsEnrollments,
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
  it('rejects unknown shapes', () => {
    expect(() => normalizeLmsEnrollments({ foo: 1 })).toThrow(LmsError)
    expect(() => normalizeLmsEnrollments(null)).toThrow(LmsError)
  })
})

describe('fetchLmsEnrollments', () => {
  const base = { baseUrl: 'https://lms.test', apiKey: 'secret', phone: '+1555' }

  it('calls the LMS endpoint with the x-api-key header', async () => {
    const f = vi.fn().mockResolvedValue(json({ enrollments: [] }))
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
