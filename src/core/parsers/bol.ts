import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { ParsedEvent } from '../repos/events.js'
import type { Parser } from './registry.js'
import { parseDutchAmount, parseDutchDayMonth } from './nl.js'
import { classifyShipment, findShipmentTitle } from './bol-shipment-status.js'
import { collectTrackingCandidates } from '../tracking/bol-links.js'
import { findProductImage } from './product-image.js'

/**
 * Parsers for bol.com.
 *
 * bol.com sends HTML-only mail from `automail@bol.com` with no plain-text part,
 * so everything runs through `textOf`. Each template embeds its own identifier
 * in the feedback links (`mailing=CLI_ORDER_CONFIRMATION_092024`); matching on
 * that prefix is more durable than matching on subject wording, which bol.com
 * rewrites more often than it renames a template.
 */

const SENDER = 'automail@bol.com'

/**
 * A bol.com order reference: a letter, three digits, then six alphanumerics.
 *
 * The prefix is not always `C`. A real mailbox carries `A`-prefixed references
 * in quantity, and a pattern assuming `C` produced a null reference for every
 * one of them — which the reconciler then skipped, so those orders never became
 * purchases at all.
 */
const ORDER_REFERENCE = /\b[A-Z]\d{3}[0-9A-Z]{6}\b/

/** A line that is only a URL, bracketed or bare — how the text part renders
 *  images and buttons. Never content, and it sits where content is expected. */
const URL_ONLY_LINE = /^\[?\s*https?:\/\/\S+\s*\]?$/i

/**
 * bol.com authors its mail as HTML. Where a plain-text part exists it is a
 * hard-wrapped auto-conversion that splits long product titles mid-phrase, so
 * every bol parser reads the HTML instead.
 */
function lines(message: ParsedMessage): string[] {
  return textOf(message, { preferHtml: true })
    .split('\n')
    .map((line) => line.replace(/[⠀͏‌​­]/g, '').trim())
    .filter((line) => line.length > 0 && !URL_ONLY_LINE.test(line) && line !== '-->')
}

export interface DeliveryAddress {
  /** Compact form, as the DHL ServicePoint redirect tool expects: `1012AB`. */
  postalCode: string
  /** Human form, as the mail prints it: `1012 AB`. */
  postalCodeFormatted: string
  city: string | null
}

/**
 * Finds the delivery postal code in the address block.
 *
 * A Dutch postal code is four digits followed by two letters, and on the
 * address line the city follows it. Requiring the line to *start* with the code
 * keeps it from matching a house number or an order reference elsewhere in the
 * mail.
 */
export function findDeliveryAddress(all: string[]): DeliveryAddress | null {
  for (const line of all) {
    const match = /^(\d{4})\s?([A-Z]{2})(?:\s+(.+))?$/.exec(line.trim())
    if (!match) continue
    const city = match[3]?.trim()
    return {
      postalCode: `${match[1]}${match[2]}`,
      postalCodeFormatted: `${match[1]} ${match[2]}`,
      city: city && city.length > 0 ? city : null,
    }
  }
  return null
}

/** The unit count that follows a given item title, wherever it sits. */
function quantityNear(all: string[], title: string | null): number {
  if (!title) return 1
  const index = all.indexOf(title)
  return index === -1 ? 1 : quantityAfter(all, index)
}

/** `3 stuks` on its own line is a unit count, as shown under an item title. */
function quantityAfter(all: string[], index: number): number {
  for (const line of all.slice(index + 1, index + 3)) {
    const match = /^(\d+)\s*stuks?$/i.exec(line)
    if (match) return Number(match[1])
  }
  return 1
}

function templateIs(message: ParsedMessage, prefix: string): boolean {
  return message.html.includes(`mailing=${prefix}`)
}

/** The value on the line following an exact label, as bol.com lays out totals. */
function valueAfter(all: string[], label: string): string | null {
  const index = all.findIndex((line) => line.toLowerCase() === label.toLowerCase())
  if (index === -1) return null
  return all[index + 1] ?? null
}

/** The remainder of a `Label: value` line. */
function valueOnLabelledLine(all: string[], label: string): string | null {
  const match = all.find((line) => line.toLowerCase().startsWith(`${label.toLowerCase()}:`))
  if (!match) return null
  const value = match.slice(match.indexOf(':') + 1).trim()
  return value.length > 0 ? value : null
}

