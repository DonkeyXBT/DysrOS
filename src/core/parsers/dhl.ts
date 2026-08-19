import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { Parser } from './registry.js'
import type { ParsedEvent } from '../repos/events.js'
import { parseDutchDayMonth } from './nl.js'

/**
 * Parsers for DHL's own delivery mail.
 *
 * The retailer's shipping mail never states the barcode — it links to a
 * redirect that has to be followed. DHL, delivering the same parcel, states
 * the barcode in plain text, along with the day and the window. So this mail
 * is worth reading on its own: it is the one that says exactly when someone
 * has to be at the door.
 *
 * It carries no order reference, which is fine — the barcode is the parcel's
 * identity, so an event from here lands on the same shipment the retailer's
 * mail created rather than beside it.
 */

/** DHL eCommerce barcodes, as printed in the mail body. */
const BARCODE = /\b(JVGL\d{10,24}|JJD[A-Z0-9]{8,24}|3S[A-Z0-9]{9,24})\b/

/** Signatures of DHL's own mail, rather than a retailer linking to DHL. */
const DHL_SIGNATURE = /dhlecommerce\.nl|dhlparcel\.nl|dhl ecommerce|dhl parcel/i

function bodyOf(message: ParsedMessage): string {
  return textOf(message, { preferHtml: true })
}

function barcodeOf(message: ParsedMessage): string | null {
  const fromBody = BARCODE.exec(bodyOf(message))?.[1]
  // The subject repeats it, which covers a mail whose body wording changed.
  return (fromBody ?? BARCODE.exec(message.subject)?.[1] ?? null)?.toUpperCase() ?? null
}

/**
 * `Tussen 12.20 - 16.20 uur` — DHL writes times with a dot and an en dash of
 * whichever kind the template feels like that month.
 */
export function findDeliveryWindow(body: string): string | null {
  const match = /tussen\s+(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})/i.exec(body)
  if (!match) return null
  return `${match[1]!.padStart(2, '0')}:${match[2]}\u2013${match[3]!.padStart(2, '0')}:${match[4]}`
}

/** `Woensdag 19 augustus` under the expected-delivery heading. */
function findExpectedDate(body: string, receivedAt: string): string | null {
  const match = /(?:^|\s)([a-zà-ü]+dag)\s+(\d{1,2}\s+[a-zà-ü]+)/i.exec(body)
  if (!match) return null
  return parseDutchDayMonth(match[2]!, receivedAt)
}

/** `van bol` — who sent the parcel, which is how it reads in the mail. */
function findSender(body: string): string | null {
  const match = /\bvan\s+([a-z0-9][a-z0-9 .&'-]{1,30}?)\b\s*(?:bij je|\.|,)/i.exec(body)
  const name = match?.[1]?.trim().toLowerCase()
  return name && name.length > 1 ? name : null
}

function isDhlMail(message: ParsedMessage): boolean {
  // A retailer's mail may link to DHL; DHL's own mail is signed by it and
  // states a barcode outright.
  if (/@bol\.com$/i.test(message.fromAddress)) return false
  const fromDhl = /dhl/i.test(message.fromAddress) || DHL_SIGNATURE.test(message.html)
  return fromDhl && barcodeOf(message) !== null
}

/**
 * "We staan vandaag voor de deur" — the courier is out with the parcel today,
 * between the two times stated.
 */
export const dhlOutForDelivery: Parser = {
  id: 'dhl-out-for-delivery',
  retailer: 'dhl',

  matches(message) {
    if (!isDhlMail(message)) return false
    const body = bodyOf(message)
    return /vandaag voor de deur|staat vandaag op de stoep|bezorger is onderweg/i.test(body)
  },

  parse(message): ParsedEvent[] {
    const body = bodyOf(message)
    const window = findDeliveryWindow(body)

    return [{
      type: 'shipped',
      retailer: 'dhl',
      externalOrderId: null,
      occurredAt: message.receivedAt,
      payload: {
        carrier: 'dhl',
        direction: 'inbound',
        trackingNumber: barcodeOf(message),
        shipmentStatus: 'out_for_delivery',
        outForDelivery: true,
        deliveryWindow: window,
        // It is today: that is what the mail is for.
        expectedDeliveryAt: message.receivedAt.slice(0, 10),
        shippedBy: findSender(body),
        trackingResolvable: false,
      },
    }]
  },
}

/**
 * "Woensdag komen we bij je langs" — an appointment for a named day, sent
 * before the parcel is out with a courier.
 */
export const dhlDeliveryAppointment: Parser = {
  id: 'dhl-delivery-appointment',
  retailer: 'dhl',

  matches(message) {
    if (!isDhlMail(message)) return false
    if (dhlOutForDelivery.matches(message)) return false
    const body = bodyOf(message)
    return /komen we bij je langs|bij je op de stoep|bezorgafspraak/i.test(body)
  },

  parse(message): ParsedEvent[] {
    const body = bodyOf(message)

    return [{
      type: 'shipped',
      retailer: 'dhl',
      externalOrderId: null,
      occurredAt: message.receivedAt,
      payload: {
        carrier: 'dhl',
        direction: 'inbound',
        trackingNumber: barcodeOf(message),
        shipmentStatus: 'in_transit',
        outForDelivery: false,
        deliveryWindow: findDeliveryWindow(body),
        expectedDeliveryAt: findExpectedDate(body, message.receivedAt),
        shippedBy: findSender(body),
        trackingResolvable: false,
      },
    }]
  },
}

export const DHL_PARSERS: readonly Parser[] = [dhlOutForDelivery, dhlDeliveryAppointment]
