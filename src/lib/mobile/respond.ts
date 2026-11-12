// ============================================================
// Mobile API (/api/mobile/v1) response envelope.
//
//   success → { "data": <payload>, "meta": <object | null> }
//   failure → { "error": { "code": "<CODE>", "message": "…", "details": null } }
//
// This is the shape the EdWhere mobile apps' shared RTK Query base
// expects (it only unwraps `data` when `meta` is present), which is why
// it differs from the public `/api/v1` envelope.
// ============================================================

import { NextResponse } from 'next/server'

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account'

export type MobileErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'

export class MobileError extends Error {
  constructor(
    readonly code: MobileErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'MobileError'
  }
}

export function ok<T>(
  data: T,
  status = 200,
  meta: Record<string, unknown> | null = null
): NextResponse {
  return NextResponse.json({ data, meta }, { status })
}

/** List envelope: `meta` carries the pagination contract the app reads. */
export function okList<T>(
  items: T[],
  nextCursor: string | null,
  extra: Record<string, unknown> = {}
): NextResponse {
  return ok(items, 200, { nextCursor, hasMore: nextCursor !== null, ...extra })
}

export function fail(
  code: MobileErrorCode,
  message: string,
  status: number,
  opts: { headers?: HeadersInit; details?: unknown } = {}
): NextResponse {
  return NextResponse.json(
    { error: { code, message, details: opts.details ?? null } },
    { status, headers: opts.headers }
  )
}

function codeForStatus(status: number): MobileErrorCode {
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RATE_LIMITED'
  return status >= 500 ? 'INTERNAL' : 'VALIDATION'
}

/** Map a thrown value to the failure envelope; unknown errors never leak their text. */
export function toMobileErrorResponse(err: unknown): NextResponse {
  if (err instanceof MobileError) return fail(err.code, err.message, err.status)
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return fail(codeForStatus(err.status), err.message, err.status)
  }
  console.error('[api/mobile] uncategorized error:', err)
  return fail('INTERNAL', 'Internal server error', 500)
}

/**
 * Expose an existing dashboard route handler under the mobile namespace.
 * Its internal `{ error: string }` / bare-payload responses are rewritten
 * into the mobile envelope so the logic stays in one place.
 */
export function withEnvelope<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>
): (...args: A) => Promise<NextResponse> {
  return async (...args) => {
    const res = await handler(...args)
    const body: unknown = await res.json().catch(() => null)
    if (res.ok) return ok(body, res.status)

    const error = (body as { error?: unknown } | null)?.error
    const retryAfter = res.headers.get('Retry-After')
    return fail(
      codeForStatus(res.status),
      typeof error === 'string' ? error : 'Request failed',
      res.status,
      { headers: retryAfter ? { 'Retry-After': retryAfter } : undefined }
    )
  }
}

/** Parse a JSON object body, or throw a 400. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MobileError('VALIDATION', 'Request body must be a JSON object', 400)
  }
  return body as Record<string, unknown>
}
