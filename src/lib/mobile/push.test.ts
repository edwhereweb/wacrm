import { describe, expect, it, vi } from 'vitest'

import { notifyInboundMessage, preview, sendPush } from './push'

function fakeDb(tables: Record<string, unknown[]>) {
  const deletes: { table: string; values: unknown[] }[] = []
  const filters: Record<string, [string, unknown][]> = {}
  const db = {
    from(table: string) {
      const rows = tables[table] ?? []
      filters[table] = []
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => (filters[table].push([c, v]), b)
      b.in = (c: string, v: unknown) => (filters[table].push([c, v]), b)
      b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok)
      b.delete = () => ({
        in: (_c: string, values: unknown[]) => (deletes.push({ table, values }), Promise.resolve({ error: null })),
      })
      return b
    },
  }
  return { db: db as never, deletes, filters }
}

const okFetch = (tickets: unknown[]) =>
  vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: tickets }) })

describe('preview', () => {
  it('collapses whitespace, truncates, and falls back when empty', () => {
    expect(preview('  hi\n there ', 'x')).toBe('hi there')
    expect(preview('a'.repeat(150), 'x')).toHaveLength(100)
    expect(preview(null, 'New message')).toBe('New message')
  })
})

describe('sendPush', () => {
  it('drops tokens Expo reports as uninstalled', async () => {
    const { db, deletes } = fakeDb({})
    const fetchImpl = okFetch([{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }])
    await sendPush(db, [
      { to: 'tok-a', title: 't', body: 'b', data: { type: 'message' } },
      { to: 'tok-b', title: 't', body: 'b', data: { type: 'message' } },
    ], fetchImpl)
    expect(deletes).toEqual([{ table: 'mobile_devices', values: ['tok-b'] }])
  })

  it('never throws when Expo is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = fakeDb({})
    await expect(
      sendPush(db, [{ to: 'x', title: 't', body: 'b', data: { type: 'm' } }], vi.fn().mockRejectedValue(new Error('down')))
    ).resolves.toBeUndefined()
  })
})

describe('notifyInboundMessage recipients', () => {
  it('notifies only the assignee of an assigned chat', async () => {
    const { db, filters } = fakeDb({
      conversations: [{ assigned_agent_id: 'u1', contact: { name: 'Asha', phone: '+91' } }],
      mobile_devices: [],
    })
    await notifyInboundMessage(db, { accountId: 'a', conversationId: 'c', text: 'hi', contentType: 'text' })
    expect(filters.mobile_devices).toContainEqual(['user_id', ['u1']])
    expect(filters.profiles).toBeUndefined()
  })

  it('notifies every agent and above for an unassigned chat', async () => {
    const { db, filters } = fakeDb({
      conversations: [{ assigned_agent_id: null, contact: null }],
      profiles: [{ user_id: 'u1' }, { user_id: 'u2' }],
      mobile_devices: [],
    })
    await notifyInboundMessage(db, { accountId: 'a', conversationId: 'c', text: 'hi', contentType: 'text' })
    expect(filters.profiles).toContainEqual(['account_role', ['owner', 'admin', 'agent']])
    expect(filters.mobile_devices).toContainEqual(['user_id', ['u1', 'u2']])
  })
})
