// POST /api/mobile/v1/contacts/{id}/conversation — open (find or create) the chat with a contact (agent+).
// The app then opens the thread; outside the 24h window it can only send a template there.

import { requireRole } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { MobileError, ok, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await params
    if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Contact not found', 404)

    const { data: contact, error: cErr } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (cErr) throw cErr
    if (!contact) throw new MobileError('NOT_FOUND', 'Contact not found', 404)

    const find = async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', id)
        .maybeSingle()
      if (error) throw error
      return data?.id as string | undefined
    }

    const existing = await find()
    if (existing) return ok({ conversation_id: existing, created: false })

    const { data: created, error } = await supabase
      .from('conversations')
      .insert({ account_id: accountId, user_id: userId, contact_id: id })
      .select('id')
      .single()
    if (error) {
      // One chat per contact (migration 036): a concurrent create won the race.
      const raced = isUniqueViolation(error) ? await find() : undefined
      if (raced) return ok({ conversation_id: raced, created: false })
      throw error
    }
    return ok({ conversation_id: created.id, created: true }, 201)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
