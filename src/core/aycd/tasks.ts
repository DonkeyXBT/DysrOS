import { parseDutchAmount, findDutchAmount, parseDutchDayMonth } from '../parsers/nl.js'
import type { ParsedEvent } from '../repos/events.js'
import type { EventType } from '../types.js'
import { splitResultValues, type MailElement, type MailFilter, type MailTask } from './client.js'

/**
 * Mail task definitions for the retailers this application already parses.
 *
 * An Inbox task is the forward-looking equivalent of a parser: instead of
 * reading a message and pulling fields out of it, it declares up front which
 * message to wait for and which fields to extract. The extraction rules
 * therefore have to be written in Inbox's own vocabulary — filters on the
 * envelope, regexes on the parts — rather than in TypeScript.
 *
 * Three properties of that vocabulary are not documented well enough to rely
 * on, so every definition here is written to survive either reading:
 *
 * - **Whole match or capture group?** Inbox returns "the value", and which of
 *   the two that is has not been confirmed against a live account. Every regex
 *   below is therefore written so both readings converge: the extractors in
 *   `toEvent` strip any label the whole match would carry and parse the
 *   remainder, so `Totaal €12,34` and `12,34` produce the same result.
 * - **Case sensitivity.** There is no flags field on a mail element, so no
 *   pattern here depends on a case-insensitive match; where a retailer's
 *   capitalisation varies the pattern spells out both forms.
 * - **HTML to text.** These retailers send HTML-only mail. How Inbox flattens
 *   it — where it inserts line breaks, whether it keeps the label and value
 *   adjacent — cannot be verified offline, so patterns allow any whitespace run
 *   between a label and its value and never assume a line boundary.
 *
 * Where a field cannot be extracted the event records null, exactly as the
 * .eml parsers do. A missing price is a gap to be filled from the order, never
 * a zero.
 */

/**
 * Body elements are rejected without a selector, and the DOM structure of these
 * retailers' templates is not something this project has verified. The whole
 * body is therefore the selector and the regex does all the narrowing — the
 * same division of labour the .eml parsers use, which flatten to text first and
 * match afterwards.
 */
const WHOLE_BODY = 'body'

export interface TaskRequest {
  /** The address Inbox should watch. */
  email: string
  /** Epoch **seconds**. Mail that arrived before this is not matched. */
  receivedAt: number
  /** Seconds until the task expires. Omitted means the client's default. */
  timeout?: number
  group?: string
}

/**
 * One retailer template, in the shape Inbox needs to wait for it and in the
 * shape this application needs to record what it caught.
 *
 * `id` doubles as the parser id on the events produced, so events captured this
 * way are distinguishable from events parsed out of retained mail. They are not
 * the same thing: an Inbox capture cannot be re-parsed later, because there is
 * no message to re-parse.
 */
export interface AycdTaskBuilder {
  id: string
  retailer: string
  eventType: EventType
  build(request: TaskRequest): MailTask
  /** `occurredAt` is an ISO timestamp; Inbox reports no send date of its own. */
  toEvent(results: Record<string, string>, occurredAt: string): ParsedEvent
}

/** The first value of a result, which arrives newline-separated when the
 *  pattern matched more than once. */
function first(results: Record<string, string>, name: string): string | null {
  const raw = results[name]
  if (raw === undefined) return null
  return splitResultValues(raw)[0] ?? null
}

/** Drops a leading label so a whole-match result reads the same as a capture. */
function withoutLabel(value: string | null, label: RegExp): string | null {
  if (value === null) return null
  const stripped = value.replace(label, '').trim()
  return stripped.length > 0 ? stripped : null
}

/** Money from either form of result: the bare amount or the labelled line. */
function amountMinor(value: string | null): number | null {
  if (value === null) return null
  const amount = parseDutchAmount(value) ?? findDutchAmount(value)
  return amount?.minor ?? null
}

/** The first digit run, so `3 x` and `3` both read as three. */
function intOf(value: string | null): number | null {
  if (value === null) return null
  const digits = /\d+/.exec(value)?.[0]
  return digits === undefined ? null : Number(digits)
}

function dayMonth(value: string | null, label: RegExp, occurredAt: string): string | null {
  const text = withoutLabel(value, label)
  if (text === null) return null
  // The weekday prefix is optional in the retailer's own wording and the day
  // parser handles it, so it is passed through untouched.
  return parseDutchDayMonth(text, occurredAt)
}

