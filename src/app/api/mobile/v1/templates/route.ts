// GET /api/mobile/v1/templates — the account's approved WhatsApp templates, for the template picker.

import { getCurrentAccount } from '@/lib/auth/account'
import { ok, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('message_templates')
      .select('id, name, language, category, header_type, header_content, body_text, footer_text, buttons')
      .eq('account_id', accountId)
      .eq('status', 'APPROVED')
      .order('name')
    if (error) throw error
    return ok(data ?? [])
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}
