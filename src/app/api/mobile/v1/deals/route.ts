// POST /api/mobile/v1/deals — create a deal (agent+). Body: title, contact_id, pipeline_id, stage_id,
// and optionally value, currency, assigned_to, notes, expected_close_date.

import { requireRole } from '@/lib/auth/account'
import { assertDealRefs, DEAL_SELECT, parseDealInput } from '@/lib/mobile/deals'
import { ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const input = parseDealInput(await readJson(request), true)
    await assertDealRefs(supabase, accountId, {
      pipelineId: input.pipeline_id!,
      stageId: input.stage_id,
      contactId: input.contact_id,
      assignedTo: input.assigned_to,
    })

    const { data: account } = await supabase
      .from('accounts')
      .select('default_currency')
      .eq('id', accountId)
      .maybeSingle()

    const { data, error } = await supabase
      .from('deals')
      .insert({
        value: 0,
        currency: account?.default_currency ?? 'USD',
        ...input,
        status: 'open',
        account_id: accountId,
        user_id: userId,
      })
      .select(DEAL_SELECT)
      .single()
    if (error) throw error
    return ok(data, 201)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
