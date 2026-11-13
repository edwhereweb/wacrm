// GET  /api/mobile/v1/conversations/{id}/messages?cursor=&limit= — newest first, reactions embedded.
//      Polling re-reads the first page, which also picks up delivery-status changes.
// POST /api/mobile/v1/conversations/{id}/messages — send (agent+), body:
//      { message_type, content_text?, media_url?, filename?, template_name?,
//        template_language?, template_params?, interactive_payload?, reply_to_message_id? }

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import {
  buildPage,
  isUuid,
  keysetFilter,
  parseListParams,
} from '@/lib/api/v1/pagination'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { limitUser, serializeMessage } from '@/lib/mobile/inbox'
import {
  fail,
  MobileError,
  ok,
  okList,
  readJson,
  toMobileErrorResponse,
} from '@/lib/mobile/respond'
import { SendMessageError, sendMessageToConversation } from '@/lib/whatsapp/send-message'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { InteractiveMessagePayload, Message, MessageReaction } from '@/types'

type Params = { params: Promise<{ id: string }> }

async function assertConversation(supabase: SupabaseClient, accountId: string, id: string) {
  if (!isUuid(id)) throw new MobileError('NOT_FOUND', 'Conversation not found', 404)
  const { data, error } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new MobileError('NOT_FOUND', 'Conversation not found', 404)
}

export async function GET(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    limitUser(userId)
    const { id } = await params
    await assertConversation(supabase, accountId, id)

    const { limit, cursor } = parseListParams(request)
    let query = supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
    const kf = keysetFilter(cursor)
    if (kf) query = query.or(kf)

    const { data, error } = await query
    if (error) throw error
    const { items, nextCursor } = buildPage((data ?? []) as Message[], limit)

    let reactions: MessageReaction[] = []
    if (items.length > 0) {
      const { data: rows, error: rErr } = await supabase
        .from('message_reactions')
        .select('message_id, emoji, actor_type')
        .in('message_id', items.map((m) => m.id))
      if (rErr) throw rErr
      reactions = (rows ?? []) as MessageReaction[]
    }

    return okList(items.map((m) => serializeMessage(m, reactions)), nextCursor)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)

export async function POST(request: Request, { params }: Params) {
  try {
    // Role check before anything reaches Meta: RLS only blocks the save,
    // after the customer already has the message.
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send) // shared with the dashboard
    if (!limit.success) {
      throw new MobileError('RATE_LIMITED', 'Sending too fast. Wait a moment.', 429)
    }

    const { id } = await params
    await assertConversation(supabase, accountId, id)
    const body = await readJson(request)
    const templateParams = Array.isArray(body.template_params)
      ? body.template_params.map(String)
      : undefined

    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId: id,
        messageType: str(body.message_type) ?? 'text',
        contentText: str(body.content_text),
        mediaUrl: str(body.media_url),
        filename: str(body.filename),
        templateName: str(body.template_name),
        templateLanguage: str(body.template_language),
        templateParams,
        // Validated by the send core (lib/whatsapp/interactive) before anything reaches Meta.
        interactivePayload: (body.interactive_payload ?? null) as InteractiveMessagePayload | null,
        replyToMessageId: str(body.reply_to_message_id),
        senderId: userId,
      })
      return ok(
        { message_id: result.messageId, whatsapp_message_id: result.whatsappMessageId },
        201
      )
    } catch (err) {
      if (err instanceof SendMessageError) {
        // Keep the send core's machine code (e.g. meta_error) so the app can branch on it.
        const code = err.status === 400 ? 'VALIDATION' : err.status === 404 ? 'NOT_FOUND' : 'INTERNAL'
        return fail(code, err.message, err.status, { details: { reason: err.code } })
      }
      throw err
    }
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
