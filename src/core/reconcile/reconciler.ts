import { createHash } from 'node:crypto'
import type { Db } from '../db/connection.js'
import { EventRepo, type StoredEvent } from '../repos/events.js'
import {
  findParcel, mergedInto, mergeInto, rememberMerge, soleParcelOfOrder,
} from './shipment-merge.js'

/**
 * Turns parsed events into the entities the application reasons about:
 * purchases, individual items, shipments and refunds.
 *
 * Two properties matter more than anything else here.
 *
 * **Idempotence.** Every row this writes has an id derived from the facts that
 * identify it, so applying the same event twice updates rather than duplicates.
 * Re-running a corrected parser over retained mail therefore heals the data
 * instead of doubling your stock.
 *
 * **Tolerance of disorder.** Mail does not arrive in the order things happened.
 * A shipping notice can precede its order confirmation, and a cancellation can
 * refer to an order that was never captured. An event that cannot yet be
 * applied is *held* — left unreconciled — and retried on the next run, rather
 * than being dropped or guessed at.
 */
export class Reconciler {
  private readonly events: EventRepo

  constructor(private readonly db: Db) {
    this.events = new EventRepo(db)
  }

  run(now: string): { applied: number; held: number } {
    const pending = [...this.events.listUnreconciled()].sort((a, b) =>
      a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
    )

    let applied = 0
    let held = 0

    for (const event of pending) {
      const done = this.apply(event, now)
      if (done) {
        this.events.markReconciled(event.id, now)
        applied += 1
      } else {
        held += 1
      }
    }

    return { applied, held }
  }

  /** Returns false when the event cannot be applied yet and should be retried. */
  private apply(event: StoredEvent, now: string): boolean {
    switch (event.type) {
      case 'order_placed':
      case 'order_confirmed':
        return this.applyOrder(event, now)
      case 'shipped':
        return this.applyShipment(event, now)
      case 'cancelled':
        return this.applyCancellation(event, now)
      case 'delivered':
        return this.applyDelivery(event)
      default:
        // Nothing to do for this type yet, but it is not an error: mark it done
        // so it does not accumulate in the queue forever.
        return true
    }
  }

  /** True when this order was deleted by hand and must stay deleted. */
  private isSuppressed(kind: string, key: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM suppressions WHERE kind = ? AND key = ?')
      .get(kind, key) !== undefined
  }

  private applyOrder(event: StoredEvent, now: string): boolean {
    if (!event.externalOrderId) return true
    if (this.isSuppressed('purchase', `${event.retailer}|${event.externalOrderId}`)) return true

    const payload = event.payload as Record<string, unknown>
    const purchaseId = purchaseKey(event.retailer, event.externalOrderId)
    const currency = (payload.currency as string) ?? 'EUR'
    const quantity = Math.max(1, Number(payload.quantity ?? 1))
    const unitMinor = Number(payload.unitMinor ?? 0)

    this.db.prepare(
      `INSERT INTO purchases
         (id, retailer, external_order_id, ordered_at, status, currency,
          subtotal_minor, shipping_minor, vat_minor, total_minor,
          totals_consistent, title, created_at)
       VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ordered_at = excluded.ordered_at,
         currency = excluded.currency,
         subtotal_minor = excluded.subtotal_minor,
         shipping_minor = excluded.shipping_minor,
         total_minor = excluded.total_minor,
         totals_consistent = excluded.totals_consistent,
         title = excluded.title,
         -- A re-parse must not undo a cancellation already applied.
         status = CASE WHEN purchases.status = 'cancelled' THEN 'cancelled' ELSE excluded.status END`,
    ).run(
      purchaseId,
      event.retailer,
      event.externalOrderId,
      event.occurredAt,
      currency,
      unitMinor * quantity,
      Number(payload.shippingMinor ?? 0),
      Number(payload.totalMinor ?? 0),
      payload.totalsConsistent ? 1 : 0,
      (payload.title as string | null) ?? null,
      now,
    )

    // One row per physical unit, so each can be sold and tracked on its own.
    for (let index = 0; index < quantity; index += 1) {
      this.db.prepare(
        `INSERT INTO items
           (id, purchase_id, title, sku, size, condition, status, image_url, cost_minor,
            cost_currency, purchased_at, created_at)
         VALUES (?, ?, ?, NULL, NULL, 'new', 'incoming', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           -- A later mail without a picture must not take away the one a
           -- previous mail supplied.
           image_url = COALESCE(excluded.image_url, items.image_url),
           cost_minor = excluded.cost_minor,
           cost_currency = excluded.cost_currency,
           purchased_at = excluded.purchased_at`,
      ).run(
        itemKey(purchaseId, index),
        purchaseId,
        (payload.title as string | null) ?? 'Unknown item',
        (payload.imageUrl as string | null) ?? null,
        unitMinor,
        currency,
        event.occurredAt,
        now,
      )
    }

    // A shipping notice may already have arrived for this order.
    this.db.prepare(
      `UPDATE shipments SET purchase_id = ?
       WHERE purchase_id IS NULL AND id IN (
         SELECT s.id FROM shipments s
         JOIN events e ON e.id = s.id
         WHERE e.retailer = ? AND e.external_order_id = ?
       )`,
    ).run(purchaseId, event.retailer, event.externalOrderId)

    return true
  }

