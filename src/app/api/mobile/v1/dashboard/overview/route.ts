// GET /api/mobile/v1/dashboard/overview?range=1|7|30|90&tz=Asia/Kolkata — the dashboard's numbers.
// Same `dashboard_overview` RPC the web dashboard calls, run as the user.

import { getCurrentAccount } from '@/lib/auth/account'
import { loadOverview, parseOverviewRange } from '@/lib/dashboard/overview'
import { limitUser } from '@/lib/mobile/inbox'
import { ok, toMobileErrorResponse } from '@/lib/mobile/respond'

function validTimeZone(tz: string | null): string {
  if (!tz) return 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

export async function GET(request: Request) {
  try {
    const { supabase, userId } = await getCurrentAccount()
    limitUser(userId)
    const params = new URL(request.url).searchParams
    const overview = await loadOverview(
      supabase,
      parseOverviewRange(params.get('range')),
      validTimeZone(params.get('tz'))
    )
    return ok(overview)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
