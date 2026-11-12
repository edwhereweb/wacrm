// DELETE /api/mobile/v1/devices/{token} — stop push to this phone (called on sign-out).

import { getCurrentAccount } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { ok, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function DELETE(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { userId } = await getCurrentAccount()
    const { token } = await params
    // Scoped to the caller, so one user can't unregister another's phone.
    const { error } = await supabaseAdmin()
      .from('mobile_devices')
      .delete()
      .eq('expo_push_token', decodeURIComponent(token))
      .eq('user_id', userId)
    if (error) throw error
    return ok({ removed: true })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
