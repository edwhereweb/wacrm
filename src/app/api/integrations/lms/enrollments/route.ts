import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchLmsEnrollments, LmsError, normalizeEmail } from '@/lib/lms/enrollments'
import type { LmsErrorCode } from '@/lib/lms/types'

const STATUS: Record<LmsErrorCode, number> = {
  invalid_phone: 400,
  misconfigured: 422,
  unauthorized: 502,
  unreachable: 502,
  bad_response: 502,
  timeout: 504,
}

function fail(code: LmsErrorCode, message: string) {
  return NextResponse.json({ error: message, code }, { status: STATUS[code] })
}

/**
 * GET /api/integrations/lms/enrollments?phone=...&email=... (at least one required)
 *
 * Server-side proxy to the LMS. The API secret is decrypted here and
 * sent as `x-api-key`; it never reaches the browser nor the logs.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const params = new URL(request.url).searchParams
    const rawPhone = (params.get('phone') ?? '').replace(/[\s\-().]/g, '')
    const phone = /^\+?\d{5,20}$/.test(rawPhone) ? rawPhone : null
    const email = normalizeEmail(params.get('email') ?? '')
    // Either identifier alone is enough; reject only when neither is usable.
    if (!phone && !email) {
      return fail('invalid_phone', 'A valid phone number or email is required')
    }

    const { data, error } = await supabase
      .from('lms_configs')
      .select('base_url, api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[lms/enrollments] config fetch error:', error.message)
      return fail('misconfigured', 'Failed to load LMS configuration')
    }
    if (!data?.base_url || !data.api_key) {
      return fail('misconfigured', 'LMS integration is not configured')
    }

    let apiKey: string
    try {
      apiKey = decrypt(data.api_key)
    } catch {
      return fail('misconfigured', 'Stored LMS key could not be decrypted')
    }

    try {
      const result = await fetchLmsEnrollments({
        baseUrl: data.base_url,
        apiKey,
        phone,
        email,
      })
      console.log(`[lms/enrollments] Lookup: returned ${result.enrollments.length} enrollments`)
      return NextResponse.json(result)
    } catch (err) {
      if (err instanceof LmsError) {
        console.warn(`[lms/enrollments] LmsError lookup: ${err.code} - ${err.message}`)
        return fail(err.code, err.message)
      }
      console.error('[lms/enrollments] unexpected error:', err)
      return fail('unreachable', 'Could not reach the LMS')
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
