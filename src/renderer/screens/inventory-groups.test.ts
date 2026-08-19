import { describe, expect, it } from 'vitest'
import { groupByProduct } from './inventory-groups.js'
import type { ItemView } from '../api.js'

function unit(overrides: Partial<ItemView> = {}): ItemView {
  return {
    id: Math.random().toString(36).slice(2),
    title: 'LEGO Botanicals Bospaddenstoelen - 11505',
    imageUrl: 'https://media.s-bol.com/a/b/250x200.jpg',
    brand: null,
    sku: null,
    size: null,
    condition: 'new',
    status: 'incoming',
    cost: '€53.99',
    costMinor: 5399,
    purchasedAt: '2026-08-14T10:00:00.000Z',
    daysHeld: 4,
    location: null,
    retailer: 'bol',
    orderRef: 'C000CXJLHK',
    costVatMinor: 937,
    costNetMinor: 4462,
    soldMinor: null,
    sold: null,
    soldVatMinor: null,
    soldAt: null,
    soldVia: null,
    buyer: null,
    profitMinor: null,
    profit: null,
    ...overrides,
  } as ItemView
}

describe('grouping inventory by product', () => {
  it('counts every unit of the same product together', () => {
    const groups = groupByProduct([unit(), unit(), unit()])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ units: 3, costMinor: 3 * 5399 })
  })

  it('treats spacing and case as the same product, since retailers vary', () => {
    const groups = groupByProduct([
      unit({ title: 'LEGO  Botanicals   Bospaddenstoelen - 11505' }),
      unit({ title: 'lego botanicals bospaddenstoelen - 11505' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.units).toBe(2)
  })

  it('keeps genuinely different products apart', () => {
    const groups = groupByProduct([unit(), unit({ title: 'One Piece - Double Pack Set - Vol. 11' })])
    expect(groups).toHaveLength(2)
  })

  it('splits the count by where the units are', () => {
    const groups = groupByProduct([
      unit({ status: 'incoming' }),
      unit({ status: 'in_stock' }),
      unit({ status: 'listed' }),
      unit({ status: 'sold' }),
      unit({ status: 'cancelled' }),
    ])

    expect(groups[0]).toMatchObject({ units: 5, incoming: 1, inStock: 2, gone: 2 })
  })

  it('puts the product you hold most of first', () => {
    const groups = groupByProduct([
      unit({ title: 'One Piece - Double Pack Set - Vol. 11' }),
      unit(),
      unit(),
    ])

    expect(groups.map((group) => group.units)).toEqual([2, 1])
  })

  it('takes a picture from whichever unit has one', () => {
    const groups = groupByProduct([unit({ imageUrl: null }), unit()])
    expect(groups[0]!.imageUrl).toBe('https://media.s-bol.com/a/b/250x200.jpg')
  })

  it('reports the most recent purchase of a product', () => {
    const groups = groupByProduct([
      unit({ purchasedAt: '2026-07-02T09:18:03.000Z' }),
      unit({ purchasedAt: '2026-08-14T10:00:00.000Z' }),
    ])

    expect(groups[0]!.lastBoughtAt).toBe('2026-08-14T10:00:00.000Z')
  })

  it('names every retailer a product came from, once each', () => {
    const groups = groupByProduct([
      unit({ retailer: 'bol' }),
      unit({ retailer: 'bol' }),
      unit({ retailer: 'mediamarkt' }),
    ])

    expect(groups[0]!.retailers).toEqual(['bol', 'mediamarkt'])
  })

  it('is empty for empty inventory rather than a row of nothing', () => {
    expect(groupByProduct([])).toEqual([])
  })
})

describe('what a product earned', () => {
  it('adds up the sales and the profit of its sold units', () => {
    const groups = groupByProduct([
      unit({ status: 'sold', soldMinor: 7500, profitMinor: 1736 }),
      unit({ status: 'sold', soldMinor: 8000, profitMinor: 2150 }),
      unit(),
    ])

    expect(groups[0]).toMatchObject({ units: 3, soldMinor: 15500, profitMinor: 3886 })
  })

  it('counts nothing earned for a product still entirely in stock', () => {
    const groups = groupByProduct([unit(), unit()])
    expect(groups[0]).toMatchObject({ soldMinor: 0, profitMinor: 0 })
  })
})
