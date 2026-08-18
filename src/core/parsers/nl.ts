import { type Money, money } from '../money.js'

/**
 * Dutch-locale extraction helpers.
 *
 * Dutch retail mail differs from English in ways that silently corrupt data if
 * ignored: the decimal separator is a comma and the thousands separator a dot,
 * so `1.234,56` is one thousand two hundred and not one point two; numeric
 * dates are day-first, so `03/09/2026` is 3 September; and the month
 * abbreviations are not the English three-letter forms — March is `mrt` and
 * October is `okt`.
 */

const MONTHS: Record<string, number> = {
  januari: 1, jan: 1,
  februari: 2, feb: 2,
  maart: 3, mrt: 3,
  april: 4, apr: 4,
  mei: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  augustus: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
}

const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')

/** Amount with a decimal comma, an optional dotted thousands group, or the
 *  Dutch whole-euro shorthand `19,-`. */
const AMOUNT = String.raw`-?\d{1,3}(?:\.\d{3})*(?:,(?:\d{2}|-|–))?|-?\d+(?:,(?:\d{2}|-|–))?`

function toMinor(raw: string): number | null {
  const negative = raw.trim().startsWith('-')
  const digits = raw.replace(/^-/, '').trim()

  const [whole = '', fraction] = digits.split(',')
  const wholeDigits = whole.replace(/\./g, '')
  if (!/^\d+$/.test(wholeDigits)) return null

  let cents = 0
  if (fraction !== undefined && fraction !== '-' && fraction !== '–') {
    if (!/^\d{2}$/.test(fraction)) return null
    cents = Number(fraction)
  }

  const minor = Number(wholeDigits) * 100 + cents
  return negative ? -minor : minor
}

/**
 * Parses a string that is expected to be an amount on its own, optionally
 * carrying a currency marker. Returns null rather than guessing when the text
 * holds no amount — a bare order number must never be read as money.
 */
export function parseDutchAmount(text: string): Money | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  if (/^gratis$/i.test(trimmed)) return money(0, 'EUR')

  const marked = new RegExp(String.raw`^(-?)\s*(?:€|EUR)\s*(${AMOUNT})$`, 'i').exec(trimmed)
  if (marked) {
    const minor = toMinor(marked[2]!)
    if (minor === null) return null
    return money(marked[1] === '-' ? -Math.abs(minor) : minor, 'EUR')
  }

  // Without a currency marker, only accept something that actually looks like a
  // decimal amount. `1234567890` is an order reference, not ten million euros.
  const bare = new RegExp(String.raw`^(-?\d{1,3}(?:\.\d{3})*,(?:\d{2}|-|–)|-?\d+,(?:\d{2}|-|–))$`).exec(trimmed)
  if (bare) {
    const minor = toMinor(bare[1]!)
    return minor === null ? null : money(minor, 'EUR')
  }

  return null
}

/** Finds the first amount inside a longer line of text. */
export function findDutchAmount(text: string): Money | null {
  const marked = new RegExp(String.raw`(-?)\s*(?:€|EUR)\s*(${AMOUNT})`, 'i').exec(text)
  if (marked) {
    const minor = toMinor(marked[2]!)
    if (minor === null) return null
    return money(marked[1] === '-' ? -Math.abs(minor) : minor, 'EUR')
  }

  const decimal = /(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2})/.exec(text)
  if (decimal) {
    const minor = toMinor(decimal[1]!)
    return minor === null ? null : money(minor, 'EUR')
  }

  return null
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function iso(year: number, month: number, day: number): string | null {
  if (!isRealDate(year, month, day)) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Parses a string expected to be a date on its own. Accepts a written Dutch
 * month with an optional leading weekday, or a day-first numeric date.
 * Returns a `YYYY-MM-DD` string, or null when the text is not a valid date.
 */
export function parseDutchDate(text: string): string | null {
  const trimmed = text.trim().toLowerCase()

  const written = new RegExp(
    String.raw`^(?:[a-zà-ü]+dag\s+)?(\d{1,2})\s+(${MONTH_PATTERN})\s+(\d{4})$`,
    'i',
  ).exec(trimmed)
  if (written) {
    return iso(Number(written[3]), MONTHS[written[2]!]!, Number(written[1]))
  }

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(trimmed)
  if (numeric) {
    return iso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]))
  }

  return null
}

/** Finds the first date inside a longer line of text. */
export function findDutchDate(text: string): string | null {
  const lower = text.toLowerCase()

  const written = new RegExp(
    String.raw`(?:[a-zà-ü]+dag\s+)?(\d{1,2})\s+(${MONTH_PATTERN})\s+(\d{4})`,
    'i',
  ).exec(lower)
  if (written) {
    const result = iso(Number(written[3]), MONTHS[written[2]!]!, Number(written[1]))
    if (result) return result
  }

  const numeric = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(lower)
  if (numeric) {
    return iso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]))
  }

  return null
}

/**
 * Parses a day-and-month with no year, inferring the year from the date the
 * mail was received.
 *
 * bol.com writes delivery dates as `Bezorgdatum: 3 juli`. Assuming the calendar
 * year of the email is right all but a few days a year: an order placed on
 * 28 December delivering on 2 January belongs to the next year. The rule is to
 * take the year of the reference date, then roll forward if that would place
 * the date more than a month in the past.
 */
export function parseDutchDayMonth(text: string, referenceIso: string): string | null {
  const match = new RegExp(
    String.raw`^(?:[a-zà-ü]+dag\s+)?(\d{1,2})\s+(${MONTH_PATTERN})$`,
    'i',
  ).exec(text.trim().toLowerCase())
  if (!match) return null

  const day = Number(match[1])
  const month = MONTHS[match[2]!]!
  const reference = new Date(referenceIso)
  if (Number.isNaN(reference.getTime())) return null

  const sameYear = iso(reference.getUTCFullYear(), month, day)
  if (sameYear) {
    const gapDays = (reference.getTime() - Date.parse(`${sameYear}T00:00:00.000Z`)) / 86_400_000
    if (gapDays <= 31) return sameYear
  }

  return iso(reference.getUTCFullYear() + 1, month, day)
}
