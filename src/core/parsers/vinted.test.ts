import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import { vintedSold, vintedLabel, vintedCompleted, parseVintedAmount } from './vinted.js'

const FIXTURES = {
  sold: 'You\u2019ve sold an item on Vinted.eml',
  soldSupreme: 'You\u2019ve sold an item on Vinted (1).eml',
  label: 'Uniqlo balloon pants shipping label \u2013 use by 19 06 2026 17 53.eml',
  labelPalace: 'Palace Tri ferg shirt shipping label \u2013 use by 25 05 2026 10 00.eml',
  completed: 'This order is completed.eml',
  completedGosha: 'This order is completed (2).eml',
} as const

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/eml/${name}`, import.meta.url))
}

const allPresent = Object.values(FIXTURES).every((name) => existsSync(fixturePath(name)))

function load(name: string): Promise<ParsedMessage> {
  return loadEml(readFileSync(fixturePath(name)))
}

describe('parseVintedAmount', () => {
  it('reads what Vinted writes', () => {
    expect(parseVintedAmount('€15.00')).toBe(1500)
    expect(parseVintedAmount('€ 8,00')).toBe(800)
    expect(parseVintedAmount('€80.00')).toBe(8000)
  })

  it('is null for anything that is not an amount', () => {
    expect(parseVintedAmount('Under 1000.0 g')).toBeNull()
    expect(parseVintedAmount(undefined)).toBeNull()
  })
})

describe.skipIf(!allPresent)('a Vinted sale', () => {
  it('reads the buyer, the item and the price', async () => {
    const [event] = vintedSold.parse(await load(FIXTURES.sold))

    expect(event!.type).toBe('sale')
    expect(event!.retailer).toBe('vinted')
    expect(event!.payload).toMatchObject({
      title: 'Uniqlo balloon pants',
      buyer: 'florence2838',
      grossMinor: 1500,
      currency: 'EUR',
    })
  })

  it('reads a different sale the same way', async () => {
    const [event] = vintedSold.parse(await load(FIXTURES.soldSupreme))
    expect(event!.payload).toMatchObject({
      title: 'Supreme Shrek T shirt',
      buyer: 'julion2705',
      grossMinor: 3000,
    })
  })

  it('is not claimed by the other Vinted parsers', async () => {
    const message = await load(FIXTURES.sold)
    expect(vintedLabel.matches(message)).toBe(false)
    expect(vintedCompleted.matches(message)).toBe(false)
  })
})

describe.skipIf(!allPresent)('a Vinted shipping label', () => {
  it('reads the barcode, the item and the transaction it belongs to', async () => {
    const [event] = vintedLabel.parse(await load(FIXTURES.label))

    expect(event!.type).toBe('shipped')
    expect(event!.externalOrderId).toBe('20362272898')
    expect(event!.payload).toMatchObject({
      title: 'Uniqlo balloon pants',
      trackingNumber: '83321021',
      direction: 'outbound',
      carrier: 'mondial relay',
      hasLabel: true,
    })
  })

  it('knows the label is attached, which is what makes it printable', async () => {
    const message = await load(FIXTURES.labelPalace)
    expect(message.attachments.some((file) => /pdf/i.test(file.contentType))).toBe(true)

    const [event] = vintedLabel.parse(message)
    expect(event!.payload).toMatchObject({
      title: 'Palace Tri ferg shirt',
      trackingNumber: '77377374',
      hasLabel: true,
    })
  })

  it('reads the deadline the parcel has to be handed over by', async () => {
    const [event] = vintedLabel.parse(await load(FIXTURES.label))
    expect(event!.payload.labelDeadline).toBe('2026-06-19T17:53:00.000Z')
  })
})

describe.skipIf(!allPresent)('a completed Vinted order', () => {
  it('reads what the sale actually brought in', async () => {
    const [event] = vintedCompleted.parse(await load(FIXTURES.completed))

    expect(event!.type).toBe('payout')
    expect(event!.externalOrderId).toBe('20362272898')
    expect(event!.payload).toMatchObject({
      title: 'Uniqlo balloon pants',
      itemPriceMinor: 1500,
      postageMinor: 319,
      payoutMinor: 1500,
    })
  })

  it('reads a larger one the same way', async () => {
    const [event] = vintedCompleted.parse(await load(FIXTURES.completedGosha))
    expect(event!.payload).toMatchObject({
      title: 'Gosha Rubchinskiy t shirt',
      itemPriceMinor: 8000,
      payoutMinor: 8000,
    })
  })
})
