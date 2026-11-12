// GET /api/mobile/v1/pipelines/{id}/deals?search= — every deal on the board, newest first.
// Search matches the board's: title, notes, contact fields and phone digits, plus (from
// 3 characters) keywords in the contact's messages and deal notes. Keyword hits carry
// `match` with the snippet, as the board shows it.

import { getCurrentAccount } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { DEAL_SELECT } from '@/lib/mobile/deals'
import { limitUser } from '@/lib/mobile/inbox'
import { MobileError, ok, toMobileErrorResponse } from '@/lib/mobile/respond'
import { filterDeals, KEYWORD_SEARCH_MIN_CHARS, type DealKeywordMatch } from '@/lib/pipelines/search'
import type { Deal } from '@/types'

// shortcut: one unpaginated read, capped, like the dashboard board (which loads every
// deal). Page by stage if a pipeline ever holds more than this.
const MAX_DEALS = 1000

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    limitUser(userId)
    const { id } = await params
    if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Pipeline not found', 404)
    const search = new URL(request.url).searchParams.get('search')?.trim() ?? ''

    const [{ data, error }, keyword] = await Promise.all([
      supabase
        .from('deals')
        .select(DEAL_SELECT)
        .eq('pipeline_id', id)
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(MAX_DEALS),
      search.length >= KEYWORD_SEARCH_MIN_CHARS
        ? supabase.rpc('search_pipeline_deals', { p_pipeline_id: id, p_query: search })
        : null,
    ])
    if (error) throw error
    // A failed keyword search shouldn't hide name/phone matches.
    if (keyword?.error) console.error('[mobile/deals] keyword search failed:', keyword.error.message)

    const matches = new Map(
      ((keyword?.data ?? []) as DealKeywordMatch[]).map((m) => [m.deal_id, m])
    )
    const deals = filterDeals((data ?? []) as unknown as Deal[], search, matches)
    return ok(deals.map((d) => ({ ...d, match: matches.get(d.id) ?? null })))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
