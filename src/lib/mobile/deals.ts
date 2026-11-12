// ============================================================
// Deal input validation for the mobile API. Mirrors what the dashboard's
// deal form writes (components/pipelines/deal-form.tsx), but checked on
// the server because the app is a thin client.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUuid } from '@/lib/api/v1/pagination'
import { CURRENCIES } from '@/lib/currency'
import { MobileError } from './respond'

/** Deal row with the contact the board and detail screens show. */
export const DEAL_SELECT =
  '*, contact:contacts(id, name, phone, email, company, avatar_url)'

export interface DealWrite {
  title?: string
  value?: number
  currency?: string
  contact_id?: string
  pipeline_id?: string
  stage_id?: string
  assigned_to?: string | null
  notes?: string | null
  expected_close_date?: string | null
  status?: 'open' | 'won' | 'lost'
}

const bad = (message: string) => new MobileError('VALIDATION', message, 400)
const CURRENCY_CODES = new Set(CURRENCIES.map((c) => c.code))

/**
 * Validate the fields present in `body`. With `creating`, title, contact,
 * pipeline and stage are required, as in the dashboard form.
 */
export function parseDealInput(body: Record<string, unknown>, creating: boolean): DealWrite {
  const out: DealWrite = {}
  const has = (k: string) => k in body

  if (has('title') || creating) {
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title || title.length > 200) throw bad('title must be 1–200 characters')
    out.title = title
  }
  if (has('value')) {
    const value = typeof body.value === 'number' ? body.value : Number(body.value)
    if (!Number.isFinite(value) || value < 0) throw bad('value must be a number of 0 or more')
    out.value = value
  }
  if (has('currency')) {
    if (typeof body.currency !== 'string' || !CURRENCY_CODES.has(body.currency)) throw bad('currency is not supported')
    out.currency = body.currency
  }
  for (const key of ['contact_id', 'pipeline_id', 'stage_id'] as const) {
    if (has(key) || creating) {
      const v = body[key]
      if (typeof v !== 'string' || !isUuid(v)) throw bad(`${key} is required`)
      out[key] = v
    }
  }
  if (has('assigned_to')) {
    const v = body.assigned_to
    if (v !== null && (typeof v !== 'string' || !isUuid(v))) throw bad('assigned_to must be a user id or null')
    out.assigned_to = v as string | null
  }
  if (has('notes')) {
    const v = body.notes
    if (v !== null && typeof v !== 'string') throw bad('notes must be text or null')
    out.notes = typeof v === 'string' && v.trim() ? v.trim().slice(0, 5000) : null
  }
  if (has('expected_close_date')) {
    const v = body.expected_close_date
    if (v !== null && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) {
      throw bad('expected_close_date must be YYYY-MM-DD or null')
    }
    out.expected_close_date = v as string | null
  }
  if (has('status')) {
    if (!['open', 'won', 'lost'].includes(body.status as string)) throw bad('status must be open, won or lost')
    out.status = body.status as DealWrite['status']
  }
  return out
}

/**
 * Check that every referenced row is in the caller's account and that the
 * stage belongs to the pipeline. RLS would hide foreign rows, but a deal
 * pointing at another account's stage must be refused, not silently saved.
 */
export async function assertDealRefs(
  db: SupabaseClient,
  accountId: string,
  refs: { pipelineId: string; stageId?: string; contactId?: string; assignedTo?: string | null }
): Promise<void> {
  const checks = await Promise.all([
    db.from('pipelines').select('id').eq('id', refs.pipelineId).eq('account_id', accountId).maybeSingle(),
    refs.stageId
      ? db.from('pipeline_stages').select('id').eq('id', refs.stageId).eq('pipeline_id', refs.pipelineId).maybeSingle()
      : null,
    refs.contactId
      ? db.from('contacts').select('id').eq('id', refs.contactId).eq('account_id', accountId).maybeSingle()
      : null,
    refs.assignedTo
      ? db.from('profiles').select('user_id').eq('user_id', refs.assignedTo).eq('account_id', accountId).maybeSingle()
      : null,
  ])
  const [pipeline, stage, contact, assignee] = checks
  for (const c of checks) if (c?.error) throw c.error
  if (!pipeline?.data) throw bad('That pipeline is not in this account')
  if (stage && !stage.data) throw bad('That stage is not in this pipeline')
  if (contact && !contact.data) throw bad('That contact is not in this account')
  if (assignee && !assignee.data) throw bad('That user is not in this account')
}
