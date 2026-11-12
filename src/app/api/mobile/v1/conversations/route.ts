// GET /api/mobile/v1/conversations
//   ?status=open|pending|closed      (omit for all)
//   ?assigned=me|unassigned          (omit for all)
//   ?search=<name or phone>  ?cursor=  ?limit=
// Newest activity first. `meta.totalUnread` (first page only) feeds the tab badge.

import { getCurrentAccount } from '@/lib/auth/account'
import { CONVERSATION_SELECT, normalizeConversations } from '@/lib/inbox/conversations'
import { contactSearchFilter } from '@/lib/contacts/search-filter'
import { decodeOffset, limitUser, serializeConversation } from '@/lib/mobile/inbox'
import { MobileError, okList, toMobileErrorResponse } from '@/lib/mobile/respond'
import type { ConversationStatus } from '@/types'

const STATUSES: ConversationStatus[] = ['open', 'pending', 'closed']

export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    limitUser(userId)

    const params = new URL(request.url).searchParams
    const status = params.get('status')
    const assigned = params.get('assigned')
    const search = params.get('search')?.trim() ?? ''
    const offset = decodeOffset(params.get('cursor'))
    const limit = Math.min(Math.max(Number(params.get('limit')) || 30, 1), 100)

    if (status && !STATUSES.includes(status as ConversationStatus)) {
      throw new MobileError('VALIDATION', 'status must be open, pending or closed', 400)
    }

    // A search filters on the embedded contact, which needs an inner join.
    const searchFilter = search ? contactSearchFilter(search) : null
    const select = searchFilter
      ? CONVERSATION_SELECT.replace('contacts(', 'contacts!inner(')
      : CONVERSATION_SELECT

    let query = supabase
      .from('conversations')
      .select(select)
      .eq('account_id', accountId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit) // one extra row tells us whether more exist

    if (status) query = query.eq('status', status)
    if (assigned === 'me') query = query.eq('assigned_agent_id', userId)
    if (assigned === 'unassigned') query = query.is('assigned_agent_id', null)
    if (searchFilter) query = query.or(searchFilter, { referencedTable: 'contacts' })

    const { data, error } = await query
    if (error) throw error

    const rows = normalizeConversations((data ?? []) as never)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((c) => serializeConversation(c))

    const extra: Record<string, unknown> = {}
    if (offset === 0) {
      const { count } = await supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .gt('unread_count', 0)
      extra.totalUnread = count ?? 0
    }

    return okList(items, hasMore ? String(offset + limit) : null, extra)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