function findOrderReference(all: string[]): string | null {
  const labelled = valueOnLabelledLine(all, 'Bestelnummer')
  const fromLabel = labelled ? ORDER_REFERENCE.exec(labelled)?.[0] : null
  if (fromLabel) return fromLabel

  // The cancellation mail carries the reference only in the customer service
  // footer, phrased as a sentence rather than a labelled field.
  for (const line of all) {
    if (/bestelnummer/i.test(line)) {
      const found = ORDER_REFERENCE.exec(line)?.[0]
      if (found) return found
    }
  }

  // Shipping mails print the reference unlabelled on a line of its own. Only a
  // line that is *entirely* a reference counts, so a code appearing inside a
  // sentence is never picked up by accident.
  const standalone = all.find((line) => /^[A-Z]\d{3}[0-9A-Z]{6}$/.test(line))
  return standalone ?? null
}

/**
 * Some order confirmations carry the reference in the subject instead of, or as
 * well as, the body: "Bedankt voor je bestelling met bestelnummer A0007D41RW".
 */
function orderReferenceFromSubject(subject: string): string | null {
  return ORDER_REFERENCE.exec(subject)?.[0] ?? null
}

export const bolOrderConfirmation: Parser = {
  id: 'bol-order-confirmation',
  retailer: 'bol',

  matches(message) {
    if (message.fromAddress !== SENDER) return false
    return templateIs(message, 'CLI_ORDER_CONFIRMATION')
      || /bedankt voor je bestelling/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)
    const orderId = findOrderReference(all) ?? orderReferenceFromSubject(message.subject)

    // The item title sits on the line directly after the order reference.
    const referenceIndex = all.findIndex((line) => /^bestelnummer:/i.test(line))
    const title = referenceIndex === -1 ? null : (all[referenceIndex + 1] ?? null)

    const quantityIndex = all.findIndex((line) => /^\d+\s*x$/i.test(line))
    const quantity = quantityIndex === -1
      ? null
      : Number(/^(\d+)/.exec(all[quantityIndex]!)![1])
    const unit = quantityIndex === -1 ? null : parseDutchAmount(all[quantityIndex + 1] ?? '')

    const shippingText = valueAfter(all, 'Verzendkosten')
    const shipping = shippingText ? parseDutchAmount(shippingText) : null

    const totalText = valueAfter(all, 'Totaal')
    const total = totalText ? parseDutchAmount(totalText) : null

    const deliveryText = valueOnLabelledLine(all, 'Bezorgdatum')
    const deliveryDate = deliveryText
      ? parseDutchDayMonth(deliveryText, message.receivedAt)
      : null

    // If the parts do not add up, something was extracted from the wrong line.
    // The event still records what was found, flagged, so it lands in review
    // rather than silently corrupting the books.
    const totalsConsistent = quantity !== null && unit !== null && shipping !== null && total !== null
      ? quantity * unit.minor + shipping.minor === total.minor
      : false

    return [{
      type: 'order_placed',
      retailer: 'bol',
      externalOrderId: orderId,
      occurredAt: message.receivedAt,
      payload: {
        title,
        titleTruncated: title !== null && title.endsWith('...'),
        imageUrl: findProductImage(message.html, title),
        seller: valueOnLabelledLine(all, 'Verkoper'),
        quantity,
        currency: 'EUR',
        unitMinor: unit?.minor ?? null,
        shippingMinor: shipping?.minor ?? null,
        totalMinor: total?.minor ?? null,
        deliveryDate,
        totalsConsistent,
      },
    }]
  },
}

export const bolCancellation: Parser = {
  id: 'bol-cancellation',
  retailer: 'bol',

  matches(message) {
    if (message.fromAddress !== SENDER) return false
    // The template id is the reliable signal; the subject wordings are the
    // ones a real mailbox actually carries, kept as a fallback for mail whose
    // template id has changed.
    return templateIs(message, 'CLI_ITEM_CANCELLED')
      || /geannuleerd|annulering/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)

    // The cancelled item is named under the "Dit is geannuleerd" heading,
    // after a line stating how many items were cancelled.
    const headingIndex = all.findIndex((line) => /^dit is geannuleerd$/i.test(line))
    let title: string | null = null
    let titleIndex = -1
    if (headingIndex !== -1) {
      titleIndex = all.findIndex(
        (line, i) => i > headingIndex && !/^\d+\s+artikel(en)?$/i.test(line),
      )
      title = titleIndex === -1 ? null : (all[titleIndex] ?? null)
    }

    return [{
      type: 'cancelled',
      retailer: 'bol',
      externalOrderId: findOrderReference(all),
      occurredAt: message.receivedAt,
      payload: {
        title,
        imageUrl: findProductImage(message.html, title),
        quantity: titleIndex === -1 ? 1 : quantityAfter(all, titleIndex),
        // bol.com states no amount in this mail, so the refund value has to come
        // from the original order rather than be guessed here.
        totalMinor: null,
        currency: 'EUR',
        refundExpected: /krijg je (dat|het) terug|hebben je terugbetaald/i.test(textOf(message)),
      },
    }]
  },
}