function bodyElement(name: string, regex: string): MailElement {
  return { name, target: 'body', selector: WHOLE_BODY, regex, formatter: 'text' }
}

function subjectElement(name: string, regex: string): MailElement {
  return { name, target: 'subject', regex }
}

function envelope(request: TaskRequest, filters: MailFilter[], elements: MailElement[]): MailTask {
  return {
    email: request.email,
    receivedAt: request.receivedAt,
    mailFilters: filters,
    mailElements: elements,
    ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
    ...(request.group === undefined ? {} : { group: request.group }),
  }
}

/** A Dutch amount as it appears in mail, with or without a currency marker. */
const AMOUNT = String.raw`(?:€\s*)?\d{1,3}(?:\.\d{3})*,\d{2}`

/** bol.com order references: a C followed by nine uppercase alphanumerics. */
const BOL_REFERENCE = String.raw`C[0-9A-Z]{9}`

const BOL_SENDER = 'automail@bol.com'

/** `3 juli`, optionally preceded by a weekday. No year: bol.com omits it. */
const DAY_MONTH = String.raw`(?:[A-Za-z]+dag\s+)?\d{1,2}\s+[A-Za-z]+`

const BESTELNUMMER_LABEL = /^\s*[Bb]estelnummer\s*:?\s*/
const BEZORGDATUM_LABEL = /^\s*[Bb]ezorgdatum\s*:?\s*/
const BEZORGD_OP_LABEL = /^\s*[Bb]ezorgd\s+op\s*/
const VERKOPER_LABEL = /^\s*[Vv]erkoper\s*:?\s*/
const CARRIER_LABEL = /^\s*(?:[Jj]e\s+pakket\s+is\s+nu\s+bij|[Mm]eegegeven\s+met)\s*/
const TOTAAL_LABEL = /^\s*[Tt]otaal\s*:?\s*/
const VERZENDKOSTEN_LABEL = /^\s*[Vv]erzendkosten\s*:?\s*/
const ORDER_HASH_LABEL = /^\s*[Oo]rder\s*#?\s*/
const SHIPPING_LABEL = /^\s*(?:[Ss]hipping|[Vv]erzendkosten)\s*:?\s*/
const GRAND_TOTAL_LABEL = /^\s*(?:[Gg]rand\s+)?(?:[Tt]otal|[Tt]otaal)\s*:?\s*/
const MM_REFERENCE_LABEL = /^\s*[Bb]estelnummer\s+is\s*/
const TRACKING_LABEL = /^\s*(?:[Tt]rack(?:ing)?|[Bb]arcode|[Zz]ending)\S*\s*:?\s*/

/**
 * Carrier names as bol.com writes them. Anything unrecognised passes through
 * lowercased rather than being dropped, matching the .eml parser: a new carrier
 * should still produce a usable shipment.
 */
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

function normaliseCarrier(value: string | null): string | null {
  const name = withoutLabel(value, CARRIER_LABEL)?.replace(/[!.]+$/, '').trim()
  if (!name) return null
  return CARRIERS[name.toLowerCase()] ?? name.toLowerCase()
}

