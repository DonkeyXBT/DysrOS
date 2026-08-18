import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { ParsedEvent } from '../repos/events.js'
import type { Parser } from './registry.js'
import { parseDutchAmount, parseDutchDayMonth } from './nl.js'

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

/** bol.com order references: a C followed by nine uppercase alphanumerics. */
const ORDER_REFERENCE = /\bC[0-9A-Z]{9}\b/

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
  const standalone = all.find((line) => /^C[0-9A-Z]{9}$/.test(line))
  return standalone ?? null
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
    const orderId = findOrderReference(all)

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
    return templateIs(message, 'CLI_ITEM_CANCELLED')
      || /is geannuleerd/i.test(message.subject)
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
    return templateIs(message, 'CLI_SHIPMENT_CONFIRMATION')
      || /je pakket is nu bij/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)
    const body = all.join('\n')

    const carrierMatch = /meegegeven met ([A-Za-zÀ-ü.]+)/i.exec(body)
      ?? /je pakket is nu bij ([A-Za-zÀ-ü.]+)/i.exec(message.subject)
    const carrierRaw = carrierMatch?.[1]?.replace(/[!.]+$/, '').trim() ?? null
    const carrier = carrierRaw ? (CARRIERS[carrierRaw.toLowerCase()] ?? carrierRaw.toLowerCase()) : null

    const deliveryMatch = /bezorgd op ([a-zà-ü]+dag\s+\d{1,2}\s+[a-zà-ü]+)/i.exec(body)
    const expectedDeliveryAt = deliveryMatch
      ? parseDutchDayMonth(deliveryMatch[1]!.replace(/^[a-zà-ü]+dag\s+/i, ''), message.receivedAt)
      : null

    const headingIndex = all.findIndex((line) => /^dit is onderweg$/i.test(line))
    let title: string | null = null
    let titleIndex = -1
    if (headingIndex !== -1) {
      titleIndex = all.findIndex(
        (line, i) => i > headingIndex && !/^\d+\s+artikel(en)?$/i.test(line),
      )
      title = titleIndex === -1 ? null : (all[titleIndex] ?? null)
    }

    // bol.com does not put the carrier barcode in this mail. The only tracking
    // handle is an opaque redirect on link.bol.com, which resolves to the real
    // code only by following it over the network — deliberately not done here,
    // so parsing stays offline and deterministic.
    const trackingUrl = /https:\/\/link\.bol\.com\/t\/[^\s"'<>\]]+/.exec(message.html)?.[0] ?? null
    const address = findDeliveryAddress(all)

    return [{
      type: 'shipped',
      retailer: 'bol',
      externalOrderId: findOrderReference(all),
      occurredAt: message.receivedAt,
      payload: {
        carrier,
        direction: 'inbound',
        title,
        titleTruncated: title !== null && title.endsWith('...'),
        quantity: titleIndex === -1 ? 1 : quantityAfter(all, titleIndex),
        expectedDeliveryAt,
        trackingNumber: null,
        trackingUrl,
        trackingResolvable: trackingUrl !== null,
        deliveryPostalCode: address?.postalCode ?? null,
        deliveryPostalCodeFormatted: address?.postalCodeFormatted ?? null,
        deliveryCity: address?.city ?? null,
        // The DHL ServicePoint redirect tool needs a tracking code and a postal
        // code. The code arrives later from the link resolver, so this only
        // reports that the postal-code half is in hand.
        dhlRedirectable: carrier === 'dhl' && address !== null,
      },
    }]
  },
}

export const BOL_PARSERS: readonly Parser[] = [
  bolOrderConfirmation,
  bolCancellation,
  bolShipmentConfirmation,
]
