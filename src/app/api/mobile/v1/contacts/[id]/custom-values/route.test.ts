import { beforeEach, describe, expect, it, vi } from 'vitest'

const C = '11111111-1111-4111-8111-111111111111'
const F1 = '22222222-2222-4222-8222-222222222222'
const F2 = '33333333-3333-4333-8333-333333333333'

const writes: { op: string; table: string; arg?: unknown }[] = []
const tables: Record<string, { data: unknown; error: unknown }> = {}
const client = {
  from(table: string) {
    const b: Record<string, unknown> = {}
    const result = () => Promise.resolve(tables[table] ?? { data: null, error: null })
    for (const m of ['select', 'eq', 'in']) b[m] = () => b
    b.maybeSingle = result
    b.then = (ok: (v: unknown) => unknown) => result().then(ok)
    b.upsert = (arg: unknown) => (writes.push({ op: 'upsert', table, arg }), Promise.resolve({ error: null }))
    b.delete = () => {
      writes.push({ op: 'delete', table })
      const d: Record<string, unknown> = {}
      d.eq = () => d
      d.in = (_c: string, ids: unknown) => ((writes.at(-1)!.arg = ids), Promise.resolve({ error: null }))
      return d
    }
    return b
  },
}
const requireRole = vi.fn()
vi.mock('@/lib/auth/account', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/account')>()),
  requireRole: (min: string) => requireRole(min),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { ForbiddenError } = await import('@/lib/auth/account')
const { PUT } = await import('./route')
const put = (body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: C }) })

beforeEach(() => {
  writes.length = 0
  for (const k of Object.keys(tables)) delete tables[k]
  requireRole.mockReset().mockResolvedValue({ supabase: client, accountId: 'acct-1' })
  tables.contacts = { data: { id: C }, error: null }
})

describe('PUT custom-values', () => {
  it('saves set fields and clears emptied ones', async () => {
    tables.custom_fields = { data: [{ id: F1 }, { id: F2 }], error: null }
    const res = await put({ values: { [F1]: ' Batch 7 ', [F2]: '' } })
    expect(res.status).toBe(200)
    expect(writes).toEqual([
      { op: 'upsert', table: 'contact_custom_values', arg: [{ contact_id: C, custom_field_id: F1, value: 'Batch 7' }] },
      { op: 'delete', table: 'contact_custom_values', arg: [F2] },
    ])
  })

  it('refuses a field from another account without writing', async () => {
    tables.custom_fields = { data: [{ id: F1 }], error: null }
    const res = await put({ values: { [F1]: 'a', [F2]: 'b' } })
    expect(res.status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('refuses viewers and malformed bodies', async () => {
    expect((await put({ values: { 'not-a-uuid': 'x' } })).status).toBe(400)
    expect((await put({ values: [] })).status).toBe(400)
    requireRole.mockRejectedValue(new ForbiddenError('Agents only'))
    expect((await put({ values: { [F1]: 'x' } })).status).toBe(403)
  })
})
