import type { SupabaseClient } from '@supabase/supabase-js'
import { countryForPhone } from '@/lib/whatsapp/pricing-countries'

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

/**
 * Rates for one recipient country (ISO code, e.g. "AE"). Meta prices
 * by the recipient's country; countries without one use the default
 * rate card. Currency and tax always come from the default card.
 */
export interface CountryRate {
  country: string
  marketing: number
  utility: number
  authentication: number
}

/** One row of whatsapp_spend_range(). */
export interface SpendDailyRow {
  day: string
  category: string
  source: 'tracked' | 'estimated'
  /** First digits of the recipient's number; null when unknown. */
  phone_prefix?: string | null
  messages: number
}

/** Inclusive local date range, YYYY-MM-DD. */
export interface SpendRange {
  from: string
  to: string
}

/** Longest range the database will count. */
export const MAX_RANGE_DAYS = 366

export interface CategorySpend {
  category: SpendCategory
  messages: number
  cost: number
}

export interface CountrySpend {
  /** ISO country code, or null when the number's country is unknown. */
  country: string | null
  messages: number
  cost: number
  /** True when this country has its own rates; false = default rates. */
  customRates: boolean
}

export interface SpendSummary {
  categories: CategorySpend[]
  /** Spend per recipient country, dearest first. */
  countries: CountrySpend[]
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

function localDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** Shift a YYYY-MM-DD date by whole days (calendar maths, no time zone). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Every date from `from` to `to`, inclusive, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < MAX_RANGE_DAYS; d = addDays(d, 1)) out.push(d)
  return out
}

/**
 * The last `days` local calendar dates (YYYY-MM-DD), oldest first, so
 * days without any spend still show as zero on the chart.
 */
export function lastLocalDays(days: number, timeZone: string, now = new Date()): string[] {
  const today = localDateKey(now, timeZone)
  return daysBetween(addDays(today, -(days - 1)), today)
}

/** Range presets for the spend card. */
export function presetRange(
  preset: 'lastDays' | 'thisMonth' | 'lastMonth',
  timeZone: string,
  days = 30,
  now = new Date(),
): SpendRange {
  const today = localDateKey(now, timeZone)
  if (preset === 'lastDays') return { from: addDays(today, -(days - 1)), to: today }
  const firstOfMonth = `${today.slice(0, 8)}01`
  if (preset === 'thisMonth') return { from: firstOfMonth, to: today }
  const lastOfPrev = addDays(firstOfMonth, -1)
  return { from: `${lastOfPrev.slice(0, 8)}01`, to: lastOfPrev }
}

/** A usable range: both dates valid, in order, and not too long. */
export function isValidRange(range: SpendRange): boolean {
  const re = /^\d{4}-\d{2}-\d{2}$/
  if (!re.test(range.from) || !re.test(range.to)) return false
  if (Number.isNaN(Date.parse(range.from)) || Number.isNaN(Date.parse(range.to))) return false
  return range.from <= range.to && addDays(range.from, MAX_RANGE_DAYS - 1) >= range.to
}

export function summarizeSpend(
  rows: SpendDailyRow[],
  rates: RateCard,
  /** Every day of the range, so empty days chart as zero. */
  dayKeys: string[] = [],
  countryRates: CountryRate[] = [],
): SpendSummary {
  const byCountry = new Map(countryRates.map((r) => [r.country, r]))
  const counts: Record<SpendCategory, number> = { marketing: 0, utility: 0, authentication: 0 }
  const costs: Record<SpendCategory, number> = { marketing: 0, utility: 0, authentication: 0 }
  const perDay = new Map<string, number>(dayKeys.map((d) => [d, 0]))
  const perCountry = new Map<string | null, { messages: number; cost: number }>()
  let tracked = 0
  let estimated = 0

  for (const row of rows) {
    const category = priceCategory(row.category)
    const n = Number(row.messages) || 0
    if (!category || n <= 0) continue
    const country = countryForPhone(row.phone_prefix)
    const rate = (country ? byCountry.get(country)?.[category] : undefined) ?? rates[category]
    const cost = n * rate

    counts[category] += n
    costs[category] += cost
    if (row.source === 'tracked') tracked += n
    else estimated += n
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + cost)
    const c = perCountry.get(country) ?? { messages: 0, cost: 0 }
    c.messages += n
    c.cost += cost
    perCountry.set(country, c)
  }

  const categories = SPEND_CATEGORIES.map((category) => ({
    category,
    messages: counts[category],
    cost: round2(costs[category]),
  }))
  const subtotal = round2(SPEND_CATEGORIES.reduce((sum, c) => sum + costs[c], 0))
  const tax = round2((subtotal * rates.tax_percent) / 100)

  return {
    categories,
    countries: [...perCountry.entries()]
      .map(([country, c]) => ({
        country,
        messages: c.messages,
        cost: round2(c.cost),
        customRates: country !== null && byCountry.has(country),
      }))
      .sort((a, b) => b.cost - a.cost || b.messages - a.messages),
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
  range: SpendRange,
  timeZone: string,
): Promise<SpendDailyRow[]> {
  const { data, error } = await supabase.rpc('whatsapp_spend_range', {
    p_from: range.from,
    p_to: range.to,
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

export async function loadCountryRates(
  supabase: SupabaseClient,
  accountId: string,
): Promise<CountryRate[]> {
  const { data, error } = await supabase
    .from('whatsapp_country_rates')
    .select('country, marketing, utility, authentication')
    .eq('account_id', accountId)
    .order('country')
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => ({
    country: r.country,
    marketing: Number(r.marketing),
    utility: Number(r.utility),
    authentication: Number(r.authentication),
  }))
}

/** Replace the account's country rates with `rates`. */
export async function saveCountryRates(
  supabase: SupabaseClient,
  accountId: string,
  rates: CountryRate[],
): Promise<void> {
  const keep = rates.map((r) => r.country)
  let remove = supabase.from('whatsapp_country_rates').delete().eq('account_id', accountId)
  if (keep.length > 0) remove = remove.not('country', 'in', `(${keep.join(',')})`)
  const { error: deleteError } = await remove
  if (deleteError) throw new Error(deleteError.message)
  if (keep.length === 0) return

  const now = new Date().toISOString()
  const { error } = await supabase.from('whatsapp_country_rates').upsert(
    rates.map((r) => ({ account_id: accountId, ...r, updated_at: now })),
    { onConflict: 'account_id,country' },
  )
  if (error) throw new Error(error.message)
}
