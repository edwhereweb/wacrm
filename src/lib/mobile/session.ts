// ============================================================
// Mobile sign-in plumbing shared by the /api/mobile/v1/auth routes
// and /me.
// ============================================================

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

import {
  canEditSettings,
  canManageMembers,
  canSendMessages,
  isAccountRole,
} from '@/lib/auth/roles'
import { DEFAULT_CURRENCY } from '@/lib/currency'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'
import { MobileError } from './respond'

/** A one-request Supabase client: nothing persisted, nothing refreshed in the background. */
export function createStatelessClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}

export function serializeTokens(session: Session) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    // Unix seconds, so the app can refresh ahead of expiry.
    expiresAt: session.expires_at ?? null,
  }
}

/** Per-IP budget for the unauthenticated auth routes; throws a 429. */
export function limitAuthAttempts(request: Request, bucket: string, extraKey = '') {
  const limit = checkRateLimit(
    `mobile:${bucket}:${getClientIp(request)}:${extraKey}`,
    { limit: 10, windowMs: 60_000 }
  )
  if (!limit.success) {
    throw new MobileError('RATE_LIMITED', 'Too many attempts. Try again in a minute.', 429)
  }
}

/**
 * Who the caller is and what they may do. `supabase` must already act as
 * the user, so both lookups run under RLS.
 */
export async function loadMe(supabase: SupabaseClient, userId: string) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('full_name, email, avatar_url, account_id, account_role')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error

  if (!profile?.account_id || !isAccountRole(profile.account_role)) {
    throw new MobileError('FORBIDDEN', 'This user is not linked to an account', 403)
  }

  // Point lookup, not an embedded join — see getCurrentAccount (issue #294).
  const { data: account, error: accountErr } = await supabase
    .from('accounts')
    .select('id, name, default_currency')
    .eq('id', profile.account_id)
    .maybeSingle()
  if (accountErr) throw accountErr
  if (!account) {
    throw new MobileError('FORBIDDEN', 'This user is not linked to an account', 403)
  }

  const role = profile.account_role
  return {
    user: {
      id: userId,
      email: profile.email,
      full_name: profile.full_name,
      avatar_url: profile.avatar_url,
    },
    account: {
      id: account.id,
      name: account.name,
      default_currency: account.default_currency ?? DEFAULT_CURRENCY,
    },
    role,
    // Computed here so the app never re-implements role rules.
    capabilities: {
      canSend: canSendMessages(role),
      canEditSettings: canEditSettings(role),
      canManageMembers: canManageMembers(role),
    },
  }
}
