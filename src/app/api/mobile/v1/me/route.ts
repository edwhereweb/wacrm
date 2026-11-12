// GET   /api/mobile/v1/me — profile, account, role and capabilities.
// PATCH /api/mobile/v1/me — { full_name }.

import type { SupabaseClient } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'
import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'
import { loadMe } from '@/lib/mobile/session'

async function requireUser(): Promise<{ supabase: SupabaseClient; userId: string }> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) throw new MobileError('UNAUTHORIZED', 'Not signed in', 401)
  return { supabase, userId: data.user.id }
}

export async function GET() {
  try {
    const { supabase, userId } = await requireUser()
    return ok(await loadMe(supabase, userId))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase, userId } = await requireUser()
    const { full_name } = await readJson(request)
    const name = typeof full_name === 'string' ? full_name.trim() : ''
    if (!name || name.length > 100) {
      throw new MobileError('VALIDATION', 'full_name must be 1–100 characters', 400)
    }

    // RLS limits this to the caller's own row; migration 034 blocks role/account changes.
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: name })
      .eq('user_id', userId)
    if (error) throw error

    return ok(await loadMe(supabase, userId))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