/** Carrier names as bol.com writes them, mapped to the identifiers the
 *  shipments table uses. Anything unrecognised is passed through lowercased
 *  rather than dropped, so a new carrier still produces a usable shipment. */
const CARRIERS: Record<string, string> = {
  dhl: 'dhl',
  postnl: 'postnl',
  dpd: 'dpd',
  gls: 'gls',
  ups: 'ups',
  budbee: 'budbee',
  trunkrs: 'trunkrs',
  cycloon: 'cycloon',
}

export const bolShipmentConfirmation: Parser = {
  id: 'bol-shipment-confirmation',
  retailer: 'bol',

  matches(message) {
    if (message.fromAddress !== SENDER) return false
    const variant = classifyShipment(message, textOf(message, { preferHtml: true }))
    // Only mail describing a parcel with a carrier belongs here; the
    // pre-dispatch notice is handled separately.
    return variant !== null && variant.status !== 'awaiting_carrier'
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)
    const body = textOf(message, { preferHtml: true })
    const variant = classifyShipment(message, body)

    const title = findShipmentTitle(all, message.html)

    const deliveryMatch = /bezorgd op ([a-zà-ü]+dag\s+\d{1,2}\s+[a-zà-ü]+)/i.exec(body)
    // "tussen 17:00 en 19:00 uur" — the window the courier gave, worth keeping
    // whole rather than reducing to a date.
    const windowMatch = /tussen\s+(\d{1,2}[:.]\d{2})\s+en\s+(\d{1,2}[:.]\d{2})/i.exec(body)
    const deliveryWindow = windowMatch
      ? `${windowMatch[1]!.replace('.', ':')}–${windowMatch[2]!.replace('.', ':')}`
      : null
    const outForDelivery = variant?.status === 'out_for_delivery'
    const expectedDeliveryAt = deliveryMatch
      ? parseDutchDayMonth(deliveryMatch[1]!.replace(/^[a-zà-ü]+dag\s+/i, ''), message.receivedAt)
      // The courier is out with it now, so the day it arrives is the day the
      // mail was sent, whether or not the mail spells the date out.
      : outForDelivery ? message.receivedAt.slice(0, 10) : null

    // bol.com does not put the carrier barcode in the mail. The only tracking
    // handle is an opaque redirect, which resolves to the real code only by
    // following it over the network.
    // Several bol links appear in a shipping mail and most lead to an account
    // page. Keeping the ranked shortlist means the resolver can try the next
    // one when the first turns out to be a dead end.
    const candidates = collectTrackingCandidates(message.html)
    const trackingUrl = candidates[0] ?? null
    const address = findDeliveryAddress(all)

    const delivered = variant?.status === 'delivered'
    const delayed = variant?.status === 'delayed' || variant?.status === 'delayed_again'

    return [{
      type: delivered ? 'delivered' : 'shipped',
      retailer: 'bol',
      externalOrderId: findOrderReference(all) ?? orderReferenceFromSubject(message.subject),
      occurredAt: message.receivedAt,
      payload: {
        carrier: variant?.carrier ?? null,
        direction: 'inbound',
        title,
        titleTruncated: title !== null && title.endsWith('...'),
        imageUrl: findProductImage(message.html, title),
        quantity: quantityNear(all, title),
        expectedDeliveryAt,
        deliveryWindow,
        outForDelivery,
        shipmentStatus: variant?.status ?? 'shipped_unknown_carrier',
        delayed,
        trackingNumber: null,
        trackingUrl,
        trackingCandidates: candidates,
        trackingResolvable: candidates.length > 0,
        deliveryPostalCode: address?.postalCode ?? null,
        deliveryPostalCodeFormatted: address?.postalCodeFormatted ?? null,
        deliveryCity: address?.city ?? null,
        dhlRedirectable: variant?.carrier === 'dhl' && address !== null,
      },
    }]
  },
}

