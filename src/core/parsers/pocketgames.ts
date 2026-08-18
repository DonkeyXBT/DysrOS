import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { ParsedEvent } from '../repos/events.js'
import type { Parser } from './registry.js'
import { findDutchAmount } from './nl.js'

/**
 * Parsers for PocketGames.nl.
 *
 * PocketGames sells through Shopify, so its mail comes from Shopify's sending
 * domain with PocketGames as the display name, and the order reference is
 * Shopify's `Order #1234` rather than a Dutch `bestelnummer`.
 *
 * Ported from a working Python implementation; not yet verified against a
 * `.eml` sample here.
 */

const ORDER_CONFIRMED = /Order\s*#\s*([A-Za-z0-9-]+)\s*confirmed/i
const ORDER_ANY = /Order\s*#\s*([A-Za-z0-9-]+)/i

const SHOPIFY_SENDERS = ['shopifyemail.com', 'shopify']

function senderBlob(message: ParsedMessage): string {
  return `${message.fromName ?? ''} ${message.fromAddress}`.toLowerCase()
}

function isPocketGamesSender(message: ParsedMessage): boolean {
  const blob = senderBlob(message)
  if (blob.includes('pocketgames')) return true
  return SHOPIFY_SENDERS.some((sender) => blob.includes(sender))
}

function findOrderNumber(subject: string, body: string): string | null {
  return ORDER_CONFIRMED.exec(subject)?.[1]
    ?? ORDER_ANY.exec(subject)?.[1]
    ?? ORDER_ANY.exec(body)?.[1]
    ?? null
}

export const pocketgamesOrderConfirmation: Parser = {
  id: 'pocketgames-order-confirmation',
  retailer: 'pocketgames',

  matches(message) {
    if (!isPocketGamesSender(message)) return false
    const subject = message.subject.toLowerCase()

    if (subject.includes('order #') && subject.includes('confirm')) return true
    if (ORDER_CONFIRMED.test(message.subject)) return true

    // A bare Shopify sender is not enough — it serves every Shopify store — so
    // require the display name to name PocketGames as well.
    return senderBlob(message).includes('pocketgames') && subject.includes('order')
  },

  parse(message): ParsedEvent[] {
    const body = textOf(message, { preferHtml: true })
    const total = findDutchAmount(
      /(?:grand\s+)?total[^\n]{0,40}|totaal[^\n]{0,40}/i.exec(body)?.[0] ?? '',
    )
    const shipping = findDutchAmount(
      /(?:shipping|verzend\w*)[^\n]{0,40}/i.exec(body)?.[0] ?? '',
    )

    return [{
      type: 'order_placed',
      retailer: 'pocketgames',
      externalOrderId: findOrderNumber(message.subject, body),
      occurredAt: message.receivedAt,
      payload: {
        currency: 'EUR',
        totalMinor: total?.minor ?? null,
        shippingMinor: shipping?.minor ?? null,
        quantity: null,
        unitMinor: null,
        totalsConsistent: false,
        source: 'ported-unverified',
      },
    }]
  },
}

export const pocketgamesShipment: Parser = {
  id: 'pocketgames-shipment',
  retailer: 'pocketgames',

  matches(message) {
    if (!isPocketGamesSender(message)) return false
    const subject = message.subject.toLowerCase()
    return /shipped|on its way|verzonden|onderweg/.test(subject)
  },

  parse(message): ParsedEvent[] {
    const body = textOf(message, { preferHtml: true })
    const postnl = /\b(3[SZ][A-Z0-9]{9,24})\b/i.exec(body)?.[1]
    const dhl = /\b(JVGL\d{10,24})\b/i.exec(body)?.[1]

    return [{
      type: 'shipped',
      retailer: 'pocketgames',
      externalOrderId: findOrderNumber(message.subject, body),
      occurredAt: message.receivedAt,
      payload: {
        direction: 'inbound',
        carrier: postnl ? 'postnl' : dhl ? 'dhl' : null,
        trackingNumber: (postnl ?? dhl)?.toUpperCase() ?? null,
        source: 'ported-unverified',
      },
    }]
  },
}

export const POCKETGAMES_PARSERS: readonly Parser[] = [
  pocketgamesShipment,
  pocketgamesOrderConfirmation,
]