  private applyShipment(event: StoredEvent, now: string): boolean {
    if (this.isSuppressed('shipment', event.id)) return true
    const payload = event.payload as Record<string, unknown>
    const purchaseId = event.externalOrderId
      ? this.findPurchaseId(event.retailer, event.externalOrderId)
      : null

    // This mail may already be known to describe a parcel another mail
    // recorded — learned when both resolved to the same barcode, at the cost of
    // a network round trip. Writing it to that parcel is what stops the
    // duplicate coming back every time the mail is read again.
    //
    // The parcel's row is written under the shared id whichever mail is
    // applied first, so neither has to wait for the other.
    const parcelId = mergedInto(this.db, event.id) ?? event.id
    if (parcelId !== event.id && this.db.prepare('SELECT 1 FROM shipments WHERE id = ?').get(parcelId)) {
      mergeInto(this.db, parcelId, {
        status: shipmentStatus(payload),
        purchaseId,
        trackingUrl: (payload.trackingUrl as string | null) ?? null,
        expectedDeliveryAt: (payload.expectedDeliveryAt as string | null) ?? null,
        deliveryWindow: (payload.deliveryWindow as string | null) ?? null,
      })
      return true
    }

    // The courier being out with a parcel is news about a parcel already
    // announced, never the announcement itself. Where the order has just one
    // parcel with that carrier, this mail belongs to it.
    if (
      parcelId === event.id
      && payload.shipmentStatus === 'out_for_delivery'
      && !payload.trackingNumber
      && event.externalOrderId
    ) {
      // Matched on the order alone: this template names no carrier, so the
      // parcel's own is the one to trust.
      const sole = soleParcelOfOrder(this.db, event.retailer, event.externalOrderId, event.id)
      if (sole) {
        mergeInto(this.db, sole, {
          status: shipmentStatus(payload),
          purchaseId,
          trackingUrl: (payload.trackingUrl as string | null) ?? null,
          expectedDeliveryAt: (payload.expectedDeliveryAt as string | null) ?? null,
          deliveryWindow: (payload.deliveryWindow as string | null) ?? null,
        })
        rememberMerge(this.db, event.id, sole)
        return true
      }
    }

    // Mail carrying a barcode another mail already recorded describes the same
    // parcel, not a new one. It updates that parcel instead of inserting a
    // second row the unique index would refuse.
    const barcode = (payload.trackingNumber as string | null) ?? null
    if (barcode) {
      const existing = findParcel(this.db, (payload.carrier as string) ?? 'unknown', barcode, event.id)
      if (existing) {
        mergeInto(this.db, existing, {
          status: shipmentStatus(payload),
          purchaseId,
          trackingUrl: (payload.trackingUrl as string | null) ?? null,
          expectedDeliveryAt: (payload.expectedDeliveryAt as string | null) ?? null,
          deliveryWindow: (payload.deliveryWindow as string | null) ?? null,
        })
        return true
      }
    }

    // A shipment is worth recording whether or not its order was ever captured,
    // so this never holds the event back.
    this.db.prepare(
      `INSERT INTO shipments
         (id, direction, carrier, tracking_number, tracking_url, status, purchase_id,
          expected_delivery_at, delivery_window, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         carrier = excluded.carrier,
         tracking_number = COALESCE(excluded.tracking_number, shipments.tracking_number),
         tracking_url = COALESCE(excluded.tracking_url, shipments.tracking_url),
         -- A parcel never goes backwards: a handover mail applied after an
         -- out-for-delivery mail must not put it back on the van.
         status = CASE
           WHEN shipments.status = 'delivered' THEN 'delivered'
           WHEN shipments.status = 'out_for_delivery'
             AND excluded.status IN ('pending', 'in_transit') THEN 'out_for_delivery'
           WHEN shipments.status = 'in_transit' AND excluded.status = 'pending' THEN 'in_transit'
           ELSE excluded.status
         END,
         purchase_id = COALESCE(excluded.purchase_id, shipments.purchase_id),
         expected_delivery_at = excluded.expected_delivery_at,
         -- A later mail that names no window must not erase the one already
         -- known: the courier still comes between those two times.
         delivery_window = COALESCE(excluded.delivery_window, shipments.delivery_window)`,
    ).run(
      parcelId,
      (payload.direction as string) ?? 'inbound',
      (payload.carrier as string) ?? 'unknown',
      (payload.trackingNumber as string | null) ?? null,
      (payload.trackingUrl as string | null) ?? null,
      shipmentStatus(payload),
      purchaseId,
      (payload.expectedDeliveryAt as string | null) ?? null,
      (payload.deliveryWindow as string | null) ?? null,
      now,
    )

    // Shipping mail carries the same article photograph. Where the order mail
    // was never seen, or carried none, this is the picture the item gets.
    if (purchaseId && payload.imageUrl) {
      this.db.prepare(
        'UPDATE items SET image_url = ? WHERE purchase_id = ? AND image_url IS NULL',
      ).run(payload.imageUrl as string, purchaseId)
    }

    return true
  }

