import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { ParsedEvent } from '../repos/events.js'
import type { Parser } from './registry.js'
import { findDutchAmount } from './nl.js'

/**
 * Parsers for MediaMarkt.nl.
 *
 * Ported from a working Python implementation, so the matching rules and
 * patterns are the ones already proven against real MediaMarkt mail. They have
 * not yet been checked against a `.eml` sample here, so unlike the bol.com
 * parsers these carry no fixture test — supply one and the port becomes
 * verifiable rather than merely faithful.
 */

const ORDER_NUMBER_PRIMARY = /bestelnummer\s+is\s*(\d{6,})/i
const ORDER_NUMBER_FALLBACK = /\bbestelnummer\b[^\d]{0,40}(\d{6,})/i
const JVGL_TRACKING = /\b(JVGL[A-Z0-9]{10,})\b/i

const CANCEL_SUBJECT_MARKERS = ['geannuleerd', 'annul']
const CANCEL_BODY_MARKERS = [
  'je bestelling is (deels) geannuleerd',
  'je bestelling is geannuleerd',
  'wat hebben we geannuleerd',
  'bestelling (deels) geannuleerd',
]
const SHIPPED_SUBJECT_MARKERS = ['onderweg']

function isMediaMarktSender(message: ParsedMessage): boolean {
  const blob = `${message.fromName ?? ''} ${message.fromAddress}`.toLowerCase()
  return blob.includes('mediamarkt')
    || message.fromAddress.toLowerCase().endsWith('mediamarkt.nl')
    || message.fromAddress.toLowerCase().includes('@mediamarkt.')
}

function findOrderNumber(body: string): string | null {
  return ORDER_NUMBER_PRIMARY.exec(body)?.[1]
    ?? ORDER_NUMBER_FALLBACK.exec(body)?.[1]
    ?? null
}

function contains(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

export const mediamarktOrderConfirmation: Parser = {
  id: 'mediamarkt-order-confirmation',
  retailer: 'mediamarkt',

  matches(message) {
    if (!isMediaMarktSender(message)) return false
    const subject = message.subject.toLowerCase()
    if (contains(subject, CANCEL_SUBJECT_MARKERS)) return false
    if (contains(subject, SHIPPED_SUBJECT_MARKERS)) return false
    return subject.includes('bedankt voor je bestelling')
  },

  parse(message): ParsedEvent[] {
    const body = textOf(message, { preferHtml: true })
    const total = findDutchAmount(
      /totaal(?:bedrag)?[^\n]{0,40}/i.exec(body)?.[0] ?? '',
    )

    return [{
      type: 'order_placed',
      retailer: 'mediamarkt',
      externalOrderId: findOrderNumber(body),
      occurredAt: message.receivedAt,
      payload: {
        currency: 'EUR',
        totalMinor: total?.minor ?? null,
        // MediaMarkt states no per-unit breakdown in a form worth trusting
        // without a sample, so quantity and unit price are left unknown rather
        // than assumed to be one.
        quantity: null,
        unitMinor: null,
        totalsConsistent: false,
        source: 'ported-unverified',
      },
    }]
  },
}

export const mediamarktShipment: Parser = {
  id: 'mediamarkt-shipment',
  retailer: 'mediamarkt',

  matches(message) {
    if (!isMediaMarktSender(message)) return false
    const subject = message.subject.toLowerCase()
    if (contains(subject, CANCEL_SUBJECT_MARKERS)) return false
    if (!contains(subject, SHIPPED_SUBJECT_MARKERS)) return false
    // "onderweg" alone is not enough: it also appears in marketing mail.
    return subject.includes('bestelling')
      || textOf(message, { preferHtml: true }).toLowerCase().includes('bestelnummer')
  },

  parse(message): ParsedEvent[] {
    const body = textOf(message, { preferHtml: true })
    const tracking = JVGL_TRACKING.exec(body)?.[1] ?? JVGL_TRACKING.exec(message.html)?.[1] ?? null

    return [{
      type: 'shipped',
      retailer: 'mediamarkt',
      externalOrderId: findOrderNumber(body),
      occurredAt: message.receivedAt,
      payload: {
        direction: 'inbound',
        // A JVGL barcode is DHL's; anything else is unknown until a sample says.
        carrier: tracking ? 'dhl' : null,
        trackingNumber: tracking ? tracking.toUpperCase() : null,
        source: 'ported-unverified',
      },
    }]
  },
}

export const mediamarktCancellation: Parser = {
  id: 'mediamarkt-cancellation',
  retailer: 'mediamarkt',

  matches(message) {
    if (!isMediaMarktSender(message)) return false
    const subject = message.subject.toLowerCase()
    if (contains(subject, CANCEL_SUBJECT_MARKERS)) return true
    return contains(textOf(message, { preferHtml: true }).toLowerCase(), CANCEL_BODY_MARKERS)
  },

  parse(message): ParsedEvent[] {
    const body = textOf(message, { preferHtml: true })
    return [{
      type: 'cancelled',
      retailer: 'mediamarkt',
      externalOrderId: findOrderNumber(body),
      occurredAt: message.receivedAt,
      payload: {
        currency: 'EUR',
        totalMinor: null,
        refundExpected: true,
        partial: body.toLowerCase().includes('(deels) geannuleerd'),
        source: 'ported-unverified',
      },
    }]
  },
}

export const MEDIAMARKT_PARSERS: readonly Parser[] = [
  mediamarktCancellation,
  mediamarktShipment,
  mediamarktOrderConfirmation,
]
