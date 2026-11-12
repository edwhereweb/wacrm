// POST /api/mobile/v1/devices — { expo_push_token, platform, app_version? }: register this phone for push.
// The token moves to whoever signed in last on the phone.

import { getCurrentAccount } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'

// Expo tokens look like ExponentPushToken[xxxxxxxx].
const TOKEN_RE = /^Expo(nent)?PushToken\[[\w-]{10,}\]$/

export async function POST(request: Request) {
  try {
    const { userId } = await getCurrentAccount()
    const body = await readJson(request)
    const token = typeof body.expo_push_token === 'string' ? body.expo_push_token.trim() : ''
    const platform = body.platform
    if (!TOKEN_RE.test(token)) throw new MobileError('VALIDATION', 'expo_push_token is not an Expo push token', 400)
    if (platform !== 'android' && platform !== 'ios') {
      throw new MobileError('VALIDATION', 'platform must be android or ios', 400)
    }

    // Service role: the table has no client policies (migration 068). The
    // user comes from the verified session above.
    const { error } = await supabaseAdmin()
      .from('mobile_devices')
      .upsert(
        {
          expo_push_token: token,
          user_id: userId,
          platform,
          app_version: typeof body.app_version === 'string' ? body.app_version.slice(0, 20) : null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'expo_push_token' }
      )
    if (error) throw error
    return ok({ registered: true }, 201)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
