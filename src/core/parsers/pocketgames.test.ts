import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import { pocketgamesOrderConfirmation, pocketgamesShipment } from './pocketgames.js'

const FIXTURES = {
  small: 'Bestelling_71205_bevestigd_0.eml',
  large: 'Bestelling_71210_bevestigd_0.eml',
} as const

function fixturePath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'eml', name)
}

const allPresent = Object.values(FIXTURES).every((name) => existsSync(fixturePath(name)))

function load(name: string): Promise<ParsedMessage> {
  return loadEml(readFileSync(fixturePath(name)))
}

describe.skipIf(!allPresent)('a PocketGames order', () => {
  it('is claimed despite arriving from a relay address', async () => {
    const message = await load(FIXTURES.small)
    // The address says nothing about the shop; the display name and body do.
    expect(message.fromAddress).toContain('@')
    expect(pocketgamesOrderConfirmation.matches(message)).toBe(true)
    expect(pocketgamesShipment.matches(message)).toBe(false)
  })

  it('reads the article, the quantity and every figure', async () => {
    const [event] = pocketgamesOrderConfirmation.parse(await load(FIXTURES.small))

    expect(event!.type).toBe('order_placed')
    expect(event!.externalOrderId).toBe('71205')
    expect(event!.payload).toMatchObject({
      title: 'Riftbound Spiritforged Champion Deck Fiora',
      quantity: 2,
      unitMinor: 1999,
      shippingMinor: 695,
      vatMinor: 815,
      totalMinor: 4693,
      totalsConsistent: true,
    })
  })

  it('reads a larger order the same way', async () => {
    const [event] = pocketgamesOrderConfirmation.parse(await load(FIXTURES.large))

    expect(event!.externalOrderId).toBe('71210')
    expect(event!.payload).toMatchObject({
      title: 'Riftbound Spiritforged BO',
      quantity: 2,
      unitMinor: 16999,
      shippingMinor: 695,
      vatMinor: 6021,
      totalMinor: 34693,
      totalsConsistent: true,
    })
  })

  it('does not claim another Shopify shop’s mail', async () => {
    const other = await loadEml([
      'From: Some Other Shop <store+123@shopifyemail.com>',
      'Subject: Bestelling #4321 bevestigd',
      'Date: Thu, 20 Aug 2026 10:03:07 +0000',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Bedankt voor je bestelling!</p><p>Totaal</p><p>€10,00</p>',
    ].join('\r\n'))

    expect(pocketgamesOrderConfirmation.matches(other)).toBe(false)
  })
})
