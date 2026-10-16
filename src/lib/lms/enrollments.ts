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

export function getPhoneCandidates(phone: string): string[] {
  const cleaned = phone.replace(/[\s\-().]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  const candidates: string[] = [];

  const add = (p: string) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  // 1. As passed (cleaned)
  add(cleaned);

  // 2. Toggle leading '+'
  if (cleaned.startsWith('+')) {
    add(cleaned.slice(1));
  } else {
    add(`+${cleaned}`);
  }

  // 3. Indian formats (10 digits vs 12 digits with 91)
  if (digits.length === 10) {
    add(digits);
    add(`+91${digits}`);
    add(`91${digits}`);
    add(`0${digits}`);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    const local10 = digits.slice(2);
    add(`+${digits}`);
    add(digits);
    add(local10);
    add(`0${local10}`);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    const local10 = digits.slice(1);
    add(local10);
    add(`+91${local10}`);
    add(`91${local10}`);
  }

  return candidates;
}

function normalizeItem(
  raw: unknown,
  fallbackKind: LmsEnrollmentKind,
  index: number,
): LmsEnrollment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const nested = (r.course ?? r.webinar ?? r.batch ?? r.program) as Record<string, unknown> | undefined
  const title =
    str(r.title) ??
    str(r.name) ??
    str(r.course_title) ??
    str(r.courseTitle) ??
    str(r.course_name) ??
    str(r.courseName) ??
    str(r.webinar_title) ??
    str(r.webinarTitle) ??
    str(r.webinar_name) ??
    str(r.webinarName) ??
    str(r.course) ??
    str(nested?.title) ??
    str(nested?.name) ??
    str(nested?.course_name) ??
    str(nested?.course_title) ??
    str(nested?.course)
  if (!title) return null
  const kind = asKind(r.type ?? r.kind ?? r.item_type ?? r.enrollment_type, fallbackKind)
  const enrolledAt =
    str(r.enrolledAt) ??
    str(r.enrolled_at) ??
    str(r.createdAt) ??
    str(r.created_at) ??
    str(r.enrolled_date) ??
    str(r.enrollment_date) ??
    str(r.date) ??
    str(nested?.enrolled_at) ??
    str(nested?.created_at)
  const valid = enrolledAt && !Number.isNaN(new Date(enrolledAt).getTime())
  return {
    id: str(r.id) ?? str(r.enrollmentId) ?? str(r.enrollment_id) ?? `${kind}-${index}`,
    kind,
    title,
    status: str(r.status) ?? str(r.enrollment_status) ?? 'enrolled',
    enrolledAt: valid ? enrolledAt : null,
  }
}

/**
 * Map the LMS payload onto the internal shape. Accepts flat enrollments array,
 * separate courses / webinars arrays, nested under data / result, or direct array.
 */
export function normalizeLmsEnrollments(payload: unknown): LmsEnrollmentsResult {
  if (!payload || typeof payload !== 'object') {
    throw new LmsError('bad_response', 'Unexpected response from LMS')
  }

  const out: LmsEnrollment[] = []
  const push = (list: unknown, kind: LmsEnrollmentKind) => {
    if (!Array.isArray(list)) return
    list.forEach((item, i) => {
      const n = normalizeItem(item, kind, out.length + i)
      if (n) out.push(n)
    })
  }

  // 1. Direct array: [ { ... } ]
  if (Array.isArray(payload)) {
    push(payload, 'course')
    return { enrollments: out }
  }

  const root = payload as Record<string, unknown>
  const body = (
    root.data && typeof root.data === 'object' ? root.data : root
  ) as Record<string, unknown>

  // 2. data is an array: { data: [ ... ] }
  if (Array.isArray(root.data)) {
    push(root.data, 'course')
    return { enrollments: out }
  }

  // 3. result is an array: { result: [ ... ] }
  if (Array.isArray(root.result)) {
    push(root.result, 'course')
    return { enrollments: out }
  }

  // 4. Object properties
  push(body.enrollments, 'course')
  push(body.courses, 'course')
  push(body.webinars, 'webinar')
  push(body.items, 'course')

  if (root !== body) {
    push(root.enrollments, 'course')
    push(root.courses, 'course')
    push(root.webinars, 'webinar')
    push(root.items, 'course')
  }

  const hasRecognizedArray =
    Array.isArray(body.enrollments) ||
    Array.isArray(body.courses) ||
    Array.isArray(body.webinars) ||
    Array.isArray(body.items) ||
    Array.isArray(root.enrollments) ||
    Array.isArray(root.courses) ||
    Array.isArray(root.webinars) ||
    Array.isArray(root.items) ||
    Array.isArray(root.data) ||
    Array.isArray(root.result)

  if (!hasRecognizedArray) {
    for (const val of Object.values(body)) {
      if (Array.isArray(val)) {
        push(val, 'course')
      }
    }
    if (out.length === 0) {
      throw new LmsError('bad_response', 'Unexpected response from LMS')
    }
  }

  return { enrollments: out }
}

