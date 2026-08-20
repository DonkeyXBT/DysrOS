import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import { bolReturnProcessed, bolCollected, bolShipmentConfirmation } from './bol.js'

const FIXTURES = {
  returned: '2026-05-06-Je-retour-is-verwerkt.eml',
  collected: '2026-07-04-Je-hebt-je-pakket-opgehaald.eml',
} as const

function fixturePath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'eml', name)
}

const allPresent = Object.values(FIXTURES).every((name) => existsSync(fixturePath(name)))

function load(name: string): Promise<ParsedMessage> {
  return loadEml(readFileSync(fixturePath(name)))
}

describe.skipIf(!allPresent)('a return bol has processed', () => {
  it('claims the mail', async () => {
    const message = await load(FIXTURES.returned)
    expect(bolReturnProcessed.matches(message)).toBe(true)
    expect(bolCollected.matches(message)).toBe(false)
  })

  it('names the article and the order, and states no amount it does not know', async () => {
    const [event] = bolReturnProcessed.parse(await load(FIXTURES.returned))

    expect(event!.type).toBe('refunded')
    expect(event!.externalOrderId).toBe('C00031J95X')
    expect(event!.payload).toMatchObject({
      title: "VTech - Toet Toet Auto's - Garage",
      reason: 'return',
      amountMinor: null,
      receivedAt: null,
    })
  })
})

describe.skipIf(!allPresent)('a parcel collected from a pickup point', () => {
  it('claims the mail, and the shipping parser leaves it alone', async () => {
    const message = await load(FIXTURES.collected)
    expect(bolCollected.matches(message)).toBe(true)
    expect(bolShipmentConfirmation.matches(message)).toBe(false)
  })

  it('is a delivery: the goods are in hand', async () => {
    const [event] = bolCollected.parse(await load(FIXTURES.collected))

    expect(event!.type).toBe('delivered')
    expect(event!.externalOrderId).toBe('C0008N3L41')
    expect(event!.payload).toMatchObject({
      title: 'Pokémon - ME02.5 Ascended Heroes ex Box - Mega Feraligatr',
      quantity: 2,
      shipmentStatus: 'delivered',
      collectedFromPoint: true,
      deliveredAt: '2026-07-04',
    })
  })
})
