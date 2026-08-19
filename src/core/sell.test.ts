import { describe, expect, it } from 'vitest'
import { allocate, breakDownSale, NL_VAT_BASIS_POINTS, vatWithinCost } from './sell.js'

describe('allocate', () => {
  it('gives one unit the whole amount', () => {
    expect(allocate(15000, [{ itemId: 'a', costMinor: 5399 }])).toEqual([15000])
  })

  it('splits evenly between units that cost the same', () => {
    expect(allocate(15000, [
      { itemId: 'a', costMinor: 5399 },
      { itemId: 'b', costMinor: 5399 },
    ])).toEqual([7500, 7500])
  })

  it('splits in proportion to cost when the units differ', () => {
    // A €54 unit and a €12 unit sold together for €100: the expensive one
    // carries most of the price, so neither margin is a fiction.
    expect(allocate(10000, [
      { itemId: 'a', costMinor: 5400 },
      { itemId: 'b', costMinor: 1200 },
    ])).toEqual([8182, 1818])
  })

  it('always adds up to exactly what was entered', () => {
    const shares = allocate(10000, [
      { itemId: 'a', costMinor: 3333 },
      { itemId: 'b', costMinor: 3333 },
      { itemId: 'c', costMinor: 3333 },
    ])
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(10000)
  })

  it('splits evenly when nothing has a cost to go by', () => {
    expect(allocate(9000, [
      { itemId: 'a', costMinor: 0 },
      { itemId: 'b', costMinor: 0 },
      { itemId: 'c', costMinor: 0 },
    ])).toEqual([3000, 3000, 3000])
  })

  it('has nothing to split across no units', () => {
    expect(allocate(5000, [])).toEqual([])
  })
})

describe('breaking down a private sale', () => {
  const unit = { itemId: 'a', costMinor: 5399 }

  it('reads a price the buyer paid as including VAT', () => {
    const sale = breakDownSale({ lines: [unit], amountMinor: 7500, includesVat: true })

    expect(sale.grossMinor).toBe(7500)
    // 7500 gross at 21% is 1302 VAT and 6198 net.
    expect(sale.vatMinor).toBe(1302)
    expect(sale.netMinor).toBe(6198)
    expect(sale.netMinor + sale.vatMinor).toBe(sale.grossMinor)
  })

  it('adds VAT on when the price was quoted without it', () => {
    const sale = breakDownSale({ lines: [unit], amountMinor: 6198, includesVat: false })
    expect(sale.grossMinor).toBe(7500)
    expect(sale.vatMinor).toBe(1302)
  })

  it('counts profit as what was received less what was paid', () => {
    const sale = breakDownSale({ lines: [unit], amountMinor: 7500, includesVat: true })

    expect(sale.profitMinor).toBe(7500 - 5399)
    // The VAT on both sides is still worked out, for the return, but it is not
    // taken out of the profit.
    expect(sale.lines[0]!.costVatMinor).toBe(937)
    expect(sale.lines[0]!.costNetMinor).toBe(4462)
    expect(sale.vatMinor).toBe(1302)
  })

  it('reports a loss as a loss', () => {
    const sale = breakDownSale({ lines: [unit], amountMinor: 3000, includesVat: true })
    expect(sale.profitMinor).toBeLessThan(0)
  })

  it('spreads one price across a lot sold together', () => {
    const sale = breakDownSale({
      lines: [{ itemId: 'a', costMinor: 5399 }, { itemId: 'b', costMinor: 5399 }],
      amountMinor: 15000,
      includesVat: true,
    })

    expect(sale.lines.map((line) => line.grossMinor)).toEqual([7500, 7500])
    expect(sale.grossMinor).toBe(15000)
    expect(sale.lines.reduce((sum, line) => sum + line.profitMinor, 0)).toBe(sale.profitMinor)
  })

  it('takes a per-unit price as per unit', () => {
    const sale = breakDownSale({
      lines: [{ itemId: 'a', costMinor: 5399 }, { itemId: 'b', costMinor: 5399 }],
      amountMinor: 7500,
      includesVat: true,
      perUnit: true,
    })

    expect(sale.grossMinor).toBe(15000)
  })

  it('uses the Dutch rate unless told otherwise', () => {
    expect(NL_VAT_BASIS_POINTS).toBe(2100)
    const sale = breakDownSale({ lines: [unit], amountMinor: 12100, includesVat: true })
    expect(sale.vatMinor).toBe(2100)
    expect(sale.netMinor).toBe(10000)
  })

  it('has nothing to break down for no units', () => {
    const sale = breakDownSale({ lines: [], amountMinor: 5000, includesVat: true })
    expect(sale).toMatchObject({ grossMinor: 0, vatMinor: 0, profitMinor: 0, lines: [] })
  })
})

describe('vatWithinCost', () => {
  it('finds the VAT already inside a price the mail stated', () => {
    expect(vatWithinCost(12100)).toBe(2100)
    expect(vatWithinCost(5399)).toBe(937)
  })

  it('is nothing for nothing', () => {
    expect(vatWithinCost(0)).toBe(0)
  })
})
