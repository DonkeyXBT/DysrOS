import { textOf, type ParsedMessage } from '../mail/parsed-message.js'
import type { Parser } from './registry.js'
import type { ParsedEvent } from '../repos/events.js'
import { normalisePostnlCode } from '../tracking/resolve-link.js'

/**
 * Parsers for PostNL's own mail.
 *
 * The retailer's mail links to a redirect and never states the barcode;
 * PostNL, delivering the same parcel, prints it in the body under "Track &
 * trace-code". Their delivery mail is also the only thing that says a parcel
 * has actually arrived — without it a parcel stays "out for delivery" in the
 * list long after it is in the hallway.
 */

const SENDERS = /@(?:[a-z0-9.-]+\.)?postnl\.nl$/i

/** PostNL barcodes: `3S` and eleven to sixteen more characters. */
const BARCODE = /\b(3[SZ][A-Z0-9]{9,20})\b/

function bodyOf(message: ParsedMessage): string {
  return textOf(message, { preferHtml: true })
}

export function findPostnlBarcode(message: ParsedMessage): string | null {
  const labelled = /track\s*&?\s*(?:amp;)?\s*trace-?code\s*:?\s*([0-9A-Z-]{10,30})/i
    .exec(bodyOf(message))?.[1]
  const found = labelled ?? BARCODE.exec(bodyOf(message))?.[1] ?? BARCODE.exec(message.subject)?.[1]
  if (!found) return null
  return normalisePostnlCode(found) ?? found.toUpperCase()
}

function isPostnlMail(message: ParsedMessage): boolean {
  return SENDERS.test(message.fromAddress) && findPostnlBarcode(message) !== null
}

/** Who sent the parcel — "je pakket van bol" — as PostNL words it. */
function findSender(body: string): string | null {
  const match = /pakket van\s+([a-z0-9][a-z0-9 .&'-]{1,30}?)\s*(?:afgeleverd|bezorgd|is|\.|,)/i
    .exec(body)
  const name = match?.[1]?.trim().toLowerCase()
  return name && name.length > 1 ? name : null
}

/**
 * "Afgeleverd: je pakket van bol" — the parcel has arrived.
 *
 * It carries no order reference, only the barcode, which is enough: the parcel
 * is already recorded under that barcode, and the order hangs off the parcel.
 */
export const postnlDelivered: Parser = {
  id: 'postnl-delivered',
  retailer: 'postnl',

  matches(message) {
    if (!isPostnlMail(message)) return false
    return /afgeleverd|is bezorgd|hebben je pakket.*(?:afgeleverd|bezorgd)/i
      .test(`${message.subject} ${bodyOf(message)}`)
  },

  parse(message): ParsedEvent[] {
    const body = bodyOf(message)
    return [{
      type: 'delivered',
      retailer: 'postnl',
      externalOrderId: null,
      occurredAt: message.receivedAt,
      payload: {
        carrier: 'postnl',
        direction: 'inbound',
        trackingNumber: findPostnlBarcode(message),
        shipmentStatus: 'delivered',
        deliveredAt: message.receivedAt.slice(0, 10),
        shippedBy: findSender(body),
        trackingResolvable: false,
      },
    }]
  },
}

/**
 * "Je pakket is onderweg" — PostNL has it and is bringing it.
 *
 * Worth reading for the barcode alone: it arrives before the retailer's own
 * redirect has been followed, so the parcel becomes followable sooner.
 */
export const postnlInTransit: Parser = {
  id: 'postnl-in-transit',
  retailer: 'postnl',

  matches(message) {
    if (!isPostnlMail(message)) return false
    if (postnlDelivered.matches(message)) return false
    return /onderweg|bezorgen we|verwacht/i.test(`${message.subject} ${bodyOf(message)}`)
  },

  parse(message): ParsedEvent[] {
    const body = bodyOf(message)
    const outForDelivery = /bezorgen we vandaag|vandaag bezorgd|onze bezorger/i.test(body)

    return [{
      type: 'shipped',
      retailer: 'postnl',
      externalOrderId: null,
      occurredAt: message.receivedAt,
      payload: {
        carrier: 'postnl',
        direction: 'inbound',
        trackingNumber: findPostnlBarcode(message),
        shipmentStatus: outForDelivery ? 'out_for_delivery' : 'in_transit',
        outForDelivery,
        shippedBy: findSender(body),
        trackingResolvable: false,
      },
    }]
  },
}

export const POSTNL_PARSERS: readonly Parser[] = [postnlDelivered, postnlInTransit]
