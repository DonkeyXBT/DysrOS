import type Database from 'better-sqlite3'

/**
 * One parcel, one row.
 *
 * A parcel is announced more than once — handed to the carrier, out for
 * delivery, delivered — and each mail is its own event, so each first arrives
 * as its own shipment row with no barcode yet. The moment two of those rows
 * resolve to the same barcode they are the same parcel, and the database says
 * so with a unique index. Left alone that surfaces as a crash mid-sync
 * (`UNIQUE constraint failed: shipments.carrier, shipments.tracking_number`)
 * and, before the crash, as the same parcel listed twice.
 *
 * So they are folded: the row that got there first is kept, everything the
 * later row learned is carried across, and the duplicate goes.
 */

/** How far along a parcel is, least to most. A later mail may say less than an
 *  earlier one — a delivered parcel never goes back to being in transit. */
const PROGRESS = [
  'pending', 'in_transit', 'out_for_delivery',
  // At a ServicePoint the parcel has arrived somewhere, but not with you.
  'ready_for_pickup',
  'delivered',
]

export function furthestStatus(a: string | null, b: string | null): string {
  const rank = (status: string | null) => PROGRESS.indexOf(status ?? 'pending')
  return rank(b) > rank(a) ? (b ?? 'pending') : (a ?? 'pending')
}

/** The row already holding this barcode, if it is not the one asking. */
export function findParcel(
  db: Database.Database,
  carrier: string,
  trackingNumber: string,
  exceptId: string,
): string | null {
  const row = db
    .prepare('SELECT id FROM shipments WHERE carrier = ? AND tracking_number = ? AND id != ?')
    .get(carrier, trackingNumber, exceptId) as { id: string } | undefined
  return row?.id ?? null
}

export interface ShipmentFacts {
  status?: string | null
  purchaseId?: string | null
  trackingUrl?: string | null
  postalCode?: string | null
  expectedDeliveryAt?: string | null
  /** `17:00–19:00`, which only the out-for-delivery mail ever states. */
  deliveryWindow?: string | null
  lastPolledAt?: string | null
}

/**
 * Carries what a duplicate knows into the row that keeps the barcode.
 *
 * Nothing already known is overwritten by a blank, and the status only ever
 * moves forward.
 */
export function mergeInto(
  db: Database.Database,
  keepId: string,
  facts: ShipmentFacts,
): void {
  const current = db
    .prepare('SELECT status FROM shipments WHERE id = ?')
    .get(keepId) as { status: string } | undefined
  if (!current) return

  db.prepare(
    `UPDATE shipments
     SET status = ?,
         purchase_id = COALESCE(purchase_id, ?),
         tracking_url = COALESCE(?, tracking_url),
         postal_code = COALESCE(?, postal_code),
         expected_delivery_at = COALESCE(?, expected_delivery_at),
         delivery_window = COALESCE(?, delivery_window),
         last_polled_at = COALESCE(?, last_polled_at)
     WHERE id = ?`,
  ).run(
    furthestStatus(current.status, facts.status ?? null),
    facts.purchaseId ?? null,
    facts.trackingUrl ?? null,
    facts.postalCode ?? null,
    facts.expectedDeliveryAt ?? null,
    facts.deliveryWindow ?? null,
    facts.lastPolledAt ?? null,
    keepId,
  )
}

/** The parcel a given mail was found to belong to, if that is already known. */
export function mergedInto(db: Database.Database, eventId: string): string | null {
  const row = db
    .prepare('SELECT into_id FROM parcel_merges WHERE event_id = ?')
    .get(eventId) as { into_id: string } | undefined
  return row?.into_id ?? null
}

/** Remembers that a mail belongs to a parcel another mail recorded. */
export function rememberMerge(db: Database.Database, eventId: string, intoId: string): void {
  db.prepare(
    `INSERT INTO parcel_merges (event_id, into_id, tracking_number, created_at)
     VALUES (?, ?, (SELECT tracking_number FROM shipments WHERE id = ?), ?)
     ON CONFLICT(event_id) DO UPDATE SET into_id = excluded.into_id`,
  ).run(eventId, intoId, intoId, new Date().toISOString())
}

/**
 * The parcel an out-for-delivery mail is about, where that is unambiguous.
 *
 * "The courier is on the way with your parcel" is never the first anyone hears
 * of a parcel — a handover mail came first and made the row. So when exactly
 * one parcel of that order is with that carrier, this mail is about that one,
 * and saying so needs no network round trip. Where an order went out in
 * several parcels there is nothing to pick between, so nothing is picked: the
 * barcodes settle it later.
 */
export function soleParcelOfOrder(
  db: Database.Database,
  retailer: string,
  externalOrderId: string,
  exceptId: string,
): string | null {
  const rows = db.prepare(
    `SELECT s.id FROM shipments s
     JOIN events e ON e.id = s.id
     WHERE e.retailer = ? AND e.external_order_id = ? AND s.id != ?`,
  ).all(retailer, externalOrderId, exceptId) as { id: string }[]
  return rows.length === 1 ? rows[0]!.id : null
}

/** Folds one shipment row into another and removes the duplicate. */
export function foldShipment(db: Database.Database, duplicateId: string, keepId: string): void {
  const duplicate = db
    .prepare(
      `SELECT status, purchase_id, tracking_url, postal_code, expected_delivery_at,
              delivery_window, last_polled_at
       FROM shipments WHERE id = ?`,
    )
    .get(duplicateId) as Record<string, string | null> | undefined
  if (!duplicate) return

  mergeInto(db, keepId, {
    status: duplicate.status ?? null,
    purchaseId: duplicate.purchase_id ?? null,
    trackingUrl: duplicate.tracking_url ?? null,
    postalCode: duplicate.postal_code ?? null,
    expectedDeliveryAt: duplicate.expected_delivery_at ?? null,
    deliveryWindow: duplicate.delivery_window ?? null,
    lastPolledAt: duplicate.last_polled_at ?? null,
  })
  db.prepare('DELETE FROM shipments WHERE id = ?').run(duplicateId)

  // Remembered, because this pairing cost a network round trip to learn and a
  // rebuild would otherwise recreate the duplicate row and ask again.
  rememberMerge(db, duplicateId, keepId)
}
