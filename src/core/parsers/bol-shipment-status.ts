import type { ParsedMessage } from '../mail/parsed-message.js'

/**
 * Works out what a bol.com logistics mail is actually saying.
 *
 * Ported from a Python implementation that has run against a real mailbox for a
 * long time, and it encodes two things the sample mail never showed:
 *
 * - There are far more subject variants than "Je pakket is nu bij X". A parcel
 *   can be delayed, delivered, or announced as "De bezorger is onderweg" with
 *   no carrier named anywhere in the subject.
 * - When the subject does not name the carrier, the body does — often only as
 *   a tracking domain (`dhlparcel`, `jouw.postnl`). Looking solely at the
 *   subject left most parcels with no carrier at all.
 */

export type ShipmentStatus =
  | 'shipped_dhl'
  | 'shipped_postnl'
  | 'shipped_unknown_carrier'
  | 'delivered'
  | 'delayed'
  | 'delayed_again'
  | 'awaiting_carrier'

export interface ShipmentVariant {
  status: ShipmentStatus
  carrier: 'dhl' | 'postnl' | null
  /** True when the parcel is with a carrier, as opposed to merely announced. */
  inTransit: boolean
}

const DHL_IN_BODY = /dhlparcel|dhlecommerce|my\.dhl|\bdhl\b/i
const POSTNL_IN_BODY = /jouw\.postnl|postnl\.nl|\bpostnl\b|\bpost nl\b/i

function carrierFromText(text: string): 'dhl' | 'postnl' | null {
  // A tracking domain is the strongest signal, since it is what the parcel is
  // actually registered with; plain mentions come second.
  if (/dhlparcel|dhlecommerce|my\.dhl/i.test(text)) return 'dhl'
  if (/jouw\.postnl|postnl\.nl/i.test(text)) return 'postnl'
  if (DHL_IN_BODY.test(text)) return 'dhl'
  if (POSTNL_IN_BODY.test(text)) return 'postnl'
  return null
}

/**
 * Returns null when the mail is not a logistics update at all, so the caller
 * can leave it for another parser rather than recording a shipment that is not
 * one.
 */
export function classifyShipment(
  message: ParsedMessage,
  bodyText: string,
): ShipmentVariant | null {
  const subject = message.subject.toLowerCase()
  const body = `${bodyText}\n${message.html}`.toLowerCase()

  if (/je pakket is weer vertraagd/.test(subject)) {
    return { status: 'delayed_again', carrier: carrierFromText(body), inTransit: true }
  }
  if (/je pakket is vertraagd/.test(subject)) {
    return { status: 'delayed', carrier: carrierFromText(body), inTransit: true }
  }
  if (/je pakket is bezorgd/.test(subject)) {
    return { status: 'delivered', carrier: carrierFromText(body), inTransit: false }
  }

  if (/je pakket is nu bij/.test(subject)) {
    const carrier = carrierFromText(subject) ?? carrierFromText(body)
    return {
      status: carrier === 'dhl' ? 'shipped_dhl' : carrier === 'postnl' ? 'shipped_postnl' : 'shipped_unknown_carrier',
      carrier,
      inTransit: true,
    }
  }

  // "De bezorger is onderweg" names no carrier in the subject; the body does.
  if (/bezorger is onderweg/.test(subject) || /bezorger is onderweg/.test(body)) {
    const carrier = carrierFromText(body) ?? 'dhl'
    return {
      status: carrier === 'postnl' ? 'shipped_postnl' : 'shipped_dhl',
      carrier,
      inTransit: true,
    }
  }

  // "Je artikelen komen eraan" is bol's own logistics, which is DHL unless the
  // body says otherwise.
  if (/je artikelen komen eraan/.test(subject)) {
    const carrier = carrierFromText(body) ?? 'dhl'
    return { status: carrier === 'postnl' ? 'shipped_postnl' : 'shipped_dhl', carrier, inTransit: true }
  }

  // "Je pakket komt eraan" precedes dispatch: bol has the parcel, no carrier
  // has it yet, and nothing can be tracked.
  if (/je pakket komt eraan/.test(subject)) {
    return { status: 'awaiting_carrier', carrier: null, inTransit: false }
  }

  // Body-only fallbacks, for mail whose subject was mangled by forwarding.
  if (/je pakket is bezorgd/.test(body) && /bol\.com|bestelnummer/.test(body)) {
    return { status: 'delivered', carrier: carrierFromText(body), inTransit: false }
  }
  if (/je pakket is nu bij/.test(body) && /bol\.com/.test(body)) {
    const carrier = carrierFromText(body)
    return {
      status: carrier === 'postnl' ? 'shipped_postnl' : 'shipped_dhl',
      carrier,
      inTransit: true,
    }
  }

  return null
}

/**
 * The item a logistics mail is about.
 *
 * bol.com lays these mails out as a heading, a count of items, then the item
 * itself. The heading wording changes between templates, so the count line is
 * the more reliable anchor — and where even that is missing, the line following
 * a product image is the last resort.
 */
export function findShipmentTitle(lines: string[], html: string): string | null {
  const HEADINGS = /^(dit is onderweg|dit is bezorgd|dit is geannuleerd|dit heb je besteld|dit komt eraan)$/i
  const COUNT_LINE = /^\d+\s+artikel(en)?$/i
  const NOISE = /^(volg je pakket|bezorgadres|hier wordt het bezorgd|goed om te weten)$/i

  const headingIndex = lines.findIndex((line) => HEADINGS.test(line))
  if (headingIndex !== -1) {
    const found = lines.slice(headingIndex + 1, headingIndex + 5)
      .find((line) => !COUNT_LINE.test(line) && !NOISE.test(line))
    if (found) return found
  }

  const countIndex = lines.findIndex((line) => COUNT_LINE.test(line))
  if (countIndex !== -1) {
    const found = lines.slice(countIndex + 1, countIndex + 4).find((line) => !NOISE.test(line))
    if (found) return found
  }

  // bol serves product imagery from media.s-bol.com; the item is named beside
  // it. This reaches into the HTML only because the text rendering has already
  // failed to place it.
  const alt = /<img[^>]+media\.s-bol\.com[^>]+alt="([^"]{4,})"/i.exec(html)?.[1]
  if (alt && !/logo|icon/i.test(alt)) return alt.trim()

  return null
}
