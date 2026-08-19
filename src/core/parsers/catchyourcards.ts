import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { Parser } from './registry.js'
import type { ParsedEvent } from '../repos/events.js'
import { parseDutchAmount } from './nl.js'

/**
 * Parsers for CatchYourCards.
 *
 * A Dutch webshop whose order mail states everything in one table: what was
 * bought, the subtotal, the postage, the total and the VAT inside it. Its
 * shipping notices come from a fulfilment system rather than from the shop's
 * own address, so those are recognised by what they contain — the shop's name,
 * an order number and a barcode — instead of by who sent them. A sender is
 * easy to change; a mail that says "# Ordernummer" next to "Track & Trace" is
 * describing a parcel whoever posted it.
 */

const SHOP_SENDER = /@catchyourcards\.nl$/i
const SHOP_SIGNATURE = /catchyourcards/i

function bodyOf(message: ParsedMessage): string {
  return textOf(message, { preferHtml: true })
}

/** Amounts are split across lines by the template, so the whole body is read. */
function flat(message: ParsedMessage): string {
  return bodyOf(message).replace(/\s+/g, ' ')
}

/**
 * `Totaal: € 76,90` and its siblings, in minor units.
 *
 * The label has to start a word: "Subtotaal" ends in "totaal", and matching
 * that first reported an order's subtotal as its total.
 */
export function amountAfter(body: string, label: RegExp): number | null {
  const pattern = new RegExp(`(?<![a-z])${label.source}\\s*:?\\s*-?\\s*€\\s*([\\d.,]+)`, 'i')
  const found = pattern.exec(body)?.[1]
  return found ? parseDutchAmount(found)?.minor ?? null : null
}

/** `Bestelling #60619` — the shop's own reference. */
export function findOrderNumber(text: string): string | null {
  return /bestelling\s*#\s*(\d{3,10})/i.exec(text)?.[1]
    ?? /ordernummer\s*#?\s*(\d{3,10})/i.exec(text)?.[1]
    ?? /\border\s+(\d{3,10})\b/i.exec(text)?.[1]
    ?? null
}

/** `Bestelling #60619 ( 27-02-2026 )` — the day it was placed. */
function findOrderDate(body: string): string | null {
  const match = /(\d{2})-(\d{2})-(\d{4})/.exec(body)
  if (!match) return null
  return `${match[3]}-${match[2]}-${match[1]}`
}

/** The article, which sits between the table's headings and its quantity. */
function findTitle(message: ParsedMessage): string | null {
  const lines = bodyOf(message).split('\n').map((line) => line.trim()).filter(Boolean)
  const priceHeading = lines.findIndex((line) => /^prijs$/i.test(line))
  if (priceHeading === -1) return null
  const title = lines[priceHeading + 1]
  return title && !/^€/.test(title) ? title : null
}

function findQuantity(body: string): number {
  const match = /×\s*(\d+)/.exec(body)
  return match ? Math.max(1, Number(match[1])) : 1
}

function isShopMail(message: ParsedMessage): boolean {
  return SHOP_SENDER.test(message.fromAddress) || SHOP_SIGNATURE.test(message.html)
}

/** "Je bestelling bij CatchYourCards is ontvangen" — the order itself. */
export const catchYourCardsOrder: Parser = {
  id: 'catchyourcards-order',
  retailer: 'catchyourcards',

  matches(message) {
    if (!isShopMail(message)) return false
    const body = flat(message)
    if (/terugbetaald|refund/i.test(`${message.subject} ${body}`)) return false
    return /bestelling ontvangen|is ontvangen|bedankt voor je bestelling/i
      .test(`${message.subject} ${body}`)
  },

  parse(message): ParsedEvent[] {
    const body = flat(message)
    const total = amountAfter(body, /totaal/)
    const shipping = amountAfter(body, /verzending[^€]*/)
    const subtotal = amountAfter(body, /subtotaal/)
    const quantity = findQuantity(body)

    return [{
      type: 'order_placed',
      retailer: 'catchyourcards',
      externalOrderId: findOrderNumber(`${message.subject} ${body}`),
      occurredAt: message.receivedAt,
      payload: {
        title: findTitle(message),
        quantity,
        currency: 'EUR',
        unitMinor: subtotal === null ? null : Math.round(subtotal / quantity),
        shippingMinor: shipping,
        totalMinor: total,
        // The shop states the VAT inside the total, which is the input VAT
        // this purchase carries.
        vatMinor: amountAfter(body, /inclusief/),
        orderedAt: findOrderDate(body),
        totalsConsistent: subtotal !== null && shipping !== null && total !== null
          ? subtotal + shipping === total
          : false,
      },
    }]
  },
}

/** "Je bestelling van CatchYourCards is onderweg" — packed and handed over. */
export const catchYourCardsProcessed: Parser = {
  id: 'catchyourcards-processed',
  retailer: 'catchyourcards',

  matches(message) {
    if (!isShopMail(message)) return false
    if (catchYourCardsOrder.matches(message)) return false
    const body = flat(message)
    return /is onderweg|klaar met het verwerken/i.test(`${message.subject} ${body}`)
  },

  parse(message): ParsedEvent[] {
    const body = flat(message)
    return [{
      type: 'order_confirmed',
      retailer: 'catchyourcards',
      externalOrderId: findOrderNumber(`${message.subject} ${body}`),
      occurredAt: message.receivedAt,
      payload: {
        stage: 'processed',
        title: findTitle(message),
        quantity: findQuantity(body),
        currency: 'EUR',
        totalMinor: amountAfter(body, /totaal/),
      },
    }]
  },
}

