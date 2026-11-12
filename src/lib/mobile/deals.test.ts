import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { assertDealRefs, parseDealInput } = await import('./deals')

const P = '11111111-1111-4111-8111-111111111111'
const S = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('parseDealInput', () => {
  it('requires title, contact, pipeline and stage when creating', () => {
    expect(() => parseDealInput({ title: 'X', pipeline_id: P, stage_id: S }, true)).toThrow(/contact_id/)
    expect(() => parseDealInput({ contact_id: C, pipeline_id: P, stage_id: S }, true)).toThrow(/title/)
    expect(parseDealInput({ title: ' Course ', contact_id: C, pipeline_id: P, stage_id: S }, true)).toEqual({
      title: 'Course',
      contact_id: C,
      pipeline_id: P,
      stage_id: S,
    })
  })

  it('only touches fields that are present on update', () => {
    expect(parseDealInput({ stage_id: S }, false)).toEqual({ stage_id: S })
    expect(parseDealInput({ notes: '  ', assigned_to: null }, false)).toEqual({ notes: null, assigned_to: null })
  })

  it('rejects bad values', () => {
    expect(() => parseDealInput({ value: -1 }, false)).toThrow(/value/)
    expect(() => parseDealInput({ value: 'abc' }, false)).toThrow(/value/)
    expect(() => parseDealInput({ currency: 'XYZ' }, false)).toThrow(/currency/)
    expect(() => parseDealInput({ status: 'closed' }, false)).toThrow(/status/)
    expect(() => parseDealInput({ expected_close_date: '13/11/2026' }, false)).toThrow(/YYYY-MM-DD/)
    expect(() => parseDealInput({ stage_id: 'nope' }, false)).toThrow(/stage_id/)
  })

  it('accepts numeric strings for value and a known currency', () => {
    expect(parseDealInput({ value: '1500.5', currency: 'INR' }, false)).toEqual({ value: 1500.5, currency: 'INR' })
  })
})

describe('assertDealRefs', () => {
  function db(found: Record<string, boolean>) {
    return {
      from(table: string) {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = () => Promise.resolve({ data: found[table] ? { id: 'x' } : null, error: null })
        return b
      },
    } as never
  }

  it('refuses a stage from another pipeline or a foreign contact', async () => {
    await expect(
      assertDealRefs(db({ pipelines: true, pipeline_stages: false }), 'a', { pipelineId: P, stageId: S })
    ).rejects.toThrow(/stage/)
    await expect(
      assertDealRefs(db({ pipelines: true, pipeline_stages: true, contacts: false }), 'a', { pipelineId: P, stageId: S, contactId: C })
    ).rejects.toThrow(/contact/)
    await expect(assertDealRefs(db({ pipelines: false }), 'a', { pipelineId: P })).rejects.toThrow(/pipeline/)
  })

  it('passes when everything is in the account', async () => {
    await expect(
      assertDealRefs(db({ pipelines: true, pipeline_stages: true, contacts: true }), 'a', { pipelineId: P, stageId: S, contactId: C })
    ).resolves.toBeUndefined()
  })
})
