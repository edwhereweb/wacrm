// GET  /api/mobile/v1/contacts?search=&tag=&cursor=&limit= — A→Z by name.
// POST /api/mobile/v1/contacts — { phone, name?, email?, company? } (agent+), find-or-create by phone.

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { isUuid } from '@/lib/api/v1/pagination'
import {
  ContactError,
  CONTACT_SELECT,
  findOrCreateContact,
  getContactById,
  serializeContact,
} from '@/lib/api/v1/contacts'
import { contactSearchFilter } from '@/lib/contacts/search-filter'
import { decodeOffset, limitUser } from '@/lib/mobile/inbox'
import { MobileError, ok, okList, readJson, toMobileErrorResponse } from '@/lib/mobile/respond'

export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    limitUser(userId)
    const params = new URL(request.url).searchParams
    const search = contactSearchFilter(params.get('search') ?? '', { includeEmail: true })
    const tag = params.get('tag')
    if (tag && !isUuid(tag)) throw new MobileError('VALIDATION', 'tag must be a tag id', 400)
    const offset = decodeOffset(params.get('cursor'))
    const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 100)

    // Same tag-filter trick as /api/v1/contacts: an aliased inner join used only for WHERE.
    let query = supabase
      .from('contacts')
      .select(tag ? `${CONTACT_SELECT}, tag_filter:contact_tags!inner(tag_id)` : CONTACT_SELECT)
      .eq('account_id', accountId)
      .order('name', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      // shortcut: offset paging (alphabetical order isn't keyset-friendly with
      // nullable names); the app dedupes by id.
      .range(offset, offset + limit)
    if (search) query = query.or(search)
    if (tag) query = query.eq('tag_filter.tag_id', tag)

    const { data, error } = await query
    if (error) throw error
    const rows = (data ?? []) as unknown as Record<string, unknown>[]
    const hasMore = rows.length > limit
    return okList(rows.slice(0, limit).map(serializeContact), hasMore ? String(offset + limit) : null)
  } catch (err) {
    return toMobileErrorResponse(err)
  }
}

const optional = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const body = await readJson(request)
    const phone = optional(body.phone)
    if (!phone) throw new MobileError('VALIDATION', 'phone is required', 400)

    const { id, created } = await findOrCreateContact(supabase, accountId, userId, {
      phone,
      name: optional(body.name),
      email: optional(body.email),
      company: optional(body.company),
    })
    const contact = await getContactById(supabase, accountId, id)
    return ok({ ...contact, created }, created ? 201 : 200)
  } catch (err) {
    if (err instanceof ContactError) {
      return toMobileErrorResponse(
        new MobileError(err.status === 400 ? 'VALIDATION' : 'INTERNAL', err.message, err.status)
      )
    }
    return toMobileErrorResponse(err)
  }
}
