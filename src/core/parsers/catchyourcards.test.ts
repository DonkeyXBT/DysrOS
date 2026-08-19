import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import {
  catchYourCardsOrder, catchYourCardsProcessed, catchYourCardsRefund,
  catchYourCardsReadyToShip, catchYourCardsInTransit, catchYourCardsReadyForPickup,
  findOrderNumber, amountAfter,
} from './catchyourcards.js'

const FIXTURES = {
  order: '2026-02-27-Je-bestelling-bij-CatchYourCards-is-ontvangen!.html',
  processed: '2026-03-02-Je-bestelling-van-CatchYourCards-is-onderweg!.html',
  refund: '2026-02-24-Je-bestelling-#59277-bij-CatchYourCards-is-terugbetaald.html',
  readyToShip: '2026-03-02-Jouw-order-60612-is-klaar-voor-verzending.html',
  inTransit: '2026-03-02-PostNL-is-onderweg.html',
  readyForPickup: '2026-03-03-Jouw-order-60619-ligt-voor-je-klaar.html',
} as const

function fixturePath(name: string): string {
  // Joined rather than built as a URL: one of these filenames contains a `#`,
  // which a URL reads as the start of a fragment and drops the rest of.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'html', name)
}

const allPresent = Object.values(FIXTURES).every((name) => existsSync(fixturePath(name)))

/** The saved page is a mail's body; this is the envelope it arrived in. */
function load(name: string, subject: string, from = 'CatchYourCards <sales@catchyourcards.nl>'): Promise<ParsedMessage> {
  return loadEml([
    `From: ${from}`,
    'To: shop@example.com',
    `Subject: ${subject}`,
    'Date: Mon, 2 Mar 2026 09:00:00 +0100',
    'Content-Type: text/html; charset=utf-8',
    '',
    readFileSync(fixturePath(name), 'utf8'),
  ].join('\r\n'))
}

describe('reading the shop’s figures', () => {
  it('finds an amount after its label, however the template breaks the line', () => {
    expect(amountAfter('Totaal: € 76,90 (inclusief € 13,35 BTW)', /totaal/)).toBe(7690)
    expect(amountAfter('Terugbetalen: - € 76,90', /terugbetalen/)).toBe(7690)
  })

  it('finds the order number in any of the wordings used', () => {
    expect(findOrderNumber('Bestelling #60619 (27-02-2026)')).toBe('60619')
    expect(findOrderNumber('# Ordernummer 60612')).toBe('60612')
    expect(findOrderNumber('Jouw order 60612 is klaar voor verzending')).toBe('60612')
  })
})

describe.skipIf(!allPresent)('a CatchYourCards order', () => {
  it('reads the article, the totals and the VAT inside them', async () => {
    const message = await load(FIXTURES.order, 'Je bestelling bij CatchYourCards is ontvangen!')
    expect(catchYourCardsOrder.matches(message)).toBe(true)

    const [event] = catchYourCardsOrder.parse(message)
    expect(event!.type).toBe('order_placed')
    expect(event!.externalOrderId).toBe('60619')
    expect(event!.payload).toMatchObject({
      title: 'Pokémon - Mega Evolution - Ascended Heroes - Elite Trainer Box',
      quantity: 1,
      unitMinor: 6995,
      shippingMinor: 695,
      totalMinor: 7690,
      vatMinor: 1335,
      totalsConsistent: true,
    })
  })

  it('is not claimed by the refund parser', async () => {
    const message = await load(FIXTURES.order, 'Je bestelling bij CatchYourCards is ontvangen!')
    expect(catchYourCardsRefund.matches(message)).toBe(false)
  })
})

describe.skipIf(!allPresent)('a CatchYourCards refund', () => {
  it('reads what is being returned', async () => {
    const message = await load(FIXTURES.refund, 'Je bestelling #59277 bij CatchYourCards is terugbetaald')
    expect(catchYourCardsRefund.matches(message)).toBe(true)

    const [event] = catchYourCardsRefund.parse(message)
    expect(event!.type).toBe('refunded')
    expect(event!.externalOrderId).toBe('59277')
    expect(event!.payload).toMatchObject({ amountMinor: 7690, receivedAt: null })
  })
})

describe.skipIf(!allPresent)('a CatchYourCards order being processed', () => {
  it('is recorded without pretending to know a barcode', async () => {
    const message = await load(FIXTURES.processed, 'Je bestelling van CatchYourCards is onderweg!')
    expect(catchYourCardsProcessed.matches(message)).toBe(true)

    const [event] = catchYourCardsProcessed.parse(message)
    expect(event!.type).toBe('order_confirmed')
    expect(event!.externalOrderId).toBe('60612')
    expect(event!.payload.trackingNumber).toBeUndefined()
  })
})

describe.skipIf(!allPresent)('the shop’s fulfilment notices', () => {
  const noSender = 'CatchYourCards <no-reply@example-fulfilment.test>'

  it('reads the barcode and the order it belongs to', async () => {
    const message = await load(FIXTURES.readyToShip, 'Jouw order 60612 is klaar voor verzending', noSender)
    expect(catchYourCardsReadyToShip.matches(message)).toBe(true)

    const [event] = catchYourCardsReadyToShip.parse(message)
    expect(event!.type).toBe('shipped')
    expect(event!.externalOrderId).toBe('60612')
    expect(event!.payload).toMatchObject({
      carrier: 'postnl',
      trackingNumber: '3SYZXG3185614',
      shipmentStatus: 'pending',
      deliveryPostalCode: '3067TR',
    })
  })

  it('reads the delivery window once the parcel is moving', async () => {
    const message = await load(FIXTURES.inTransit, 'PostNL is onderweg', noSender)
    expect(catchYourCardsInTransit.matches(message)).toBe(true)

    const [event] = catchYourCardsInTransit.parse(message)
    expect(event!.payload).toMatchObject({
      shipmentStatus: 'in_transit',
      trackingNumber: '3SYZXG3185614',
      expectedDeliveryAt: '2026-03-04',
      deliveryWindow: '08:30–21:30',
    })
  })

  it('knows a parcel waiting at a collection point', async () => {
    const message = await load(FIXTURES.readyForPickup, 'Jouw order 60619 ligt voor je klaar', noSender)
    expect(catchYourCardsReadyForPickup.matches(message)).toBe(true)
    expect(catchYourCardsInTransit.matches(message)).toBe(false)

    const [event] = catchYourCardsReadyForPickup.parse(message)
    expect(event!.payload).toMatchObject({
      shipmentStatus: 'ready_for_pickup',
      trackingNumber: '3SYZXG3680311',
    })
    expect(event!.externalOrderId).toBe('60619')
  })

  it('ignores a mail from the same platform for another shop', async () => {
    const other = await loadEml([
      'From: Shipping <no-reply@example-fulfilment.test>',
      'Subject: Jouw order 1234 is klaar voor verzending',
      'Date: Mon, 2 Mar 2026 09:00:00 +0100',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p># Ordernummer 1234</p><p>Track &amp; Trace 3SABC123456789</p>',
    ].join('\r\n'))

    expect(catchYourCardsReadyToShip.matches(other)).toBe(false)
  })
})
