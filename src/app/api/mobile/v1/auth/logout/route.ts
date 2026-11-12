// POST /api/mobile/v1/auth/logout — revoke this device's session.

import { parseBearerJwt } from '@/lib/mobile/bearer'
import { MobileError, ok, toMobileErrorResponse } from '@/lib/mobile/respond'
import { createStatelessClient } from '@/lib/mobile/session'

export async function POST(request: Request) {
  try {
    const token = parseBearerJwt(request.headers.get('authorization'))
    if (!token) throw new MobileError('UNAUTHORIZED', 'Not signed in', 401)

    // `admin.signOut` is the call `auth.signOut()` makes internally; it is
    // authorised by the user's own token. 'local' ends only this session,
    // leaving the agent signed in on the web.
    const { error } = await createStatelessClient().auth.admin.signOut(token, 'local')
    // An already-expired token is as signed-out as it gets.
    if (error && error.status !== 401 && error.status !== 403) throw error

    return ok({ signedOut: true })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