export const bolOrderConfirmationTask: AycdTaskBuilder = {
  id: 'aycd-bol-order-confirmation',
  retailer: 'bol',
  eventType: 'order_placed',

  build(request) {
    return envelope(
      request,
      [
        { target: 'from', comparator: 'includes', value: BOL_SENDER },
        { target: 'subject', comparator: 'includes', value: 'bestelling' },
      ],
      [
        bodyElement('orderRef', BOL_REFERENCE),
        // The title follows the reference. Whitespace rather than a newline,
        // since how Inbox breaks the HTML into lines is not known.
        bodyElement('title', String.raw`[Bb]estelnummer:\s*${BOL_REFERENCE}\s*([^\n]{3,120})`),
        bodyElement('seller', String.raw`[Vv]erkoper:\s*([^\n]{2,80})`),
        bodyElement('quantity', String.raw`\d+\s*x\s*(?:€|\d)`),
        bodyElement('unitPrice', String.raw`\d+\s*x\s*(${AMOUNT})`),
        bodyElement('shipping', String.raw`[Vv]erzendkosten\s*:?\s*(${AMOUNT}|[Gg]ratis)`),
        bodyElement('total', String.raw`[Tt]otaal\s*:?\s*(${AMOUNT})`),
        bodyElement('deliveryDate', String.raw`[Bb]ezorgdatum:\s*(${DAY_MONTH})`),
      ],
    )
  },

  toEvent(results, occurredAt) {
    const quantity = intOf(first(results, 'quantity'))
    const unitMinor = amountMinor(first(results, 'unitPrice'))
    const shippingMinor = amountMinor(withoutLabel(first(results, 'shipping'), VERZENDKOSTEN_LABEL))
    const totalMinor = amountMinor(withoutLabel(first(results, 'total'), TOTAAL_LABEL))
    const title = withoutLabel(
      first(results, 'title'),
      new RegExp(String.raw`^\s*[Bb]estelnummer:\s*${BOL_REFERENCE}\s*`),
    )

    return {
      type: 'order_placed',
      retailer: 'bol',
      externalOrderId: withoutLabel(first(results, 'orderRef'), BESTELNUMMER_LABEL),
      occurredAt,
      payload: {
        title,
        titleTruncated: title !== null && title.endsWith('...'),
        seller: withoutLabel(first(results, 'seller'), VERKOPER_LABEL),
        quantity,
        currency: 'EUR',
        unitMinor,
        shippingMinor,
        totalMinor,
        deliveryDate: dayMonth(first(results, 'deliveryDate'), BEZORGDATUM_LABEL, occurredAt),
        totalsConsistent: quantity !== null && unitMinor !== null
          && shippingMinor !== null && totalMinor !== null
          && quantity * unitMinor + shippingMinor === totalMinor,
        source: 'aycd-inbox',
      },
    }
  },
}

export const bolShipmentTask: AycdTaskBuilder = {
  id: 'aycd-bol-shipment-confirmation',
  retailer: 'bol',
  eventType: 'shipped',

  build(request) {
    return envelope(
      request,
      [
        { target: 'from', comparator: 'includes', value: BOL_SENDER },
        { target: 'subject', comparator: 'includes', value: 'pakket' },
      ],
      [
        subjectElement('carrier', String.raw`[Jj]e pakket is nu bij\s*([A-Za-zÀ-ü.]+)`),
        bodyElement('orderRef', BOL_REFERENCE),
        bodyElement('title', String.raw`[Dd]it is onderweg\s*(?:\d+\s+artikel(?:en)?\s*)?([^\n]{3,120})`),
        bodyElement('quantity', String.raw`\d+\s*stuks?`),
        bodyElement('expectedDelivery', String.raw`[Bb]ezorgd op\s+(${DAY_MONTH})`),
        // The postal code doubles as the DHL ServicePoint redirect key, so it
        // is worth an element of its own even though it is not order data.
        bodyElement('postalCode', String.raw`\d{4}\s?[A-Z]{2}`),
      ],
    )
  },

  toEvent(results, occurredAt) {
    const postalRaw = first(results, 'postalCode')?.replace(/\s+/g, '') ?? null
    const carrier = normaliseCarrier(first(results, 'carrier'))
    const title = withoutLabel(first(results, 'title'), /^\s*[Dd]it is onderweg\s*(?:\d+\s+artikel(?:en)?\s*)?/)

    return {
      type: 'shipped',
      retailer: 'bol',
      externalOrderId: withoutLabel(first(results, 'orderRef'), BESTELNUMMER_LABEL),
      occurredAt,
      payload: {
        carrier,
        direction: 'inbound',
        title,
        titleTruncated: title !== null && title.endsWith('...'),
        quantity: intOf(first(results, 'quantity')) ?? 1,
        expectedDeliveryAt: dayMonth(first(results, 'expectedDelivery'), BEZORGD_OP_LABEL, occurredAt),
        // bol.com prints no carrier barcode in this mail, and Inbox returns no
        // links this task did not ask for, so tracking stays unresolved here
        // just as it does for the same mail read over IMAP.
        trackingNumber: null,
        trackingUrl: null,
        trackingResolvable: false,
        deliveryPostalCode: postalRaw,
        deliveryPostalCodeFormatted: postalRaw === null
          ? null
          : `${postalRaw.slice(0, 4)} ${postalRaw.slice(4)}`,
        deliveryCity: null,
        dhlRedirectable: carrier === 'dhl' && postalRaw !== null,
        source: 'aycd-inbox',
      },
    }
  },
}

