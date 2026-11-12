import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { createBearerClient, parseBearerJwt } from '@/lib/mobile/bearer'

export async function createClient() {
  // Mobile app requests authenticate with a bearer token, not cookies.
  const bearer = parseBearerJwt((await headers()).get('authorization'))
  if (bearer) return createBearerClient(bearer)

  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}
