import { describe, it, expect } from 'vitest'
import { money } from './money.js'
import { vatFromGross, vatFromNet } from './vat.js'

describe('vatFromNet', () => {
  it('adds 21% VAT to a net amount', () => {
    const result = vatFromNet(money(10000, 'EUR'), 2100)
    expect(result.net).toEqual({ minor: 10000, currency: 'EUR' })
    expect(result.vat).toEqual({ minor: 2100, currency: 'EUR' })
    expect(result.gross).toEqual({ minor: 12100, currency: 'EUR' })
  })

  it('rounds the VAT amount to whole minor units', () => {
    const result = vatFromNet(money(999, 'EUR'), 2100)
    expect(result.vat).toEqual({ minor: 210, currency: 'EUR' })
    expect(result.gross).toEqual({ minor: 1209, currency: 'EUR' })
  })
})

describe('vatFromGross', () => {
  it('extracts 21% VAT from a gross amount', () => {
    const result = vatFromGross(money(12100, 'EUR'), 2100)
    expect(result.gross).toEqual({ minor: 12100, currency: 'EUR' })
    expect(result.vat).toEqual({ minor: 2100, currency: 'EUR' })
    expect(result.net).toEqual({ minor: 10000, currency: 'EUR' })
  })

  it('keeps net and VAT summing exactly to gross when rounding bites', () => {
    const result = vatFromGross(money(10000, 'EUR'), 2100)
    expect(result.vat).toEqual({ minor: 1736, currency: 'EUR' })
    expect(result.net).toEqual({ minor: 8264, currency: 'EUR' })
    expect(result.net.minor + result.vat.minor).toBe(result.gross.minor)
  })
})

describe('rate validation', () => {
  it('accepts a zero rate for VAT-exempt goods', () => {
    const result = vatFromNet(money(5000, 'EUR'), 0)
    expect(result.vat).toEqual({ minor: 0, currency: 'EUR' })
    expect(result.gross).toEqual({ minor: 5000, currency: 'EUR' })
  })

  it('rejects a negative rate', () => {
    expect(() => vatFromNet(money(5000, 'EUR'), -100)).toThrow(/rate/i)
  })

  it('rejects a non-integer rate, since rates are basis points', () => {
    expect(() => vatFromNet(money(5000, 'EUR'), 21.5)).toThrow(/basis points/i)
  })
})
