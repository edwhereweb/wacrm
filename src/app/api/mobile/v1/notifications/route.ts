// GET /api/mobile/v1/notifications?cursor= — the caller's notifications, newest first.
// `meta.unreadCount` feeds the bell badge. RLS limits rows to the caller (migration 027).

import { getCurrentAccount } from '@/lib/auth/account'
import { buildPage, keysetFilter, parseListParams } from '@/lib/api/v1/pagination'
import { limitUser } from '@/lib/mobile/inbox'
import { okList, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function GET(request: Request) {
  try {
    const { supabase, userId } = await getCurrentAccount()
    limitUser(userId)
    const { limit, cursor } = parseListParams(request)

    let query = supabase
      .from('notifications')
      .select('id, type, title, body, conversation_id, contact_id, read_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
    const kf = keysetFilter(cursor)
    if (kf) query = query.or(kf)

    const [{ data, error }, { count, error: countErr }] = await Promise.all([
      query,
      supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('read_at', null),
    ])
    if (error) throw error
    if (countErr) throw countErr

    const { items, nextCursor } = buildPage(data ?? [], limit)
    return okList(items, nextCursor, { unreadCount: count ?? 0 })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
