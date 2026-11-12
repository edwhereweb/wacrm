// ============================================================
// Mobile app sessions — a Supabase client for a request that carries
// `Authorization: Bearer <supabase access token>` instead of cookies.
//
// The mobile app has no cookie jar and no Supabase SDK; it holds the
// access token it got from POST /api/mobile/v1/auth/login. Forwarding
// that token to PostgREST makes `auth.uid()` resolve to the caller, so
// every RLS policy applies exactly as it does for the dashboard.
// ============================================================

import { createServerClient } from '@supabase/ssr'

/**
 * Pull a Supabase JWT out of an Authorization header. Public-API keys
 * (`wacrm_live_…`) also travel as bearer tokens but are not sessions,
 * so anything that isn't three dot-separated segments is ignored.
 */
export function parseBearerJwt(header: string | null): string | null {
  const token = header?.match(/^\s*bearer\s+(\S+)\s*$/i)?.[1]
  return token && token.split('.').length === 3 ? token : null
}

export function createBearerClient(token: string) {
  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: { getAll: () => [], setAll: () => {} },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  // There is no stored session, so a bare `auth.getUser()` would report
  // "session missing". Default it to the request's token so the existing
  // `getCurrentAccount()` and route code work unchanged for mobile callers.
  const getUser = client.auth.getUser.bind(client.auth)
  client.auth.getUser = (jwt?: string) => getUser(jwt ?? token)

  return client
}
