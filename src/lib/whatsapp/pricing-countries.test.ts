import { describe, expect, it } from 'vitest'
import { countryForPhone, phonePrefix, PRICING_COUNTRIES } from './pricing-countries'

describe('countryForPhone', () => {
  it('reads the country from the calling code', () => {
    expect(countryForPhone('919876543210')).toBe('IN')
    expect(countryForPhone('+971 50 123 4567')).toBe('AE')
    expect(countryForPhone('447700900123')).toBe('GB')
    expect(countryForPhone('14155550123')).toBe('US')
  })

  it('prefers the longest calling code', () => {
    expect(countryForPhone('77011234567')).toBe('KZ')
    expect(countryForPhone('79161234567')).toBe('RU')
  })

  it('works on a stored 4-digit prefix', () => {
    expect(countryForPhone('9715')).toBe('AE')
    expect(countryForPhone('9198')).toBe('IN')
  })

  it('returns null for unknown or empty numbers', () => {
    expect(countryForPhone('99912345')).toBeNull()
    expect(countryForPhone('')).toBeNull()
    expect(countryForPhone(null)).toBeNull()
  })

  it('has no calling code listed twice', () => {
    const dials = PRICING_COUNTRIES.flatMap((c) => c.dial)
    expect(new Set(dials).size).toBe(dials.length)
  })
})

describe('phonePrefix', () => {
  it('keeps the first 4 digits only', () => {
    expect(phonePrefix('+91 98765 43210')).toBe('9198')
    expect(phonePrefix(undefined)).toBeNull()
  })
})
