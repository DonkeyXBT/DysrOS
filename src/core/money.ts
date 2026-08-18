export type Currency = 'EUR' | 'USD' | 'GBP'

export interface Money {
  minor: number
  currency: Currency
}

const SYMBOLS: Record<Currency, string> = { EUR: '€', USD: '$', GBP: '£' }

export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

export function money(minor: number, currency: Currency): Money {
  if (!Number.isInteger(minor)) {
    throw new Error(`Money requires an integer minor amount, received ${minor}`)
  }
  return { minor, currency }
}

function assertSameCurrency(a: Currency, b: Currency): void {
  if (a !== b) throw new Error(`Currency mismatch: ${a} and ${b}`)
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a.currency, b.currency)
  return { minor: a.minor + b.minor, currency: a.currency }
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a.currency, b.currency)
  return { minor: a.minor - b.minor, currency: a.currency }
}

export function multiplyMoney(m: Money, factor: number): Money {
  return { minor: roundHalfAwayFromZero(m.minor * factor), currency: m.currency }
}

export function sumMoney(values: Money[], currency: Currency): Money {
  let total = 0
  for (const value of values) {
    assertSameCurrency(value.currency, currency)
    total += value.minor
  }
  return { minor: total, currency }
}

export function convertMoney(m: Money, rate: number, to: Currency): Money {
  if (!(rate > 0)) throw new Error(`Conversion rate must be positive, received ${rate}`)
  return { minor: roundHalfAwayFromZero(m.minor * rate), currency: to }
}

export function formatMoney(m: Money): string {
  const sign = m.minor < 0 ? '-' : ''
  const absolute = Math.abs(m.minor)
  const units = Math.floor(absolute / 100)
  const cents = String(absolute % 100).padStart(2, '0')
  return `${sign}${SYMBOLS[m.currency]}${units}.${cents}`
}
