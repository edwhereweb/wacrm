import type {
  LmsEnrollment,
  LmsEnrollmentKind,
  LmsEnrollmentsResult,
  LmsErrorCode,
} from './types'

export const LMS_TIMEOUT_MS = 8000

export class LmsError extends Error {
  constructor(
    readonly code: LmsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LmsError'
  }
}

/**
 * Validate and canonicalise an admin-entered LMS base URL: http(s) only,
 * no credentials / query / hash, no trailing slash. Returns null if invalid.
 */
export function normalizeLmsBaseUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function asKind(v: unknown, fallback: LmsEnrollmentKind): LmsEnrollmentKind {
  const s = typeof v === 'string' ? v.toLowerCase() : ''
  if (s === 'webinar') return 'webinar'
  if (s === 'course') return 'course'
  return fallback
}

function normalizeItem(
  raw: unknown,
  fallbackKind: LmsEnrollmentKind,
  index: number,
): LmsEnrollment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const nested = (r.course ?? r.webinar) as Record<string, unknown> | undefined
  const title =
    str(r.title) ??
    str(r.name) ??
    str(nested?.title) ??
    str(nested?.name)
  if (!title) return null
  const kind = asKind(r.type ?? r.kind, fallbackKind)
  const enrolledAt = str(r.enrolledAt) ?? str(r.enrolled_at) ?? str(r.createdAt) ?? str(r.created_at)
  const valid = enrolledAt && !Number.isNaN(new Date(enrolledAt).getTime())
  return {
    id: str(r.id) ?? str(r.enrollmentId) ?? `${kind}-${index}`,
    kind,
    title,
    status: str(r.status) ?? 'enrolled',
    enrolledAt: valid ? enrolledAt : null,
  }
}

/**
 * Map the LMS payload onto the internal shape. Accepts either a flat
 * `enrollments` array (items carry `type`), or separate `courses` /
 * `webinars` arrays, optionally under a `data` envelope.
 */
export function normalizeLmsEnrollments(payload: unknown): LmsEnrollmentsResult {
  if (!payload || typeof payload !== 'object') {
    throw new LmsError('bad_response', 'Unexpected response from LMS')
  }
  const root = payload as Record<string, unknown>
  const body = (
    root.data && typeof root.data === 'object' ? root.data : root
  ) as Record<string, unknown>

  const out: LmsEnrollment[] = []
  const push = (list: unknown, kind: LmsEnrollmentKind) => {
    if (!Array.isArray(list)) return
    list.forEach((item, i) => {
      const n = normalizeItem(item, kind, out.length + i)
      if (n) out.push(n)
    })
  }
  push(body.enrollments, 'course')
  push(body.courses, 'course')
  push(body.webinars, 'webinar')

  if (
    !Array.isArray(body.enrollments) &&
    !Array.isArray(body.courses) &&
    !Array.isArray(body.webinars)
  ) {
    throw new LmsError('bad_response', 'Unexpected response from LMS')
  }
  return { enrollments: out }
}

export async function fetchLmsEnrollments(opts: {
  baseUrl: string
  apiKey: string
  phone: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<LmsEnrollmentsResult> {
  const { baseUrl, apiKey, phone, fetchImpl = fetch, timeoutMs = LMS_TIMEOUT_MS } = opts
  const url = `${baseUrl}/api/v1/contacts/enrollments?phone=${encodeURIComponent(phone)}`

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'error',
    })
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new LmsError('timeout', 'LMS did not respond in time')
    }
    throw new LmsError('unreachable', 'Could not reach the LMS')
  }

  if (res.status === 401 || res.status === 403) {
    throw new LmsError('unauthorized', 'LMS rejected the API key')
  }
  // An unknown phone is simply "not enrolled anywhere".
  if (res.status === 404) return { enrollments: [] }
  if (!res.ok) {
    throw new LmsError('unreachable', `LMS returned status ${res.status}`)
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new LmsError('bad_response', 'Unexpected response from LMS')
  }
  return normalizeLmsEnrollments(json)
}
