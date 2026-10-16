import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'
import { normalizeLmsBaseUrl } from '@/lib/lms/enrollments'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/integrations/lms/config
 *
 * Any member may read whether the LMS is configured. The encrypted
 * secret is NEVER returned — only a `has_key` flag.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('lms_configs')
      .select('base_url, api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[lms/config GET] fetch error:', error.message)
      return NextResponse.json(
        { error: 'Failed to load LMS configuration' },
        { status: 500 },
      )
    }
    if (!data) return NextResponse.json({ configured: false })
    return NextResponse.json({
      configured: true,
      base_url: data.base_url,
      has_key: !!data.api_key,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/integrations/lms/config  (admin+)
 *
 * Upsert the LMS base URL + API secret. When `api_key` is omitted the
 * stored secret is kept (the form only sends it when re-entered).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`lms-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const baseUrl = normalizeLmsBaseUrl(
      typeof body.base_url === 'string' ? body.base_url : '',
    )
    if (!baseUrl) return bad('base_url must be a valid http(s) URL')

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    const { data: existing } = await supabase
      .from('lms_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!existing && !rawKey) return bad('api_key is required')

    if (existing) {
      const { error } = await supabase
        .from('lms_configs')
        .update(
          rawKey
            ? { base_url: baseUrl, api_key: encrypt(rawKey) }
            : { base_url: baseUrl },
        )
        .eq('account_id', accountId)
      if (error) {
        console.error('[lms/config POST] update error:', error.message)
        return NextResponse.json(
          { error: 'Failed to save LMS configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error } = await supabase.from('lms_configs').insert({
        account_id: accountId,
        created_by: userId,
        base_url: baseUrl,
        api_key: encrypt(rawKey),
      })
      if (error) {
        console.error('[lms/config POST] insert error:', error.message)
        return NextResponse.json(
          { error: 'Failed to save LMS configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/integrations/lms/config  (admin+) — remove the LMS config. */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('lms_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[lms/config DELETE] error:', error.message)
      return NextResponse.json(
        { error: 'Failed to delete LMS configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
