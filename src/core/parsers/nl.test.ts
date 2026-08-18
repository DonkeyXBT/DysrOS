import { describe, it, expect } from 'vitest'
import { parseDutchAmount, parseDutchDate, findDutchAmount, findDutchDate, parseDutchDayMonth } from './nl.js'

describe('parseDutchAmount', () => {
  it('reads a comma as the decimal separator', () => {
    expect(parseDutchAmount('219,99')).toEqual({ minor: 21999, currency: 'EUR' })
  })

  it('reads a dot as the thousands separator', () => {
    expect(parseDutchAmount('1.234,56')).toEqual({ minor: 123456, currency: 'EUR' })
    expect(parseDutchAmount('12.345.678,90')).toEqual({ minor: 1234567890, currency: 'EUR' })
  })

  it('accepts a euro symbol before the amount, with or without a space', () => {
    expect(parseDutchAmount('€ 219,99')).toEqual({ minor: 21999, currency: 'EUR' })
    expect(parseDutchAmount('€219,99')).toEqual({ minor: 21999, currency: 'EUR' })
    expect(parseDutchAmount('EUR 219,99')).toEqual({ minor: 21999, currency: 'EUR' })
  })

  it('handles the Dutch shorthand for whole euros', () => {
    expect(parseDutchAmount('€ 19,-')).toEqual({ minor: 1900, currency: 'EUR' })
    expect(parseDutchAmount('€ 19,–')).toEqual({ minor: 1900, currency: 'EUR' })
  })

  it('treats gratis as zero', () => {
    expect(parseDutchAmount('gratis')).toEqual({ minor: 0, currency: 'EUR' })
    expect(parseDutchAmount('Gratis')).toEqual({ minor: 0, currency: 'EUR' })
  })

  it('reads a negative amount, as a refund line would show', () => {
    expect(parseDutchAmount('-€ 219,99')).toEqual({ minor: -21999, currency: 'EUR' })
    expect(parseDutchAmount('€ -219,99')).toEqual({ minor: -21999, currency: 'EUR' })
  })

  it('treats a bare whole number as whole euros', () => {
    expect(parseDutchAmount('€ 219')).toEqual({ minor: 21900, currency: 'EUR' })
  })

  it('returns null for text carrying no amount', () => {
    expect(parseDutchAmount('Bestelnummer')).toBeNull()
    expect(parseDutchAmount('')).toBeNull()
  })

  it('does not mistake an order number for an amount', () => {
    expect(parseDutchAmount('Bestelnummer 1234567890')).toBeNull()
  })
})

describe('findDutchAmount', () => {
  it('pulls the amount out of a labelled line', () => {
    expect(findDutchAmount('Totaalbedrag: € 1.234,56 inclusief btw'))
      .toEqual({ minor: 123456, currency: 'EUR' })
  })

  it('returns the first amount when several appear', () => {
    expect(findDutchAmount('€ 10,00 en € 20,00')).toEqual({ minor: 1000, currency: 'EUR' })
  })

  it('returns null when the line holds no amount', () => {
    expect(findDutchAmount('Je bestelling is onderweg')).toBeNull()
  })
})

describe('parseDutchDate', () => {
  it('reads a full Dutch month name', () => {
    expect(parseDutchDate('18 augustus 2026')).toBe('2026-08-18')
    expect(parseDutchDate('1 januari 2027')).toBe('2027-01-01')
  })

  it('reads every month name', () => {
    const months = [
      ['januari', '01'], ['februari', '02'], ['maart', '03'], ['april', '04'],
      ['mei', '05'], ['juni', '06'], ['juli', '07'], ['augustus', '08'],
      ['september', '09'], ['oktober', '10'], ['november', '11'], ['december', '12'],
    ] as const
    for (const [name, number] of months) {
      expect(parseDutchDate(`5 ${name} 2026`)).toBe(`2026-${number}-05`)
    }
  })

  it('reads Dutch month abbreviations, including mrt and okt', () => {
    expect(parseDutchDate('18 aug 2026')).toBe('2026-08-18')
    expect(parseDutchDate('3 mrt 2026')).toBe('2026-03-03')
    expect(parseDutchDate('9 okt 2026')).toBe('2026-10-09')
  })

  it('ignores a leading weekday name', () => {
    expect(parseDutchDate('dinsdag 18 augustus 2026')).toBe('2026-08-18')
    expect(parseDutchDate('woensdag 3 mrt 2026')).toBe('2026-03-03')
  })

  it('reads a numeric Dutch date as day first', () => {
    expect(parseDutchDate('18-08-2026')).toBe('2026-08-18')
    expect(parseDutchDate('03/09/2026')).toBe('2026-09-03')
    expect(parseDutchDate('18-8-2026')).toBe('2026-08-18')
  })

  it('is case insensitive', () => {
    expect(parseDutchDate('18 Augustus 2026')).toBe('2026-08-18')
  })

  it('returns null for an unparseable date', () => {
    expect(parseDutchDate('binnenkort')).toBeNull()
    expect(parseDutchDate('18 smurfember 2026')).toBeNull()
  })

  it('rejects an impossible day', () => {
    expect(parseDutchDate('32 augustus 2026')).toBeNull()
    expect(parseDutchDate('31 februari 2026')).toBeNull()
  })
})

describe('findDutchDate', () => {
  it('pulls a date out of a sentence', () => {
    expect(findDutchDate('Bezorgd op dinsdag 18 augustus 2026 tussen 10:00 en 12:00'))
      .toBe('2026-08-18')
  })

  it('prefers a written month date over a bare number sequence', () => {
    expect(findDutchDate('Bestelnummer 1234567890, geplaatst op 18 augustus 2026'))
      .toBe('2026-08-18')
  })

  it('returns null when no date is present', () => {
    expect(findDutchDate('Bedankt voor je bestelling')).toBeNull()
  })
})

describe('parseDutchDayMonth', () => {
  it('infers the year from the date the mail was received', () => {
    expect(parseDutchDayMonth('3 juli', '2026-07-02T09:18:03.000Z')).toBe('2026-07-03')
    expect(parseDutchDayMonth('15 augustus', '2026-08-14T12:06:06.000Z')).toBe('2026-08-15')
  })

  it('rolls into the next year when the day-month has already passed', () => {
    expect(parseDutchDayMonth('2 januari', '2026-12-28T10:00:00.000Z')).toBe('2027-01-02')
  })

  it('keeps a delivery date a few days in the past in the same year', () => {
    expect(parseDutchDayMonth('28 december', '2026-12-30T10:00:00.000Z')).toBe('2026-12-28')
  })

  it('accepts an abbreviated month', () => {
    expect(parseDutchDayMonth('9 okt', '2026-10-01T00:00:00.000Z')).toBe('2026-10-09')
  })

  it('returns null when the text is not a day and month', () => {
    expect(parseDutchDayMonth('morgen', '2026-07-02T09:18:03.000Z')).toBeNull()
    expect(parseDutchDayMonth('30 februari', '2026-01-01T00:00:00.000Z')).toBeNull()
  })
})