/**
 * "Je pakket komt eraan" — bol.com has accepted the parcel but not handed it to
 * a carrier. It names no carrier and carries no barcode, so it is recorded as
 * an order being prepared rather than as a parcel in transit; the real shipping
 * mail follows and supplies both.
 */
export const bolShipmentPending: Parser = {
  id: 'bol-shipment-pending',
  retailer: 'bol',

  matches(message) {
    if (message.fromAddress !== SENDER) return false
    return /komt eraan/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)
    return [{
      type: 'order_confirmed',
      retailer: 'bol',
      externalOrderId: findOrderReference(all) ?? orderReferenceFromSubject(message.subject),
      occurredAt: message.receivedAt,
      payload: {
        stage: 'awaiting_carrier',
        imageUrl: findProductImage(message.html, null),
        trackingUrl: /https:\/\/link\.bol\.com\/t\/[^\s"'<>\]]+/.exec(message.html)?.[0] ?? null,
      },
    }]
  },
}

/**
 * "Je retour is verwerkt" — the goods are back with bol and the money follows.
 *
 * The mail names the article but no amount: bol says the money is on its way
 * within five working days and leaves it at that. What the unit cost is
 * already recorded against the order, so the refund is worked out from there
 * rather than guessed at here.
 */
export const bolReturnProcessed: Parser = {
  id: 'bol-return-processed',
  retailer: 'bol',

  matches(message) {
    if (message.fromAddress !== SENDER) return false
    return templateIs(message, 'CLI_RETURN_RECEIPT')
      || /retour is verwerkt|retour ontvangen/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)

    // The article sits under the heading that says what was processed.
    const headingIndex = all.findIndex((line) => /^dit hebben we verwerkt$/i.test(line))
    const titleIndex = headingIndex === -1
      ? -1
      : all.findIndex((line, i) => i > headingIndex && !/^\d+\s+artikel(en)?$/i.test(line))
    const title = titleIndex === -1 ? null : (all[titleIndex] ?? null)

    return [{
      type: 'refunded',
      retailer: 'bol',
      externalOrderId: findOrderReference(all) ?? orderReferenceFromSubject(message.subject),
      occurredAt: message.receivedAt,
      payload: {
        reason: 'return',
        title,
        imageUrl: findProductImage(message.html, title),
        quantity: titleIndex === -1 ? 1 : quantityAfter(all, titleIndex),
        currency: 'EUR',
        // bol states no amount in this mail. The order knows what the unit
        // cost, and inventing a figure here would be worse than deriving one.
        amountMinor: null,
        receivedAt: null,
      },
    }]
  },
}

/**
 * "Je hebt je pakket opgehaald" — collected from a pickup point.
 *
 * The parcel's journey ends here just as surely as if someone had handed it
 * over at the door, so it settles the parcel and puts the goods in stock. A
 * parcel left at a point and never collected is a different thing entirely,
 * and this is the mail that tells them apart.
 */
export const bolCollected: Parser = {
  id: 'bol-collected',
  retailer: 'bol',

  matches(message) {
    if (message.fromAddress !== SENDER) return false
    return templateIs(message, 'CLI_COLLECTION_CONFIRMATION')
      || /opgehaald/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)

    const headingIndex = all.findIndex((line) => /^dit heb je opgehaald$/i.test(line))
    const titleIndex = headingIndex === -1
      ? -1
      : all.findIndex((line, i) => i > headingIndex && !/^\d+\s+artikel(en)?$/i.test(line))
    const title = titleIndex === -1 ? null : (all[titleIndex] ?? null)

    return [{
      type: 'delivered',
      retailer: 'bol',
      externalOrderId: findOrderReference(all) ?? orderReferenceFromSubject(message.subject),
      occurredAt: message.receivedAt,
      payload: {
        direction: 'inbound',
        title,
        imageUrl: findProductImage(message.html, title),
        quantity: titleIndex === -1 ? 1 : quantityAfter(all, titleIndex),
        shipmentStatus: 'delivered',
        collectedFromPoint: true,
        deliveredAt: message.receivedAt.slice(0, 10),
        trackingNumber: null,
      },
    }]
  },
}

export const BOL_PARSERS: readonly Parser[] = [
  bolReturnProcessed,
  bolCollected,
  bolOrderConfirmation,
  bolCancellation,
  bolShipmentPending,
  bolShipmentConfirmation,
]
