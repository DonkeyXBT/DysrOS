import { describe, it, expect } from 'vitest'
import { loadEml, type ParsedMessage } from '../mail/parsed-message.js'
import { MEDIAMARKT_PARSERS } from './mediamarkt.js'
import { PROSHOP_PARSERS } from './proshop.js'
import { POCKETGAMES_PARSERS } from './pocketgames.js'
import { BOL_PARSERS } from './bol.js'
import { ParserRegistry } from './registry.js'

/**
 * These retailers' parsers were ported from a working Python implementation
 * rather than written against a real `.eml`. The tests below therefore verify
 * the *port* — that the documented patterns are applied correctly — not that
 * the patterns match this retailer's live mail. Supply a sample and these
 * become fixture tests like the bol.com ones.
 */

function eml(options: {
  from: string
  subject: string
  body: string
  date?: string
}): Promise<ParsedMessage> {
  return loadEml(
    [
      `From: ${options.from}`,
      `Subject: ${options.subject}`,
      `Date: ${options.date ?? 'Tue, 18 Aug 2026 09:00:00 +0200'}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      `<html><body>${options.body}</body></html>`,
      '',
    ].join('\r\n'),
  )
}

const registry = new ParserRegistry([
  ...BOL_PARSERS,
  ...MEDIAMARKT_PARSERS,
  ...PROSHOP_PARSERS,
  ...POCKETGAMES_PARSERS,
])

describe('MediaMarkt', () => {
  const from = 'MediaMarkt <noreply@mediamarkt.nl>'

  it('claims an order confirmation and reads the order number', async () => {
    const message = await eml({
      from,
      subject: 'Bedankt voor je bestelling',
      body: '<p>Je bestelnummer is 1234567890</p><p>Totaal: &euro; 219,99</p>',
    })
    const result = registry.parse(message)

    expect(result!.parserId).toBe('mediamarkt-order-confirmation')
    expect(result!.events[0]!.externalOrderId).toBe('1234567890')
    expect(result!.events[0]!.payload.totalMinor).toBe(21999)
  })

  it('reads an order number from the looser fallback wording', async () => {
    const message = await eml({
      from,
      subject: 'Bedankt voor je bestelling',
      body: '<p>Bestelnummer: 9988776655</p>',
    })
    expect(registry.parse(message)!.events[0]!.externalOrderId).toBe('9988776655')
  })

  it('routes a cancellation to the cancellation parser, not the order one', async () => {
    const message = await eml({
      from,
      subject: 'Je bestelling is geannuleerd',
      body: '<p>Je bestelnummer is 1234567890</p>',
    })
    const result = registry.parse(message)

    expect(result!.parserId).toBe('mediamarkt-cancellation')
    expect(result!.events[0]!.type).toBe('cancelled')
    expect(result!.events[0]!.payload.refundExpected).toBe(true)
  })

  it('flags a partial cancellation', async () => {
    const message = await eml({
      from,
      subject: 'Je bestelling is (deels) geannuleerd',
      body: '<p>Je bestelling is (deels) geannuleerd. Je bestelnummer is 1234567890</p>',
    })
    expect(registry.parse(message)!.events[0]!.payload.partial).toBe(true)
  })

  it('reads a DHL barcode out of a shipping mail', async () => {
    const message = await eml({
      from,
      subject: 'Je bestelling is onderweg',
      body: '<p>Je bestelnummer is 1234567890</p><p>Track &amp; Trace: JVGL0627463317265600</p>',
    })
    const result = registry.parse(message)

    expect(result!.parserId).toBe('mediamarkt-shipment')
    expect(result!.events[0]!.payload.carrier).toBe('dhl')
    expect(result!.events[0]!.payload.trackingNumber).toBe('JVGL0627463317265600')
  })

  it('does not claim "onderweg" marketing mail with no order reference', async () => {
    const message = await eml({
      from,
      subject: 'De zomer is onderweg — bekijk de aanbiedingen',
      body: '<p>Shop nu</p>',
    })
    expect(registry.parse(message)).toBeNull()
  })

  it('ignores a lookalike sender', async () => {
    const message = await eml({
      from: 'Media Markets <noreply@mediamarkets-deals.example>',
      subject: 'Bedankt voor je bestelling',
      body: '<p>Je bestelnummer is 1234567890</p>',
    })
    expect(registry.parse(message)).toBeNull()
  })
})

describe('Proshop', () => {
  const from = 'Proshop <noreply@proshop.nl>'

  it('reads the order number from an order confirmation', async () => {
    const message = await eml({
      from,
      subject: 'Bevestiging van je bestelling',
      body: '<p>Bestelnummer: 4455667788</p><p>Totaal &euro; 1.249,00</p>',
    })
    const result = registry.parse(message)

    expect(result!.parserId).toBe('proshop-order-confirmation')
    expect(result!.events[0]!.externalOrderId).toBe('4455667788')
    expect(result!.events[0]!.payload.totalMinor).toBe(124900)
  })

  it('takes a numeric tracking code only from a line that is about tracking', async () => {
    const message = await eml({
      from,
      subject: 'Je bestelling is verzonden',
      body: '<p>Bestelnummer: 4455667788</p><p>Track &amp; Trace: 05512847362910</p>',
    })
    const result = registry.parse(message)

    expect(result!.parserId).toBe('proshop-shipment')
    expect(result!.events[0]!.payload.trackingNumber).toBe('05512847362910')
  })

  it('also accepts a PostNL barcode on a tracking line', async () => {
    const message = await eml({
      from,
      subject: 'Je bestelling is verzonden',
      body: '<p>Bestelnummer: 4455667788</p><p>Track &amp; Trace: 3SBTC0294817263</p>',
    })
    expect(registry.parse(message)!.events[0]!.payload.trackingNumber).toBe('3SBTC0294817263')
  })

  it('does not mistake the order number for a tracking code', async () => {
    const message = await eml({
      from,
      subject: 'Je bestelling is verzonden',
      body: '<p>Bestelnummer: 4455667788</p><p>Je pakket komt eraan.</p>',
    })
    // The order number is a 10-digit run and would match the tracking pattern
    // if it were applied to the whole body.
    expect(registry.parse(message)!.events[0]!.payload.trackingNumber).toBeNull()
  })

  it('routes a cancellation confirmation to the cancellation parser', async () => {
    const message = await eml({
      from,
      subject: 'Bevestiging van annulering',
      body: '<p>Bestelnummer: 4455667788</p>',
    })
    const result = registry.parse(message)

    expect(result!.parserId).toBe('proshop-cancellation')
    expect(result!.events[0]!.type).toBe('cancelled')
  })
})

describe('PocketGames', () => {
  it('claims a Shopify order confirmation and reads the Shopify reference', async () => {
    const message = await eml({
      from: 'PocketGames <noreply@shopifyemail.com>',
      subject: 'Order #1042 confirmed',
      body: '<p>Thank you for your order</p><p>Total &euro; 89,95</p>',
    })
    const result = registry.parse(message)

    expect(result!.parserId).toBe('pocketgames-order-confirmation')
    expect(result!.events[0]!.externalOrderId).toBe('1042')
    expect(result!.events[0]!.payload.totalMinor).toBe(8995)
  })

  it('reads the shipping line separately from the total', async () => {
    const message = await eml({
      from: 'PocketGames <noreply@shopifyemail.com>',
      subject: 'Order #1042 confirmed',
      body: '<p>Shipping &euro; 4,95</p><p>Total &euro; 89,95</p>',
    })
    const payload = registry.parse(message)!.events[0]!.payload
    expect(payload.shippingMinor).toBe(495)
    expect(payload.totalMinor).toBe(8995)
  })

  it('does not claim another store\'s Shopify mail', async () => {
    const message = await eml({
      from: 'Some Other Store <noreply@shopifyemail.com>',
      subject: 'Your order has shipped',
      body: '<p>On its way</p>',
    })
    // Shopify sends for every store on the platform, so a bare Shopify sender
    // with no PocketGames identity and no confirmed-order subject is not ours.
    expect(registry.parse(message)?.parserId).not.toBe('pocketgames-order-confirmation')
  })

  it('reads a PostNL barcode from a shipping mail', async () => {
    const message = await eml({
      from: 'PocketGames <noreply@shopifyemail.com>',
      subject: 'Order #1042 shipped',
      body: '<p>Track: 3SBTC0294817263</p>',
    })
    const result = registry.parse(message)

    expect(result!.parserId).toBe('pocketgames-shipment')
    expect(result!.events[0]!.payload.carrier).toBe('postnl')
    expect(result!.events[0]!.payload.trackingNumber).toBe('3SBTC0294817263')
  })
})

describe('registry isolation across retailers', () => {
  it('does not let any ported parser claim bol.com mail', async () => {
    const message = await eml({
      from: 'bol <automail@bol.com>',
      subject: 'Bedankt voor je bestelling',
      body: '<p>Bestelnummer: C0008N401L</p>',
    })
    expect(registry.parse(message)!.retailer).toBe('bol')
  })

  it('reports every installed parser for the diagnostics screen', () => {
    const ids = registry.describe().map((parser) => parser.id)
    expect(ids).toContain('mediamarkt-order-confirmation')
    expect(ids).toContain('proshop-shipment')
    expect(ids).toContain('pocketgames-order-confirmation')
  })
})