async function requestLmsUrl(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; json: unknown | null }> {
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

  if (res.status === 404) {
    return { status: 404, json: null }
  }

  if (!res.ok) {
    return { status: res.status, json: null }
  }

  try {
    const json = await res.json()
    return { status: res.status, json }
  } catch {
    return { status: res.status, json: null }
  }
}

export function normalizeEmail(email: string): string | null {
  const e = email.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(e) ? e : null
}

/**
 * Lookup precedence (stable, first non-empty result wins):
 *   1. phone — each normalized phone candidate, in getPhoneCandidates order
 *   2. email — lowercased/trimmed
 * Either identifier alone is sufficient; a phone that matches nothing (or an
 * email that mismatches) never blocks the other identifier from resolving.
 */
export async function fetchLmsEnrollments(opts: {
  baseUrl: string
  apiKey: string
  phone?: string | null
  email?: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<LmsEnrollmentsResult> {
  const { baseUrl, apiKey, phone, email, fetchImpl = fetch, timeoutMs = LMS_TIMEOUT_MS } = opts

  let cleanBase = baseUrl.replace(/\/+$/, '')
  if (cleanBase.endsWith('/api/v1')) {
    cleanBase = cleanBase.slice(0, -'/api/v1'.length)
  } else if (cleanBase.endsWith('/api')) {
    cleanBase = cleanBase.slice(0, -'/api'.length)
  }

  const normalizedEmail = email ? normalizeEmail(email) : null
  const queries: string[] = [
    ...(phone ? getPhoneCandidates(phone) : []).map((p) => `phone=${encodeURIComponent(p)}`),
    ...(normalizedEmail ? [`email=${encodeURIComponent(normalizedEmail)}`] : []),
  ]
  if (queries.length === 0) {
    throw new LmsError('invalid_phone', 'A phone number or email is required')
  }
  let lastNonOkStatus: number | null = null

  // Iterate over candidate identifiers (phone formats first, then email)
  for (const query of queries) {
    const endpoints = [
      `${cleanBase}/api/v1/contacts/enrollments?${query}`,
      `${cleanBase}/api/v1/enrollments?${query}`,
    ]

    for (const url of endpoints) {
      const { status, json } = await requestLmsUrl(url, apiKey, fetchImpl, timeoutMs)

      if (status === 404) {
        continue
      }

      if (status !== 200 || !json) {
        lastNonOkStatus = status
        continue
      }

      try {
        const normalized = normalizeLmsEnrollments(json)
        if (normalized.enrollments.length > 0) {
          return normalized
        }
      } catch {
        continue
      }
    }
  }

  if (lastNonOkStatus && lastNonOkStatus !== 404) {
    throw new LmsError('unreachable', `LMS returned status ${lastNonOkStatus}`)
  }

  return { enrollments: [] }
}
