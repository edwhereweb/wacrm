// POST /api/mobile/v1/auth/login — { email, password } → tokens + who the user is.

import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'
import {
  createStatelessClient,
  limitAuthAttempts,
  loadMe,
  serializeTokens,
} from '@/lib/mobile/session'

export async function POST(request: Request) {
  try {
    const { email, password } = await readJson(request)
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      throw new MobileError('VALIDATION', 'email and password are required', 400)
    }
    limitAuthAttempts(request, 'login', email.trim().toLowerCase())

    const supabase = createStatelessClient()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (error || !data.session) {
      // One message for unknown user and wrong password alike.
      throw new MobileError('UNAUTHORIZED', 'Invalid email or password', 401)
    }

    // The client now holds the session in memory, so loadMe runs under RLS as the user.
    const me = await loadMe(supabase, data.session.user.id)
    return ok({ ...serializeTokens(data.session), ...me })
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
