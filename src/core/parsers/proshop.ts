import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { ParsedEvent } from '../repos/events.js'
import type { Parser } from './registry.js'
import { findDutchAmount } from './nl.js'

/**
 * Parsers for Proshop.nl.
 *
 * Ported from a working Python implementation. Not yet verified against a
 * `.eml` sample here.
 *
 * Proshop's tracking pattern is the loosest of any retailer in this codebase —
 * a bare run of ten or more digits — so it is only accepted on a line that also
 * mentions tracking. Applied to a whole email it would happily match an order
 * number, a phone number or a VAT id.
 */

const ORDER_NUMBER = /bestelnummer[:\s]+(\d{6,})/i
/**
 * The ported pattern is a bare run of ten or more digits, which is the form
 * Proshop uses. Carrier-specific shapes are accepted too, since Proshop ships
 * with PostNL and DHL in the Netherlands and both are unambiguous.
 */
const TRACKING_TOKEN = /\b(3[SZ][A-Z0-9]{9,24}|JVGL\d{10,24}|\d{10,}[A-Z]?)\b/i
const CANCEL_SUBJECT = 'bevestiging van annulering'

function isProshopSender(message: ParsedMessage): boolean {
  return `${message.fromName ?? ''} ${message.fromAddress}`.toLowerCase().includes('proshop')
}

function findOrderNumber(subject: string, body: string): string | null {
  return ORDER_NUMBER.exec(subject)?.[1] ?? ORDER_NUMBER.exec(body)?.[1] ?? null
}

/** Only trust a digit run that sits on a line actually about tracking. */
function findTracking(body: string): string | null {
  for (const line of body.split('\n')) {
    if (!/track|trace|zending|barcode|verzend/i.test(line)) continue
    const found = TRACKING_TOKEN.exec(line)?.[1]
    if (found) return found.toUpperCase()
  }
  return null
}

export const proshopOrderConfirmation: Parser = {
  id: 'proshop-order-confirmation',
  retailer: 'proshop',

  matches(message) {
    if (!isProshopSender(message)) return false
    const subject = message.subject.toLowerCase()
    if (subject.includes(CANCEL_SUBJECT)) return false
    if (/verzonden|onderweg|shipped/i.test(subject)) return false
    return /bestelling|order|bevestiging/i.test(subject)
  },

  parse(message): ParsedEvent[] {
    const body = textOf(message, { preferHtml: true })
    const total = findDutchAmount(/totaal[^\n]{0,40}/i.exec(body)?.[0] ?? '')

    return [{
      type: 'order_placed',
      retailer: 'proshop',
      externalOrderId: findOrderNumber(message.subject, body),
      occurredAt: message.receivedAt,
      payload: {
        currency: 'EUR',
        totalMinor: total?.minor ?? null,
        quantity: null,
        unitMinor: null,
        totalsConsistent: false,
        source: 'ported-unverified',
      },
    }]
  },
}

export const proshopShipment: Parser = {
  id: 'proshop-shipment',
  retailer: 'proshop',

  matches(message) {
    if (!isProshopSender(message)) return false
    const subject = message.subject.toLowerCase()
    if (subject.includes(CANCEL_SUBJECT)) return false
    return /verzonden|onderweg|shipped|track/i.test(subject)
  },

  parse(message): ParsedEvent[] {
    const body = textOf(message, { preferHtml: true })
    const tracking = findTracking(body)

    return [{
      type: 'shipped',
      retailer: 'proshop',
      externalOrderId: findOrderNumber(message.subject, body),
      occurredAt: message.receivedAt,
      payload: {
        direction: 'inbound',
        carrier: null,
        trackingNumber: tracking,
        source: 'ported-unverified',
      },
    }]
  },
}

export const proshopCancellation: Parser = {
  id: 'proshop-cancellation',
  retailer: 'proshop',

  matches(message) {
    if (!isProshopSender(message)) return false
    const haystack = `${message.subject} ${textOf(message, { preferHtml: true })}`.toLowerCase()
    return haystack.includes(CANCEL_SUBJECT)
  },

  parse(message): ParsedEvent[] {
    const body = textOf(message, { preferHtml: true })
    return [{
      type: 'cancelled',
      retailer: 'proshop',
      externalOrderId: findOrderNumber(message.subject, body),
      occurredAt: message.receivedAt,
      payload: {
        currency: 'EUR',
        totalMinor: null,
        refundExpected: true,
        source: 'ported-unverified',
      },
    }]
  },
}

export const PROSHOP_PARSERS: readonly Parser[] = [
  proshopCancellation,
  proshopShipment,
  proshopOrderConfirmation,
]
