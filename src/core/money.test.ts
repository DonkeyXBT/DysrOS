import { describe, it, expect } from 'vitest'
import {
  money, addMoney, subtractMoney, multiplyMoney, sumMoney,
  convertMoney, formatMoney, roundHalfAwayFromZero,
} from './money.js'

describe('money construction', () => {
  it('rejects a non-integer minor amount', () => {
    expect(() => money(10.5, 'EUR')).toThrow(/integer/i)
  })

  it('accepts a negative amount, since refunds exist', () => {
    expect(money(-2200, 'EUR')).toEqual({ minor: -2200, currency: 'EUR' })
  })
})

describe('rounding', () => {
  it('rounds half away from zero, not to even', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3)
    expect(roundHalfAwayFromZero(3.5)).toBe(4)
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3)
    expect(roundHalfAwayFromZero(2.4)).toBe(2)
  })
})

describe('addition and subtraction', () => {
  it('adds amounts in the same currency', () => {
    expect(addMoney(money(22000, 'EUR'), money(1550, 'EUR')))
      .toEqual({ minor: 23550, currency: 'EUR' })
  })

  it('refuses to add different currencies', () => {
    expect(() => addMoney(money(100, 'EUR'), money(100, 'USD')))
      .toThrow(/currency mismatch/i)
  })

  it('subtracts, allowing a negative result', () => {
    expect(subtractMoney(money(1000, 'EUR'), money(2500, 'EUR')))
      .toEqual({ minor: -1500, currency: 'EUR' })
  })
})

describe('multiplication', () => {
  it('rounds the result to whole minor units', () => {
    expect(multiplyMoney(money(1999, 'EUR'), 0.15))
      .toEqual({ minor: 300, currency: 'EUR' })
  })
})

describe('summing', () => {
  it('returns zero in the given currency for an empty list', () => {
    expect(sumMoney([], 'GBP')).toEqual({ minor: 0, currency: 'GBP' })
  })

  it('sums a list', () => {
    const values = [money(1000, 'EUR'), money(250, 'EUR'), money(-100, 'EUR')]
    expect(sumMoney(values, 'EUR')).toEqual({ minor: 1150, currency: 'EUR' })
  })

  it('refuses a list containing a foreign currency', () => {
    expect(() => sumMoney([money(1000, 'EUR'), money(1, 'USD')], 'EUR'))
      .toThrow(/currency mismatch/i)
  })
})

describe('conversion', () => {
  it('converts using the supplied rate and rounds once', () => {
    expect(convertMoney(money(22000, 'USD'), 0.9231, 'EUR'))
      .toEqual({ minor: 20308, currency: 'EUR' })
  })

  it('rejects a non-positive rate', () => {
    expect(() => convertMoney(money(100, 'USD'), 0, 'EUR')).toThrow(/rate/i)
  })
})

describe('formatting', () => {
  it('formats with the currency symbol and two decimals', () => {
    expect(formatMoney(money(20308, 'EUR'))).toBe('€203.08')
    expect(formatMoney(money(-1500, 'USD'))).toBe('-$15.00')
    expect(formatMoney(money(5, 'GBP'))).toBe('£0.05')
  })
})