/** "Je bestelling #59277 is terugbetaald" — the money is coming back. */
export const catchYourCardsRefund: Parser = {
  id: 'catchyourcards-refund',
  retailer: 'catchyourcards',

  matches(message) {
    if (!isShopMail(message)) return false
    return /terugbetaald|terugbetaling/i.test(`${message.subject} ${flat(message)}`)
  },

  parse(message): ParsedEvent[] {
    const body = flat(message)
    // "Terugbetalen: - € 76,90" is what is being returned; the total below it
    // is what remains payable, which after a full refund is nothing.
    const refunded = amountAfter(body, /terugbetalen/) ?? amountAfter(body, /totaal/)

    return [{
      type: 'refunded',
      retailer: 'catchyourcards',
      externalOrderId: findOrderNumber(`${message.subject} ${body}`),
      occurredAt: message.receivedAt,
      payload: {
        title: findTitle(message),
        currency: 'EUR',
        totalMinor: refunded,
        amountMinor: refunded,
        // The mail announces the refund; the money lands separately and this
        // does not pretend to know when.
        receivedAt: null,
      },
    }]
  },
}

/**
 * The shop's fulfilment notices.
 *
 * Sent by a shipping platform rather than by the shop, so they are recognised
 * by what they carry: the shop's name, an order number and a barcode.
 */
const FULFILMENT = /#\s*ordernummer|track\s*&\s*trace/i

function isFulfilmentMail(message: ParsedMessage): boolean {
  const body = flat(message)
  return SHOP_SIGNATURE.test(body) && FULFILMENT.test(body) && findBarcode(body) !== null
}

function findBarcode(body: string): string | null {
  return /\b(3[SZ][A-Z0-9]{9,20})\b/.exec(body)?.[1]?.toUpperCase() ?? null
}

/** `Geschatte bezorging 4-3-2026 08:30 - 21:30` */
function findExpected(body: string): { date: string | null; window: string | null } {
  const day = /geschatte bezorging\s*(\d{1,2})-(\d{1,2})-(\d{4})/i.exec(body)
  const window = /(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/.exec(body)
  return {
    date: day
      ? `${day[3]}-${day[2]!.padStart(2, '0')}-${day[1]!.padStart(2, '0')}`
      : null,
    window: window ? `${window[1]}–${window[2]}` : null,
  }
}

/**
 * Who is carrying it.
 *
 * Named in the body where the template says so, and read from the barcode
 * where it does not: `3S` is PostNL's shape and `JVGL` is DHL's, and a parcel
 * with no carrier at all cannot be followed or redirected.
 */
function carrierOf(body: string): string | null {
  if (/postnl/i.test(body)) return 'postnl'
  if (/\bdhl\b/i.test(body)) return 'dhl'
  const barcode = findBarcode(body)
  if (barcode?.startsWith('3S') || barcode?.startsWith('3Z')) return 'postnl'
  if (barcode?.startsWith('JVGL') || barcode?.startsWith('JJD')) return 'dhl'
  return null
}

/** `3067 TR Rotterdam` — where the parcel is going. */
function findPostcode(body: string): string | null {
  const match = /\b([1-9][0-9]{3})\s?([A-Z]{2})\b/.exec(body)
  return match ? `${match[1]}${match[2]}` : null
}

function fulfilment(
  id: string,
  status: string,
  claims: (subject: string, body: string) => boolean,
): Parser {
  return {
    id,
    retailer: 'catchyourcards',

    matches(message) {
      if (!isFulfilmentMail(message)) return false
      return claims(message.subject, flat(message))
    },

    parse(message): ParsedEvent[] {
      const body = flat(message)
      const expected = findExpected(body)
      const postcode = findPostcode(body)

      return [{
        type: status === 'delivered' ? 'delivered' : 'shipped',
        retailer: 'catchyourcards',
        externalOrderId: findOrderNumber(`${message.subject} ${body}`),
        occurredAt: message.receivedAt,
        payload: {
          direction: 'inbound',
          carrier: carrierOf(body),
          trackingNumber: findBarcode(body),
          shipmentStatus: status,
          expectedDeliveryAt: expected.date,
          deliveryWindow: expected.window,
          deliveryPostalCode: postcode,
          trackingResolvable: false,
        },
      }]
    },
  }
}

/** "Jouw order is klaar voor verzending" — packed, barcode issued. */
export const catchYourCardsReadyToShip = fulfilment(
  'catchyourcards-ready-to-ship',
  'pending',
  (subject, body) => /klaar voor verzending|is ingepakt/i.test(`${subject} ${body}`),
)

/** "PostNL is onderweg" — with the carrier, and often a delivery window. */
export const catchYourCardsInTransit = fulfilment(
  'catchyourcards-in-transit',
  'in_transit',
  (subject, body) =>
    /is onderweg/i.test(`${subject} ${body}`)
    && !/klaar voor je|afhaalpunt/i.test(`${subject} ${body}`),
)

/** "Jouw order ligt voor je klaar" — waiting at a collection point. */
export const catchYourCardsReadyForPickup = fulfilment(
  'catchyourcards-ready-for-pickup',
  'ready_for_pickup',
  (subject, body) => /ligt voor je klaar|afhaalpunt/i.test(`${subject} ${body}`),
)

export const CATCHYOURCARDS_PARSERS: readonly Parser[] = [
  // Order before the notices: the shop's own mail is the better source of what
  // was bought, and its wording overlaps ("is onderweg" appears in both).
  catchYourCardsRefund,
  catchYourCardsOrder,
  catchYourCardsReadyForPickup,
  catchYourCardsReadyToShip,
  catchYourCardsInTransit,
  catchYourCardsProcessed,
]
