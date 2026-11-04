import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATE_CARD,
  lastLocalDays,
  priceCategory,
  summarizeSpend,
  type SpendDailyRow,
} from './whatsapp-spend'

describe('priceCategory', () => {
  it('maps Meta categories to priced ones', () => {
    expect(priceCategory('marketing')).toBe('marketing')
    expect(priceCategory('MARKETING_LITE')).toBe('marketing')
    expect(priceCategory('utility')).toBe('utility')
    expect(priceCategory('authentication')).toBe('authentication')
    expect(priceCategory('authentication_international')).toBe('authentication')
  })

  it('treats service and unknown categories as free', () => {
    expect(priceCategory('service')).toBeNull()
    expect(priceCategory('referral_conversion')).toBeNull()
  })
})

describe('summarizeSpend', () => {
  const rows: SpendDailyRow[] = [
    { day: '2026-11-02', category: 'marketing', source: 'estimated', messages: 100 },
    { day: '2026-11-02', category: 'utility', source: 'estimated', messages: 20 },
    { day: '2026-11-03', category: 'marketing', source: 'tracked', messages: 50 },
    { day: '2026-11-03', category: 'authentication', source: 'tracked', messages: 10 },
    { day: '2026-11-03', category: 'service', source: 'tracked', messages: 999 },
  ]

  it('prices each category with the rate card and adds GST', () => {
    const s = summarizeSpend(rows, DEFAULT_RATE_CARD)
    // 150 × 0.8631 + 20 × 0.115 + 10 × 0.115 = 129.465 + 2.3 + 1.15
    expect(s.categories).toEqual([
      { category: 'marketing', messages: 150, cost: 129.47 },
      { category: 'utility', messages: 20, cost: 2.3 },
      { category: 'authentication', messages: 10, cost: 1.15 },
    ])
    expect(s.subtotal).toBe(132.92)
    expect(s.tax).toBe(23.93)
    expect(s.total).toBe(156.85)
  })

  it('separates exact (tracked) from estimated counts and ignores free messages', () => {
    const s = summarizeSpend(rows, DEFAULT_RATE_CARD)
    expect(s.trackedMessages).toBe(60)
    expect(s.estimatedMessages).toBe(120)
    expect(s.messages).toBe(180)
  })

  it('builds a per-day cost series, oldest first', () => {
    const s = summarizeSpend([...rows].reverse(), DEFAULT_RATE_CARD)
    expect(s.daily.map((d) => d.day)).toEqual(['2026-11-02', '2026-11-03'])
    expect(s.daily[0].cost).toBe(88.61)
  })

  it('returns zeros for no data', () => {
    const s = summarizeSpend([], DEFAULT_RATE_CARD)
    expect(s.total).toBe(0)
    expect(s.daily).toEqual([])
  })
})

describe('lastLocalDays', () => {
  it('lists the last N local dates, oldest first', () => {
    const now = new Date('2026-11-04T20:00:00Z') // 05 Nov 01:30 in Kolkata
    expect(lastLocalDays(3, 'Asia/Kolkata', now)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05'])
    expect(lastLocalDays(1, 'UTC', now)).toEqual(['2026-11-04'])
  })

  it('fills days without spend with zero', () => {
    const s = summarizeSpend(
      [{ day: '2026-11-03', category: 'utility', source: 'tracked', messages: 10 }],
      DEFAULT_RATE_CARD,
      ['2026-11-02', '2026-11-03', '2026-11-04'],
    )
    expect(s.daily).toEqual([
      { day: '2026-11-02', cost: 0 },
      { day: '2026-11-03', cost: 1.15 },
      { day: '2026-11-04', cost: 0 },
    ])
  })
})
