import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import { bolOrderConfirmation, bolCancellation, bolShipmentConfirmation } from './bol.js'

const FIXTURES = {
  orderWithShipping: 'Bedankt voor je bestelling.eml',
  orderFreeShipping: 'Bedankt_voor_je_bestelling_0.eml',
  cancellation: 'Je_artikel_is_geannuleerd_0.eml',
  shipmentDhl: 'Je pakket is nu bij DHL.eml',
  shipmentPostnl: 'Je pakket is nu bij PostNL.eml',
  outForDelivery: 'De_bezorger_is_onderweg_0.eml',
} as const

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/eml/${name}`, import.meta.url))
}

const allPresent = Object.values(FIXTURES).every((name) => existsSync(fixturePath(name)))

function load(name: string): Promise<ParsedMessage> {
  return loadEml(readFileSync(fixturePath(name)))
}

describe.skipIf(!allPresent)('bolOrderConfirmation', () => {
  it('claims a bol.com order confirmation', async () => {
    expect(bolOrderConfirmation.matches(await load(FIXTURES.orderWithShipping))).toBe(true)
    expect(bolOrderConfirmation.matches(await load(FIXTURES.orderFreeShipping))).toBe(true)
  })

  it('does not claim a cancellation', async () => {
    expect(bolOrderConfirmation.matches(await load(FIXTURES.cancellation))).toBe(false)
  })

  it('extracts an order with paid shipping', async () => {
    const [event] = bolOrderConfirmation.parse(await load(FIXTURES.orderWithShipping))

    expect(event!.type).toBe('order_placed')
    expect(event!.retailer).toBe('bol')
    expect(event!.externalOrderId).toBe('C0008N401L')
    expect(event!.occurredAt).toBe('2026-07-02T09:18:03.000Z')
    expect(event!.payload).toMatchObject({
      title: 'One Piece - Double Pack Set - Vol. 11',
      seller: 'bol',
      quantity: 1,
      currency: 'EUR',
      unitMinor: 1199,
      shippingMinor: 299,
      totalMinor: 1498,
      deliveryDate: '2026-07-03',
      totalsConsistent: true,
    })
  })

  it('extracts an order with free shipping and a quantity above one', async () => {
    const [event] = bolOrderConfirmation.parse(await load(FIXTURES.orderFreeShipping))

    expect(event!.externalOrderId).toBe('C000CXJLHK')
    expect(event!.payload).toMatchObject({
      seller: 'bol',
      quantity: 3,
      unitMinor: 5399,
      shippingMinor: 0,
      totalMinor: 16197,
      deliveryDate: '2026-08-15',
      totalsConsistent: true,
    })
  })

  it('keeps the item title bol.com truncated, rather than inventing the rest', async () => {
    const [event] = bolOrderConfirmation.parse(await load(FIXTURES.orderFreeShipping))
    expect(event!.payload.title)
      .toBe('LEGO Botanicals Hangende Drakenklimop Planten Bouwpakket voor Volwasse...')
    expect(event!.payload.titleTruncated).toBe(true)
  })

  it('marks a complete title as not truncated', async () => {
    const [event] = bolOrderConfirmation.parse(await load(FIXTURES.orderWithShipping))
    expect(event!.payload.titleTruncated).toBe(false)
  })
})

describe.skipIf(!allPresent)('bolCancellation', () => {
  it('claims a cancellation and not an order confirmation', async () => {
    expect(bolCancellation.matches(await load(FIXTURES.cancellation))).toBe(true)
    expect(bolCancellation.matches(await load(FIXTURES.orderWithShipping))).toBe(false)
  })

  it('extracts the order reference from the customer service footer', async () => {
    const [event] = bolCancellation.parse(await load(FIXTURES.cancellation))

    expect(event!.type).toBe('cancelled')
    expect(event!.retailer).toBe('bol')
    expect(event!.externalOrderId).toBe('C000CXJH1J')
    expect(event!.occurredAt).toBe('2026-08-14T15:11:20.000Z')
  })

  it('extracts the cancelled item title', async () => {
    const [event] = bolCancellation.parse(await load(FIXTURES.cancellation))
    expect(event!.payload.title).toBe('LEGO® Botanicals Bospaddenstoelen - 11505')
    expect(event!.payload.quantity).toBe(3)
  })

  it('reports no amount, because bol.com does not put one in this mail', async () => {
    const [event] = bolCancellation.parse(await load(FIXTURES.cancellation))
    expect(event!.payload.totalMinor).toBeNull()
    expect(event!.payload.refundExpected).toBe(true)
  })
})

describe.skipIf(!allPresent)('bolShipmentConfirmation', () => {
  it('claims both shipping mails and nothing else', async () => {
    expect(bolShipmentConfirmation.matches(await load(FIXTURES.shipmentDhl))).toBe(true)
    expect(bolShipmentConfirmation.matches(await load(FIXTURES.shipmentPostnl))).toBe(true)
    expect(bolShipmentConfirmation.matches(await load(FIXTURES.cancellation))).toBe(false)
    expect(bolShipmentConfirmation.matches(await load(FIXTURES.orderWithShipping))).toBe(false)
  })

  it('is not claimed by the order or cancellation parsers', async () => {
    expect(bolOrderConfirmation.matches(await load(FIXTURES.shipmentDhl))).toBe(false)
    expect(bolCancellation.matches(await load(FIXTURES.shipmentDhl))).toBe(false)
  })

  it('extracts a DHL shipment', async () => {
    const [event] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentDhl))

    expect(event!.type).toBe('shipped')
    expect(event!.retailer).toBe('bol')
    expect(event!.externalOrderId).toBe('C000D3NXM9')
    expect(event!.occurredAt).toBe('2026-08-18T14:07:04.000Z')
    expect(event!.payload).toMatchObject({
      carrier: 'dhl',
      direction: 'inbound',
      title: 'Pokémon TCG - Ascended Heroes Booster Bundle',
      quantity: 1,
      expectedDeliveryAt: '2026-08-19',
    })
  })

  it('extracts a PostNL shipment, including a quantity above one', async () => {
    const [event] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentPostnl))

    expect(event!.externalOrderId).toBe('C000D3LK83')
    expect(event!.payload).toMatchObject({
      carrier: 'postnl',
      title: 'Pokémon SV10 Destined Rivals - Elite Trainer Box - Pokémon Kaarten - Trading Cards',
      quantity: 2,
      expectedDeliveryAt: '2026-08-19',
    })
  })

  it('captures the tracking link bol.com provides', async () => {
    const [event] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentDhl))
    expect(event!.payload.trackingUrl).toMatch(/^https:\/\/link\.bol\.com\/t\//)
  })

  it('reports no tracking code, because bol.com does not put one in the mail', async () => {
    for (const fixture of [FIXTURES.shipmentDhl, FIXTURES.shipmentPostnl]) {
      const [event] = bolShipmentConfirmation.parse(await load(fixture))
      expect(event!.payload.trackingNumber).toBeNull()
      expect(event!.payload.trackingResolvable).toBe(true)
    }
  })
})

describe.skipIf(!allPresent)('bol delivery address extraction', () => {
  // The fixtures are real mail carrying a real delivery address, so these
  // assert the shape of what was extracted rather than the value itself. The
  // address stays in the git-ignored fixture, not in a public repository.
  it('pulls the postal code from a DHL shipping mail, normalised for the redirect tool', async () => {
    const [event] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentDhl))
    expect(event!.payload.deliveryPostalCode).toMatch(/^\d{4}[A-Z]{2}$/)
    expect(event!.payload.deliveryPostalCodeFormatted).toMatch(/^\d{4} [A-Z]{2}$/)
    expect(event!.payload.deliveryCity).toEqual(expect.any(String))
  })

  it('pulls it from a PostNL shipping mail too', async () => {
    const [event] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentPostnl))
    expect(event!.payload.deliveryPostalCode).toMatch(/^\d{4}[A-Z]{2}$/)
  })

  it('marks a DHL shipment as redirectable once a postal code is known', async () => {
    const [dhl] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentDhl))
    expect(dhl!.payload.dhlRedirectable).toBe(true)

    const [postnl] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentPostnl))
    expect(postnl!.payload.dhlRedirectable).toBe(false)
  })
})

describe.skipIf(!allPresent)('product photographs', () => {
  it('takes the article picture from an order confirmation', async () => {
    const [event] = bolOrderConfirmation.parse(await load(FIXTURES.orderWithShipping))
    expect(event!.payload.imageUrl).toBe('https://media.s-bol.com/mo3GjW1ZZyxA/YvAEmy2/250x200.jpg')
  })

  it('takes it from a cancellation too', async () => {
    const [event] = bolCancellation.parse(await load(FIXTURES.cancellation))
    expect(event!.payload.imageUrl).toBe('https://media.s-bol.com/75PLxJB9Z3rj/L8y4jQp/250x200.jpg')
  })

  it('takes it from a shipping mail, for both carriers', async () => {
    const [dhl] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentDhl))
    expect(dhl!.payload.imageUrl).toBe('https://media.s-bol.com/QwyZPpV5XDJ0/gLjOgGZ/250x200.jpg')
    const [postnl] = bolShipmentConfirmation.parse(await load(FIXTURES.shipmentPostnl))
    expect(postnl!.payload.imageUrl).toBe('https://media.s-bol.com/mpOJ18KNN5YE/9ro2rmJ/250x200.jpg')
  })
})

describe.skipIf(!allPresent)('the courier is out with it', () => {
  it('is claimed by the shipping parser, not the pre-dispatch one', async () => {
    const message = await load(FIXTURES.outForDelivery)
    expect(bolShipmentConfirmation.matches(message)).toBe(true)
  })

  it('records the last leg as its own status rather than as transit', async () => {
    const [event] = bolShipmentConfirmation.parse(await load(FIXTURES.outForDelivery))

    expect(event!.type).toBe('shipped')
    expect(event!.externalOrderId).toBe('C000D3LPPH')
    expect(event!.payload).toMatchObject({
      carrier: 'dhl',
      shipmentStatus: 'out_for_delivery',
      outForDelivery: true,
      title: 'Pokémon TCG - Ascended Heroes Booster Bundle',
      quantity: 2,
      imageUrl: 'https://media.s-bol.com/QwyZPpV5XDJ0/gLjOgGZ/250x200.jpg',
    })
  })

  it('keeps the window the courier gave, on the day it was sent', async () => {
    const [event] = bolShipmentConfirmation.parse(await load(FIXTURES.outForDelivery))
    expect(event!.payload.deliveryWindow).toBe('17:00–19:00')
    expect(event!.payload.expectedDeliveryAt).toBe('2026-08-19')
  })
})
