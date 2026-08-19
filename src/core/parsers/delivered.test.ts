import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import { dhlDelivered, dhlOutForDelivery } from './dhl.js'
import { postnlDelivered, postnlInTransit, findPostnlBarcode } from './postnl.js'
import { bolShipmentConfirmation } from './bol.js'

const FIXTURES = {
  dhl: 'Je_pakket_is_bezorgd_dhl.eml',
  postnl: 'Afgeleverd_je_pakket_van_bol_postnl.eml',
} as const

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/eml/${name}`, import.meta.url))
}

const allPresent = Object.values(FIXTURES).every((name) => existsSync(fixturePath(name)))

function load(name: string): Promise<ParsedMessage> {
  return loadEml(readFileSync(fixturePath(name)))
}

describe.skipIf(!allPresent)('DHL says a parcel is delivered', () => {
  it('claims the mail, and the out-for-delivery parser does not', async () => {
    const message = await load(FIXTURES.dhl)
    expect(dhlDelivered.matches(message)).toBe(true)
    expect(dhlOutForDelivery.matches(message)).toBe(false)
  })

  it('reads the barcode and the day it arrived', async () => {
    const [event] = dhlDelivered.parse(await load(FIXTURES.dhl))

    expect(event!.type).toBe('delivered')
    expect(event!.payload).toMatchObject({
      carrier: 'dhl',
      trackingNumber: 'JVGL0637312004384176',
      shipmentStatus: 'delivered',
      deliveredAt: '2026-08-19',
      shippedBy: 'bol',
    })
  })
})

describe.skipIf(!allPresent)('PostNL says a parcel is delivered', () => {
  it('claims the mail', async () => {
    const message = await load(FIXTURES.postnl)
    expect(postnlDelivered.matches(message)).toBe(true)
    expect(postnlInTransit.matches(message)).toBe(false)
    // The retailer's parser must not claim the carrier's own mail.
    expect(bolShipmentConfirmation.matches(message)).toBe(false)
  })

  it('reads the barcode from under its label', async () => {
    const message = await load(FIXTURES.postnl)
    expect(findPostnlBarcode(message)).toBe('3STUNM283074965')

    const [event] = postnlDelivered.parse(message)
    expect(event!.type).toBe('delivered')
    expect(event!.payload).toMatchObject({
      carrier: 'postnl',
      trackingNumber: '3STUNM283074965',
      shipmentStatus: 'delivered',
      shippedBy: 'bol',
    })
  })

  it('ignores mail from anyone who is not PostNL', async () => {
    const notPostnl = await loadEml([
      'From: Someone <mail@example.com>',
      'Subject: Afgeleverd: je pakket van bol',
      'Date: Wed, 19 Aug 2026 17:40:43 +0200',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Track &amp; trace-code 3STUNM283074965</p>',
    ].join('\r\n'))

    expect(postnlDelivered.matches(notPostnl)).toBe(false)
  })

  it('ignores PostNL mail with no barcode in it', async () => {
    const marketing = await loadEml([
      'From: PostNL <notificatie@edm.postnl.nl>',
      'Subject: Wijzig je bezorgvoorkeuren',
      'Date: Wed, 19 Aug 2026 17:40:43 +0200',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Stel je bezorgvoorkeuren in via je account.</p>',
    ].join('\r\n'))

    expect(postnlDelivered.matches(marketing)).toBe(false)
    expect(postnlInTransit.matches(marketing)).toBe(false)
  })
})
