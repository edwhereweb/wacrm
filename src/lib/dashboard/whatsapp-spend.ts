import type { SupabaseClient } from '@supabase/supabase-js'

/** Meta's billing categories we price. Anything else costs nothing. */
export const SPEND_CATEGORIES = ['marketing', 'utility', 'authentication'] as const
export type SpendCategory = (typeof SPEND_CATEGORIES)[number]

export interface RateCard {
  currency: string
  marketing: number
  utility: number
  authentication: number
  /** GST / VAT added on top of Meta's rates, in percent. */
  tax_percent: number
}

/**
 * Meta's India list rates per delivered message, before GST (2026).
 * Used until an admin saves their own rate card. Meta revises these —
 * check https://developers.facebook.com/docs/whatsapp/pricing.
 */
export const DEFAULT_RATE_CARD: RateCard = {
  currency: 'INR',
  marketing: 0.8631,
  utility: 0.115,
  authentication: 0.115,
  tax_percent: 18,
}

/** One row of whatsapp_spend_daily(). */
export interface SpendDailyRow {
  day: string
  category: string
  source: 'tracked' | 'estimated'
  messages: number
}

export interface CategorySpend {
  category: SpendCategory
  messages: number
  cost: number
}

export interface SpendSummary {
  categories: CategorySpend[]
  /** Billable messages across all priced categories. */
  messages: number
  subtotal: number
  tax: number
  total: number
  /** Messages whose charge Meta reported (exact) vs estimated from templates. */
  trackedMessages: number
  estimatedMessages: number
  /** Total cost per day, oldest first, for the sparkline. */
  daily: { day: string; cost: number }[]
}

/**
 * Map Meta's category to a priced one. "authentication_international"
 * is priced like authentication (it is dearer; admins can raise the
 * authentication rate if they send many abroad). Service, free-entry
 * and unknown categories return null — not charged.
 */
export function priceCategory(raw: string): SpendCategory | null {
  const c = raw.trim().toLowerCase()
  if (c === 'marketing' || c === 'marketing_lite') return 'marketing'
  if (c === 'utility') return 'utility'
  if (c.startsWith('authentication')) return 'authentication'
  return null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * The last `days` local calendar dates (YYYY-MM-DD), oldest first, so
 * days without any spend still show as zero on the chart.
 */
export function lastLocalDays(days: number, timeZone: string, now = new Date()): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const key = fmt.format(new Date(now.getTime() - i * 86_400_000))
    if (out[out.length - 1] !== key) out.push(key)
  }
  return out
}

export function summarizeSpend(
  rows: SpendDailyRow[],
  rates: RateCard,
  /** Every day of the range, so empty days chart as zero. */
  dayKeys: string[] = [],
): SpendSummary {
  const counts: Record<SpendCategory, number> = { marketing: 0, utility: 0, authentication: 0 }
  const perDay = new Map<string, number>(dayKeys.map((d) => [d, 0]))
  let tracked = 0
  let estimated = 0

  for (const row of rows) {
    const category = priceCategory(row.category)
    const n = Number(row.messages) || 0
    if (!category || n <= 0) continue
    counts[category] += n
    if (row.source === 'tracked') tracked += n
    else estimated += n
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + n * rates[category])
  }

  const categories = SPEND_CATEGORIES.map((category) => ({
    category,
    messages: counts[category],
    cost: round2(counts[category] * rates[category]),
  }))
  const subtotal = round2(categories.reduce((sum, c) => sum + counts[c.category] * rates[c.category], 0))
  const tax = round2((subtotal * rates.tax_percent) / 100)

  return {
    categories,
    messages: tracked + estimated,
    subtotal,
    tax,
    total: round2(subtotal + tax),
    trackedMessages: tracked,
    estimatedMessages: estimated,
    daily: [...perDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, cost]) => ({ day, cost: round2(cost) })),
  }
}

export async function loadSpendRows(
  supabase: SupabaseClient,
  days: number,
  timeZone: string,
): Promise<SpendDailyRow[]> {
  const { data, error } = await supabase.rpc('whatsapp_spend_daily', {
    p_days: days,
    p_timezone: timeZone,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as SpendDailyRow[]
}

export async function loadRateCard(
  supabase: SupabaseClient,
  accountId: string,
): Promise<RateCard> {
  const { data, error } = await supabase
    .from('whatsapp_rate_cards')
    .select('currency, marketing, utility, authentication, tax_percent')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return DEFAULT_RATE_CARD
  return {
    currency: data.currency || DEFAULT_RATE_CARD.currency,
    marketing: Number(data.marketing),
    utility: Number(data.utility),
    authentication: Number(data.authentication),
    tax_percent: Number(data.tax_percent),
  }
}

export async function saveRateCard(
  supabase: SupabaseClient,
  accountId: string,
  rates: RateCard,
): Promise<void> {
  const { error } = await supabase.from('whatsapp_rate_cards').upsert(
    { account_id: accountId, ...rates, updated_at: new Date().toISOString() },
    { onConflict: 'account_id' },
  )
  if (error) throw new Error(error.message)
}
