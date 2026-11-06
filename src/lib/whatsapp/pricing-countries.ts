/**
 * Meta prices template messages by the RECIPIENT's country, read from
 * the phone number's calling code. This list covers the markets Meta
 * prices on its own plus common destinations; any other number is
 * charged at the account's default rate.
 *
 * `US` stands for the whole +1 zone (US and Canada are one market).
 */
export const PRICING_COUNTRIES: { code: string; dial: string[] }[] = [
  { code: 'AE', dial: ['971'] },
  { code: 'AR', dial: ['54'] },
  { code: 'AT', dial: ['43'] },
  { code: 'AU', dial: ['61'] },
  { code: 'BD', dial: ['880'] },
  { code: 'BE', dial: ['32'] },
  { code: 'BH', dial: ['973'] },
  { code: 'BR', dial: ['55'] },
  { code: 'CH', dial: ['41'] },
  { code: 'CL', dial: ['56'] },
  { code: 'CN', dial: ['86'] },
  { code: 'CO', dial: ['57'] },
  { code: 'DE', dial: ['49'] },
  { code: 'DK', dial: ['45'] },
  { code: 'EG', dial: ['20'] },
  { code: 'ES', dial: ['34'] },
  { code: 'FI', dial: ['358'] },
  { code: 'FR', dial: ['33'] },
  { code: 'GB', dial: ['44'] },
  { code: 'GH', dial: ['233'] },
  { code: 'GR', dial: ['30'] },
  { code: 'HK', dial: ['852'] },
  { code: 'ID', dial: ['62'] },
  { code: 'IE', dial: ['353'] },
  { code: 'IL', dial: ['972'] },
  { code: 'IN', dial: ['91'] },
  { code: 'IT', dial: ['39'] },
  { code: 'JO', dial: ['962'] },
  { code: 'JP', dial: ['81'] },
  { code: 'KE', dial: ['254'] },
  { code: 'KR', dial: ['82'] },
  { code: 'KW', dial: ['965'] },
  { code: 'KZ', dial: ['76', '77'] },
  { code: 'LK', dial: ['94'] },
  { code: 'MA', dial: ['212'] },
  { code: 'MX', dial: ['52'] },
  { code: 'MY', dial: ['60'] },
  { code: 'NG', dial: ['234'] },
  { code: 'NL', dial: ['31'] },
  { code: 'NO', dial: ['47'] },
  { code: 'NP', dial: ['977'] },
  { code: 'NZ', dial: ['64'] },
  { code: 'OM', dial: ['968'] },
  { code: 'PE', dial: ['51'] },
  { code: 'PH', dial: ['63'] },
  { code: 'PK', dial: ['92'] },
  { code: 'PL', dial: ['48'] },
  { code: 'PT', dial: ['351'] },
  { code: 'QA', dial: ['974'] },
  { code: 'RU', dial: ['7'] },
  { code: 'SA', dial: ['966'] },
  { code: 'SE', dial: ['46'] },
  { code: 'SG', dial: ['65'] },
  { code: 'TH', dial: ['66'] },
  { code: 'TR', dial: ['90'] },
  { code: 'TW', dial: ['886'] },
  { code: 'TZ', dial: ['255'] },
  { code: 'UA', dial: ['380'] },
  { code: 'UG', dial: ['256'] },
  { code: 'US', dial: ['1'] },
  { code: 'VN', dial: ['84'] },
  { code: 'ZA', dial: ['27'] },
]

export const PRICING_COUNTRY_CODES = PRICING_COUNTRIES.map((c) => c.code)

// Longest calling code first, so "77" (Kazakhstan) wins over "7".
const DIAL_INDEX = PRICING_COUNTRIES.flatMap((c) => c.dial.map((dial) => ({ dial, code: c.code }))).sort(
  (a, b) => b.dial.length - a.dial.length,
)

/** Digits we keep per recipient: enough to tell every calling code apart. */
export const PHONE_PREFIX_LENGTH = 4

/** First few digits of a phone / WhatsApp id, or null when there are none. */
export function phonePrefix(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits ? digits.slice(0, PHONE_PREFIX_LENGTH) : null
}

/** ISO country for a phone number (or its prefix); null when unknown. */
export function countryForPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (!digits) return null
  return DIAL_INDEX.find((d) => digits.startsWith(d.dial))?.code ?? null
}
