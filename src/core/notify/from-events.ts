import { money } from '../money.js'
import type { NotifiableEvent, NotificationInput } from './discord.js'

/**
 * Turning what happened into something worth saying.
 *
 * The embeds, the rules and the sending have existed since the first version —
 * what was missing is this: nothing ever turned a reconciled event into a
 * notification, so the only message that ever reached Discord was the test
 * one. This is the step in between.
 *
 * Only events a person would want to hear about become notifications, and each
 * carries what the mail actually established: never a placeholder, never a
 * guess at a tracking code that has not been resolved yet.
 */

/** Event types worth telling someone about, mapped to the rules they obey. */
const NOTIFIABLE: Record<string, NotifiableEvent> = {
  order_placed: 'order_placed',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
  refunded: 'refunded',
  sale: 'sale',
  payout: 'payout',
}

export interface NotifiableRow {
  id: string
  type: string
  retailer: string
  externalOrderId: string | null
  occurredAt: string
  payload: Record<string, unknown>
  /** What the parcel itself knows, which is more than the mail said. */
  parcel?: {
    carrier: string | null
    trackingNumber: string | null
    trackingUrl: string | null
    status: string | null
    expectedDeliveryAt: string | null
    deliveryWindow: string | null
  } | null
}

export function toNotification(row: NotifiableRow): NotificationInput | null {
  const event = NOTIFIABLE[row.type]
  if (!event) return null

  const payload = row.payload
  const parcel = row.parcel ?? null

  // A parcel out with the courier is not the same news as one handed over, and
  // it is the news people actually wait for.
  const status = (parcel?.status ?? payload.shipmentStatus) as string | undefined
  const outForDelivery = status === 'out_for_delivery'

  const amountMinor = numberOr(payload.totalMinor, null)
  const currency = typeof payload.currency === 'string' ? payload.currency : 'EUR'

  return {
    event,
    retailer: row.retailer,
    reference: row.externalOrderId,
    title: (payload.title as string | null) ?? null,
    quantity: numberOr(payload.quantity, 1) ?? 1,
    amount: amountMinor === null ? null : money(amountMinor, currency as 'EUR'),
    // The barcode is resolved after the mail is read, so the parcel is the
    // better source; the mail's own link stands in until then.
    carrier: parcel?.carrier ?? (payload.carrier as string | null) ?? null,
    trackingNumber: parcel?.trackingNumber ?? (payload.trackingNumber as string | null) ?? null,
    trackingUrl: parcel?.trackingUrl ?? (payload.trackingUrl as string | null) ?? null,
    expectedDeliveryAt: parcel?.expectedDeliveryAt ?? (payload.expectedDeliveryAt as string | null) ?? null,
    deliveryWindow: parcel?.deliveryWindow ?? (payload.deliveryWindow as string | null) ?? null,
    status: outForDelivery ? 'Out for delivery' : null,
    occurredAt: row.occurredAt,
  }
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