export const bolCancellationTask: AycdTaskBuilder = {
  id: 'aycd-bol-cancellation',
  retailer: 'bol',
  eventType: 'cancelled',

  build(request) {
    return envelope(
      request,
      [
        { target: 'from', comparator: 'includes', value: BOL_SENDER },
        { target: 'subject', comparator: 'includes', value: 'geannuleerd' },
      ],
      [
        bodyElement('orderRef', BOL_REFERENCE),
        bodyElement('title', String.raw`[Dd]it is geannuleerd\s*(?:\d+\s+artikel(?:en)?\s*)?([^\n]{3,120})`),
        bodyElement('quantity', String.raw`\d+\s*stuks?`),
        bodyElement(
          'refundPhrase',
          String.raw`(?:krijg je (?:dat|het) terug|hebben je terugbetaald)`,
        ),
      ],
    )
  },

  toEvent(results, occurredAt) {
    return {
      type: 'cancelled',
      retailer: 'bol',
      externalOrderId: withoutLabel(first(results, 'orderRef'), BESTELNUMMER_LABEL),
      occurredAt,
      payload: {
        title: withoutLabel(
          first(results, 'title'),
          /^\s*[Dd]it is geannuleerd\s*(?:\d+\s+artikel(?:en)?\s*)?/,
        ),
        quantity: intOf(first(results, 'quantity')) ?? 1,
        // bol.com states no amount in this mail, so the refund value has to
        // come from the original order rather than be guessed here.
        totalMinor: null,
        currency: 'EUR',
        // The .eml parser reads the refund wording out of the whole body. A
        // task can only ask for a pattern, so the presence of the phrase is
        // the answer: no match means the field is absent, not that a refund
        // was denied.
        refundExpected: first(results, 'refundPhrase') !== null,
        source: 'aycd-inbox',
      },
    }
  },
}

export const mediamarktOrderTask: AycdTaskBuilder = {
  id: 'aycd-mediamarkt-order-confirmation',
  retailer: 'mediamarkt',
  eventType: 'order_placed',

  build(request) {
    return envelope(
      request,
      [
        { target: 'from', comparator: 'includes', value: 'mediamarkt' },
        { target: 'subject', comparator: 'includes', value: 'bestelling' },
        // Cancellation and shipping mail share the sender and the word
        // "bestelling", and Inbox completes on the first match, so they are
        // excluded rather than left to race the confirmation task.
        { target: 'subject', comparator: 'excludes', value: 'geannuleerd' },
        { target: 'subject', comparator: 'excludes', value: 'onderweg' },
      ],
      [
        bodyElement('orderRef', String.raw`[Bb]estelnummer\s+is\s*(\d{6,})`),
        bodyElement('total', String.raw`[Tt]otaal(?:bedrag)?\s*:?\s*(${AMOUNT})`),
      ],
    )
  },

  toEvent(results, occurredAt) {
    return {
      type: 'order_placed',
      retailer: 'mediamarkt',
      externalOrderId: withoutLabel(first(results, 'orderRef'), MM_REFERENCE_LABEL),
      occurredAt,
      payload: {
        currency: 'EUR',
        totalMinor: amountMinor(withoutLabel(first(results, 'total'), GRAND_TOTAL_LABEL)),
        // MediaMarkt states no per-unit breakdown in a form worth trusting
        // without a sample, so quantity and unit price stay unknown rather
        // than being assumed to be one.
        quantity: null,
        unitMinor: null,
        totalsConsistent: false,
        source: 'aycd-inbox',
      },
    }
  },
}