  private applyCancellation(event: StoredEvent, now: string): boolean {
    if (!event.externalOrderId) return true
    const purchaseId = this.findPurchaseId(event.retailer, event.externalOrderId)

    // Without the original order there is nothing to reverse, and the refund
    // amount is not stated in a cancellation mail. Hold it for the next run.
    if (!purchaseId) return false

    this.db.prepare("UPDATE purchases SET status = 'cancelled' WHERE id = ?").run(purchaseId)
    this.db.prepare(
      "UPDATE items SET status = 'cancelled' WHERE purchase_id = ? AND status NOT IN ('sold','delivered','returned')",
    ).run(purchaseId)

    if (event.payload.refundExpected) {
      const purchase = this.db
        .prepare('SELECT total_minor, currency FROM purchases WHERE id = ?')
        .get(purchaseId) as { total_minor: number; currency: string }

      this.db.prepare(
        `INSERT INTO refunds (id, purchase_id, currency, amount_minor, received_at, expected_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET amount_minor = excluded.amount_minor`,
      ).run(
        refundKey(purchaseId),
        purchaseId,
        purchase.currency,
        purchase.total_minor,
        event.occurredAt,
        now,
      )
    }

    return true
  }

  private applyDelivery(event: StoredEvent): boolean {
    if (!event.externalOrderId) return true
    const purchaseId = this.findPurchaseId(event.retailer, event.externalOrderId)
    if (!purchaseId) return false

    // Only items still in transit move into stock; a cancelled or returned item
    // must not be resurrected by a late delivery notice.
    this.db.prepare(
      "UPDATE items SET status = 'in_stock' WHERE purchase_id = ? AND status = 'incoming'",
    ).run(purchaseId)
    this.db.prepare("UPDATE purchases SET status = 'delivered' WHERE id = ? AND status != 'cancelled'")
      .run(purchaseId)

    return true
  }

  private findPurchaseId(retailer: string, externalOrderId: string): string | null {
    const row = this.db
      .prepare('SELECT id FROM purchases WHERE retailer = ? AND external_order_id = ?')
      .get(retailer, externalOrderId) as { id: string } | undefined
    return row?.id ?? null
  }
}

function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

export function purchaseKey(retailer: string, externalOrderId: string): string {
  return digest(`purchase|${retailer}|${externalOrderId}`)
}

export function itemKey(purchaseId: string, index: number): string {
  return digest(`item|${purchaseId}|${index}`)
}

export function refundKey(purchaseId: string): string {
  return digest(`refund|${purchaseId}`)
}

/**
 * What the shipments table records for a parcel.
 *
 * A parcel out with the courier says more than "in transit", and it says it on
 * the day it matters, so it is kept rather than flattened. Without a barcode
 * there is nothing to follow yet, which is what "pending" means here.
 */
function shipmentStatus(payload: Record<string, unknown>): string {
  if (payload.shipmentStatus === 'out_for_delivery') return 'out_for_delivery'
  return payload.trackingNumber ? 'in_transit' : 'pending'
}
