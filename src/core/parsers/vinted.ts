import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { Parser } from './registry.js'
import type { ParsedEvent } from '../repos/events.js'

/**
 * Parsers for Vinted, which is the whole of a sale rather than part of one.
 *
 * Three mails describe it, and each carries something the others do not:
 * the sale itself names the buyer and the price, the shipping label carries
 * the barcode and the label to print, and the completion states the transaction
 * id and what actually landed in the balance after postage.
 *
 * They are tied together by the item's name — the only thing all three state —
 * with the transaction id taking over as soon as a mail mentions one.
 */

const SENDER = /@(?:[a-z0-9.-]+\.)?vinted\.(?:nl|com|co\.uk|de|fr|be)$/i

function bodyOf(message: ParsedMessage): string {
  return textOf(message, { preferHtml: true })
}

function lines(message: ParsedMessage): string[] {
  return bodyOf(message).split('\n').map((line) => line.trim()).filter(Boolean)
}

function isVinted(message: ParsedMessage): boolean {
  return SENDER.test(message.fromAddress)
}

/** `€15.00` as Vinted writes it, in minor units. */
export function parseVintedAmount(text: string | undefined): number | null {
  if (!text) return null
  const match = /€\s?(\d+(?:[.,]\d{2})?)/.exec(text)
  if (!match) return null
  return Math.round(Number(match[1]!.replace(',', '.')) * 100)
}

/** The value on the line after a label, which is how Vinted lays these out. */
function valueAfter(all: string[], label: RegExp): string | null {
  const index = all.findIndex((line) => label.test(line))
  if (index === -1) return null
  return all[index + 1] ?? null
}

export function findTransactionId(body: string): string | null {
  return /transaction id:?\s*#?\s*(\d{6,20})/i.exec(body)?.[1] ?? null
}

/**
 * "You've sold an item on Vinted" — someone has bought something.
 *
 * The buyer's name sits above "has bought" and the item below it, which is
 * how the mail reads aloud: `florence2838 has bought Uniqlo balloon pants`.
 */
export const vintedSold: Parser = {
  id: 'vinted-sold',
  retailer: 'vinted',

  matches(message) {
    if (!isVinted(message)) return false
    return /sold an item|verkocht/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)
    // "florence2838 has bought" on one line, the item on the next, the price
    // on the one after that.
    const boughtAt = all.findIndex((line) => /has bought|heeft.*gekocht/i.test(line))
    const buyer = boughtAt === -1
      ? null
      : (/^(.*?)\s+(?:has bought|heeft)/i.exec(all[boughtAt]!)?.[1]?.trim() || null)
    const title = boughtAt === -1 ? null : (all[boughtAt + 1] ?? null)
    const amount = boughtAt === -1 ? null : parseVintedAmount(all[boughtAt + 2])

    return [{
      type: 'sale',
      retailer: 'vinted',
      externalOrderId: findTransactionId(bodyOf(message)),
      occurredAt: message.receivedAt,
      payload: {
        channel: 'vinted',
        title,
        buyer,
        currency: 'EUR',
        // What the buyer paid for the item. Postage is theirs, not the
        // seller's, and the completion mail states what actually lands.
        totalMinor: amount,
        grossMinor: amount,
      },
    }]
  },
}

/**
 * "<item> shipping label – use by <date>" — the parcel is ready to send.
 *
 * The label itself is attached as a PDF, and the mail states the barcode
 * before any carrier has scanned it, which is earlier than a carrier's own
 * mail could.
 */
export const vintedLabel: Parser = {
  id: 'vinted-label',
  retailer: 'vinted',

  matches(message) {
    if (!isVinted(message)) return false
    return /shipping label|verzendlabel/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)
    const body = bodyOf(message)
    const title = valueAfter(all, /^item:?$/i)
      ?? /^(.*?)\s+shipping label/i.exec(message.subject)?.[1]?.trim()
      ?? null

    const tracking = valueAfter(all, /^tracking code:?$/i)
      ?? /tracking code:?\s*([A-Z0-9]{6,30})/i.exec(body)?.[1]
      ?? null

    return [{
      type: 'shipped',
      retailer: 'vinted',
      externalOrderId: findTransactionId(body),
      occurredAt: message.receivedAt,
      payload: {
        channel: 'vinted',
        direction: 'outbound',
        title,
        carrier: findCarrier(body),
        trackingNumber: tracking?.toUpperCase() ?? null,
        shipmentStatus: 'pending',
        // The label is attached to this very message, so the message is where
        // the application fetches it from when someone asks to print it.
        hasLabel: message.attachments.some((file) => /pdf/i.test(file.contentType)),
        labelDeadline: findDeadline(message.subject, body),
        trackingResolvable: false,
      },
    }]
  },
}

/**
 * "This order is completed" — the money has landed.
 *
 * This is the mail that closes a sale: it states the transaction id, what the
 * item fetched, what the postage was, and what actually reached the balance.
 */
export const vintedCompleted: Parser = {
  id: 'vinted-completed',
  retailer: 'vinted',

  matches(message) {
    if (!isVinted(message)) return false
    return /order is completed|bestelling is voltooid/i.test(message.subject)
  },

  parse(message): ParsedEvent[] {
    const all = lines(message)
    const body = bodyOf(message)

    // "Your sale of Uniqlo balloon pants was completed successfully."
    const title = /your sale of\s+(.+?)\s+was completed/i.exec(body)?.[1]?.trim()
      ?? /je verkoop van\s+(.+?)\s+is voltooid/i.exec(body)?.[1]?.trim()
      ?? null

    return [{
      type: 'payout',
      retailer: 'vinted',
      externalOrderId: findTransactionId(body),
      occurredAt: message.receivedAt,
      payload: {
        channel: 'vinted',
        title,
        currency: 'EUR',
        itemPriceMinor: parseVintedAmount(valueAfter(all, /^item price:?$/i) ?? undefined),
        postageMinor: parseVintedAmount(valueAfter(all, /^postage:?$/i) ?? undefined),
        payoutMinor: parseVintedAmount(
          valueAfter(all, /transferred to your vinted balance/i) ?? undefined,
        ),
        soldAt: /date:?\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(body)
          ? `${/date:?\s*\d{2}\/\d{2}\/(\d{4})/i.exec(body)![1]}-${/date:?\s*\d{2}\/(\d{2})/i.exec(body)![1]}-${/date:?\s*(\d{2})/i.exec(body)![1]}`
          : null,
      },
    }]
  },
}

/** Vinted names the drop-off network in the label mail. */
function findCarrier(body: string): string | null {
  const known: [RegExp, string][] = [
    [/mondial relay/i, 'mondial relay'],
    [/\bdhl\b/i, 'dhl'],
    [/postnl/i, 'postnl'],
    [/\bgls\b/i, 'gls'],
    [/\bdpd\b/i, 'dpd'],
    [/\bups\b/i, 'ups'],
    [/inpost/i, 'inpost'],
  ]
  return known.find(([pattern]) => pattern.test(body))?.[1] ?? null
}

/** `use by 19/06/2026 17:53` — the parcel must be handed over before this. */
function findDeadline(subject: string, body: string): string | null {
  const match = /(\d{2})\/(\d{2})\/(\d{4})[\s,]*(\d{2}):(\d{2})/.exec(`${subject} ${body}`)
  if (!match) return null
  const [, day, month, year, hour, minute] = match
  return `${year}-${month}-${day}T${hour}:${minute}:00.000Z`
}

export const VINTED_PARSERS: readonly Parser[] = [vintedSold, vintedLabel, vintedCompleted]
