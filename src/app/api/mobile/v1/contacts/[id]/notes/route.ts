// GET  /api/mobile/v1/contacts/{id}/notes — newest first, with author names.
// POST /api/mobile/v1/contacts/{id}/notes — { note_text } (agent+).

import type { SupabaseClient } from '@supabase/supabase-js'

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'

type Params = { params: Promise<{ id: string }> }

async function assertContact(supabase: SupabaseClient, accountId: string, id: string) {
  if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Contact not found', 404)
  const { data, error } = await supabase
    .from('contacts')
    .select('id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new MobileError('NOT_FOUND', 'Contact not found', 404)
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    await assertContact(supabase, accountId, id)
    const { data, error } = await supabase
      .from('contact_notes')
      .select('id, note_text, user_id, created_at')
      .eq('contact_id', id)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw error
    return ok(data ?? [])
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id } = await params
    await assertContact(supabase, accountId, id)
    const { note_text } = await readJson(request)
    const text = typeof note_text === 'string' ? note_text.trim() : ''
    if (!text || text.length > 5000) throw new MobileError('VALIDATION', 'A note must be 1–5000 characters', 400)

    const { data, error } = await supabase
      .from('contact_notes')
      .insert({ contact_id: id, account_id: accountId, user_id: userId, note_text: text })
      .select('id, note_text, user_id, created_at')
      .single()
    if (error) throw error
    return ok(data, 201)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
