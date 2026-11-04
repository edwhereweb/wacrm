import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The `pricing` block Meta attaches to message status webhooks
 * (per-message pricing). `billable` is false for free messages, e.g.
 * service replies or utility templates inside an open service window.
 */
export interface MetaStatusPricing {
  billable?: boolean
  pricing_model?: string
  category?: string
  type?: string
}

export interface MessageChargeRow {
  account_id: string
  wamid: string
  billable: boolean
  pricing_category: string
  pricing_type: string | null
  pricing_model: string | null
  delivered_at: string
}

/** Meta charges a template message once it is delivered. */
const CHARGEABLE_STATUSES = new Set(['delivered', 'read'])

/**
 * Turn one status webhook into a charge row, or null when it carries
 * nothing to record (not a delivery, or no pricing block).
 */
export function chargeRowFromStatus(
  accountId: string,
  status: {
    id: string
    status: string
    pricing?: MetaStatusPricing | null
  },
  deliveredAt: string,
): MessageChargeRow | null {
  const pricing = status.pricing
  if (!pricing || !CHARGEABLE_STATUSES.has(status.status)) return null
  const category = pricing.category?.trim().toLowerCase()
  if (!category || !status.id) return null

  const type = pricing.type?.trim().toLowerCase() || null
  // Older payloads may omit `billable`; free types are named "free_…".
  const billable =
    typeof pricing.billable === 'boolean'
      ? pricing.billable
      : !(type?.startsWith('free') ?? false) && category !== 'service'

  return {
    account_id: accountId,
    wamid: status.id,
    billable,
    pricing_category: category,
    pricing_type: type,
    pricing_model: pricing.pricing_model?.trim() || null,
    delivered_at: deliveredAt,
  }
}

/**
 * Store the charge. A message is charged once: the first delivery
 * status wins and a later `read` for the same message is ignored.
 * Best effort — a failure here must never break status processing.
 */
export async function recordMessageCharge(
  db: SupabaseClient,
  row: MessageChargeRow,
): Promise<void> {
  const { error } = await db
    .from('whatsapp_message_charges')
    .upsert(row, { onConflict: 'account_id,wamid', ignoreDuplicates: true })
  if (error) {
    console.error('recordMessageCharge failed:', error.message)
  }
}
