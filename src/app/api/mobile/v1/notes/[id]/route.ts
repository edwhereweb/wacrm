// DELETE /api/mobile/v1/notes/{id} — (agent+); RLS decides whose notes may go.

import { requireRole } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { MobileError, ok, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Note not found', 404)
    const { data, error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
    if (error) throw error
    if (!data?.length) throw new MobileError('NOT_FOUND', 'Note not found', 404)
    return ok({ deleted: true })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
