// POST /api/mobile/v1/conversations/{id}/read — clear the unread badge.
// Same write the dashboard makes when a thread is opened; for a viewer
// RLS turns it into a no-op, which is also what the dashboard does.

import { getCurrentAccount } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { MobileError, ok, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Conversation not found', 404)

    const { error } = await supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', id)
      .eq('account_id', accountId)
      .gt('unread_count', 0)
    if (error) throw error

    return ok({ read: true })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
