// GET    /api/mobile/v1/contacts/{id} — contact, tags, custom field values and its chat (if any).
// PATCH  /api/mobile/v1/contacts/{id} — { name?, email?, company? } (agent+); null clears a field.
// DELETE /api/mobile/v1/contacts/{id} — (agent+) chats stay, unlinked (migration 004).

import type { SupabaseClient } from '@supabase/supabase-js'

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { getContactById } from '@/lib/api/v1/contacts'
import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'

type Params = { params: Promise<{ id: string }> }

async function loadContact(supabase: SupabaseClient, accountId: string, id: string) {
  const contact = isUuid(id) ? await getContactById(supabase, accountId, id) : null
  if (!contact) throw new MobileError('NOT_FOUND', 'Contact not found', 404)
  return contact
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    const contact = await loadContact(supabase, accountId, id)

    const [fields, values, conv] = await Promise.all([
      supabase.from('custom_fields').select('id, field_name, field_type').eq('account_id', accountId).order('field_name'),
      supabase.from('contact_custom_values').select('custom_field_id, value').eq('contact_id', id),
      supabase.from('conversations').select('id, status').eq('account_id', accountId).eq('contact_id', id).maybeSingle(),
    ])
    for (const r of [fields, values, conv]) if (r.error) throw r.error

    const valueById = new Map((values.data ?? []).map((v) => [v.custom_field_id as string, v.value as string | null]))
    return ok({
      ...contact,
      // shortcut: read-only on mobile; editing custom fields stays on the web for now.
      custom_fields: (fields.data ?? [])
        .map((f) => ({ id: f.id, name: f.field_name, type: f.field_type, value: valueById.get(f.id) ?? null }))
        .filter((f) => f.value),
      conversation: conv.data ?? null,
    })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    await loadContact(supabase, accountId, id)
    const body = await readJson(request)

    const updates: Record<string, unknown> = {}
    for (const field of ['name', 'email', 'company'] as const) {
      if (!(field in body)) continue
      const v = body[field]
      if (v !== null && typeof v !== 'string') {
        throw new MobileError('VALIDATION', `${field} must be text or null`, 400)
      }
      updates[field] = typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null
    }
    if (Object.keys(updates).length === 0) throw new MobileError('VALIDATION', 'Nothing to update', 400)

    updates.updated_at = new Date().toISOString()
    const { error } = await supabase.from('contacts').update(updates).eq('id', id).eq('account_id', accountId)
    if (error) throw error
    return ok(await loadContact(supabase, accountId, id))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    await loadContact(supabase, accountId, id)
    const { data, error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
    if (error) throw error
    // Readable but not deletable means RLS said no.
    if (!data?.length) throw new MobileError('FORBIDDEN', 'You can’t delete this contact', 403)
    return ok({ deleted: true })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
