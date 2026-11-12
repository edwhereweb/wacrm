// GET    /api/mobile/v1/deals/{id}
// PATCH  /api/mobile/v1/deals/{id} — any deal field, plus status (open|won|lost) (agent+).
//        Moving a deal is `{ stage_id }`.
// DELETE /api/mobile/v1/deals/{id} — (agent+)

import type { SupabaseClient } from '@supabase/supabase-js'

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { assertDealRefs, DEAL_SELECT, parseDealInput } from '@/lib/mobile/deals'
import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'

type Params = { params: Promise<{ id: string }> }

async function loadDeal(supabase: SupabaseClient, accountId: string, id: string) {
  if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Deal not found', 404)
  const { data, error } = await supabase
    .from('deals')
    .select(DEAL_SELECT)
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new MobileError('NOT_FOUND', 'Deal not found', 404)
  return data as Record<string, unknown> & { pipeline_id: string }
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    return ok(await loadDeal(supabase, accountId, id))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const current = await loadDeal(supabase, accountId, id)
    const input = parseDealInput(await readJson(request), false)
    if (Object.keys(input).length === 0) throw new MobileError('VALIDATION', 'Nothing to update', 400)

    if (input.pipeline_id || input.stage_id || input.contact_id || input.assigned_to) {
      await assertDealRefs(supabase, accountId, {
        pipelineId: input.pipeline_id ?? current.pipeline_id,
        stageId: input.stage_id,
        contactId: input.contact_id,
        assignedTo: input.assigned_to,
      })
    }

    // closed_at follows status through a trigger (migration 059).
    const { error } = await supabase.from('deals').update(input).eq('id', id).eq('account_id', accountId)
    if (error) throw error
    return ok(await loadDeal(supabase, accountId, id))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    await loadDeal(supabase, accountId, id)
    const { error } = await supabase.from('deals').delete().eq('id', id).eq('account_id', accountId)
    if (error) throw error
    return ok({ deleted: true })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
