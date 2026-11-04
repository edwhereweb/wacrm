import { describe, expect, it, vi } from 'vitest'
import { chargeRowFromStatus, recordMessageCharge } from './message-charges'

const AT = '2026-11-04T10:00:00.000Z'

describe('chargeRowFromStatus', () => {
  it('records a billable marketing delivery', () => {
    expect(
      chargeRowFromStatus(
        'acct',
        {
          id: 'wamid.1',
          status: 'delivered',
          pricing: { billable: true, pricing_model: 'PMP', category: 'marketing', type: 'regular' },
        },
        AT,
      ),
    ).toEqual({
      account_id: 'acct',
      wamid: 'wamid.1',
      billable: true,
      pricing_category: 'marketing',
      pricing_type: 'regular',
      pricing_model: 'PMP',
      delivered_at: AT,
    })
  })

  it('keeps Meta’s billable=false for free messages', () => {
    const row = chargeRowFromStatus(
      'acct',
      {
        id: 'wamid.2',
        status: 'delivered',
        pricing: { billable: false, category: 'utility', type: 'free_customer_service' },
      },
      AT,
    )
    expect(row?.billable).toBe(false)
  })

  it('infers billable when Meta omits it', () => {
    const base = { id: 'w', status: 'read' }
    expect(chargeRowFromStatus('a', { ...base, pricing: { category: 'marketing', type: 'regular' } }, AT)?.billable).toBe(true)
    expect(chargeRowFromStatus('a', { ...base, pricing: { category: 'marketing', type: 'free_entry_point' } }, AT)?.billable).toBe(false)
    expect(chargeRowFromStatus('a', { ...base, pricing: { category: 'service' } }, AT)?.billable).toBe(false)
  })

  it('ignores statuses that are not deliveries, and statuses without pricing', () => {
    const pricing = { billable: true, category: 'marketing' }
    expect(chargeRowFromStatus('a', { id: 'w', status: 'sent', pricing }, AT)).toBeNull()
    expect(chargeRowFromStatus('a', { id: 'w', status: 'failed', pricing }, AT)).toBeNull()
    expect(chargeRowFromStatus('a', { id: 'w', status: 'delivered' }, AT)).toBeNull()
    expect(chargeRowFromStatus('a', { id: 'w', status: 'delivered', pricing: {} }, AT)).toBeNull()
  })

  it('normalises the category case', () => {
    expect(
      chargeRowFromStatus('a', { id: 'w', status: 'delivered', pricing: { category: 'AUTHENTICATION' } }, AT)
        ?.pricing_category,
    ).toBe('authentication')
  })
})

describe('recordMessageCharge', () => {
  it('upserts without overwriting an earlier delivery', async () => {
    const upsert = vi.fn(async () => ({ error: null }))
    const db = { from: vi.fn(() => ({ upsert })) }
    const row = chargeRowFromStatus('a', { id: 'w', status: 'delivered', pricing: { category: 'marketing' } }, AT)!
    await recordMessageCharge(db as never, row)
    expect(db.from).toHaveBeenCalledWith('whatsapp_message_charges')
    expect(upsert).toHaveBeenCalledWith(row, { onConflict: 'account_id,wamid', ignoreDuplicates: true })
  })

  it('swallows errors so status processing continues', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = { from: () => ({ upsert: async () => ({ error: { message: 'boom' } }) }) }
    const row = chargeRowFromStatus('a', { id: 'w', status: 'delivered', pricing: { category: 'marketing' } }, AT)!
    await expect(recordMessageCharge(db as never, row)).resolves.toBeUndefined()
    spy.mockRestore()
  })
})
