import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { ParsedEvent } from '../repos/events.js'
import type { Parser } from './registry.js'
import { parseDutchAmount } from './nl.js'

/**
 * Parsers for PocketGames.
 *
 * A Shopify shop, and Shopify's mail arrives from a relay address that says
 * nothing about the shop — `store+67495362819_at_t_shopifyemail_com…@icloud.com`
 * in the sample here. What identifies it is the display name and the body, so
 * that is what is matched on: an address like that will change, and the shop's
 * name in its own mail will not.
 *
 * The Dutch storefront states everything in one block: the article with its
 * quantity, then subtotal, postage, BTW and total. Both languages are read,
 * since a Shopify shop switches locale with the customer.
 */

const SHOP = /pocketgames/i

/** `Bestelling #71205 bevestigd`, or Shopify's English `Order #1042`. */
const ORDER_NUMBER = /(?:bestelling|bestel|order)\s*#\s*([A-Za-z0-9-]{2,12})/i

/** `Order #71210 has been canceled`, and the Dutch and British spellings. */
const CANCELLED = /(?:has been|is|was)\s+cancell?ed|geannuleerd/i

function bodyOf(message: ParsedMessage): string {
  return textOf(message, { preferHtml: true })
}

/**
 * The amount belonging to a label.
 *
 * Shopify's own template puts the figure on the line after the label; a
 * plainer mail puts it on the same line. Both are read, and only the next two
 * lines are considered so the next label's amount is never mistaken for this
 * one's.
 */
function amountFor(lines: string[], label: RegExp): number | null {
  const index = lines.findIndex((line) => label.test(line))
  if (index === -1) return null

  for (const line of lines.slice(index, index + 3)) {
    const found = /€\s*([\d.,]+)/.exec(line)?.[1]
    if (found) return parseDutchAmount(found)?.minor ?? null
  }
  return null
}

function isPocketGames(message: ParsedMessage): boolean {
  return SHOP.test(`${message.fromName ?? ''} ${message.fromAddress}`)
    || SHOP.test(message.html)
}

function findOrderNumber(subject: string, body: string): string | null {
  return ORDER_NUMBER.exec(subject)?.[1] ?? ORDER_NUMBER.exec(body)?.[1] ?? null
}

/**
 * The article and how many of it.
 *
 * Shopify writes `Riftbound Spiritforged Champion Deck Fiora × 2` on the line
 * after the order summary heading, with the line total beneath it. A
 * cancellation names the same article under a heading of its own, which is
 * what says *which* article was cancelled when an order held several.
 */
function findLine(lines: string[]): { title: string | null; quantity: number } {
  const heading = lines.findIndex(
    (line) => /^(besteloverzicht|order summary|verwijderde artikelen|removed items)$/i.test(line),
  )
  const candidate = heading === -1
    ? lines.find((line) => /\s×\s*\d+$/.test(line))
    : lines.slice(heading + 1, heading + 4).find((line) => /\s×\s*\d+$/.test(line))
  if (!candidate) return { title: null, quantity: 1 }

  const match = /^(.*?)\s×\s*(\d+)$/.exec(candidate)
  return {
    title: match?.[1]?.trim() ?? candidate,
    quantity: Math.max(1, Number(match?.[2] ?? 1)),
  }
}

export const pocketgamesOrderConfirmation: Parser = {
  id: 'pocketgames-order-confirmation',
  retailer: 'pocketgames',

  matches(message) {
    if (!isPocketGames(message)) return false
    const subject = message.subject.toLowerCase()
    if (/verzonden|onderweg|shipped|on its way/.test(subject)) return false
    // A cancellation restates the whole order — article, subtotal, postage,
    // total — so it reads exactly like a confirmation unless it is excluded.
    if (CANCELLED.test(subject)) return false
    return /bevestigd|confirmed/.test(subject)
      || /bedankt voor je bestelling|thank you for your (?:order|purchase)/i.test(bodyOf(message))
  },

  parse(message): ParsedEvent[] {
    const body = bodyOf(message)
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean)

    // Anchored at the start of the line so "Subtotaal" is never read as the
    // total, and tolerant of the amount following on the same line.
    const subtotal = amountFor(lines, /^(subtotaal|subtotal)\b/i)
    const shipping = amountFor(lines, /^(verzending|verzendkosten|shipping)\b/i)
    const vat = amountFor(lines, /^(btw|tax(es)?|vat)\b/i)
    const total = amountFor(lines, /^(totaal|total)\b/i)
    const { title, quantity } = findLine(lines)

    return [{
      type: 'order_placed',
      retailer: 'pocketgames',
      externalOrderId: findOrderNumber(message.subject, body),
      occurredAt: message.receivedAt,
      payload: {
        title,
        quantity,
        currency: 'EUR',
        unitMinor: subtotal === null ? null : Math.round(subtotal / quantity),
        shippingMinor: shipping,
        // The shop states the BTW inside the total, which is what this
        // purchase can reclaim.
        vatMinor: vat,
        totalMinor: total,
        totalsConsistent: subtotal !== null && shipping !== null && total !== null
          ? subtotal + shipping === total
          : false,
      },
    }]
  },
}

/**
 * "Order #71210 has been canceled".
 *
 * The shop names the article it removed and states the money in full: what the
 * goods came to, what is being refunded, and to which card. The article and
 * how many of it are what matter downstream — an order of three with one
 * cancelled is still an order of two — so both are read rather than assuming
 * the whole order fell away.
 */
export const pocketgamesCancellation: Parser = {
  id: 'pocketgames-cancellation',
  retailer: 'pocketgames',

  matches(message) {
    if (!isPocketGames(message)) return false
    return CANCELLED.test(`${message.subject} ${bodyOf(message)}`)
  },

  parse(message): ParsedEvent[] {
    const body = bodyOf(message)
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean)
    const { title, quantity } = findLine(lines)

    return [{
      type: 'cancelled',
      retailer: 'pocketgames',
      externalOrderId: findOrderNumber(message.subject, body),
      occurredAt: message.receivedAt,
      payload: {
        title,
        quantity,
        currency: 'EUR',
        totalMinor: amountFor(lines, /^(totaal|total)\b/i),
        // The line naming the card the money goes back to, which is the whole
        // refund including postage. "Refunded", just above, is the goods only,
        // and the word boundary is what keeps the two apart.
        refundMinor: amountFor(lines, /^(terugbetaling|refund)\b/i),
        // A cancellation is a refund: the shop has the money and the goods are
        // not coming. Nothing in the mail has to promise it.
        refundExpected: true,
      },
    }]
  },
}

export const pocketgamesShipment: Parser = {
  id: 'pocketgames-shipment',
  retailer: 'pocketgames',

  matches(message) {
    if (!isPocketGames(message)) return false
    return /verzonden|onderweg|shipped|on its way/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const body = bodyOf(message)
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
        shipmentStatus: (postnl ?? dhl) ? 'in_transit' : 'pending',
        trackingResolvable: false,
      },
    }]
  },
}

export const POCKETGAMES_PARSERS: readonly Parser[] = [
  // Before the confirmation: a cancellation repeats the order in full, so
  // whichever is asked first is the one that answers.
  pocketgamesCancellation,
  pocketgamesShipment,
  pocketgamesOrderConfirmation,
]
