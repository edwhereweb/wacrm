// PUT /api/mobile/v1/contacts/{id}/custom-values — { values: { <custom_field_id>: "text" } } (agent+).
// Only the fields sent are touched; an empty string clears one. Same write plan as the
// contact detail view on the web (lib/contacts/custom-value-writes).

import { requireRole } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { planCustomValueWrites } from '@/lib/contacts/custom-value-writes'
import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'

const MAX_VALUE = 2000

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Contact not found', 404)

    const { values } = await readJson(request)
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new MobileError('VALIDATION', 'Send { values: { fieldId: text } }', 400)
    }
    const entries = Object.entries(values as Record<string, unknown>)
    if (entries.length === 0 || entries.length > 100) throw new MobileError('VALIDATION', 'Send 1–100 fields', 400)
    for (const [fieldId, v] of entries) {
      if (!isUuid(fieldId) || typeof v !== 'string' || v.length > MAX_VALUE) {
        throw new MobileError('VALIDATION', `Each value must be text up to ${MAX_VALUE} characters`, 400)
      }
    }

    const [contact, fields] = await Promise.all([
      supabase.from('contacts').select('id').eq('id', id).eq('account_id', accountId).maybeSingle(),
      supabase.from('custom_fields').select('id').eq('account_id', accountId).in('id', entries.map(([f]) => f)),
    ])
    if (contact.error) throw contact.error
    if (fields.error) throw fields.error
    if (!contact.data) throw new MobileError('NOT_FOUND', 'Contact not found', 404)
    // A field id from another account must not land on this contact.
    if ((fields.data ?? []).length !== entries.length) {
      throw new MobileError('VALIDATION', 'One of those fields is not in this account', 400)
    }

    const { upserts, clearedFieldIds } = planCustomValueWrites(id, values as Record<string, string>)
    if (upserts.length) {
      const { error } = await supabase
        .from('contact_custom_values')
        .upsert(upserts, { onConflict: 'contact_id,custom_field_id' })
      if (error) throw error
    }
    if (clearedFieldIds.length) {
      const { error } = await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', id)
        .in('custom_field_id', clearedFieldIds)
      if (error) throw error
    }
    return ok({ saved: upserts.length, cleared: clearedFieldIds.length })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
