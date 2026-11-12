// GET   /api/mobile/v1/conversations/{id} — one thread with contact, tags and can_reply_freeform.
// PATCH /api/mobile/v1/conversations/{id} — { status?, assigned_agent_id? } (agent+).

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import { CONVERSATION_SELECT, normalizeConversation } from '@/lib/inbox/conversations'
import { serializeConversation } from '@/lib/mobile/inbox'
import { MobileError, ok, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'
import type { SupabaseClient } from '@supabase/supabase-js'

type Params = { params: Promise<{ id: string }> }

async function loadConversation(supabase: SupabaseClient, accountId: string, id: string) {
  if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Conversation not found', 404)
  const { data, error } = await supabase
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new MobileError('NOT_FOUND', 'Conversation not found', 404)
  return serializeConversation(normalizeConversation(data as never))
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    return ok(await loadConversation(supabase, accountId, id))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const body = await readJson(request)
    await loadConversation(supabase, accountId, id) // 404 for a foreign or unknown id

    const update: Record<string, unknown> = {}
    if ('status' in body) {
      if (!['open', 'pending', 'closed'].includes(body.status as string)) {
        throw new MobileError('VALIDATION', 'status must be open, pending or closed', 400)
      }
      update.status = body.status // closed_at is stamped by a trigger (migration 059)
    }
    if ('assigned_agent_id' in body) {
      const agentId = body.assigned_agent_id
      if (agentId !== null) {
        if (typeof agentId !== 'string' || !isUuid(agentId)) {
          throw new MobileError('VALIDATION', 'assigned_agent_id must be a user id or null', 400)
        }
        // Only a member of this account can own the thread.
        const { data: member } = await supabase
          .from('profiles')
          .select('user_id')
          .eq('user_id', agentId)
          .eq('account_id', accountId)
          .maybeSingle()
        if (!member) throw new MobileError('VALIDATION', 'That user is not in this account', 400)
      }
      update.assigned_agent_id = agentId
    }
    if (Object.keys(update).length === 0) {
      throw new MobileError('VALIDATION', 'Nothing to update', 400)
    }

    const { error } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) throw error

    return ok(await loadConversation(supabase, accountId, id))
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
