// POST /api/mobile/v1/notifications/read — { ids: string[] } or { all: true }.

import { getCurrentAccount } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function POST(request: Request) {
  try {
    const { supabase, userId } = await getCurrentAccount()
    const body = await readJson(request)
    const ids = Array.isArray(body.ids) ? body.ids : null
    if (body.all !== true && (!ids || ids.length === 0 || ids.length > 200 || !ids.every((i) => typeof i === 'string' && isUuid(i)))) {
      throw new MobileError('VALIDATION', 'Send { ids: [...] } (up to 200) or { all: true }', 400)
    }

    // Only read_at is client-writable (column grant in migration 027).
    let query = supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('read_at', null)
    if (body.all !== true) query = query.in('id', ids as string[])
    const { error } = await query
    if (error) throw error

    return ok({ read: true })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
