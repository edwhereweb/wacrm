// GET /api/mobile/v1/pipelines — the account's pipelines with their stages in board order.

import { getCurrentAccount } from '@/lib/auth/account'
import { ok, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data: pipelines, error } = await supabase
      .from('pipelines')
      .select('id, name, created_at')
      .eq('account_id', accountId)
      .order('created_at')
    if (error) throw error

    const ids = (pipelines ?? []).map((p) => p.id)
    const { data: stages, error: sErr } = ids.length
      ? await supabase
          .from('pipeline_stages')
          .select('id, pipeline_id, name, color, position')
          .in('pipeline_id', ids)
          .order('position')
      : { data: [], error: null }
    if (sErr) throw sErr

    return ok(
      (pipelines ?? []).map((p) => ({
        ...p,
        stages: (stages ?? []).filter((s) => s.pipeline_id === p.id),
      }))
    )
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
