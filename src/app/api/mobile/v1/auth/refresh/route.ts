// POST /api/mobile/v1/auth/refresh — { refreshToken } → a new token pair.
// Supabase rotates the refresh token on every use; the app must store the new one.

import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'
import {
  createStatelessClient,
  limitAuthAttempts,
  serializeTokens,
} from '@/lib/mobile/session'

export async function POST(request: Request) {
  try {
    const { refreshToken } = await readJson(request)
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new MobileError('VALIDATION', 'refreshToken is required', 400)
    }
    limitAuthAttempts(request, 'refresh')

    const { data, error } = await createStatelessClient().auth.refreshSession({
      refresh_token: refreshToken,
    })
    if (error || !data.session) {
      throw new MobileError('UNAUTHORIZED', 'Session expired. Sign in again.', 401)
    }
    return ok(serializeTokens(data.session))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