export const mediamarktShipmentTask: AycdTaskBuilder = {
  id: 'aycd-mediamarkt-shipment',
  retailer: 'mediamarkt',
  eventType: 'shipped',

  build(request) {
    return envelope(
      request,
      [
        { target: 'from', comparator: 'includes', value: 'mediamarkt' },
        { target: 'subject', comparator: 'includes', value: 'onderweg' },
      ],
      [
        bodyElement('orderRef', String.raw`[Bb]estelnummer\s+is\s*(\d{6,})`),
        // MediaMarkt ships with GLS in the Netherlands, whose barcode shape is
        // unambiguous enough to match on its own.
        bodyElement('tracking', String.raw`JVGL[A-Z0-9]{10,}`),
      ],
    )
  },

  toEvent(results, occurredAt) {
    const tracking = withoutLabel(first(results, 'tracking'), TRACKING_LABEL)
    return {
      type: 'shipped',
      retailer: 'mediamarkt',
      externalOrderId: withoutLabel(first(results, 'orderRef'), MM_REFERENCE_LABEL),
      occurredAt,
      payload: {
        carrier: tracking === null ? null : 'gls',
        direction: 'inbound',
        trackingNumber: tracking?.toUpperCase() ?? null,
        trackingUrl: null,
        trackingResolvable: false,
        quantity: 1,
        source: 'aycd-inbox',
      },
    }
  },
}

export const proshopOrderTask: AycdTaskBuilder = {
  id: 'aycd-proshop-order-confirmation',
  retailer: 'proshop',
  eventType: 'order_placed',

  build(request) {
    return envelope(
      request,
      [
        { target: 'from', comparator: 'includes', value: 'proshop' },
        { target: 'subject', comparator: 'includes', value: 'bestelling', orValues: ['order', 'bevestiging'] },
        { target: 'subject', comparator: 'excludes', value: 'annulering' },
        { target: 'subject', comparator: 'excludes', value: 'verzonden' },
      ],
      [
        bodyElement('orderRef', String.raw`[Bb]estelnummer\s*:?\s*(\d{6,})`),
        bodyElement('total', String.raw`[Tt]otaal\s*:?\s*(${AMOUNT})`),
      ],
    )
  },

  toEvent(results, occurredAt) {
    return {
      type: 'order_placed',
      retailer: 'proshop',
      externalOrderId: withoutLabel(first(results, 'orderRef'), BESTELNUMMER_LABEL),
      occurredAt,
      payload: {
        currency: 'EUR',
        totalMinor: amountMinor(withoutLabel(first(results, 'total'), TOTAAL_LABEL)),
        quantity: null,
        unitMinor: null,
        totalsConsistent: false,
        source: 'aycd-inbox',
      },
    }
  },
}

export const pocketgamesOrderTask: AycdTaskBuilder = {
  id: 'aycd-pocketgames-order-confirmation',
  retailer: 'pocketgames',
  eventType: 'order_placed',

  build(request) {
    return envelope(
      request,
      [
        // PocketGames sells through Shopify, so the sending domain serves every
        // Shopify store. The store name in the subject is what distinguishes it.
        { target: 'subject', comparator: 'includes', value: 'Order #' },
        { target: 'subject', comparator: 'includes', value: 'confirmed' },
        { target: 'from', comparator: 'includes', value: 'pocketgames', orValues: ['shopifyemail.com'] },
      ],
      [
        subjectElement('orderRef', String.raw`[Oo]rder\s*#\s*([A-Za-z0-9-]+)`),
        bodyElement('total', String.raw`(?:[Gg]rand\s+)?[Tt]otal\s*:?\s*(${AMOUNT})`),
        bodyElement('shipping', String.raw`(?:[Ss]hipping|[Vv]erzendkosten)\s*:?\s*(${AMOUNT})`),
      ],
    )
  },

  toEvent(results, occurredAt) {
    return {
      type: 'order_placed',
      retailer: 'pocketgames',
      externalOrderId: withoutLabel(first(results, 'orderRef'), ORDER_HASH_LABEL),
      occurredAt,
      payload: {
        currency: 'EUR',
        totalMinor: amountMinor(withoutLabel(first(results, 'total'), GRAND_TOTAL_LABEL)),
        shippingMinor: amountMinor(withoutLabel(first(results, 'shipping'), SHIPPING_LABEL)),
        quantity: null,
        unitMinor: null,
        totalsConsistent: false,
        source: 'aycd-inbox',
      },
    }
  },
}

export const AYCD_TASK_BUILDERS: readonly AycdTaskBuilder[] = [
  bolOrderConfirmationTask,
  bolShipmentTask,
  bolCancellationTask,
  mediamarktOrderTask,
  mediamarktShipmentTask,
  proshopOrderTask,
  pocketgamesOrderTask,
]

export function builderById(id: string): AycdTaskBuilder | null {
  return AYCD_TASK_BUILDERS.find((builder) => builder.id === id) ?? null
}
