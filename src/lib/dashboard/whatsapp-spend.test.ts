import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATE_CARD,
  daysBetween,
  isValidRange,
  lastLocalDays,
  presetRange,
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

describe('country pricing', () => {
  const rows: SpendDailyRow[] = [
    { day: '2026-11-02', category: 'marketing', source: 'tracked', phone_prefix: '9198', messages: 100 },
    { day: '2026-11-02', category: 'marketing', source: 'tracked', phone_prefix: '9715', messages: 10 },
    { day: '2026-11-02', category: 'utility', source: 'estimated', phone_prefix: '9715', messages: 4 },
    { day: '2026-11-02', category: 'marketing', source: 'estimated', phone_prefix: null, messages: 2 },
  ]
  const uae = { country: 'AE', marketing: 3.5, utility: 1.2, authentication: 1 }

  it('uses a country’s own rates and the default rates for the rest', () => {
    const s = summarizeSpend(rows, DEFAULT_RATE_CARD, [], [uae])
    // India + unknown at default: 102 × 0.8631 = 88.0362; UAE: 10 × 3.5 + 4 × 1.2 = 39.8
    expect(s.subtotal).toBe(127.84)
    expect(s.categories[0]).toEqual({ category: 'marketing', messages: 112, cost: 123.04 })
    expect(s.categories[1]).toEqual({ category: 'utility', messages: 4, cost: 4.8 })
  })

  it('breaks spend down by country, dearest first', () => {
    const s = summarizeSpend(rows, DEFAULT_RATE_CARD, [], [uae])
    expect(s.countries).toEqual([
      { country: 'IN', messages: 100, cost: 86.31, customRates: false },
      { country: 'AE', messages: 14, cost: 39.8, customRates: true },
      { country: null, messages: 2, cost: 1.73, customRates: false },
    ])
  })

  it('keeps a zero country rate (free) instead of falling back', () => {
    const s = summarizeSpend(rows, DEFAULT_RATE_CARD, [], [{ ...uae, marketing: 0, utility: 0 }])
    expect(s.countries.find((c) => c.country === 'AE')?.cost).toBe(0)
  })
})

describe('date ranges', () => {
  const now = new Date('2026-11-06T10:00:00Z')

  it('lists every day of a range, across months', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ])
  })

  it('builds the presets in local time', () => {
    expect(presetRange('lastDays', 'UTC', 7, now)).toEqual({ from: '2026-10-31', to: '2026-11-06' })
    expect(presetRange('thisMonth', 'UTC', 7, now)).toEqual({ from: '2026-11-01', to: '2026-11-06' })
    expect(presetRange('lastMonth', 'UTC', 7, now)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(presetRange('lastMonth', 'UTC', 7, new Date('2026-01-15T00:00:00Z'))).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    })
  })

  it('rejects reversed, empty or over-long ranges', () => {
    expect(isValidRange({ from: '2026-11-01', to: '2026-11-01' })).toBe(true)
    expect(isValidRange({ from: '2026-11-02', to: '2026-11-01' })).toBe(false)
    expect(isValidRange({ from: '', to: '2026-11-01' })).toBe(false)
    expect(isValidRange({ from: '2025-11-06', to: '2026-11-06' })).toBe(true) // 366 days
    expect(isValidRange({ from: '2025-11-05', to: '2026-11-06' })).toBe(false)
  })
})
